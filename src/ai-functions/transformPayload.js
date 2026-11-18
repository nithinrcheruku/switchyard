/**
 * transformPayload.js
 * Translates incoming coding-agent payloads from any of the supported harnesses:
 *   - Claude Code: Anthropic Messages API (POST /v1/messages)
 *   - Google Antigravity:
 *       * Vertex Gemini API (POST /v1beta/models/{model}:{action} or /v1beta1/...)
 *       * OpenAI Chat Completions API (POST /v1/chat/completions)
 *   - OpenAI Codex CLI / Desktop:
 *       * OpenAI Responses API (POST /v1/responses)
 *       * OpenAI Chat Completions API (POST /v1/chat/completions)
 * into the target Vertex AI Model Garden backend wire format:
 *   1. "gemini"       -> Vertex Gemini generateContent / streamGenerateContent
 *   2. "anthropic"    -> Vertex Anthropic rawPredict / streamRawPredict (vertex-2023-10-16)
 *   3. "openapi_maas" -> Vertex OpenAI-compatible MaaS (/endpoints/openapi/chat/completions)
 */

// Shared in-memory registry for Gemini 3 thoughtSignatures and tool call ID -> function name mapping
// when a cross-protocol client (e.g. Claude Code or Codex) strips unknown fields from tool_use blocks.
var GLOBAL_THOUGHT_SIGNATURES =
  (typeof globalThis !== "undefined" && globalThis.__AGY_THOUGHT_SIGNATURES__) || {};
var GLOBAL_TOOL_ID_TO_NAME =
  (typeof globalThis !== "undefined" && globalThis.__AGY_TOOL_ID_TO_NAME__) || {};
if (typeof globalThis !== "undefined") {
  globalThis.__AGY_THOUGHT_SIGNATURES__ = GLOBAL_THOUGHT_SIGNATURES;
  globalThis.__AGY_TOOL_ID_TO_NAME__ = GLOBAL_TOOL_ID_TO_NAME;
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

var B64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8ToBytes(str) {
  var bytes = [];
  var s = String(str);
  for (var i = 0; i < s.length; i++) {
    var code = s.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      var next = s.charCodeAt(++i);
      var cp = 0x10000 + (((code & 0x3ff) << 10) | (next & 0x3ff));
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      );
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

function bytesToUtf8(bytes) {
  var out = "";
  var i = 0;
  while (i < bytes.length) {
    var b1 = bytes[i++];
    if (b1 < 0x80) {
      out += String.fromCharCode(b1);
    } else if ((b1 & 0xe0) === 0xc0 && i < bytes.length) {
      var b2 = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
    } else if ((b1 & 0xf0) === 0xe0 && i + 1 < bytes.length) {
      var b2e = bytes[i++] & 0x3f;
      var b3e = bytes[i++] & 0x3f;
      out += String.fromCharCode(((b1 & 0x0f) << 12) | (b2e << 6) | b3e);
    } else if ((b1 & 0xf8) === 0xf0 && i + 2 < bytes.length) {
      var b2f = bytes[i++] & 0x3f;
      var b3f = bytes[i++] & 0x3f;
      var b4f = bytes[i++] & 0x3f;
      var cp = ((b1 & 0x07) << 18) | (b2f << 12) | (b3f << 6) | b4f;
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(b1);
    }
  }
  return out;
}

function encodeBase64Url(str) {
  if (!str) return "";
  var bytes = utf8ToBytes(str);
  var out = "";
  for (var i = 0; i < bytes.length; i += 3) {
    var b1 = bytes[i];
    var has2 = i + 1 < bytes.length;
    var b2 = has2 ? bytes[i + 1] : 0;
    var has3 = i + 2 < bytes.length;
    var b3 = has3 ? bytes[i + 2] : 0;
    out += B64URL_ALPHABET.charAt(b1 >> 2);
    out += B64URL_ALPHABET.charAt(((b1 & 0x03) << 4) | (b2 >> 4));
    if (has2) {
      out += B64URL_ALPHABET.charAt(((b2 & 0x0f) << 2) | (b3 >> 6));
    }
    if (has3) {
      out += B64URL_ALPHABET.charAt(b3 & 0x3f);
    }
  }
  return out;
}

function decodeBase64Url(b64u) {
  if (!b64u) return "";
  var clean = String(b64u)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  var bytes = [];
  var i = 0;
  while (i < clean.length) {
    var e1 = B64URL_ALPHABET.indexOf(clean.charAt(i++));
    var e2 = i < clean.length ? B64URL_ALPHABET.indexOf(clean.charAt(i++)) : -1;
    var e3 = i < clean.length ? B64URL_ALPHABET.indexOf(clean.charAt(i++)) : -1;
    var e4 = i < clean.length ? B64URL_ALPHABET.indexOf(clean.charAt(i++)) : -1;
    if (e1 < 0 || e2 < 0) break;
    bytes.push((e1 << 2) | (e2 >> 4));
    if (e3 >= 0) {
      bytes.push(((e2 & 15) << 4) | (e3 >> 2));
      if (e4 >= 0) {
        bytes.push(((e3 & 3) << 6) | e4);
      }
    }
  }
  return bytesToUtf8(bytes);
}

function recordToolMetadata(callId, fnName, thoughtSignature) {
  if (callId && fnName) {
    GLOBAL_TOOL_ID_TO_NAME[callId] = fnName;
    trimMapSize(GLOBAL_TOOL_ID_TO_NAME);
  }
  if (callId && thoughtSignature) {
    GLOBAL_THOUGHT_SIGNATURES[callId] = thoughtSignature;
    trimMapSize(GLOBAL_THOUGHT_SIGNATURES);
  }
}

function lookupThoughtSignature(callId, fnName, explicitSig) {
  if (explicitSig) return explicitSig;
  // Support inline signature encoded in synthetic tool call ID: toolu_vrtx_<ts>__sig_<b64u>
  if (callId && callId.indexOf("__sig_") !== -1) {
    var encoded = callId.substring(callId.indexOf("__sig_") + 6);
    var decoded = decodeBase64Url(encoded);
    if (decoded) return decoded;
  }
  if (callId && GLOBAL_THOUGHT_SIGNATURES[callId]) {
    return GLOBAL_THOUGHT_SIGNATURES[callId];
  }
  return null;
}

function normalizeSchemaTypesToLower(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  var copy = {};
  var keys = Object.keys(schema);
  for (var k = 0; k < keys.length; k++) {
    var key = keys[k];
    var val = schema[key];
    if (key === "type") {
      if (typeof val === "string") {
        copy[key] = val.toLowerCase();
      } else if (Array.isArray(val)) {
        var typeArr = [];
        for (var ti = 0; ti < val.length; ti++) {
          typeArr.push(
            typeof val[ti] === "string" ? val[ti].toLowerCase() : val[ti]
          );
        }
        copy[key] = typeArr;
      } else {
        copy[key] = val;
      }
    } else if (
      key === "properties" ||
      key === "patternProperties" ||
      key === "$defs" ||
      key === "definitions"
    ) {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        var propMap = {};
        var propNames = Object.keys(val);
        for (var pi = 0; pi < propNames.length; pi++) {
          var pName = propNames[pi];
          var pVal = val[pName];
          if (pVal && typeof pVal === "object" && !Array.isArray(pVal)) {
            propMap[pName] = normalizeSchemaTypesToLower(pVal);
          } else {
            propMap[pName] = pVal;
          }
        }
        copy[key] = propMap;
      } else {
        copy[key] = val;
      }
    } else if (
      key === "items" ||
      key === "additionalProperties" ||
      key === "not" ||
      key === "if" ||
      key === "then" ||
      key === "else"
    ) {
      if (Array.isArray(val)) {
        var itemArr = [];
        for (var ii = 0; ii < val.length; ii++) {
          itemArr.push(
            val[ii] && typeof val[ii] === "object" && !Array.isArray(val[ii])
              ? normalizeSchemaTypesToLower(val[ii])
              : val[ii]
          );
        }
        copy[key] = itemArr;
      } else if (val && typeof val === "object") {
        copy[key] = normalizeSchemaTypesToLower(val);
      } else {
        copy[key] = val;
      }
    } else if (
      key === "anyOf" ||
      key === "oneOf" ||
      key === "allOf" ||
      key === "prefixItems"
    ) {
      if (Array.isArray(val)) {
        var subArr = [];
        for (var si = 0; si < val.length; si++) {
          subArr.push(
            val[si] && typeof val[si] === "object" && !Array.isArray(val[si])
              ? normalizeSchemaTypesToLower(val[si])
              : val[si]
          );
        }
        copy[key] = subArr;
      } else {
        copy[key] = val;
      }
    } else {
      // Preserve required, enum, description, default, format, minimum, maximum, etc. untouched
      copy[key] = val;
    }
  }
  return copy;
}

function parseJsonArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === "object") return rawArgs;
  if (typeof rawArgs === "string") {
    try {
      return JSON.parse(rawArgs);
    } catch (e) {
      return { raw: rawArgs };
    }
  }
  return {};
}

function normalizeToCanonicalRequest(body, clientProtocol) {
  var explicitTemp =
    typeof body.temperature === "number"
      ? body.temperature
      : body.generationConfig && typeof body.generationConfig.temperature === "number"
      ? body.generationConfig.temperature
      : null;

  var canonical = {
    systemText: "",
    messages: [], // [{ role: "user" | "assistant", text: "", thoughts: [], toolCalls: [], toolResults: [] }]
    tools: [],    // [{ name, description, parameters }]
    toolChoice: body.tool_choice || null,
    maxTokens:
      body.max_tokens ||
      body.max_output_tokens ||
      (body.generationConfig && body.generationConfig.maxOutputTokens) ||
      4096,
    temperature: explicitTemp,
    stream: Boolean(body.stream)
  };

  // Map tool_use_id / call_id -> function name across all turns in this conversation
  var toolIdToName = {};
  var kNames = Object.keys(GLOBAL_TOOL_ID_TO_NAME);
  for (var kn = 0; kn < kNames.length; kn++) {
    toolIdToName[kNames[kn]] = GLOBAL_TOOL_ID_TO_NAME[kNames[kn]];
  }

  if (clientProtocol === "anthropic_messages") {
    if (typeof body.system === "string") {
      canonical.systemText = body.system;
    } else if (Array.isArray(body.system)) {
      var sysParts = [];
      for (var s = 0; s < body.system.length; s++) {
        if (body.system[s] && body.system[s].text) sysParts.push(body.system[s].text);
      }
      canonical.systemText = sysParts.join("\n");
    }

    var msgs = body.messages || [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      var msgEntry = {
        role: m.role === "assistant" ? "assistant" : "user",
        text: "",
        images: [],
        thoughts: [],
        toolCalls: [],
        toolResults: []
      };
      var pendingThoughtSig = null;
      if (typeof m.content === "string") {
        msgEntry.text = m.content;
      } else if (Array.isArray(m.content)) {
        var textBlocks = [];
        for (var j = 0; j < m.content.length; j++) {
          var block = m.content[j];
          if (!block) continue;
          if (block.type === "thinking" || block.type === "thought") {
            // Only forward Gemini thoughtSignature (not Anthropic's cryptographic thinking.signature)
            var sig = block.thoughtSignature || null;
            if (sig) pendingThoughtSig = sig;
            msgEntry.thoughts.push({
              text: block.thinking || block.text || "",
              thoughtSignature: sig
            });
          } else if (block.type === "text" && block.text) {
            textBlocks.push(block.text);
          } else if (block.type === "image" && block.source) {
            if (block.source.data) {
              msgEntry.images.push({
                mediaType: block.source.media_type || "image/png",
                data: block.source.data
              });
            }
          } else if (block.type === "tool_use") {
            var tcId = block.id || "toolu_" + i + "_" + j;
            var tcName = block.name || "tool";
            var tcSig = lookupThoughtSignature(
              tcId,
              tcName,
              block.thoughtSignature || pendingThoughtSig
            );
            // Attach turn-level pendingThoughtSig at most once (first parallel tool_use)
            pendingThoughtSig = null;
            toolIdToName[tcId] = tcName;
            recordToolMetadata(tcId, tcName, tcSig);
            msgEntry.toolCalls.push({
              id: tcId,
              name: tcName,
              args: block.input || {},
              thoughtSignature: tcSig
            });
          } else if (block.type === "tool_result") {
            var refId = block.tool_use_id || "toolu_0";
            var resolvedName = block.name || toolIdToName[refId] || refId;
            var resultContent = "";
            if (typeof block.content === "string") {
              resultContent = block.content;
            } else if (Array.isArray(block.content)) {
              var trTexts = [];
              for (var bci = 0; bci < block.content.length; bci++) {
                var subBlock = block.content[bci];
                if (!subBlock) continue;
                if (subBlock.text) {
                  trTexts.push(subBlock.text);
                } else if (subBlock.type === "image" && subBlock.source && subBlock.source.data) {
                  msgEntry.images.push({
                    mediaType: subBlock.source.media_type || "image/png",
                    data: subBlock.source.data
                  });
                } else {
                  trTexts.push(JSON.stringify(subBlock));
                }
              }
              resultContent = trTexts.join("\n");
            } else {
              resultContent = JSON.stringify(block.content || {});
            }
            msgEntry.toolResults.push({
              toolUseId: refId,
              name: resolvedName,
              content: resultContent,
              isError: Boolean(block.is_error)
            });
          }
        }
        msgEntry.text = textBlocks.join("\n");
      }
      canonical.messages.push(msgEntry);
    }

    var anthTools = body.tools || [];
    for (var t = 0; t < anthTools.length; t++) {
      canonical.tools.push({
        name: anthTools[t].name,
        description: anthTools[t].description || "",
        parameters: normalizeSchemaTypesToLower(
          anthTools[t].input_schema || { type: "object", properties: {} }
        )
      });
    }
  } else if (clientProtocol === "openai_responses") {
    canonical.systemText = body.instructions || "";
    if (typeof body.input === "string") {
      canonical.messages.push({
        role: "user",
        text: body.input,
        images: [],
        thoughts: [],
        toolCalls: [],
        toolResults: []
      });
    } else if (Array.isArray(body.input)) {
      for (var r = 0; r < body.input.length; r++) {
        var item = body.input[r];
        if (!item) continue;
        if (item.type === "reasoning") {
          // Skip Codex reasoning items or attach summary text to previous assistant message thoughts
          continue;
        }
        if (item.role === "system" || item.role === "developer") {
          var sysTxt = typeof item.content === "string" ? item.content : "";
          if (Array.isArray(item.content)) {
            var sp = [];
            for (var si = 0; si < item.content.length; si++) {
              if (item.content[si] && item.content[si].text) sp.push(item.content[si].text);
            }
            sysTxt = sp.join("\n");
          }
          if (sysTxt) {
            canonical.systemText += (canonical.systemText ? "\n" : "") + sysTxt;
          }
        } else if (
          item.type === "function_call" ||
          item.type === "local_shell_call" ||
          item.type === "custom_tool_call"
        ) {
          var fcCallId = item.call_id || item.id || "call_" + r;
          var fcName =
            item.name ||
            (item.type === "local_shell_call" ? "local_shell" : "tool");
          var fcArgs =
            item.action || parseJsonArgs(item.arguments || item.input);
          var fcSig = lookupThoughtSignature(
            fcCallId,
            fcName,
            item.thoughtSignature || item.signature
          );
          toolIdToName[fcCallId] = fcName;
          recordToolMetadata(fcCallId, fcName, fcSig);
          var fcObj = {
            id: fcCallId,
            name: fcName,
            args: fcArgs,
            thoughtSignature: fcSig
          };
          var prevMsg =
            canonical.messages.length > 0
              ? canonical.messages[canonical.messages.length - 1]
              : null;
          if (prevMsg && prevMsg.role === "assistant" && prevMsg.toolResults.length === 0) {
            prevMsg.toolCalls.push(fcObj);
          } else {
            canonical.messages.push({
              role: "assistant",
              text: "",
              images: [],
              thoughts: [],
              toolCalls: [fcObj],
              toolResults: []
            });
          }
        } else if (
          item.type === "function_call_output" ||
          item.type === "local_shell_call_output" ||
          item.type === "custom_tool_call_output"
        ) {
          var outCallId = item.call_id || "call_1";
          var outFnName = item.name || toolIdToName[outCallId] || outCallId;
          var trObj = {
            toolUseId: outCallId,
            name: outFnName,
            content:
              typeof item.output === "string"
                ? item.output
                : JSON.stringify(item.output || "")
          };
          var lastMsg =
            canonical.messages.length > 0
              ? canonical.messages[canonical.messages.length - 1]
              : null;
          if (
            lastMsg &&
            lastMsg.role === "user" &&
            !lastMsg.text &&
            lastMsg.toolResults.length > 0
          ) {
            lastMsg.toolResults.push(trObj);
          } else {
            canonical.messages.push({
              role: "user",
              text: "",
              images: [],
              thoughts: [],
              toolCalls: [],
              toolResults: [trObj]
            });
          }
        } else {
          var txt = "";
          var respImages = [];
          if (typeof item.content === "string") {
            txt = item.content;
          } else if (Array.isArray(item.content)) {
            var rParts = [];
            for (var rp = 0; rp < item.content.length; rp++) {
              var cPart = item.content[rp];
              if (!cPart) continue;
              if (typeof cPart.text === "string") {
                rParts.push(cPart.text);
              } else if (
                (cPart.type === "input_image" || cPart.type === "image_url") &&
                cPart.image_url
              ) {
                var rawUrl =
                  typeof cPart.image_url === "string"
                    ? cPart.image_url
                    : cPart.image_url.url || "";
                if (rawUrl.indexOf("data:") === 0 && rawUrl.indexOf(";base64,") !== -1) {
                  var semi = rawUrl.indexOf(";base64,");
                  respImages.push({
                    mediaType: rawUrl.substring(5, semi),
                    data: rawUrl.substring(semi + 8)
                  });
                }
              }
            }
            txt = rParts.join("\n");
          }
          if (txt || respImages.length > 0) {
            canonical.messages.push({
              role: item.role === "assistant" ? "assistant" : "user",
              text: txt,
              images: respImages,
              thoughts: [],
              toolCalls: [],
              toolResults: []
            });
          }
        }
      }
    }

    var respTools = body.tools || [];
    for (var rt = 0; rt < respTools.length; rt++) {
      var toolObj = respTools[rt].function || respTools[rt];
      if (toolObj && toolObj.name) {
        canonical.tools.push({
          name: toolObj.name,
          description: toolObj.description || "",
          parameters: normalizeSchemaTypesToLower(
            toolObj.parameters || { type: "object", properties: {} }
          )
        });
      }
    }
  } else if (clientProtocol === "openai_chat") {
    var chatMsgs = body.messages || [];
    for (var c = 0; c < chatMsgs.length; c++) {
      var cm = chatMsgs[c];
      if (!cm) continue;
      if (cm.role === "system" || cm.role === "developer") {
        var sysContent = typeof cm.content === "string" ? cm.content : "";
        if (Array.isArray(cm.content)) {
          var sysArr = [];
          for (var sc = 0; sc < cm.content.length; sc++) {
            if (cm.content[sc] && cm.content[sc].text) sysArr.push(cm.content[sc].text);
          }
          sysContent = sysArr.join("\n");
        }
        if (sysContent) {
          canonical.systemText += (canonical.systemText ? "\n" : "") + sysContent;
        }
      } else if (cm.role === "tool" || cm.role === "function") {
        var tCallId = cm.tool_call_id || cm.id || cm.name || "call_" + c;
        var tFnName = cm.name || toolIdToName[tCallId] || tCallId;
        var tContent =
          typeof cm.content === "string"
            ? cm.content
            : JSON.stringify(cm.content || "");
        var chatTrObj = {
          toolUseId: tCallId,
          name: tFnName,
          content: tContent
        };
        var prevChatMsg =
          canonical.messages.length > 0
            ? canonical.messages[canonical.messages.length - 1]
            : null;
        if (
          prevChatMsg &&
          prevChatMsg.role === "user" &&
          !prevChatMsg.text &&
          prevChatMsg.toolResults.length > 0
        ) {
          prevChatMsg.toolResults.push(chatTrObj);
        } else {
          canonical.messages.push({
            role: "user",
            text: "",
            thoughts: [],
            toolCalls: [],
            toolResults: [chatTrObj]
          });
        }
      } else {
        var chatText = "";
        var chatImages = [];
        if (typeof cm.content === "string") {
          chatText = cm.content;
        } else if (Array.isArray(cm.content)) {
          var cParts = [];
          for (var cp = 0; cp < cm.content.length; cp++) {
            var cItem = cm.content[cp];
            if (!cItem) continue;
            if (cItem.text) {
              cParts.push(cItem.text);
            } else if (
              (cItem.type === "image_url" || cItem.type === "input_image") &&
              cItem.image_url
            ) {
              var cImgUrl =
                typeof cItem.image_url === "string"
                  ? cItem.image_url
                  : cItem.image_url.url || "";
              if (cImgUrl.indexOf("data:") === 0 && cImgUrl.indexOf(";base64,") !== -1) {
                var cSemi = cImgUrl.indexOf(";base64,");
                chatImages.push({
                  mediaType: cImgUrl.substring(5, cSemi),
                  data: cImgUrl.substring(cSemi + 8)
                });
              }
            }
          }
          chatText = cParts.join("\n");
        }
        var chatToolCalls = [];
        if (Array.isArray(cm.tool_calls)) {
          for (var ctc = 0; ctc < cm.tool_calls.length; ctc++) {
            var rawTc = cm.tool_calls[ctc];
            var fnSpec = (rawTc && rawTc.function) || {};
            var callIdVal = (rawTc && rawTc.id) || "call_" + c + "_" + ctc;
            var fnNameVal = fnSpec.name || "tool";
            var explicitChatSig =
              (rawTc &&
                rawTc.extra_content &&
                rawTc.extra_content.google &&
                rawTc.extra_content.google.thought_signature) ||
              (rawTc &&
                (rawTc.thoughtSignature ||
                  rawTc.thought_signature ||
                  rawTc.signature)) ||
              null;
            var tcSigVal = lookupThoughtSignature(
              callIdVal,
              fnNameVal,
              explicitChatSig
            );
            toolIdToName[callIdVal] = fnNameVal;
            recordToolMetadata(callIdVal, fnNameVal, tcSigVal);
            chatToolCalls.push({
              id: callIdVal,
              name: fnNameVal,
              args: parseJsonArgs(fnSpec.arguments),
              thoughtSignature: tcSigVal
            });
          }
        } else if (cm.function_call && cm.function_call.name) {
          var legacyId = "call_" + c + "_0";
          toolIdToName[legacyId] = cm.function_call.name;
          chatToolCalls.push({
            id: legacyId,
            name: cm.function_call.name,
            args: parseJsonArgs(cm.function_call.arguments),
            thoughtSignature: null
          });
        }
        canonical.messages.push({
          role: cm.role === "assistant" ? "assistant" : "user",
          text: chatText,
          images: chatImages,
          thoughts: [],
          toolCalls: chatToolCalls,
          toolResults: []
        });
      }
    }
    var chatTools = body.tools || [];
    for (var ct = 0; ct < chatTools.length; ct++) {
      var fn = chatTools[ct].function || chatTools[ct];
      if (fn && fn.name) {
        canonical.tools.push({
          name: fn.name,
          description: fn.description || "",
          parameters: normalizeSchemaTypesToLower(
            fn.parameters || { type: "object", properties: {} }
          )
        });
      }
    }
  } else if (clientProtocol === "vertex_gemini") {
    if (body.systemInstruction && Array.isArray(body.systemInstruction.parts)) {
      var gSys = [];
      for (var gs = 0; gs < body.systemInstruction.parts.length; gs++) {
        if (body.systemInstruction.parts[gs] && body.systemInstruction.parts[gs].text) {
          gSys.push(body.systemInstruction.parts[gs].text);
        }
      }
      canonical.systemText = gSys.join("\n");
    }
    // Track FIFO queue of generated call IDs per function name so Antigravity -> Claude
    // maps functionCall and functionResponse to the exact same tool_use_id.
    var pendingCallIdsByName = {};
    var contents = body.contents || [];
    for (var g = 0; g < contents.length; g++) {
      var gc = contents[g];
      var gText = [];
      var gImages = [];
      var gThoughts = [];
      var gToolCalls = [];
      var gToolResults = [];
      var parts = (gc && gc.parts) || [];
      for (var gp = 0; gp < parts.length; gp++) {
        var part = parts[gp];
        if (!part) continue;
        if (part.thought) {
          gThoughts.push({
            text: part.text || "",
            thoughtSignature: part.thoughtSignature || null
          });
        } else if (part.text) {
          gText.push(part.text);
        }
        if (part.inlineData && part.inlineData.data) {
          gImages.push({
            mediaType: part.inlineData.mimeType || "image/png",
            data: part.inlineData.data
          });
        }
        if (part.functionCall) {
          var gFnName = part.functionCall.name || "tool";
          var gCallId =
            part.functionCall.id || "toolu_" + gFnName + "_" + g + "_" + gp;
          if (!pendingCallIdsByName[gFnName]) {
            pendingCallIdsByName[gFnName] = [];
          }
          pendingCallIdsByName[gFnName].push(gCallId);
          toolIdToName[gCallId] = gFnName;
          gToolCalls.push({
            id: gCallId,
            name: gFnName,
            args: part.functionCall.args || {},
            thoughtSignature: part.thoughtSignature || null
          });
        }
        if (part.functionResponse) {
          var respFnName = part.functionResponse.name || "tool";
          var matchedCallId = part.functionResponse.id || null;
          if (
            !matchedCallId &&
            pendingCallIdsByName[respFnName] &&
            pendingCallIdsByName[respFnName].length > 0
          ) {
            matchedCallId = pendingCallIdsByName[respFnName].shift();
          }
          if (!matchedCallId) {
            matchedCallId = "toolu_" + respFnName;
          }
          var respObj = part.functionResponse.response;
          var respStr = "";
          if (respObj && typeof respObj === "object" && typeof respObj.result === "string") {
            respStr = respObj.result;
          } else if (typeof respObj === "string") {
            respStr = respObj;
          } else {
            respStr = JSON.stringify(respObj || {});
          }
          gToolResults.push({
            toolUseId: matchedCallId,
            name: respFnName,
            content: respStr
          });
        }
      }
      canonical.messages.push({
        role: gc.role === "model" || gc.role === "assistant" ? "assistant" : "user",
        text: gText.join("\n"),
        images: gImages,
        thoughts: gThoughts,
        toolCalls: gToolCalls,
        toolResults: gToolResults
      });
    }
    if (body.tools && Array.isArray(body.tools)) {
      for (var gt = 0; gt < body.tools.length; gt++) {
        var decls = body.tools[gt] && body.tools[gt].functionDeclarations;
        if (Array.isArray(decls)) {
          for (var gd = 0; gd < decls.length; gd++) {
            var rawSchema =
              decls[gd].parametersJsonSchema ||
              decls[gd].parameters || { type: "object", properties: {} };
            canonical.tools.push({
              name: decls[gd].name,
              description: decls[gd].description || "",
              parameters: normalizeSchemaTypesToLower(rawSchema)
            });
          }
        }
      }
    }
  }

  return canonical;
}

function buildVertexGeminiPayload(canonical) {
  var payload = {
    contents: [],
    generationConfig: {
      // Vertex AI Gemini models enforce maxOutputTokens in [1, 65536]; clamp 128k Claude Code defaults
      maxOutputTokens: Math.min(Math.max(canonical.maxTokens || 1024, 1024), 65536),
      // Google recommends temperature 1.0 for Gemini 3 models to prevent looping
      temperature:
        canonical.temperature !== null && typeof canonical.temperature === "number"
          ? canonical.temperature
          : 1.0
    }
  };
  if (canonical.systemText) {
    payload.systemInstruction = {
      parts: [{ text: canonical.systemText }]
    };
  }
  for (var i = 0; i < canonical.messages.length; i++) {
    var m = canonical.messages[i];
    var parts = [];
    var hasToolCallsInTurn = m.toolCalls && m.toolCalls.length > 0;
    if (m.thoughts && m.thoughts.length > 0) {
      for (var th = 0; th < m.thoughts.length; th++) {
        // Skip unsigned thinking blocks from non-Gemini models when toolCalls are present
        if (hasToolCallsInTurn && !m.thoughts[th].thoughtSignature) {
          continue;
        }
        var thoughtPart = {
          thought: true,
          text: m.thoughts[th].text || ""
        };
        if (m.thoughts[th].thoughtSignature) {
          thoughtPart.thoughtSignature = m.thoughts[th].thoughtSignature;
        }
        parts.push(thoughtPart);
      }
    }
    if (m.images && m.images.length > 0) {
      for (var im = 0; im < m.images.length; im++) {
        parts.push({
          inlineData: {
            mimeType: m.images[im].mediaType || "image/png",
            data: m.images[im].data || ""
          }
        });
      }
    }
    if (m.text) {
      parts.push({ text: m.text });
    }
    for (var tc = 0; tc < m.toolCalls.length; tc++) {
      var callItem = m.toolCalls[tc];
      var fcPart = {
        functionCall: {
          name: callItem.name,
          args: callItem.args || {}
        }
      };
      var sig = lookupThoughtSignature(
        callItem.id,
        callItem.name,
        callItem.thoughtSignature
      );
      if (sig) {
        fcPart.thoughtSignature = sig;
      } else if (tc === 0) {
        // Official Gemini 3 dummy signature when switching from Claude/MaaS mid-tool-loop
        // or when thoughtSignature could not be recovered
        fcPart.thoughtSignature = "skip_thought_signature_validator";
      }
      parts.push(fcPart);
    }
    for (var tr = 0; tr < m.toolResults.length; tr++) {
      var trItem = m.toolResults[tr];
      var fnName =
        trItem.name ||
        GLOBAL_TOOL_ID_TO_NAME[trItem.toolUseId] ||
        trItem.toolUseId ||
        "tool_result";
      parts.push({
        functionResponse: {
          name: fnName,
          response: { result: trItem.content }
        }
      });
    }
    if (parts.length === 0) {
      parts.push({ text: " " });
    }
    payload.contents.push({
      role: m.role === "assistant" ? "model" : "user",
      parts: parts
    });
  }
  if (canonical.tools.length > 0) {
    var decls = [];
    for (var t = 0; t < canonical.tools.length; t++) {
      decls.push({
        name: canonical.tools[t].name,
        description: canonical.tools[t].description,
        parametersJsonSchema: normalizeSchemaTypesToLower(canonical.tools[t].parameters)
      });
    }
    payload.tools = [{ functionDeclarations: decls }];
    if (canonical.toolChoice) {
      var tcType =
        typeof canonical.toolChoice === "string"
          ? canonical.toolChoice
          : canonical.toolChoice.type || "auto";
      var forcedToolName =
        typeof canonical.toolChoice === "object"
          ? canonical.toolChoice.name ||
            (canonical.toolChoice.function && canonical.toolChoice.function.name) ||
            null
          : null;
      if (
        tcType === "any" ||
        tcType === "required" ||
        tcType === "tool" ||
        tcType === "function"
      ) {
        var fcCfg = { mode: "ANY" };
        if (forcedToolName) {
          fcCfg.allowedFunctionNames = [forcedToolName];
        }
        payload.toolConfig = {
          functionCallingConfig: fcCfg
        };
      } else if (tcType === "none") {
        payload.toolConfig = {
          functionCallingConfig: { mode: "NONE" }
        };
      }
    }
  }
  return payload;
}

function buildVertexAnthropicPayload(canonical, isStreaming) {
  var payload = {
    anthropic_version: "vertex-2023-10-16",
    max_tokens: Math.min(Math.max(canonical.maxTokens || 4096, 1), 64000),
    messages: []
  };
  if (isStreaming) {
    payload.stream = true;
  }
  if (canonical.temperature !== null && typeof canonical.temperature === "number") {
    payload.temperature = canonical.temperature;
  }
  if (canonical.systemText) {
    payload.system = canonical.systemText;
  }
  for (var i = 0; i < canonical.messages.length; i++) {
    var m = canonical.messages[i];
    var contentBlocks = [];
    // Anthropic requires tool_result blocks BEFORE text blocks in user messages
    for (var tr = 0; tr < m.toolResults.length; tr++) {
      var trBlock = {
        type: "tool_result",
        tool_use_id: m.toolResults[tr].toolUseId,
        content: m.toolResults[tr].content
      };
      if (m.toolResults[tr].isError) {
        trBlock.is_error = true;
      }
      contentBlocks.push(trBlock);
    }
    if (m.images && m.images.length > 0) {
      for (var im = 0; im < m.images.length; im++) {
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: m.images[im].mediaType || "image/png",
            data: m.images[im].data || ""
          }
        });
      }
    }
    if (m.text) {
      contentBlocks.push({ type: "text", text: m.text });
    }
    for (var tc = 0; tc < m.toolCalls.length; tc++) {
      contentBlocks.push({
        type: "tool_use",
        id: m.toolCalls[tc].id,
        name: m.toolCalls[tc].name,
        input: m.toolCalls[tc].args || {}
      });
    }
    if (contentBlocks.length === 0) {
      continue;
    }
    payload.messages.push({
      role: m.role,
      content:
        contentBlocks.length === 1 && contentBlocks[0].type === "text"
          ? contentBlocks[0].text
          : contentBlocks
    });
  }
  if (canonical.tools.length > 0) {
    payload.tools = [];
    for (var t = 0; t < canonical.tools.length; t++) {
      var normalizedSchema = normalizeSchemaTypesToLower(canonical.tools[t].parameters);
      if (!normalizedSchema.type) {
        normalizedSchema.type = "object";
      }
      payload.tools.push({
        name: canonical.tools[t].name,
        description: canonical.tools[t].description,
        input_schema: normalizedSchema
      });
    }
    if (canonical.toolChoice) {
      var choiceType =
        typeof canonical.toolChoice === "string"
          ? canonical.toolChoice
          : canonical.toolChoice.type || "auto";
      if (choiceType === "any" || choiceType === "required") {
        payload.tool_choice = { type: "any" };
      } else if (choiceType === "tool" && canonical.toolChoice.name) {
        payload.tool_choice = { type: "tool", name: canonical.toolChoice.name };
      } else if (
        choiceType === "function" &&
        canonical.toolChoice.function &&
        canonical.toolChoice.function.name
      ) {
        payload.tool_choice = {
          type: "tool",
          name: canonical.toolChoice.function.name
        };
      } else if (choiceType === "auto") {
        payload.tool_choice = { type: "auto" };
      }
    }
  }
  return payload;
}

function resolvePhysicalVertexModelAndRegion(targetFamily, vertexModelId, rawRegion) {
  var id = String(vertexModelId || "");
  var region = String(rawRegion || "global");

  if (targetFamily === "gemini") {
    region = "global";
    if (
      id === "gemini-4-argon" ||
      id === "gemini-4-argon-cyber-permissive" ||
      id === "gemini-3.1-pro"
    ) {
      return { modelId: "gemini-3.1-pro-preview", region: "global" };
    }
    if (
      id === "gemini-3.8-flash" ||
      id === "gemini-3.7-flash" ||
      id === "gemini-3.6-flash" ||
      id === "gemini-3.5-flash"
    ) {
      return { modelId: "gemini-3-flash-preview", region: "global" };
    }
    // gemini-3.5-flash-lite is served under its own ID. It used to be rewritten to
    // gemini-3.1-flash-lite-preview, for which Vertex AI returns 404 NOT_FOUND ("not found or
    // your project does not have access to it") in the project this gateway is tested in.
    return { modelId: id, region: region };
  }

  if (targetFamily === "anthropic") {
    if (
      id === "claude-opus-5-5" ||
      id === "claude-opus-5" ||
      id === "claude-fable-5-1" ||
      id === "claude-fable-5" ||
      id === "claude-opus-4-8"
    ) {
      return { modelId: "claude-opus-4-7", region: "global" };
    }
    if (id === "claude-sonnet-5-5" || id === "claude-sonnet-5") {
      return { modelId: "claude-sonnet-4-6", region: "global" };
    }
    if (
      id === "claude-haiku-5-5" ||
      id === "claude-haiku-4-5" ||
      id === "claude-haiku-4-5@20251001"
    ) {
      return { modelId: "claude-haiku-4-5@20251001", region: "us-east5" };
    }
    return { modelId: id, region: region };
  }

  if (targetFamily === "openapi_maas") {
    // Gate O1/O2: Map Vertex AI Model Garden MaaS open-weight models to live serverless MaaS endpoints in global
    if (
      id.indexOf("glm") !== -1 ||
      id.indexOf("qwen") !== -1 ||
      id === "zai-org/glm-5.2-maas"
    ) {
      return { modelId: "zai-org/glm-5.2-maas", region: "global" };
    }
    if (
      id.indexOf("deepseek") !== -1 ||
      id.indexOf("kimi") !== -1 ||
      id.indexOf("minimax") !== -1 ||
      id === "deepseek-ai/deepseek-v4.1-flash-maas"
    ) {
      return { modelId: "deepseek-ai/deepseek-v4.1-flash-maas", region: "global" };
    }
    if (
      id.indexOf("gpt-oss-120b") !== -1 ||
      id.indexOf("gpt-oss") !== -1 ||
      id === "openai/gpt-oss-120b-maas"
    ) {
      return { modelId: "openai/gpt-oss-120b-maas", region: "global" };
    }
    if (id.indexOf("gemma-4") !== -1 || id === "google/gemma-4-26b-a4b-it-maas") {
      return { modelId: "google/gemma-4-26b-a4b-it-maas", region: "global" };
    }
    return { modelId: "zai-org/glm-5.2-maas", region: "global" };
  }

  return { modelId: id, region: region };
}

function buildVertexOpenAIMaaSPayload(canonical, vertexModelId, isStreaming) {
  var resolvedMaaS = resolvePhysicalVertexModelAndRegion(
    "openapi_maas",
    vertexModelId,
    "global"
  );
  var maxLimit = 65536;
  if (resolvedMaaS.modelId.indexOf("llama-4") !== -1) {
    maxLimit = 8192;
  } else if (resolvedMaaS.modelId.indexOf("glm-5.2") !== -1) {
    maxLimit = 64000;
  } else if (resolvedMaaS.modelId.indexOf("gpt-oss") !== -1) {
    maxLimit = 131072;
  }
  var payload = {
    model: resolvedMaaS.modelId,
    max_tokens: Math.min(Math.max(canonical.maxTokens || 4096, 256), maxLimit),
    temperature:
      canonical.temperature !== null && typeof canonical.temperature === "number"
        ? canonical.temperature
        : 0.2,
    stream: isStreaming,
    messages: []
  };
  if (isStreaming) {
    payload.stream_options = { include_usage: true };
  }
  if (canonical.systemText) {
    payload.messages.push({ role: "system", content: canonical.systemText });
  }
  for (var i = 0; i < canonical.messages.length; i++) {
    var m = canonical.messages[i];
    if (m.role === "assistant") {
      var assistantMsg = {
        role: "assistant",
        content: m.text || null
      };
      if (m.toolCalls && m.toolCalls.length > 0) {
        assistantMsg.tool_calls = [];
        for (var tc = 0; tc < m.toolCalls.length; tc++) {
          var maasTcObj = {
            id: m.toolCalls[tc].id,
            type: "function",
            function: {
              name: m.toolCalls[tc].name,
              arguments: JSON.stringify(m.toolCalls[tc].args || {})
            }
          };
          var maasSig = lookupThoughtSignature(
            m.toolCalls[tc].id,
            m.toolCalls[tc].name,
            m.toolCalls[tc].thoughtSignature
          );
          if (maasSig) {
            maasTcObj.extra_content = {
              google: {
                thought_signature: maasSig
              }
            };
          } else if (tc === 0 && resolvedMaaS.modelId.indexOf("gemini") !== -1) {
            // Vertex OpenAI Chat Completions endpoint backed by Gemini 3 requires
            // extra_content.google.thought_signature on historical tool_calls;
            // omit for non-Gemini open-weight MaaS models (Gate O4).
            maasTcObj.extra_content = {
              google: {
                thought_signature: "skip_thought_signature_validator"
              }
            };
          }
          assistantMsg.tool_calls.push(maasTcObj);
        }
      }
      payload.messages.push(assistantMsg);
    } else {
      if (m.toolResults && m.toolResults.length > 0) {
        for (var tr = 0; tr < m.toolResults.length; tr++) {
          payload.messages.push({
            role: "tool",
            tool_call_id: m.toolResults[tr].toolUseId,
            name: m.toolResults[tr].name,
            content:
              typeof m.toolResults[tr].content === "string"
                ? m.toolResults[tr].content
                : JSON.stringify(m.toolResults[tr].content || "")
          });
        }
      }
      if (m.images && m.images.length > 0) {
        var userBlocks = [];
        if (m.text) {
          userBlocks.push({ type: "text", text: m.text });
        }
        for (var mim = 0; mim < m.images.length; mim++) {
          userBlocks.push({
            type: "image_url",
            image_url: {
              url:
                "data:" +
                (m.images[mim].mediaType || "image/png") +
                ";base64," +
                (m.images[mim].data || "")
            }
          });
        }
        payload.messages.push({
          role: "user",
          content: userBlocks
        });
      } else if (m.text || (!m.toolResults || m.toolResults.length === 0)) {
        payload.messages.push({
          role: "user",
          content: m.text || ""
        });
      }
    }
  }
  if (canonical.tools.length > 0) {
    payload.tools = [];
    for (var t = 0; t < canonical.tools.length; t++) {
      payload.tools.push({
        type: "function",
        function: {
          name: canonical.tools[t].name,
          description: canonical.tools[t].description,
          parameters: normalizeSchemaTypesToLower(canonical.tools[t].parameters)
        }
      });
    }
    if (canonical.toolChoice) {
      var maasChoiceType =
        typeof canonical.toolChoice === "string"
          ? canonical.toolChoice
          : canonical.toolChoice.type || "auto";
      if (maasChoiceType === "any" || maasChoiceType === "required") {
        payload.tool_choice = "required";
      } else if (maasChoiceType === "none") {
        payload.tool_choice = "none";
      } else if (maasChoiceType === "tool" && canonical.toolChoice.name) {
        payload.tool_choice = {
          type: "function",
          function: { name: canonical.toolChoice.name }
        };
      } else if (
        maasChoiceType === "function" &&
        canonical.toolChoice.function &&
        canonical.toolChoice.function.name
      ) {
        payload.tool_choice = {
          type: "function",
          function: { name: canonical.toolChoice.function.name }
        };
      } else if (maasChoiceType === "auto") {
        payload.tool_choice = "auto";
      }
    }
  }
  return payload;
}

function computeTargetVertexUrl(context, targetFamily, vertexModelId, action) {
  var projectId =
    context.getVariable("propertyset.ai_config.vertex_project_id") ||
    context.getVariable("organization.name") ||
    "default-project";
  var rawRegion = context.getVariable("vertex_region") || "global";
  var resolved = resolvePhysicalVertexModelAndRegion(
    targetFamily,
    vertexModelId,
    rawRegion
  );
  var region = resolved.region;
  var physicalModelId = resolved.modelId;
  context.setVariable("ai.physical_model", physicalModelId);
  context.setVariable("ai.physical_region", region);
  var host =
    region === "global"
      ? "https://aiplatform.googleapis.com"
      : "https://" + region + "-aiplatform.googleapis.com";
  if (targetFamily === "anthropic") {
    return (
      host +
      "/v1/projects/" +
      projectId +
      "/locations/" +
      region +
      "/publishers/anthropic/models/" +
      physicalModelId +
      ":" +
      action
    );
  }
  if (targetFamily === "openapi_maas") {
    return (
      host +
      "/v1/projects/" +
      projectId +
      "/locations/" +
      region +
      "/endpoints/openapi/chat/completions"
    );
  }
  return (
    host +
    "/v1/projects/" +
    projectId +
    "/locations/" +
    region +
    "/publishers/google/models/" +
    physicalModelId +
    ":" +
    action
  );
}

function runTransformPayload(context) {
  var clientProtocol = context.getVariable("client_protocol") || "anthropic_messages";
  var targetFamily =
    context.getVariable("target_model_family") ||
    context.getVariable("ai.targetFamily") ||
    "gemini";
  var vertexModelId =
    context.getVariable("vertex_model_id") || "gemini-3.1-pro-preview";
  var isStreaming =
    context.getVariable("is_streaming") === "true" ||
    context.getVariable("ai.isStreaming") === "true";
  var isCountTokens =
    context.getVariable("is_count_tokens") === "true" ||
    context.getVariable("ai.isCountTokens") === "true";
  var rawBody = context.getVariable("request.content") || "{}";
  var body = {};
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    body = {};
  }

  // Save original request body in flow variable for Stage 05 automatic Vertex fallback
  context.setVariable("original_client_request_body", rawBody);

  // Request uncompressed upstream payload from Vertex AI so Apigee JS callouts can
  // safely parse and rewrite JSON/SSE bodies without causing client ZlibError
  if (typeof context.removeVariable === "function") {
    context.removeVariable("request.header.Accept-Encoding");
    context.removeVariable("request.header.accept-encoding");
  } else {
    context.setVariable("request.header.Accept-Encoding", "identity");
  }

  // Fast-path passthrough for Google Gemini Decisions API (POST /v1beta/decisions, gemini-decision-1)
  if (clientProtocol === "gemini_decisions" || targetFamily === "gemini_decisions") {
    var decisionsUrl =
      context.getVariable("ai.decisionsApiUrl") ||
      "https://generativelanguage.googleapis.com/v1beta/decisions";
    if (body && typeof body === "object" && !body.model) {
      body.model = vertexModelId || "gemini-decision-1";
    }
    context.setVariable("vertex_action", "decisions");
    context.setVariable("ai.vertexAction", "decisions");
    context.setVariable("ai.targetUrl", decisionsUrl);
    var decisionsSerialized = JSON.stringify(body);
    context.setVariable("transformed_payload", decisionsSerialized);
    context.setVariable("request.content", decisionsSerialized);
    return;
  }

  // Fast-path passthrough when Antigravity calls a native Vertex Gemini model directly
  if (clientProtocol === "vertex_gemini" && targetFamily === "gemini") {
    if (body && typeof body === "object" && "model" in body) {
      delete body.model;
    }
    if (
      body.generationConfig &&
      typeof body.generationConfig.maxOutputTokens === "number" &&
      body.generationConfig.maxOutputTokens > 65536
    ) {
      body.generationConfig.maxOutputTokens = 65536;
    }
    var geminiAction = isCountTokens
      ? "countTokens"
      : isStreaming
      ? "streamGenerateContent?alt=sse"
      : "generateContent";
    context.setVariable("vertex_action", geminiAction);
    context.setVariable("ai.vertexAction", geminiAction);
    context.setVariable(
      "ai.targetUrl",
      computeTargetVertexUrl(context, "gemini", vertexModelId, geminiAction)
    );
    var passthroughSerialized = JSON.stringify(body);
    context.setVariable("transformed_payload", passthroughSerialized);
    context.setVariable("request.content", passthroughSerialized);
    return;
  }

  // Fast-path passthrough when Claude Code calls a native Vertex Anthropic Claude model directly:
  // Preserves extended thinking, cache_control, images, tool_choice, temperature, and block order.
  if (clientProtocol === "anthropic_messages" && targetFamily === "anthropic") {
    var anthAction = isCountTokens
      ? "countTokens"
      : isStreaming
      ? "streamRawPredict"
      : "rawPredict";
    context.setVariable("vertex_action", anthAction);
    context.setVariable("ai.vertexAction", anthAction);
    context.setVariable(
      "ai.targetUrl",
      computeTargetVertexUrl(context, "anthropic", vertexModelId, anthAction)
    );
    var anthClone = {};
    var bKeys = Object.keys(body);
    for (var bk = 0; bk < bKeys.length; bk++) {
      var key = bKeys[bk];
      if (key !== "model") {
        anthClone[key] = body[key];
      }
    }
    anthClone.anthropic_version = "vertex-2023-10-16";
    if (isCountTokens) {
      delete anthClone.stream;
      delete anthClone.max_tokens;
    } else if (isStreaming) {
      anthClone.stream = true;
    } else {
      delete anthClone.stream;
    }
    if (!isCountTokens) {
      if (!anthClone.max_tokens) {
        anthClone.max_tokens = 4096;
      } else if (anthClone.max_tokens > 64000) {
        anthClone.max_tokens = 64000;
        if (
          anthClone.thinking &&
          typeof anthClone.thinking.budget_tokens === "number" &&
          anthClone.thinking.budget_tokens >= anthClone.max_tokens
        ) {
          anthClone.thinking.budget_tokens = Math.max(1024, anthClone.max_tokens - 4096);
        }
      }
    }
    var anthPassthrough = JSON.stringify(anthClone);
    context.setVariable("transformed_payload", anthPassthrough);
    context.setVariable("request.content", anthPassthrough);
    return;
  }

  var canonical = normalizeToCanonicalRequest(body, clientProtocol);
  var outPayload = {};

  if (targetFamily === "gemini") {
    outPayload = buildVertexGeminiPayload(canonical);
    if (isCountTokens) {
      outPayload = { contents: outPayload.contents };
    }
    var gAct = isCountTokens
      ? "countTokens"
      : isStreaming
      ? "streamGenerateContent?alt=sse"
      : "generateContent";
    context.setVariable("vertex_action", gAct);
    context.setVariable("ai.vertexAction", gAct);
    context.setVariable(
      "ai.targetUrl",
      computeTargetVertexUrl(context, "gemini", vertexModelId, gAct)
    );
  } else if (targetFamily === "anthropic") {
    outPayload = buildVertexAnthropicPayload(canonical, isStreaming);
    var aAct = isCountTokens
      ? "countTokens"
      : isStreaming
      ? "streamRawPredict"
      : "rawPredict";
    context.setVariable("vertex_action", aAct);
    context.setVariable("ai.vertexAction", aAct);
    context.setVariable(
      "ai.targetUrl",
      computeTargetVertexUrl(context, "anthropic", vertexModelId, aAct)
    );
  } else if (isCountTokens) {
    // Gate O5: OpenAI-compatible MaaS endpoints have no /count_tokens route;
    // approximate via Vertex Gemini :countTokens without running full LLM inference.
    var maasCountPayload = buildVertexGeminiPayload(canonical);
    outPayload = { contents: maasCountPayload.contents };
    context.setVariable("target_model_family", "gemini");
    context.setVariable("ai.targetFamily", "gemini");
    context.setVariable("vertex_action", "countTokens");
    context.setVariable("ai.vertexAction", "countTokens");
    context.setVariable(
      "ai.targetUrl",
      computeTargetVertexUrl(context, "gemini", "gemini-3-flash-preview", "countTokens")
    );
  } else {
    outPayload = buildVertexOpenAIMaaSPayload(canonical, vertexModelId, isStreaming);
    context.setVariable("vertex_action", "chat/completions");
    context.setVariable("ai.vertexAction", "chat/completions");
    context.setVariable(
      "ai.targetUrl",
      computeTargetVertexUrl(context, "openapi_maas", vertexModelId, "chat/completions")
    );
  }

  var serialized = JSON.stringify(outPayload);
  context.setVariable("transformed_payload", serialized);
  context.setVariable("request.content", serialized);
}

if (typeof context !== "undefined") {
  runTransformPayload(context);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    GLOBAL_THOUGHT_SIGNATURES: GLOBAL_THOUGHT_SIGNATURES,
    GLOBAL_TOOL_ID_TO_NAME: GLOBAL_TOOL_ID_TO_NAME,
    encodeBase64Url: encodeBase64Url,
    decodeBase64Url: decodeBase64Url,
    recordToolMetadata: recordToolMetadata,
    lookupThoughtSignature: lookupThoughtSignature,
    normalizeSchemaTypesToLower: normalizeSchemaTypesToLower,
    normalizeToCanonicalRequest: normalizeToCanonicalRequest,
    buildVertexGeminiPayload: buildVertexGeminiPayload,
    buildVertexAnthropicPayload: buildVertexAnthropicPayload,
    buildVertexOpenAIMaaSPayload: buildVertexOpenAIMaaSPayload,
    runTransformPayload: runTransformPayload
  };
}
