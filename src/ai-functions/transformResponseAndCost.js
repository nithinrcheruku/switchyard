/**
 * transformResponseAndCost.js
 * Translates unary responses from any Vertex AI Model Garden backend family
 * ("gemini", "anthropic", "openapi_maas") back into the calling coding agent's
 * expected wire schema:
 *   - Claude Code: Anthropic Messages API (id, type: "message", content: [{type: "text"|"tool_use"}], usage)
 *   - Google Antigravity: Vertex Gemini API (candidates, usageMetadata) or OpenAI Chat Completions
 *   - OpenAI Codex CLI / Desktop:
 *       * /v1/responses -> OpenAI Responses API (id, object: "response", output: [...], usage)
 *       * /v1/chat/completions -> OpenAI Chat Completions API (choices, usage)
 * Also computes normalized token counts (including Gemini 3 thoughtsTokenCount and cache tokens)
 * and FinOps USD chargeback cost for DataCapture.
 */

var GLOBAL_THOUGHT_SIGNATURES =
  (typeof globalThis !== "undefined" && globalThis.__AGY_THOUGHT_SIGNATURES__) || {};
var GLOBAL_TOOL_ID_TO_NAME =
  (typeof globalThis !== "undefined" && globalThis.__AGY_TOOL_ID_TO_NAME__) || {};
if (typeof globalThis !== "undefined") {
  globalThis.__AGY_THOUGHT_SIGNATURES__ = GLOBAL_THOUGHT_SIGNATURES;
  globalThis.__AGY_TOOL_ID_TO_NAME__ = GLOBAL_TOOL_ID_TO_NAME;
}

var TOOL_CALL_SEQ = 0;
var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8ToBytes(str) {
  var bytes = [];
  var s = String(str || "");
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      var next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        var cp = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        bytes.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
        i++;
      } else {
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return bytes;
}

function encodeBase64Url(str) {
  if (!str) return "";
  var bytes = utf8ToBytes(str);
  var out = [];
  for (var i = 0; i < bytes.length; i += 3) {
    var b0 = bytes[i];
    var hasB1 = i + 1 < bytes.length;
    var hasB2 = i + 2 < bytes.length;
    var b1 = hasB1 ? bytes[i + 1] : 0;
    var b2 = hasB2 ? bytes[i + 2] : 0;
    out.push(B64_CHARS.charAt(b0 >> 2));
    out.push(B64_CHARS.charAt(((b0 & 3) << 4) | (b1 >> 4)));
    if (hasB1) {
      out.push(B64_CHARS.charAt(((b1 & 15) << 2) | (b2 >> 6)));
    }
    if (hasB2) {
      out.push(B64_CHARS.charAt(b2 & 63));
    }
  }
  return out.join("");
}

function generateUniqueToolId(prefix, index, thoughtSignature) {
  TOOL_CALL_SEQ = (TOOL_CALL_SEQ + 1) % 1000000;
  var baseId =
    prefix + "_" + Date.now().toString(36) + "_" + TOOL_CALL_SEQ + "_" + (index + 1);
  if (thoughtSignature) {
    var b64 = encodeBase64Url(String(thoughtSignature));
    if (b64) {
      return baseId + "__sig_" + b64;
    }
  }
  return baseId;
}

var MAX_REGISTRY_ENTRIES = 4000;

function trimMapSize(obj) {
  var keys = Object.keys(obj);
  if (keys.length > MAX_REGISTRY_ENTRIES) {
    var removeCount = keys.length - MAX_REGISTRY_ENTRIES + 500;
    for (var i = 0; i < removeCount && i < keys.length; i++) {
      delete obj[keys[i]];
    }
  }
}

function recordToolSig(callId, fnName, sig) {
  if (callId && fnName) {
    GLOBAL_TOOL_ID_TO_NAME[callId] = fnName;
    trimMapSize(GLOBAL_TOOL_ID_TO_NAME);
  }
  if (callId && sig) {
    GLOBAL_THOUGHT_SIGNATURES[callId] = sig;
    trimMapSize(GLOBAL_THOUGHT_SIGNATURES);
  }
}

function parseBackendUnaryResponse(body, targetFamily) {
  var result = {
    text: "",
    thoughts: [], // [{ text, thoughtSignature }]
    toolCalls: [], // [{ id, name, args, thoughtSignature }]
    inputTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    stopReason: "end_turn",
    openaiFinishReason: "stop",
    geminiFinishReason: "STOP"
  };

  if (!body || typeof body !== "object") return result;

  if (targetFamily === "gemini_decisions") {
    var dUsage = body.usage && typeof body.usage === "object" ? body.usage : {};
    result.inputTokens = Number(dUsage.total_input_tokens || dUsage.total_tokens || 0);
    // Gemini Decision 1 always generates 0 output tokens.
    result.outputTokens = Number(dUsage.total_output_tokens || 0);
    result.thoughtsTokens = 0;
    result.cachedInputTokens = Number(dUsage.total_cached_tokens || 0);
    if (body.prompt_feedback && body.prompt_feedback.block_reason) {
      result.stopReason = "refusal";
      result.openaiFinishReason = "content_filter";
      result.geminiFinishReason = "SAFETY";
    }
  } else if (targetFamily === "gemini") {
    var cand = body.candidates && body.candidates[0];
    var latestThoughtSig = null;
    if (cand && cand.content && Array.isArray(cand.content.parts)) {
      var textParts = [];
      for (var i = 0; i < cand.content.parts.length; i++) {
        var p = cand.content.parts[i];
        if (!p) continue;
        if (p.thought) {
          if (p.thoughtSignature) {
            latestThoughtSig = p.thoughtSignature;
          }
          result.thoughts.push({
            text: p.text || "",
            thoughtSignature: p.thoughtSignature || null
          });
        } else if (p.text) {
          if (p.thoughtSignature) {
            latestThoughtSig = p.thoughtSignature;
          }
          textParts.push(p.text);
        }
        if (p.functionCall) {
          // Gemini 3 only attaches thoughtSignature to the first functionCall in parallel calls
          var sig = p.thoughtSignature || null;
          if (!sig && latestThoughtSig && result.toolCalls.length === 0) {
            sig = latestThoughtSig;
            latestThoughtSig = null;
          }
          var fnName = p.functionCall.name || "tool";
          var callId = generateUniqueToolId(
            p.functionCall.id || "toolu_vrtx",
            i,
            sig
          );
          recordToolSig(callId, fnName, sig);
          result.toolCalls.push({
            id: callId,
            name: fnName,
            args: p.functionCall.args || {},
            thoughtSignature: sig
          });
        }
      }
      result.text = textParts.join("");
    }
    var gFinish = (cand && cand.finishReason) || "STOP";
    result.geminiFinishReason = gFinish;
    if (result.toolCalls.length > 0) {
      result.stopReason = "tool_use";
      result.openaiFinishReason = "tool_calls";
    } else if (gFinish === "MAX_TOKENS") {
      result.stopReason = "max_tokens";
      result.openaiFinishReason = "length";
    } else if (
      gFinish === "SAFETY" ||
      gFinish === "RECITATION" ||
      gFinish === "BLOCKLIST" ||
      gFinish === "PROHIBITED_CONTENT"
    ) {
      result.stopReason = "refusal";
      result.openaiFinishReason = "content_filter";
    } else {
      result.stopReason = "end_turn";
      result.openaiFinishReason = "stop";
    }
    var meta = body.usageMetadata || {};
    result.inputTokens = Number(meta.promptTokenCount || 0);
    result.outputTokens = Number(meta.candidatesTokenCount || 0);
    result.thoughtsTokens = Number(meta.thoughtsTokenCount || 0);
    result.cachedInputTokens = Number(meta.cachedContentTokenCount || 0);
  } else if (targetFamily === "anthropic") {
    var blocks = body.content || [];
    var aText = [];
    for (var j = 0; j < blocks.length; j++) {
      var b = blocks[j];
      if (!b) continue;
      if (b.type === "thinking") {
        // Keep Anthropic cryptographic signature isolated from Gemini thoughtSignature
        result.thoughts.push({
          text: b.thinking || "",
          anthropicSignature: b.signature || null,
          thoughtSignature: null
        });
      } else if (b.type === "text" && b.text) {
        aText.push(b.text);
      } else if (b.type === "tool_use") {
        var anthId = b.id || generateUniqueToolId("toolu_anth", j, null);
        var anthName = b.name || "tool";
        recordToolSig(anthId, anthName, null);
        result.toolCalls.push({
          id: anthId,
          name: anthName,
          args: b.input || {},
          thoughtSignature: null
        });
      }
    }
    result.text = aText.join("");
    var aStop = body.stop_reason || (result.toolCalls.length > 0 ? "tool_use" : "end_turn");
    result.stopReason = aStop;
    if (aStop === "tool_use") {
      result.openaiFinishReason = "tool_calls";
      result.geminiFinishReason = "STOP";
    } else if (aStop === "max_tokens") {
      result.openaiFinishReason = "length";
      result.geminiFinishReason = "MAX_TOKENS";
    } else {
      result.openaiFinishReason = "stop";
      result.geminiFinishReason = "STOP";
    }
    var u = body.usage || {};
    var anthUncachedIn = Number(u.input_tokens || 0);
    result.outputTokens = Number(u.output_tokens || 0);
    result.cachedInputTokens = Number(u.cache_read_input_tokens || 0);
    result.cacheCreationTokens = Number(u.cache_creation_input_tokens || 0);
    result.inputTokens = anthUncachedIn + result.cachedInputTokens + result.cacheCreationTokens;
  } else {
    // openapi_maas
    var choice = body.choices && body.choices[0];
    if (choice && choice.message) {
      result.text = choice.message.content || "";
      var tcs = choice.message.tool_calls || [];
      for (var k = 0; k < tcs.length; k++) {
        var fn = tcs[k].function || {};
        var parsedArgs = {};
        try {
          parsedArgs =
            typeof fn.arguments === "string"
              ? JSON.parse(fn.arguments)
              : fn.arguments || {};
        } catch (e) {
          parsedArgs = {};
        }
        var maasSig =
          (tcs[k].extra_content &&
            tcs[k].extra_content.google &&
            tcs[k].extra_content.google.thought_signature) ||
          tcs[k].thoughtSignature ||
          tcs[k].thought_signature ||
          null;
        var baseMaasId = tcs[k].id || generateUniqueToolId("call_maas", k, null);
        var maasId =
          maasSig && baseMaasId.indexOf("__sig_") === -1
            ? baseMaasId + "__sig_" + encodeBase64Url(maasSig)
            : baseMaasId;
        var maasName = fn.name || "tool";
        recordToolSig(maasId, maasName, maasSig);
        result.toolCalls.push({
          id: maasId,
          name: maasName,
          args: parsedArgs,
          thoughtSignature: maasSig
        });
      }
    }
    var oaiFinish = (choice && choice.finish_reason) || "stop";
    if (result.toolCalls.length > 0 || oaiFinish === "tool_calls" || oaiFinish === "function_call") {
      result.stopReason = "tool_use";
      result.openaiFinishReason = "tool_calls";
      result.geminiFinishReason = "STOP";
    } else if (oaiFinish === "length") {
      result.stopReason = "max_tokens";
      result.openaiFinishReason = "length";
      result.geminiFinishReason = "MAX_TOKENS";
    } else if (oaiFinish === "content_filter") {
      result.stopReason = "refusal";
      result.openaiFinishReason = "content_filter";
      result.geminiFinishReason = "SAFETY";
    } else {
      result.stopReason = "end_turn";
      result.openaiFinishReason = "stop";
      result.geminiFinishReason = "STOP";
    }
    var mu = body.usage || {};
    result.inputTokens = Number(mu.prompt_tokens || 0);
    result.outputTokens = Number(mu.completion_tokens || 0);
    if (mu.completion_tokens_details && mu.completion_tokens_details.reasoning_tokens) {
      result.thoughtsTokens = Number(mu.completion_tokens_details.reasoning_tokens || 0);
    }
    if (mu.prompt_tokens_details && mu.prompt_tokens_details.cached_tokens) {
      result.cachedInputTokens = Number(mu.prompt_tokens_details.cached_tokens || 0);
    }
  }

  return result;
}

function formatForClientProtocol(normalized, clientProtocol, modelId) {
  if (clientProtocol === "anthropic_messages") {
    var content = [];
    if (normalized.thoughts && normalized.thoughts.length > 0) {
      for (var th = 0; th < normalized.thoughts.length; th++) {
        var sigForAnth =
          normalized.thoughts[th].anthropicSignature ||
          normalized.thoughts[th].thoughtSignature ||
          null;
        if (normalized.thoughts[th].text || sigForAnth) {
          var thinkBlock = {
            type: "thinking",
            thinking: normalized.thoughts[th].text || ""
          };
          if (sigForAnth) {
            thinkBlock.signature = sigForAnth;
          }
          content.push(thinkBlock);
        }
      }
    }
    if (normalized.text) {
      content.push({ type: "text", text: normalized.text });
    }
    for (var i = 0; i < normalized.toolCalls.length; i++) {
      var tcBlock = {
        type: "tool_use",
        id: normalized.toolCalls[i].id,
        name: normalized.toolCalls[i].name,
        input: normalized.toolCalls[i].args
      };
      if (normalized.toolCalls[i].thoughtSignature) {
        tcBlock.thoughtSignature = normalized.toolCalls[i].thoughtSignature;
      }
      content.push(tcBlock);
    }
    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }
    return {
      id: "msg_apigee_vertex_" + Date.now(),
      type: "message",
      role: "assistant",
      model: modelId,
      content: content,
      stop_reason: normalized.stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: Math.max(
          0,
          normalized.inputTokens -
            normalized.cachedInputTokens -
            normalized.cacheCreationTokens
        ),
        output_tokens: normalized.outputTokens + normalized.thoughtsTokens,
        cache_read_input_tokens: normalized.cachedInputTokens,
        cache_creation_input_tokens: normalized.cacheCreationTokens
      }
    };
  } else if (clientProtocol === "openai_responses") {
    var outputItems = [];
    if (normalized.text || normalized.toolCalls.length === 0) {
      outputItems.push({
        type: "message",
        id: "msg_resp_" + Date.now(),
        status: normalized.stopReason === "max_tokens" ? "incomplete" : "completed",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: normalized.text,
            annotations: []
          }
        ]
      });
    }
    for (var r = 0; r < normalized.toolCalls.length; r++) {
      var fcItem = {
        type: "function_call",
        id: "fc_" + (r + 1),
        call_id: normalized.toolCalls[r].id,
        name: normalized.toolCalls[r].name,
        arguments: JSON.stringify(normalized.toolCalls[r].args),
        status: "completed"
      };
      if (normalized.toolCalls[r].thoughtSignature) {
        fcItem.thoughtSignature = normalized.toolCalls[r].thoughtSignature;
      }
      outputItems.push(fcItem);
    }
    return {
      id: "resp_apigee_vertex_" + Date.now(),
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: normalized.stopReason === "max_tokens" ? "incomplete" : "completed",
      model: modelId,
      output: outputItems,
      output_text: normalized.text,
      usage: {
        input_tokens: normalized.inputTokens,
        output_tokens: normalized.outputTokens + normalized.thoughtsTokens,
        total_tokens:
          normalized.inputTokens + normalized.outputTokens + normalized.thoughtsTokens
      }
    };
  } else if (clientProtocol === "openai_chat") {
    var msg = {
      role: "assistant",
      content: normalized.text || null
    };
    if (normalized.toolCalls.length > 0) {
      msg.tool_calls = [];
      for (var c = 0; c < normalized.toolCalls.length; c++) {
        var oaiTc = {
          id: normalized.toolCalls[c].id,
          type: "function",
          function: {
            name: normalized.toolCalls[c].name,
            arguments: JSON.stringify(normalized.toolCalls[c].args)
          }
        };
        if (normalized.toolCalls[c].thoughtSignature) {
          oaiTc.thoughtSignature = normalized.toolCalls[c].thoughtSignature;
          oaiTc.extra_content = {
            google: {
              thought_signature: normalized.toolCalls[c].thoughtSignature
            }
          };
        }
        msg.tool_calls.push(oaiTc);
      }
    }
    return {
      id: "chatcmpl_apigee_vertex_" + Date.now(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: msg,
          finish_reason: normalized.openaiFinishReason
        }
      ],
      usage: {
        prompt_tokens: normalized.inputTokens,
        completion_tokens: normalized.outputTokens + normalized.thoughtsTokens,
        total_tokens:
          normalized.inputTokens + normalized.outputTokens + normalized.thoughtsTokens
      }
    };
  } else {
    // vertex_gemini (Google Antigravity)
    var parts = [];
    if (normalized.thoughts && normalized.thoughts.length > 0) {
      for (var gt = 0; gt < normalized.thoughts.length; gt++) {
        var gThought = {
          thought: true,
          text: normalized.thoughts[gt].text || ""
        };
        if (normalized.thoughts[gt].thoughtSignature) {
          gThought.thoughtSignature = normalized.thoughts[gt].thoughtSignature;
        }
        parts.push(gThought);
      }
    }
    if (normalized.text) {
      parts.push({ text: normalized.text });
    }
    for (var g = 0; g < normalized.toolCalls.length; g++) {
      var gFc = {
        functionCall: {
          name: normalized.toolCalls[g].name,
          args: normalized.toolCalls[g].args
        }
      };
      if (normalized.toolCalls[g].thoughtSignature) {
        gFc.thoughtSignature = normalized.toolCalls[g].thoughtSignature;
      }
      parts.push(gFc);
    }
    return {
      candidates: [
        {
          content: {
            role: "model",
            parts: parts
          },
          finishReason: normalized.geminiFinishReason,
          index: 0
        }
      ],
      usageMetadata: {
        promptTokenCount: normalized.inputTokens,
        candidatesTokenCount: normalized.outputTokens,
        thoughtsTokenCount: normalized.thoughtsTokens,
        cachedContentTokenCount: normalized.cachedInputTokens,
        totalTokenCount:
          normalized.inputTokens + normalized.outputTokens + normalized.thoughtsTokens
      },
      modelVersion: modelId
    };
  }
}

/**
 * Fallback parser for buffered SSE responses (`event: ...\ndata: {...}`) when PostFlow
 * receives an entire SSE stream payload in `response.content`.
 */
function parseBackendSseResponse(rawSse, targetFamily) {
  var result = {
    text: "",
    thoughtsText: "",
    toolCalls: [],
    inputTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    stopReason: "end_turn",
    openaiFinishReason: "stop",
    geminiFinishReason: "STOP"
  };
  var lines = String(rawSse || "").split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf("data:") !== 0) continue;
    var dataStr = line.substring(5).trim();
    if (!dataStr || dataStr === "[DONE]") continue;
    try {
      var ev = JSON.parse(dataStr);
      if (ev.usageMetadata) {
        if (ev.usageMetadata.promptTokenCount) {
          result.inputTokens = Number(ev.usageMetadata.promptTokenCount);
        }
        if (ev.usageMetadata.candidatesTokenCount) {
          result.outputTokens = Number(ev.usageMetadata.candidatesTokenCount);
        }
        if (ev.usageMetadata.thoughtsTokenCount) {
          result.thoughtsTokens = Number(ev.usageMetadata.thoughtsTokenCount);
        }
        if (ev.usageMetadata.cachedContentTokenCount) {
          result.cachedInputTokens = Number(ev.usageMetadata.cachedContentTokenCount);
        }
      }
      if (ev.message && ev.message.usage) {
        var msgUncachedIn = Number(ev.message.usage.input_tokens || 0);
        if (ev.message.usage.output_tokens) {
          result.outputTokens = Number(ev.message.usage.output_tokens);
        }
        if (ev.message.usage.cache_read_input_tokens) {
          result.cachedInputTokens = Number(ev.message.usage.cache_read_input_tokens);
        }
        if (ev.message.usage.cache_creation_input_tokens) {
          result.cacheCreationTokens = Number(ev.message.usage.cache_creation_input_tokens);
        }
        if (msgUncachedIn > 0 || result.cachedInputTokens > 0 || result.cacheCreationTokens > 0) {
          result.inputTokens = msgUncachedIn + result.cachedInputTokens + result.cacheCreationTokens;
        }
      }
      if (ev.usage) {
        if (targetFamily === "anthropic") {
          var evAnthUncached =
            ev.usage.input_tokens !== undefined
              ? Number(ev.usage.input_tokens)
              : Math.max(
                  0,
                  result.inputTokens - result.cachedInputTokens - result.cacheCreationTokens
                );
          if (ev.usage.cache_read_input_tokens !== undefined) {
            result.cachedInputTokens = Number(ev.usage.cache_read_input_tokens);
          }
          if (ev.usage.cache_creation_input_tokens !== undefined) {
            result.cacheCreationTokens = Number(ev.usage.cache_creation_input_tokens);
          }
          result.inputTokens =
            evAnthUncached + result.cachedInputTokens + result.cacheCreationTokens;
        } else if (ev.usage.input_tokens || ev.usage.prompt_tokens) {
          result.inputTokens = Number(ev.usage.input_tokens || ev.usage.prompt_tokens);
        }
        if (ev.usage.output_tokens || ev.usage.completion_tokens) {
          result.outputTokens = Number(ev.usage.output_tokens || ev.usage.completion_tokens);
        }
        if (targetFamily !== "anthropic" && ev.usage.cache_read_input_tokens) {
          result.cachedInputTokens = Number(ev.usage.cache_read_input_tokens);
        }
        if (ev.usage.prompt_tokens_details && ev.usage.prompt_tokens_details.cached_tokens) {
          result.cachedInputTokens = Number(ev.usage.prompt_tokens_details.cached_tokens);
        }
      }
      if (ev.response && ev.response.usage) {
        if (ev.response.usage.input_tokens) {
          result.inputTokens = Number(ev.response.usage.input_tokens);
        }
        if (ev.response.usage.output_tokens) {
          result.outputTokens = Number(ev.response.usage.output_tokens);
        }
      }
    } catch (ignoreErr) {}
  }
  return result;
}

function runTransformResponseAndCost(context) {
  if (context.getVariable("ai.isCatalogOrFinopsRequest") === "true") {
    context.setVariable("response.status.code", 200);
    context.setVariable("response.header.Content-Type", "application/json");
    context.setVariable(
      "response.content",
      context.getVariable("ai.directResponseJson") || "{}"
    );
    return;
  }

  var clientProtocol = context.getVariable("client_protocol") || "anthropic_messages";
  var targetFamily =
    context.getVariable("target_model_family") ||
    context.getVariable("ai.targetFamily") ||
    "gemini";
  var targetModelId =
    context.getVariable("target_model_id") ||
    context.getVariable("ai.selectedModel") ||
    "gemini-3.1-pro-preview";
  var vertexModelId =
    context.getVariable("vertex_model_id") || targetModelId;
  var routerTierEarly =
    context.getVariable("target_model_tier") ||
    context.getVariable("ai.selectedTier") ||
    "tier2-daily";
  var routerDecisionEarly =
    context.getVariable("smart_router_decision") ||
    context.getVariable("ai.smartRouterDecision") ||
    context.getVariable("smart_judge_reason") ||
    context.getVariable("ai.smartJudgeReason") ||
    "explicit_model";
  var codingHarnessEarly =
    context.getVariable("coding_harness") ||
    context.getVariable("ai.codingHarness") ||
    context.getVariable("coding_harness_name") ||
    clientProtocol;

  var usedSmartJudgeEarly =
    context.getVariable("ai.useSmartJudge") === "true" ||
    context.getVariable("needs_smart_judge") === "true";
  var routingModeEarly =
    context.getVariable("routing_mode") ||
    context.getVariable("ai.routingMode") ||
    (usedSmartJudgeEarly
      ? "smart_auto"
      : routerTierEarly === "tier3-frontier"
      ? "manual_frontier_pin"
      : "daily_direct");
  var recommendedTierEarly =
    context.getVariable("recommended_tier") ||
    context.getVariable("ai.recommendedTier") ||
    routerTierEarly;
  var recommendedModelEarly =
    context.getVariable("recommended_model") ||
    context.getVariable("ai.recommendedModel") ||
    targetModelId;
  var workloadCategoryEarly =
    context.getVariable("workload_category") ||
    context.getVariable("ai.workloadCategory") ||
    "Feature & Code Editing";
  var projectNameEarly =
    context.getVariable("project_name") ||
    context.getVariable("ai.projectName") ||
    "codingagent-modelrouter";
  var sessionIdEarly =
    context.getVariable("session_id") ||
    context.getVariable("ai.sessionId") ||
    "sess_default";
  var gatewayReqIdEarly =
    context.getVariable("ai.gatewayRequestId") ||
    "req_" + Date.now().toString(36);
  var traceIdEarly = context.getVariable("ai.traceId") || "";
  var gatewayKeyNameEarly =
    context.getVariable("ai.gatewayKeyName") ||
    context.getVariable("gateway_key_name") ||
    "default-gateway-key";
  var credentialTypeEarly =
    context.getVariable("ai.credentialType") ||
    context.getVariable("credential_type") ||
    "user_key";
  var ingestionModeEarly =
    context.getVariable("ai.finopsIngestionMode") || "USAGE";
  var envNameEarly = context.getVariable("ai.environment") || "production";

  // Always emit routing attribution & transparency headers even on SSE streaming responses
  context.setVariable("response.header.x-vertex-ai-model", String(vertexModelId));
  context.setVariable("response.header.X-Vertex-Target-Model", String(targetModelId));
  context.setVariable("response.header.x-routed-model", String(targetModelId));
  context.setVariable("response.header.X-Routed-Model", String(targetModelId));
  context.setVariable("response.header.x-switchyard-model", String(targetModelId));
  context.setVariable("response.header.X-Vertex-Model-Endpoint-Id", String(vertexModelId));
  context.setVariable("response.header.X-Vertex-Target-Family", String(targetFamily));
  context.setVariable("response.header.X-Vertex-Target-Tier", String(routerTierEarly));
  context.setVariable("response.header.x-smart-router-tier", String(routerTierEarly));
  context.setVariable("response.header.x-routing-tier", String(routerTierEarly));
  context.setVariable("response.header.X-Routing-Tier", String(routerTierEarly));
  context.setVariable("response.header.X-Smart-Router-Decision", String(routerDecisionEarly));
  context.setVariable("response.header.x-routing-reason", String(routerDecisionEarly));
  context.setVariable("response.header.X-Routing-Reason", String(routerDecisionEarly));
  context.setVariable("response.header.x-coding-harness", String(codingHarnessEarly));
  context.setVariable("response.header.X-Coding-Harness", String(codingHarnessEarly));
  context.setVariable("response.header.X-Gateway-Routing-Mode", String(routingModeEarly));
  context.setVariable("response.header.X-Gateway-Recommended-Tier", String(recommendedTierEarly));
  context.setVariable("response.header.X-Gateway-Recommended-Model", String(recommendedModelEarly));
  context.setVariable("response.header.X-Gateway-Workload-Category", String(workloadCategoryEarly));
  context.setVariable("response.header.X-Gateway-Session-ID", String(sessionIdEarly));
  context.setVariable("response.header.X-Gateway-Project", String(projectNameEarly));
  context.setVariable("response.header.X-Gateway-Request-ID", String(gatewayReqIdEarly));
  if (traceIdEarly) {
    context.setVariable("response.header.X-Gateway-Trace-ID", String(traceIdEarly));
  }
  context.setVariable("response.header.X-Gateway-Key-Name", String(gatewayKeyNameEarly));
  context.setVariable("response.header.X-Gateway-Credential-Type", String(credentialTypeEarly));
  context.setVariable("response.header.X-Gateway-Ingestion-Mode", String(ingestionModeEarly));
  context.setVariable("response.header.X-Gateway-Environment", String(envNameEarly));

  // Smart Router classifier attribution. Only set when `model: auto` ran the router:
  //   X-Router-Classifier      rules | custom | decisions | gemini | length-fallback
  //   X-Router-Classifier-Ms   time the classifier callout added inside the gateway (0 = none
  //                            made). Absent when the proxy has no JS-PrepareSmartJudge step,
  //                            because nothing timed the callout.
  var routerClassifierEarly = context.getVariable("ai.routerClassifier") || "";
  if (routerClassifierEarly) {
    context.setVariable("response.header.X-Router-Classifier", String(routerClassifierEarly));
    var routerClassifierMsEarly = context.getVariable("ai.routerClassifierMs");
    if (routerClassifierMsEarly !== null && routerClassifierMsEarly !== undefined && String(routerClassifierMsEarly) !== "") {
      context.setVariable(
        "response.header.X-Router-Classifier-Ms",
        String(routerClassifierMsEarly)
      );
    }
    var routerClassifierModelEarly = context.getVariable("ai.routerClassifierModel") || "";
    if (routerClassifierModelEarly) {
      context.setVariable(
        "response.header.X-Router-Classifier-Model",
        String(routerClassifierModelEarly)
      );
    }
    var routerClassifierConfidenceEarly =
      context.getVariable("ai.routerClassifierConfidence") || "";
    if (routerClassifierConfidenceEarly) {
      context.setVariable(
        "response.header.X-Router-Classifier-Confidence",
        String(routerClassifierConfidenceEarly)
      );
    }
  }

  var fundingPoolEarly =
    targetFamily === "gemini" || targetFamily === "gemini_decisions"
      ? "ANTIGRAVITY_GEMINI_CREDITS"
      : "GCP_COMMIT_FSP_DISCOUNT";
  context.setVariable("response.header.x-vertex-funding-pool", String(fundingPoolEarly));
  context.setVariable("ai.fundingPool", fundingPoolEarly);
  context.setVariable("ai.codingHarness", String(codingHarnessEarly));
  context.setVariable("ai.targetVertexModel", String(vertexModelId));
  context.setVariable("ai.routedModel", String(targetModelId));
  context.setVariable("ai.routingTier", String(routerTierEarly));

  var isStreaming =
    context.getVariable("is_streaming") === "true" ||
    context.getVariable("ai.isStreaming") === "true";
  var rawResp = context.getVariable("response.content") || "";
  if (!rawResp) {
    rawResp = "{}";
  }

  var parsedResp = {};
  var isSsePayload = false;
  var sseNormalized = null;
  try {
    parsedResp = JSON.parse(rawResp);
  } catch (e) {
    if (rawResp.indexOf("data:") !== -1) {
      isSsePayload = true;
      sseNormalized = parseBackendSseResponse(rawResp, targetFamily);
    } else if (!isStreaming) {
      return;
    }
  }

  var isCountTokens =
    context.getVariable("is_count_tokens") === "true" ||
    context.getVariable("ai.isCountTokens") === "true";

  if (isCountTokens) {
    var countVal = Number(
      parsedResp.input_tokens || parsedResp.totalTokens || 0
    );
    if (clientProtocol === "anthropic_messages") {
      context.setVariable(
        "response.content",
        JSON.stringify({ input_tokens: countVal })
      );
    } else if (clientProtocol === "vertex_gemini") {
      context.setVariable(
        "response.content",
        JSON.stringify({ totalTokens: countVal })
      );
    }
    context.setVariable("ai.totalTokenCount", "0");
    return;
  }

  var inputCostPer1M = parseFloat(context.getVariable("model_input_cost_1m") || "2.00");
  var outputCostPer1M = parseFloat(context.getVariable("model_output_cost_1m") || "12.00");

  var normalized = isSsePayload
    ? sseNormalized
    : parseBackendUnaryResponse(parsedResp, targetFamily);
  if (isStreaming && normalized.inputTokens === 0 && normalized.outputTokens === 0) {
    var existingIn = parseInt(context.getVariable("ai.inputTokens") || "0", 10);
    var existingOut = parseInt(context.getVariable("ai.outputTokens") || "0", 10);
    var promptText = String(
      context.getVariable("ai.extractedPrompt") ||
        context.getVariable("extracted_prompt") ||
        ""
    );
    normalized.inputTokens =
      existingIn > 0 ? existingIn : Math.max(25, Math.ceil(promptText.length / 4));
    normalized.outputTokens = existingOut > 0 ? existingOut : 75;
  }
  // Gemini 2.5/3 thoughtsTokenCount is billed at the output token rate.
  // Cached input tokens are billed at 10% for Anthropic and 25% for Gemini.
  var cacheReadDiscount = targetFamily === "anthropic" ? 0.10 : 0.25;
  var billableOutputTokens = normalized.outputTokens + normalized.thoughtsTokens;
  var uncachedInputTokens = Math.max(
    0,
    normalized.inputTokens - normalized.cachedInputTokens - normalized.cacheCreationTokens
  );
  var totalTokens = normalized.inputTokens + billableOutputTokens;
  var estimatedCostUsd =
    (uncachedInputTokens / 1000000.0) * inputCostPer1M +
    (normalized.cachedInputTokens / 1000000.0) * (inputCostPer1M * cacheReadDiscount) +
    (normalized.cacheCreationTokens / 1000000.0) * (inputCostPer1M * 1.25) +
    (billableOutputTokens / 1000000.0) * outputCostPer1M;

  // Counterfactual Frontier Baseline: what this exact call would cost on unrouted Claude Opus 4.7 ($15/$75 per 1M)
  var frontierBaselineCostUsd =
    (uncachedInputTokens / 1000000.0) * 15.0 +
    (normalized.cachedInputTokens / 1000000.0) * (15.0 * 0.10) +
    (normalized.cacheCreationTokens / 1000000.0) * (15.0 * 1.25) +
    (billableOutputTokens / 1000000.0) * 75.0;
  var routingSavingsUsd = Math.max(0.0, frontierBaselineCostUsd - estimatedCostUsd);
  var routingSavingsPct =
    frontierBaselineCostUsd > 0
      ? ((routingSavingsUsd / frontierBaselineCostUsd) * 100.0).toFixed(1)
      : "0.0";
  var fundingPool =
    targetFamily === "gemini" || targetFamily === "gemini_decisions"
      ? "ANTIGRAVITY_GEMINI_CREDITS"
      : "GCP_COMMIT_FSP_DISCOUNT";
  var fspDiscountPct = parseFloat(context.getVariable("org_fsp_discount_pct") || "15.0");
  if (isNaN(fspDiscountPct) || fspDiscountPct < 0) fspDiscountPct = 15.0;
  if (fspDiscountPct > 100.0) fspDiscountPct = 100.0;
  var netCashCostUsd =
    fundingPool === "ANTIGRAVITY_GEMINI_CREDITS"
      ? 0.0
      : estimatedCostUsd * Math.max(0.0, 1.0 - fspDiscountPct / 100.0);
  var totalNetSavingsUsd = Math.max(0.0, frontierBaselineCostUsd - netCashCostUsd);

  var reqStartMs = parseInt(context.getVariable("ai.requestStartMs") || "0", 10);
  var totalLatencyMs = reqStartMs > 0 ? Math.max(1, Date.now() - reqStartMs) : 1;
  var existingTtft = parseInt(context.getVariable("ai.ttftMs") || "0", 10);
  var ttftMs = existingTtft > 0 ? existingTtft : totalLatencyMs;

  var cacheHitRatePct =
    normalized.inputTokens > 0
      ? ((normalized.cachedInputTokens / normalized.inputTokens) * 100.0).toFixed(1)
      : "0.0";
  var usedSmartJudge =
    context.getVariable("ai.useSmartJudge") === "true" ||
    context.getVariable("needs_smart_judge") === "true";
  var routerCostUsd = usedSmartJudge ? 0.000018 : 0.0;

  var routerTier =
    context.getVariable("target_model_tier") ||
    context.getVariable("ai.selectedTier") ||
    "tier2-daily";
  var routingMode =
    context.getVariable("routing_mode") ||
    context.getVariable("ai.routingMode") ||
    (usedSmartJudge ? "smart_auto" : routerTier === "tier3-frontier" ? "manual_frontier_pin" : "daily_direct");
  var recommendedTier =
    context.getVariable("recommended_tier") ||
    context.getVariable("ai.recommendedTier") ||
    routerTier;
  var recommendedModel =
    context.getVariable("recommended_model") ||
    context.getVariable("ai.recommendedModel") ||
    targetModelId;
  var recommendedInRate = parseFloat(context.getVariable("recommended_in_rate") || "1.25");
  var recommendedOutRate = parseFloat(context.getVariable("recommended_out_rate") || "10.0");
  var recommendedCostUsd =
    (uncachedInputTokens / 1000000.0) * recommendedInRate +
    (normalized.cachedInputTokens / 1000000.0) * (recommendedInRate * 0.25) +
    (normalized.cacheCreationTokens / 1000000.0) * (recommendedInRate * 1.25) +
    (billableOutputTokens / 1000000.0) * recommendedOutRate;

  var isFrontierOverkill =
    routingMode === "manual_frontier_pin" &&
    routerTier === "tier3-frontier" &&
    recommendedTier !== "tier3-frontier";
  var avoidableFrontierSpendUsd = isFrontierOverkill
    ? Math.max(0.0, estimatedCostUsd - recommendedCostUsd)
    : 0.0;
  var workloadCategory =
    context.getVariable("workload_category") ||
    context.getVariable("ai.workloadCategory") ||
    "Feature & Code Editing";
  var projectName =
    context.getVariable("project_name") ||
    context.getVariable("ai.projectName") ||
    "codingagent-modelrouter";
  var sessionId =
    context.getVariable("session_id") ||
    context.getVariable("ai.sessionId") ||
    "sess_default";

  // Flat flow variables
  context.setVariable("prompt_token_count", String(normalized.inputTokens));
  context.setVariable("candidate_token_count", String(normalized.outputTokens));
  context.setVariable("thoughts_token_count", String(normalized.thoughtsTokens));
  context.setVariable("cached_token_count", String(normalized.cachedInputTokens));
  context.setVariable("cache_creation_token_count", String(normalized.cacheCreationTokens));
  context.setVariable("cache_hit_rate_pct", cacheHitRatePct);
  context.setVariable("total_token_count", String(totalTokens));
  context.setVariable("response_text_for_armor", normalized.text.slice(0, 4000));
  context.setVariable("estimated_cost_usd", estimatedCostUsd.toFixed(6));
  context.setVariable("net_cash_cost_usd", netCashCostUsd.toFixed(6));
  context.setVariable("total_net_savings_usd", totalNetSavingsUsd.toFixed(6));
  context.setVariable("router_cost_usd", routerCostUsd.toFixed(6));
  context.setVariable("frontier_baseline_cost_usd", frontierBaselineCostUsd.toFixed(6));
  context.setVariable("routing_savings_usd", routingSavingsUsd.toFixed(6));
  context.setVariable("routing_savings_pct", routingSavingsPct);
  context.setVariable("avoidable_frontier_spend_usd", avoidableFrontierSpendUsd.toFixed(6));
  context.setVariable("is_frontier_overkill", isFrontierOverkill ? "true" : "false");
  context.setVariable("funding_pool", fundingPool);
  context.setVariable("total_latency_ms", String(totalLatencyMs));
  context.setVariable("ttft_ms", String(ttftMs));

  // Dot-scoped flow variables for Apigee YAML policies (LLMTokenQuota, DataCapture, Model Armor)
  context.setVariable("ai.inputTokens", String(normalized.inputTokens));
  context.setVariable("ai.promptTokenCount", String(normalized.inputTokens));
  context.setVariable("ai.outputTokens", String(billableOutputTokens));
  context.setVariable("ai.completionTokenCount", String(billableOutputTokens));
  context.setVariable("ai.thoughtsTokens", String(normalized.thoughtsTokens));
  context.setVariable("ai.cachedTokens", String(normalized.cachedInputTokens));
  context.setVariable("ai.cacheCreationTokens", String(normalized.cacheCreationTokens));
  context.setVariable("ai.cacheHitRatePct", cacheHitRatePct);
  if (!isStreaming || isSsePayload) {
    context.setVariable("ai.totalTokenCount", String(totalTokens));
  }
  context.setVariable("ai.responseText", normalized.text.slice(0, 4000));
  context.setVariable("ai.extractedResponseText", normalized.text.slice(0, 4000));
  context.setVariable("ai.estimatedCostUsd", estimatedCostUsd.toFixed(6));
  context.setVariable("ai.netCashCostUsd", netCashCostUsd.toFixed(6));
  context.setVariable("ai.totalNetSavingsUsd", totalNetSavingsUsd.toFixed(6));
  context.setVariable("ai.routerCostUsd", routerCostUsd.toFixed(6));
  context.setVariable("ai.frontierBaselineCostUsd", frontierBaselineCostUsd.toFixed(6));
  context.setVariable("ai.routingSavingsUsd", routingSavingsUsd.toFixed(6));
  context.setVariable("ai.routingSavingsPct", routingSavingsPct);
  context.setVariable("ai.avoidableFrontierSpendUsd", avoidableFrontierSpendUsd.toFixed(6));
  context.setVariable("ai.isFrontierOverkill", isFrontierOverkill ? "true" : "false");
  context.setVariable("ai.fundingPool", fundingPool);
  context.setVariable("ai.routingMode", routingMode);
  context.setVariable("ai.recommendedTier", recommendedTier);
  context.setVariable("ai.recommendedModel", recommendedModel);
  context.setVariable("ai.workloadCategory", workloadCategory);
  context.setVariable("ai.projectName", projectName);
  context.setVariable("ai.sessionId", sessionId);
  context.setVariable("ai.totalLatencyMs", String(totalLatencyMs));
  context.setVariable("ai.ttftMs", String(ttftMs));

  // FinOps DataCapture attribution variables (APG-9)
  var devEmail =
    context.getVariable("developer_email") ||
    context.getVariable("ai.developerEmail") ||
    context.getVariable("developer.email") ||
    context.getVariable("verifyapikey.VA-VerifyApiKey.developer.email") ||
    context.getVariable("auth.oidc_email") ||
    "unknown@enterprise.internal";
  var teamName =
    context.getVariable("ai.teamName") ||
    context.getVariable("request.header.x-team-name") ||
    context.getVariable("verifyapikey.VA-VerifyApiKey.developer.team_name") ||
    context.getVariable("verifyapikey.VA-VerifyApiKey.developer.attribute.team") ||
    "platform-engineering";
  var costCenter =
    context.getVariable("ai.costCenter") ||
    context.getVariable("request.header.x-cost-center") ||
    context.getVariable("verifyapikey.VA-VerifyApiKey.developer.cost_center") ||
    context.getVariable("verifyapikey.VA-VerifyApiKey.developer.attribute.cost_center") ||
    "CC-1000";
  var codingHarness =
    context.getVariable("coding_harness") ||
    context.getVariable("ai.codingHarness") ||
    context.getVariable("coding_harness_name") ||
    clientProtocol;

  var physicalModel =
    context.getVariable("ai.physical_model") ||
    vertexModelId;
  context.setVariable("ai.developerEmail", devEmail);
  context.setVariable("ai.teamName", teamName);
  context.setVariable("ai.costCenter", costCenter);
  context.setVariable("ai.codingHarness", codingHarness);
  context.setVariable("ai.targetVertexModel", vertexModelId);
  context.setVariable("ai.physicalModel", physicalModel);
  context.setVariable("ai.physical_model", physicalModel);

  var routerDecision =
    context.getVariable("smart_router_decision") ||
    context.getVariable("ai.smartRouterDecision") ||
    context.getVariable("smart_judge_reason") ||
    context.getVariable("ai.smartJudgeReason") ||
    "explicit_model";
  var isRouterOverride =
    context.getVariable("ai.isRouterOverride") === "true" || Boolean(isFrontierOverkill);
  var budgetAction = context.getVariable("ai.budgetAction") || "within_budget";
  var budgetWarning = context.getVariable("ai.budgetWarning") || "";
  var budgetDowngraded = context.getVariable("ai.budgetDowngraded") === "true";

  var gatewayKeyName =
    context.getVariable("ai.gatewayKeyName") ||
    context.getVariable("gateway_key_name") ||
    "default-gateway-key";
  var credentialType =
    context.getVariable("ai.credentialType") ||
    context.getVariable("credential_type") ||
    "user_key";
  var userIdSource =
    context.getVariable("ai.userIdSource") ||
    context.getVariable("user_id_source") ||
    "api_key_owner";
  var ingestionMode = context.getVariable("ai.finopsIngestionMode") || "USAGE";
  var envName = context.getVariable("ai.environment") || "production";
  var tagsCsv = context.getVariable("ai.tags") || "";
  var traceId = context.getVariable("ai.traceId") || "";
  var spanId = context.getVariable("ai.spanId") || "";
  var gatewayReqId =
    context.getVariable("ai.gatewayRequestId") ||
    "req_" + Date.now().toString(36);
  var gcpProjectId =
    context.getVariable("gcp_project_id") ||
    context.getVariable("organization.name") ||
    "";

  context.setVariable("ai.gatewayKeyName", gatewayKeyName);
  context.setVariable("ai.credentialType", credentialType);
  context.setVariable("ai.userIdSource", userIdSource);
  context.setVariable("ai.finopsIngestionMode", ingestionMode);

  // Only populate ai.finopsLogPayload on unary or buffered SSE; live SSE streaming populates
  // ai.finopsLogPayload in EventFlow (JS-TransformStreamEvent) with exact accumulated chunk usage.
  if (!isStreaming || isSsePayload) {
    if (ingestionMode === "NONE") {
      // Privacy NONE mode: enforce auth, routing, and <LLMTokenQuota> rate limits,
      // while omitting all FinOps log telemetry.
      context.setVariable("ai.finopsLogPayload", "");
    } else {
      // null (not 0) when no JS-PrepareSmartJudge step timed the classifier callout.
      var routerClassifierMsRaw = context.getVariable("ai.routerClassifierMs");
      var routerClassifierMsLog =
        routerClassifierMsRaw === null ||
        routerClassifierMsRaw === undefined ||
        String(routerClassifierMsRaw) === ""
          ? null
          : Number(routerClassifierMsRaw);
      var finopsLogEntry = {
        event_type: "ai_router_finops_turn",
        timestamp: new Date().toISOString(),
        gateway_request_id: String(gatewayReqId),
        trace_id: String(traceId),
        span_id: String(spanId),
        developer_email: String(devEmail),
        quota_owner_id: String(
          context.getVariable("quota_owner_id") ||
            context.getVariable("auth.developer_email") ||
            devEmail
        ),
        gateway_key_name: String(gatewayKeyName),
        credential_type: String(credentialType),
        user_id_source: String(userIdSource),
        ingestion_mode: String(ingestionMode),
        environment: String(envName),
        tags: tagsCsv ? String(tagsCsv).split(",") : [],
        team_name: String(teamName),
        cost_center: String(costCenter),
        coding_harness: String(codingHarness),
        client_protocol: String(clientProtocol),
        project_name: String(projectName),
        session_id: String(sessionId),
        workload_category: String(workloadCategory),
        routing_mode: String(routingMode),
        requested_model: String(
          context.getVariable("ai.clientRequestedModel") ||
            context.getVariable("requested_model") ||
            targetModelId
        ),
        routed_model: String(targetModelId),
        vertex_model_id: String(vertexModelId),
        physical_model_id: String(physicalModel),
        model_family: String(targetFamily),
        model_tier: String(routerTier),
        actual_tier: String(routerTier),
        recommended_tier: String(recommendedTier),
        recommended_model: String(recommendedModel),
        is_frontier_overkill: Boolean(isFrontierOverkill),
        is_router_override: Boolean(isRouterOverride),
        is_subagent: context.getVariable("ai.isSubagent") === "true",
        fallback_triggered: context.getVariable("vertex_fallback_triggered") === "true",
        budget_action: String(budgetAction),
        smart_router_decision: String(routerDecision),
        router_classifier: String(context.getVariable("ai.routerClassifier") || ""),
        router_classifier_model: String(context.getVariable("ai.routerClassifierModel") || ""),
        router_classifier_confidence: String(
          context.getVariable("ai.routerClassifierConfidence") || ""
        ),
        router_classifier_ms: routerClassifierMsLog,
        router_classifier_input_tokens: parseInt(
          context.getVariable("ai.routerClassifierInputTokens") || "0",
          10
        ) || 0,
        router_classifier_cost_usd: parseFloat(
          context.getVariable("ai.routerClassifierCostUsd") || "0"
        ) || 0,
        funding_pool: String(fundingPool),
        ttft_ms: Number(ttftMs),
        total_latency_ms: Number(totalLatencyMs),
        input_tokens: Number(normalized.inputTokens),
        output_tokens: Number(billableOutputTokens),
        cached_tokens: Number(normalized.cachedInputTokens),
        cache_creation_tokens: Number(normalized.cacheCreationTokens),
        thoughts_tokens: Number(normalized.thoughtsTokens),
        total_tokens: Number(totalTokens),
        cache_hit_rate_pct: parseFloat(cacheHitRatePct),
        actual_cost_usd: parseFloat(estimatedCostUsd.toFixed(6)),
        net_cash_cost_usd: parseFloat(netCashCostUsd.toFixed(6)),
        total_net_savings_usd: parseFloat(totalNetSavingsUsd.toFixed(6)),
        router_cost_usd: parseFloat(routerCostUsd.toFixed(6)),
        frontier_baseline_cost_usd: parseFloat(frontierBaselineCostUsd.toFixed(6)),
        routing_savings_usd: parseFloat(routingSavingsUsd.toFixed(6)),
        avoidable_frontier_spend_usd: parseFloat(avoidableFrontierSpendUsd.toFixed(6))
      };
      if (gcpProjectId && traceId) {
        finopsLogEntry["logging.googleapis.com/trace"] =
          "projects/" + String(gcpProjectId) + "/traces/" + String(traceId);
        if (spanId) {
          finopsLogEntry["logging.googleapis.com/spanId"] = String(spanId);
        }
        finopsLogEntry["logging.googleapis.com/trace_sampled"] = true;
      }
      if (ingestionMode === "FULL") {
        var toolNames = [];
        if (normalized.toolCalls && normalized.toolCalls.length > 0) {
          for (var tni = 0; tni < normalized.toolCalls.length && tni < 10; tni++) {
            if (normalized.toolCalls[tni] && normalized.toolCalls[tni].name) {
              toolNames.push(String(normalized.toolCalls[tni].name));
            }
          }
        }
        finopsLogEntry.trace_payload = {
          prompt_preview: String(
            context.getVariable("ai.latestUserPrompt") ||
              context.getVariable("prompt_text_for_armor") ||
              ""
          ).slice(0, 2000),
          response_preview: String(normalized.text || "").slice(0, 2000),
          tool_call_names: toolNames
        };
      }
      context.setVariable("ai.finopsLogPayload", JSON.stringify(finopsLogEntry));
    }
  }

  context.setVariable("response.header.x-vertex-ai-model", String(vertexModelId));
  context.setVariable("response.header.X-Vertex-Target-Model", String(targetModelId));
  context.setVariable("response.header.x-routed-model", String(targetModelId));
  context.setVariable("response.header.X-Routed-Model", String(targetModelId));
  context.setVariable("response.header.x-switchyard-model", String(targetModelId));
  context.setVariable("response.header.X-Vertex-Model-Endpoint-Id", String(vertexModelId));
  context.setVariable("response.header.X-Vertex-Target-Family", String(targetFamily));
  context.setVariable("response.header.X-Vertex-Target-Tier", String(routerTier));
  context.setVariable("response.header.x-smart-router-tier", String(routerTier));
  context.setVariable("response.header.x-routing-tier", String(routerTier));
  context.setVariable("response.header.X-Routing-Tier", String(routerTier));
  context.setVariable("response.header.X-Smart-Router-Decision", String(routerDecision));
  context.setVariable("response.header.x-routing-reason", String(routerDecision));
  context.setVariable("response.header.X-Routing-Reason", String(routerDecision));
  context.setVariable("response.header.x-coding-harness", String(codingHarness));
  context.setVariable("response.header.X-Coding-Harness", String(codingHarness));
  context.setVariable("response.header.x-vertex-funding-pool", String(fundingPool));
  context.setVariable("response.header.X-Estimated-Cost-USD", estimatedCostUsd.toFixed(6));
  context.setVariable("response.header.X-Net-Cash-Cost-USD", netCashCostUsd.toFixed(6));
  context.setVariable("response.header.X-Frontier-Baseline-Cost-USD", frontierBaselineCostUsd.toFixed(6));
  context.setVariable("response.header.X-Routing-Savings-USD", routingSavingsUsd.toFixed(6));
  context.setVariable("response.header.X-Routing-Savings-Pct", routingSavingsPct + "%");
  context.setVariable("response.header.X-Gateway-Routing-Mode", String(routingMode));
  context.setVariable("response.header.X-Gateway-Recommended-Tier", String(recommendedTier));
  context.setVariable("response.header.X-Gateway-Recommended-Model", String(recommendedModel));
  context.setVariable("response.header.X-Gateway-Avoidable-Spend-USD", avoidableFrontierSpendUsd.toFixed(6));
  context.setVariable("response.header.X-Gateway-Workload-Category", String(workloadCategory));
  context.setVariable("response.header.X-Gateway-Cache-Hit-Rate", cacheHitRatePct + "%");
  context.setVariable("response.header.X-Gateway-Session-ID", String(sessionId));
  context.setVariable("response.header.X-Gateway-Project", String(projectName));
  context.setVariable("response.header.X-Gateway-Router-Override", isRouterOverride ? "true" : "false");
  context.setVariable("response.header.X-Gateway-Request-ID", String(gatewayReqId));
  if (traceId) {
    context.setVariable("response.header.X-Gateway-Trace-ID", String(traceId));
  }
  context.setVariable("response.header.X-Gateway-Key-Name", String(gatewayKeyName));
  context.setVariable("response.header.X-Gateway-Credential-Type", String(credentialType));
  context.setVariable("response.header.X-Gateway-Ingestion-Mode", String(ingestionMode));
  context.setVariable("response.header.X-Gateway-Environment", String(envName));
  context.setVariable("response.header.X-Gateway-Latency-Ms", String(totalLatencyMs));
  context.setVariable("response.header.X-Gateway-TTFT-Ms", String(ttftMs));
  if (budgetWarning) {
    context.setVariable("response.header.X-Switchyard-Budget-Warning", String(budgetWarning));
  }
  if (budgetDowngraded) {
    context.setVariable("response.header.X-Switchyard-Budget-Downgraded", "true");
  }
  context.setVariable("response.header.x-finops-estimated-cost-usd", estimatedCostUsd.toFixed(6));
  context.setVariable("response.header.x-finops-baseline-opus-usd", frontierBaselineCostUsd.toFixed(6));
  context.setVariable(
    "response.header.x-finops-saved-vs-opus-usd",
    routingSavingsUsd.toFixed(6) + " (" + routingSavingsPct + "%)"
  );

  // Ensure request.content contains $.model so Apigee X's <LLMTokenQuota> (LTQ-CountTokensUnary)
  // can resolve {jsonPath('$.model',request.content,true)} in PostFlow Response
  context.setVariable(
    "request.content",
    JSON.stringify({ model: String(vertexModelId || targetModelId || "gemini-3-flash-preview") })
  );

  // Native passthrough when client protocol matches backend model family directly,
  // or when SSE streaming is active (handled chunk-by-chunk by EventFlow JS-TransformStreamEvent)
  if (
    isStreaming ||
    isSsePayload ||
    (clientProtocol === "vertex_gemini" && targetFamily === "gemini") ||
    (clientProtocol === "anthropic_messages" && targetFamily === "anthropic") ||
    (clientProtocol === "gemini_decisions" && targetFamily === "gemini_decisions")
  ) {
    return;
  }

  if (normalized && normalized.text && normalized.text.indexOf("Vertex Smart Router") !== -1) {
    normalized.text = normalized.text.replace(
      /\n*(?:---\s*\n+)?⚡\s*\*{0,2}Vertex Smart Router[\s\S]*$/g,
      ""
    );
  }
  var autoRouteBadge =
    context.getVariable("ai.autoRouteBadge") === "true"
      ? context.getVariable("ai.smartRouterBadge") || ""
      : "";
  if (
    autoRouteBadge &&
    clientProtocol === "openai_responses" &&
    normalized &&
    (!normalized.toolCalls || normalized.toolCalls.length === 0) &&
    normalized.text
  ) {
    normalized.text = normalized.text + "\n\n" + autoRouteBadge;
  }

  var clientPayload = formatForClientProtocol(normalized, clientProtocol, targetModelId);
  if (typeof context.removeVariable === "function") {
    context.removeVariable("response.header.Content-Encoding");
    context.removeVariable("response.header.content-encoding");
  }
  context.setVariable("response.content", JSON.stringify(clientPayload));
}

if (typeof context !== "undefined") {
  runTransformResponseAndCost(context);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    encodeBase64Url: encodeBase64Url,
    parseBackendUnaryResponse: parseBackendUnaryResponse,
    parseBackendSseResponse: parseBackendSseResponse,
    formatForClientProtocol: formatForClientProtocol,
    runTransformResponseAndCost: runTransformResponseAndCost
  };
}
