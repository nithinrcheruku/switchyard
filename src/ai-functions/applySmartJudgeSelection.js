/**
 * applySmartJudgeSelection.js
 * Smart Router tier selection for `model: auto`. One file, two entry points:
 *
 *   JS-PrepareSmartJudge (policy property phase=prepare)
 *     Runs the deterministic rules first (unless judgeBackend is "decisions-only") and
 *     decides whether a classifier callout is needed at all. A rule match, an empty prompt
 *     or the "heuristic" backend sets ai.judgeBackend = "none", so no network callout fires.
 *     Supported backends:
 *       - "gemini"         Vertex AI LLM judge (SC-ModelJudge, gemini-3.5-flash-lite)
 *       - "decisions"      Rule-first + Gemini Decisions API (SC-DecisionsClassifier, gemini-decision-1)
 *       - "decisions-only" Pure Gemini Decisions API for all `model: auto` turns (skips keyword rules)
 *       - "custom"         Bring-your-own HTTPS classifier (SC-CustomClassifier)
 *       - "heuristic"      Deterministic rules + prompt-length fallback only (0 ms, no network)
 *
 *   JS-ApplySmartJudgeSelection (no phase property; also what the Node emulator calls)
 *     Picks the tier from, in order: a deterministic rule (unless decisions-only), the custom
 *     classifier response (SC-CustomClassifier), the Gemini Decisions API response
 *     (SC-DecisionsClassifier), the LLM judge response (SC-ModelJudge), then the prompt-length
 *     fallback, and resolves the Vertex AI Model Garden model within the developer's
 *     allowed RBAC tiers.
 *
 * Accepts both tier labels (tier1-fast, tier2-daily, tier3-frontier, tier4-open)
 * and complexity labels (SIMPLE, MEDIUM, COMPLEX, REASONING).
 */
var SMART_ROUTER_TIERS = ["tier1-fast", "tier2-daily", "tier3-frontier", "tier4-open"];
var VALID_JUDGE_BACKENDS = ["gemini", "decisions", "decisions-only", "custom", "heuristic"];
var MAX_DECISIONS_INPUT_CHARS = 16000;
var DECISIONS_INPUT_COST_PER_1M_USD = 0.10;

function escapeJsonStringValue(str) {
  if (!str) return "";
  var quoted = JSON.stringify(String(str));
  return quoted.slice(1, -1);
}

function normalizeTierOrLabel(value) {
  if (value === null || value === undefined) return "";
  var raw = String(value).trim();
  if (!raw) return "";
  var lower = raw.toLowerCase();
  if (SMART_ROUTER_TIERS.indexOf(lower) !== -1) {
    return lower;
  }
  var labelToTier = {
    SIMPLE: "tier1-fast",
    MEDIUM: "tier4-open",
    COMPLEX: "tier2-daily",
    REASONING: "tier3-frontier"
  };
  return labelToTier[raw.toUpperCase()] || "";
}

/**
 * High-confidence deterministic domain & complexity signals (<1ms, no network).
 * Returns { matched, tier, reason, signal, explicitModelChoice }.
 */
function evaluateSmartRouterRules(promptText) {
  promptText = promptText || "";
  var selectedTier = "tier2-daily";
  var judgeReason = "complexity:medium->tier2-daily";
  var explicitModelChoice = null;
  var signalSummary = "Daily Multi-File Engineering";

  var lowerPrompt = promptText.toLowerCase().trim();
  var deterministicMatched = false;

  // 1. High-confidence deterministic domain & complexity signals (evaluated first for <1ms precision)
  if (
    /^\/(models|finops|finops-admin|vertex|switch|route|status)(\s|$)/i.test(lowerPrompt) ||
    /^(models|finops|finops-admin|route|status)$/i.test(lowerPrompt) ||
    lowerPrompt.indexOf("vertex-connect finops") !== -1 ||
    lowerPrompt.indexOf("vertex-connect models") !== -1 ||
    lowerPrompt.indexOf("vertex-connect route") !== -1 ||
    lowerPrompt.indexOf("vertex-connect status") !== -1 ||
    lowerPrompt.indexOf("vertex-connect claude") !== -1 ||
    lowerPrompt.indexOf("vertex-connect codex") !== -1
  ) {
    selectedTier = "tier1-fast";
    judgeReason = "smart_router_tier1_slash_command_fast";
    signalSummary = "CLI Utility / Slash Command (Ultra-Fast Flash)";
    deterministicMatched = true;
  } else if (
    lowerPrompt.indexOf("architecture") !== -1 ||
    lowerPrompt.indexOf("architect") !== -1 ||
    lowerPrompt.indexOf("race condition") !== -1 ||
    lowerPrompt.indexOf("distributed") !== -1 ||
    lowerPrompt.indexOf("consensus") !== -1 ||
    lowerPrompt.indexOf("deadlock") !== -1 ||
    lowerPrompt.indexOf("raft") !== -1 ||
    lowerPrompt.indexOf("paxos") !== -1 ||
    lowerPrompt.indexOf("byzantine") !== -1 ||
    lowerPrompt.indexOf("lock-free") !== -1
  ) {
    selectedTier = "tier3-frontier";
    judgeReason = "smart_router_tier3_frontier_architecture";
    signalSummary = "Complex Architecture / Concurrency Reasoning";
    deterministicMatched = true;
  } else if (
    lowerPrompt.indexOf("unit test") !== -1 ||
    lowerPrompt.indexOf("unit_test") !== -1 ||
    lowerPrompt.indexOf("implement function") !== -1 ||
    lowerPrompt.indexOf("boilerplate") !== -1 ||
    lowerPrompt.indexOf("regex") !== -1
  ) {
    selectedTier = "tier4-open";
    judgeReason = "smart_router_tier4_open_weight_codegen";
    signalSummary = "Codegen / Unit Test / Regex Pattern";
    deterministicMatched = true;
  } else if (
    lowerPrompt.indexOf("algebra") !== -1 ||
    lowerPrompt.indexOf("polynomial") !== -1 ||
    /\bfactor\s+/i.test(promptText) ||
    /\bfactorize\b/i.test(promptText) ||
    lowerPrompt.indexOf("simplify ") !== -1 ||
    lowerPrompt.indexOf("simultaneous") !== -1 ||
    lowerPrompt.indexOf("inequality") !== -1 ||
    lowerPrompt.indexOf("logarithm") !== -1 ||
    lowerPrompt.indexOf("trigonometry") !== -1 ||
    lowerPrompt.indexOf("linear system") !== -1 ||
    lowerPrompt.indexOf("roots of") !== -1 ||
    lowerPrompt.indexOf("slope") !== -1 ||
    lowerPrompt.indexOf("line passing through") !== -1 ||
    lowerPrompt.indexOf("passing through the points") !== -1 ||
    lowerPrompt.indexOf("coordinate") !== -1 ||
    lowerPrompt.indexOf("equation") !== -1 ||
    lowerPrompt.indexOf("quadratic") !== -1 ||
    lowerPrompt.indexOf("derivative") !== -1 ||
    lowerPrompt.indexOf("integral") !== -1 ||
    lowerPrompt.indexOf("eigenvalue") !== -1 ||
    lowerPrompt.indexOf("matrix") !== -1 ||
    lowerPrompt.indexOf("theorem") !== -1 ||
    lowerPrompt.indexOf("calculus") !== -1 ||
    lowerPrompt.indexOf("probability") !== -1 ||
    /\bsolve\s+/i.test(promptText) ||
    promptText.indexOf("\\(") !== -1 ||
    promptText.indexOf("\\[") !== -1 ||
    /\(\s*-?\d+\s*,\s*-?\d+\s*\)/.test(promptText) ||
    /\b[a-z]\s*\^\s*\d+/i.test(promptText) ||
    /\b\d+[a-z]\s*[\+\-\=]\s*-?\d+/i.test(promptText) ||
    /\b[a-z]\s*[\+\-]\s*\d+\s*=\s*-?\d+/i.test(promptText)
  ) {
    selectedTier = "tier4-open";
    judgeReason = "smart_router_tier4_math_reasoning_glm52";
    signalSummary = "Analytical Math / Algebra / Multi-Step Proof";
    explicitModelChoice = {
      canonicalId: "glm-5.2",
      vertexModelId: "zai-org/glm-5.2-maas",
      family: "openapi_maas",
      tier: "tier4-open",
      region: "global",
      vertexHost: "aiplatform.googleapis.com",
      inputCostPer1M: "0.80",
      outputCostPer1M: "0.80"
    };
    deterministicMatched = true;
  } else if (
    lowerPrompt.indexOf("refactor") !== -1 ||
    lowerPrompt.indexOf("multi-file") !== -1 ||
    lowerPrompt.indexOf("debug ") !== -1 ||
    lowerPrompt.indexOf("root cause") !== -1 ||
    lowerPrompt.indexOf("code review") !== -1
  ) {
    selectedTier = "tier2-daily";
    judgeReason = "smart_router_tier2_daily_pro";
    signalSummary = "Multi-File Refactor / Engineering Analysis";
    deterministicMatched = true;
  } else if (
    /^\s*(?:tell me\s+|what is\s+|calculate\s+|compute\s+)?\d+\s*[\+\-\*\/]\s*\d+\s*\??\s*$/i.test(
      promptText
    )
  ) {
    selectedTier = "tier1-fast";
    judgeReason = "smart_router_tier1_fast_flash";
    signalSummary = "Trivial Arithmetic / Instant Lookup (<180 chars)";
    deterministicMatched = true;
  }

  return {
    matched: deterministicMatched,
    tier: selectedTier,
    reason: judgeReason,
    signal: signalSummary,
    explicitModelChoice: explicitModelChoice
  };
}

function readSmartRouterPrompt(context) {
  return (
    context.getVariable("ai.latestUserPrompt") ||
    context.getVariable("prompt_text_for_armor") ||
    context.getVariable("ai.extractedPrompt") ||
    ""
  );
}

/**
 * Phase 1 (JS-PrepareSmartJudge): decide which classifier callout, if any, should run.
 *
 * `props` are the policy <Properties>:
 *   judgeBackend             "gemini" (LLM judge), "decisions" (rule-first + Decisions API),
 *                            "decisions-only" (pure Decisions API, bypasses keyword rules),
 *                            "custom" (SC-CustomClassifier) or
 *                            "heuristic" (rules + length fallback only, no callout)
 *   allowClassifierOverride  "true" lets the X-Router-Classifier request header choose the
 *                            backend per request. For benchmarking environments only.
 */
function runPrepareSmartJudge(context, props) {
  props = props || {};
  var promptText = readSmartRouterPrompt(context);
  var backend = String(props.judgeBackend || "gemini").toLowerCase().trim();
  if (String(props.allowClassifierOverride || "").toLowerCase() === "true") {
    var requested = String(
      context.getVariable("request.header.x-router-classifier") ||
        context.getVariable("request.header.X-Router-Classifier") ||
        ""
    )
      .toLowerCase()
      .trim();
    if (VALID_JUDGE_BACKENDS.indexOf(requested) !== -1) {
      backend = requested;
    }
  }
  if (VALID_JUDGE_BACKENDS.indexOf(backend) === -1) {
    backend = "gemini";
  }

  var skipRules = backend === "decisions-only";
  var rules = skipRules
    ? { matched: false }
    : evaluateSmartRouterRules(promptText);
  var hasPrompt = Boolean(String(promptText).replace(/\s+/g, ""));
  var callout = backend === "decisions-only" ? "decisions" : backend;
  if (!hasPrompt || backend === "heuristic" || (!skipRules && rules.matched)) {
    // A rule already decides (or there is nothing to classify): skip the network hop.
    callout = "none";
  }

  // Bounded JSON-escaped shared input for SC-DecisionsClassifier (well within 262,144 tokens).
  var boundedInput = String(promptText || "").slice(0, MAX_DECISIONS_INPUT_CHARS);
  context.setVariable("ai.decisionsInput", escapeJsonStringValue(boundedInput));
  context.setVariable("ai.decisionsSkipRules", skipRules ? "true" : "false");
  context.setVariable("ai.judgeBackendConfigured", backend);
  context.setVariable("ai.judgeBackend", callout);
  context.setVariable("ai.judgeRuleMatched", !skipRules && rules.matched ? "true" : "false");
  context.setVariable("ai.judgeStartMs", String(new Date().getTime()));
}

function sanitizeClassifierName(value) {
  // Ends up in a response header and in logs: keep it to a short, plain token.
  return String(value || "")
    .replace(/[^A-Za-z0-9._:-]/g, "")
    .slice(0, 64);
}

/**
 * Parse a Google Gemini Decisions API (POST /v1beta/decisions) response into a validated
 * Smart Router tier decision.
 *
 * Official response contract:
 *   {
 *     "answers": {
 *       "routing_tier": { "type": "choice", "choice": "tier2-daily", "confidence": 0.92, "probabilities": {...} },
 *       "needs_deep_reasoning": { "type": "noul", "noul": 0.12, "confidence": 0.88 }
 *     },
 *     "usage": { "total_input_tokens": 180, "total_output_tokens": 0, "total_tokens": 180 },
 *     "prompt_feedback": { "block_reason": "safety" } // optional; if set, answers is empty
 *   }
 *
 * Also supports score-type routing answers (argmax discrete level -> tier1/4/2/3).
 * Returns null on error, safety block, malformed JSON, or invalid tier so the caller
 * fails open to prompt-length fallback.
 */
function parseDecisionsApiResponse(raw, opts) {
  if (!raw) return null;
  opts = opts || {};
  var parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.error) return null;
  if (parsed.prompt_feedback && parsed.prompt_feedback.block_reason) return null;

  var answers = parsed.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;

  var tierAnswer = answers.routing_tier || null;
  if (!tierAnswer || typeof tierAnswer !== "object") {
    var aKeys = Object.keys(answers);
    for (var i = 0; i < aKeys.length; i++) {
      var cand = answers[aKeys[i]];
      if (cand && typeof cand === "object" && (cand.type === "choice" || cand.type === "score")) {
        tierAnswer = cand;
        break;
      }
    }
  }
  if (!tierAnswer || typeof tierAnswer !== "object") return null;

  var selectedTier = "";
  var confidence = NaN;
  var answerType = String(tierAnswer.type || "").toLowerCase();

  if (answerType === "choice") {
    selectedTier = normalizeTierOrLabel(tierAnswer.choice);
    if (!selectedTier) return null;
    confidence = parseFloat(tierAnswer.confidence);
    if (
      isNaN(confidence) &&
      tierAnswer.probabilities &&
      typeof tierAnswer.probabilities === "object" &&
      tierAnswer.choice !== undefined &&
      tierAnswer.probabilities[tierAnswer.choice] !== undefined
    ) {
      confidence = parseFloat(tierAnswer.probabilities[tierAnswer.choice]);
    }
  } else if (answerType === "score") {
    // Per Decisions API docs: pick the discrete level with the highest probability.
    var scoreLevelsToTier = ["tier1-fast", "tier4-open", "tier2-daily", "tier3-frontier"];
    var bestIdx = -1;
    var bestProb = -1;
    if (tierAnswer.probabilities && typeof tierAnswer.probabilities === "object") {
      var pKeys = Object.keys(tierAnswer.probabilities);
      for (var pk = 0; pk < pKeys.length; pk++) {
        var lvlIdx = parseInt(pKeys[pk], 10);
        var lvlProb = parseFloat(tierAnswer.probabilities[pKeys[pk]]);
        if (!isNaN(lvlIdx) && !isNaN(lvlProb) && lvlProb > bestProb) {
          bestProb = lvlProb;
          bestIdx = lvlIdx;
        }
      }
    }
    if (bestIdx >= 0 && bestIdx < scoreLevelsToTier.length) {
      selectedTier = scoreLevelsToTier[bestIdx];
    } else {
      var rawScore = parseFloat(tierAnswer.score);
      if (isNaN(rawScore)) return null;
      var clampedIdx = Math.max(0, Math.min(scoreLevelsToTier.length - 1, Math.round(rawScore)));
      selectedTier = scoreLevelsToTier[clampedIdx];
    }
    confidence = parseFloat(tierAnswer.confidence);
    if (isNaN(confidence) && bestProb >= 0) {
      confidence = bestProb;
    }
  } else {
    return null;
  }

  if (!isNaN(confidence)) {
    if (confidence < 0 || confidence > 1) {
      confidence = Math.max(0, Math.min(1, confidence));
    }
  }

  var minConfidence = parseFloat(
    opts.decisionsMinConfidence !== undefined && opts.decisionsMinConfidence !== ""
      ? opts.decisionsMinConfidence
      : "0.50"
  );
  var lowConfTierRaw = String(opts.decisionsLowConfidenceTier || "tier2-daily")
    .trim()
    .toLowerCase();
  var escalationThreshold = parseFloat(
    opts.decisionsEscalationThreshold !== undefined && opts.decisionsEscalationThreshold !== ""
      ? opts.decisionsEscalationThreshold
      : "0.85"
  );
  if (isNaN(escalationThreshold) || escalationThreshold <= 0 || escalationThreshold > 0.99) {
    escalationThreshold = 0.85;
  }

  var modelName = sanitizeClassifierName(opts.decisionsModel) || "gemini-decision-1";
  var lowConfidenceEscalated = false;
  var escalatedByNoul = false;
  var deepProb = NaN;

  if (!isNaN(confidence) && !isNaN(minConfidence) && minConfidence > 0 && confidence < minConfidence) {
    if (lowConfTierRaw === "fallback" || lowConfTierRaw === "abstain") {
      return null;
    }
    if (SMART_ROUTER_TIERS.indexOf(lowConfTierRaw) !== -1) {
      selectedTier = lowConfTierRaw;
      lowConfidenceEscalated = true;
    }
  }

  // Parallel `needs_deep_reasoning` binary noul check (evaluated in the same forward pass).
  // Escalates borderline choices (confidence < 0.75) when P(needs_deep_reasoning) >= threshold.
  if (!lowConfidenceEscalated && selectedTier !== "tier3-frontier") {
    var deepAnswer = answers.needs_deep_reasoning;
    if (deepAnswer && typeof deepAnswer === "object" && String(deepAnswer.type || "").toLowerCase() === "noul") {
      deepProb = parseFloat(deepAnswer.noul);
      if (
        !isNaN(deepProb) &&
        deepProb >= escalationThreshold &&
        (isNaN(confidence) || confidence < 0.75)
      ) {
        selectedTier = "tier3-frontier";
        escalatedByNoul = true;
      }
    }
  }

  var decisionsSignal = {
    "tier1-fast": "Lookup / Fast Turn",
    "tier4-open": "Self-Contained Codegen",
    "tier2-daily": "Multi-File Engineering",
    "tier3-frontier": "Architecture / Deep Reasoning"
  };

  var confRounded = !isNaN(confidence) ? Math.round(confidence * 1000) / 1000 : NaN;
  var reason;
  var signal;
  if (lowConfidenceEscalated) {
    reason =
      "decisions:low_confidence(" +
      (isNaN(confRounded) ? "0" : String(confRounded)) +
      ")->" +
      selectedTier;
    signal =
      "Gemini Decisions API (Low-Confidence Escalation): " +
      (decisionsSignal[selectedTier] || selectedTier);
  } else if (escalatedByNoul) {
    reason = "decisions:" + modelName + "->" + selectedTier + "(escalated)";
    signal =
      "Gemini Decisions API (Deep-Reasoning Escalation P=" +
      String(Math.round(deepProb * 100) / 100) +
      "): " +
      (decisionsSignal[selectedTier] || selectedTier);
  } else {
    reason = "decisions:" + modelName + "->" + selectedTier;
    signal = "Gemini Decisions API: " + (decisionsSignal[selectedTier] || selectedTier);
  }

  var usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {};
  var inputTokens = parseInt(usage.total_input_tokens || usage.total_tokens || "0", 10);
  if (isNaN(inputTokens) || inputTokens < 0) inputTokens = 0;
  var outputTokens = parseInt(usage.total_output_tokens || "0", 10);
  if (isNaN(outputTokens) || outputTokens < 0) outputTokens = 0;
  var costUsd = (inputTokens * DECISIONS_INPUT_COST_PER_1M_USD) / 1000000.0;

  return {
    tier: selectedTier,
    confidence: isNaN(confRounded) ? "" : String(confRounded),
    model: modelName,
    reason: reason,
    signal: signal,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    costUsd: costUsd,
    lowConfidenceEscalated: lowConfidenceEscalated,
    escalatedByNoul: escalatedByNoul
  };
}

function runApplySmartJudgeSelection(context, props) {
  props = props || {};
  var judgeResponseRaw =
    context.getVariable("smartJudgeResponse.content") ||
    context.getVariable("judgeResponse.content") ||
    "";
  var customResponseRaw = context.getVariable("customClassifierResponse.content") || "";
  var decisionsResponseRaw = context.getVariable("decisionsClassifierResponse.content") || "";
  var allowedTiers =
    context.getVariable("allowed_model_tiers") ||
    context.getVariable("auth.allowed_models") ||
    "tier1-fast,tier2-daily,tier4-open";
  var promptText = readSmartRouterPrompt(context);
  var skipRules = context.getVariable("ai.decisionsSkipRules") === "true";

  // 1. Deterministic rules win over classifiers unless `decisions-only` explicitly bypasses them.
  var rules = skipRules
    ? {
        matched: false,
        tier: "tier2-daily",
        reason: "complexity:medium->tier2-daily",
        signal: "Daily Multi-File Engineering",
        explicitModelChoice: null
      }
    : evaluateSmartRouterRules(promptText);
  var selectedTier = rules.tier;
  var judgeReason = rules.reason;
  var explicitModelChoice = rules.explicitModelChoice;
  var signalSummary = rules.signal;
  var deterministicMatched = rules.matched;
  var classifierUsed = deterministicMatched ? "rules" : "";
  var classifierModel = "";
  var classifierConfidence = "";
  var classifierInputTokens = 0;
  var classifierCostUsd = 0;

  // 2. Custom classifier (SC-CustomClassifier). Contract: a JSON object with either
  //    "tier" (one of SMART_ROUTER_TIERS) or "label" (SIMPLE|MEDIUM|COMPLEX|REASONING),
  //    optional "confidence", "classifier" and "abstain". Anything else is ignored and
  //    selection falls through, so a broken or custom classifier can never pick a tier
  //    the gateway does not know.
  var handledByCustom = false;
  if (!deterministicMatched && customResponseRaw) {
    try {
      var customParsed = JSON.parse(customResponseRaw);
      if (customParsed && typeof customParsed === "object" && !customParsed.abstain) {
        var customTier = normalizeTierOrLabel(customParsed.tier || customParsed.label);
        if (SMART_ROUTER_TIERS.indexOf(customTier) !== -1) {
          var customSignal = {
            "tier1-fast": "Lookup / Fast Turn",
            "tier4-open": "Self-Contained Codegen",
            "tier2-daily": "Multi-File Engineering",
            "tier3-frontier": "Architecture / Deep Reasoning"
          };
          handledByCustom = true;
          selectedTier = customTier;
          classifierUsed = "custom";
          classifierModel = sanitizeClassifierName(customParsed.classifier) || "custom";
          var customConfidence = parseFloat(customParsed.confidence);
          if (!isNaN(customConfidence)) {
            classifierConfidence = String(Math.round(customConfidence * 1000) / 1000);
          }
          judgeReason = "classifier:" + classifierModel + "->" + customTier;
          signalSummary = "Custom Classifier: " + customSignal[customTier];
        }
      }
    } catch (eCustom) {
      // Fall through to Decisions API / LLM judge response (if any), then the length fallback.
    }
  }

  // 3. Gemini Decisions API classifier (SC-DecisionsClassifier, gemini-decision-1).
  //    Returns calibrated probabilities & confidence with 0 output tokens.
  var handledByDecisions = false;
  if (!deterministicMatched && !handledByCustom && decisionsResponseRaw) {
    var decisionsResult = parseDecisionsApiResponse(decisionsResponseRaw, props);
    if (decisionsResult) {
      handledByDecisions = true;
      selectedTier = decisionsResult.tier;
      classifierUsed = "decisions";
      classifierModel = decisionsResult.model;
      classifierConfidence = decisionsResult.confidence;
      classifierInputTokens = decisionsResult.inputTokens;
      classifierCostUsd = decisionsResult.costUsd;
      judgeReason = decisionsResult.reason;
      signalSummary = decisionsResult.signal;
    }
  }

  // 4. LLM judge (SC-ModelJudge).
  var handledByJudge = false;
  if (!deterministicMatched && !handledByCustom && !handledByDecisions && judgeResponseRaw) {
    try {
      var parsed = JSON.parse(judgeResponseRaw);
      var textOut =
        parsed.candidates &&
        parsed.candidates[0] &&
        parsed.candidates[0].content &&
        parsed.candidates[0].content.parts &&
        parsed.candidates[0].content.parts[0] &&
        parsed.candidates[0].content.parts[0].text;
      if (textOut) {
        handledByJudge = true;
        classifierUsed = "gemini";
        var clean = textOut.trim().toLowerCase();
        if (clean.indexOf("tier1-fast") !== -1 || clean.indexOf("simple") !== -1) {
          selectedTier = "tier1-fast";
          judgeReason = "judge:SIMPLE->tier1-fast";
          signalSummary = "LLM Judge: SIMPLE Lookup / Fast Turn";
        } else if (
          clean.indexOf("tier3-frontier") !== -1 ||
          clean.indexOf("reasoning") !== -1
        ) {
          selectedTier = "tier3-frontier";
          judgeReason = "judge:REASONING->tier3-frontier";
          signalSummary = "LLM Judge: REASONING / Frontier Architecture";
        } else if (
          clean.indexOf("tier4-open") !== -1 ||
          clean.indexOf("medium") !== -1
        ) {
          selectedTier = "tier4-open";
          judgeReason = "judge:MEDIUM->tier4-open";
          signalSummary = "LLM Judge: MEDIUM / Open-Weight Specialist";
        } else {
          selectedTier = "tier2-daily";
          judgeReason = "judge:COMPLEX->tier2-daily";
          signalSummary = "LLM Judge: COMPLEX / Daily Pro Driver";
        }
      }
    } catch (e) {
      // Fallback heuristic below
    }
  }
  // 5. Nothing answered (callout skipped, failed, timed out or abstained): prompt length.
  if (!deterministicMatched && !handledByCustom && !handledByDecisions && !handledByJudge) {
    classifierUsed = "length-fallback";
    if (promptText.length < 180) {
      selectedTier = "tier1-fast";
      judgeReason = "smart_router_tier1_fast_flash";
      signalSummary = "Short Prompt / Fast Turn (<180 chars)";
    } else {
      selectedTier = "tier2-daily";
      judgeReason = "smart_router_tier2_daily_pro";
      signalSummary = "Multi-Turn Coding / Daily Pro Driver";
    }
  }

  if (
    selectedTier === "tier3-frontier" &&
    allowedTiers.indexOf("tier3-frontier") === -1 &&
    allowedTiers.indexOf("opus") === -1
  ) {
    selectedTier = "tier2-daily";
    judgeReason = judgeReason + "(rbac_capped->tier2-daily)";
  }

  // Gate O3: Tier-4 cap for standard tier or profiles without open-weight models
  if (
    selectedTier === "tier4-open" &&
    allowedTiers.indexOf("tier4-open") === -1
  ) {
    selectedTier = "tier2-daily";
    judgeReason = judgeReason + "(rbac_capped->tier2-daily)";
  }

  var chosen = {
    canonicalId: "gemini-3.1-pro-preview",
    vertexModelId: "gemini-3.1-pro-preview",
    family: "gemini",
    tier: "tier2-daily",
    region: "global",
    vertexHost: "aiplatform.googleapis.com",
    inputCostPer1M: "2.00",
    outputCostPer1M: "12.00"
  };

  if (selectedTier === "tier1-fast") {
    // gemini-3.5-flash-lite is reserved strictly for SC-ModelJudge classification;
    // small Gemini coding & lookup turns route to gemini-3.8-flash.
    chosen = {
      canonicalId: "gemini-3.8-flash",
      vertexModelId: "gemini-3.8-flash",
      family: "gemini",
      tier: "tier1-fast",
      region: "global",
      vertexHost: "aiplatform.googleapis.com",
      inputCostPer1M: "0.15",
      outputCostPer1M: "0.60"
    };
  } else if (selectedTier === "tier3-frontier") {
    chosen = {
      canonicalId: "claude-opus-4-7",
      vertexModelId: "claude-opus-4-7",
      family: "anthropic",
      tier: "tier3-frontier",
      region: "global",
      vertexHost: "aiplatform.googleapis.com",
      inputCostPer1M: "15.00",
      outputCostPer1M: "75.00"
    };
  } else if (selectedTier === "tier4-open") {
    if (explicitModelChoice) {
      chosen = explicitModelChoice;
    } else {
      chosen = {
        canonicalId: "glm-5.2",
        vertexModelId: "zai-org/glm-5.2-maas",
        family: "openapi_maas",
        tier: "tier4-open",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "0.80",
        outputCostPer1M: "0.80"
      };
    }
  }

  // Respect X-Switchyard-Model-Map (high=...,mid=...,low=...) when auto routing is used
  var switchyardHigh = context.getVariable("ai.switchyardModelHigh") || "";
  var switchyardMid = context.getVariable("ai.switchyardModelMid") || "";
  var switchyardLow = context.getVariable("ai.switchyardModelLow") || "";
  var customTargetId = "";
  if (selectedTier === "tier1-fast" && switchyardLow) {
    customTargetId = switchyardLow;
  } else if (
    (selectedTier === "tier2-daily" || selectedTier === "tier4-open") &&
    switchyardMid
  ) {
    customTargetId = switchyardMid;
  } else if (selectedTier === "tier3-frontier" && switchyardHigh) {
    customTargetId = switchyardHigh;
  }
  if (customTargetId) {
    var CUSTOM_MAP_CATALOG = {
      "claude-haiku-4-5": {
        canonicalId: "claude-haiku-4-5",
        vertexModelId: "claude-haiku-4-5@20251001",
        family: "anthropic",
        tier: "tier1-fast",
        region: "us-east5",
        vertexHost: "us-east5-aiplatform.googleapis.com",
        inputCostPer1M: "0.80",
        outputCostPer1M: "4.00"
      },
      "claude-haiku-5-5": {
        canonicalId: "claude-haiku-5-5",
        vertexModelId: "claude-haiku-5-5",
        family: "anthropic",
        tier: "tier1-fast",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "0.80",
        outputCostPer1M: "4.00"
      },
      "claude-sonnet-4-6": {
        canonicalId: "claude-sonnet-4-6",
        vertexModelId: "claude-sonnet-4-6",
        family: "anthropic",
        tier: "tier2-daily",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "3.00",
        outputCostPer1M: "15.00"
      },
      "claude-sonnet-5-5": {
        canonicalId: "claude-sonnet-5-5",
        vertexModelId: "claude-sonnet-5-5",
        family: "anthropic",
        tier: "tier2-daily",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "3.00",
        outputCostPer1M: "15.00"
      },
      "claude-opus-4-8": {
        canonicalId: "claude-opus-5-5",
        vertexModelId: "claude-opus-5-5",
        family: "anthropic",
        tier: "tier3-frontier",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "15.00",
        outputCostPer1M: "75.00"
      },
      "claude-opus-5-5": {
        canonicalId: "claude-opus-5-5",
        vertexModelId: "claude-opus-5-5",
        family: "anthropic",
        tier: "tier3-frontier",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "15.00",
        outputCostPer1M: "75.00"
      },
      "gemini-4-argon": {
        canonicalId: "gemini-4-argon",
        vertexModelId: "gemini-4-argon",
        family: "gemini",
        tier: "tier3-frontier",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "2.00",
        outputCostPer1M: "12.00"
      },
      "gemini-3.5-pro": {
        canonicalId: "gemini-4-argon",
        vertexModelId: "gemini-4-argon",
        family: "gemini",
        tier: "tier3-frontier",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "2.00",
        outputCostPer1M: "12.00"
      },
      "gemini-3.8-flash": {
        canonicalId: "gemini-3.8-flash",
        vertexModelId: "gemini-3.8-flash",
        family: "gemini",
        tier: "tier1-fast",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "0.15",
        outputCostPer1M: "0.60"
      },
      "gemini-3.5-flash-lite": {
        canonicalId: "gemini-3.5-flash-lite",
        vertexModelId: "gemini-3.5-flash-lite",
        family: "gemini",
        tier: "tier1-fast",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "0.075",
        outputCostPer1M: "0.30"
      },
      "qwen3-coder": {
        canonicalId: "qwen3-coder",
        vertexModelId: "qwen/qwen3-coder-480b-a35b-instruct-maas",
        family: "openapi_maas",
        tier: "tier4-open",
        region: "us-central1",
        vertexHost: "us-central1-aiplatform.googleapis.com",
        inputCostPer1M: "0.90",
        outputCostPer1M: "0.90"
      },
      "glm-5.2": {
        canonicalId: "glm-5.2",
        vertexModelId: "zai-org/glm-5.2-maas",
        family: "openapi_maas",
        tier: "tier4-open",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "0.80",
        outputCostPer1M: "0.80"
      },
      "deepseek-v4.1-flash": {
        canonicalId: "deepseek-v4.1-flash",
        vertexModelId: "deepseek-ai/deepseek-v4.1-flash-maas",
        family: "openapi_maas",
        tier: "tier4-open",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "0.20",
        outputCostPer1M: "0.80"
      },
      "gpt-oss-120b": {
        canonicalId: "gpt-oss-120b",
        vertexModelId: "openai/gpt-oss-120b-maas",
        family: "openapi_maas",
        tier: "tier4-open",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "0.40",
        outputCostPer1M: "1.20"
      },
      "llama-4-maverick": {
        canonicalId: "llama-4-maverick",
        vertexModelId: "meta/llama-4-maverick-17b-128e-instruct-maas",
        family: "openapi_maas",
        tier: "tier4-open",
        region: "us-east5",
        vertexHost: "us-east5-aiplatform.googleapis.com",
        inputCostPer1M: "0.25",
        outputCostPer1M: "0.75"
      },
      "llama-4-scout": {
        canonicalId: "llama-4-scout",
        vertexModelId: "meta/llama-4-scout-17b-16e-instruct-maas",
        family: "openapi_maas",
        tier: "tier4-open",
        region: "us-east5",
        vertexHost: "us-east5-aiplatform.googleapis.com",
        inputCostPer1M: "0.25",
        outputCostPer1M: "0.75"
      },
      "gemma-4-26b": {
        canonicalId: "gemma-4-26b",
        vertexModelId: "google/gemma-4-26b-a4b-it-maas",
        family: "openapi_maas",
        tier: "tier4-open",
        region: "global",
        vertexHost: "aiplatform.googleapis.com",
        inputCostPer1M: "0.15",
        outputCostPer1M: "0.45"
      }
    };
    if (CUSTOM_MAP_CATALOG[customTargetId]) {
      chosen = CUSTOM_MAP_CATALOG[customTargetId];
      judgeReason = judgeReason + "(switchyard_map->" + chosen.canonicalId + ")";
    }
  }

  // Gate C4: Final RBAC validation check on chosen model against allowed tiers
  var allowedParts = allowedTiers.split(",");
  var isChosenAllowed = false;
  for (var aIdx = 0; aIdx < allowedParts.length; aIdx++) {
    var aTier = allowedParts[aIdx].trim();
    if (aTier === chosen.tier || aTier === chosen.canonicalId) {
      isChosenAllowed = true;
      break;
    }
  }
  if (!isChosenAllowed) {
    chosen = {
      canonicalId: "gemini-3.1-pro-preview",
      vertexModelId: "gemini-3.1-pro-preview",
      family: "gemini",
      tier: "tier2-daily",
      region: "global",
      vertexHost: "aiplatform.googleapis.com",
      inputCostPer1M: "2.00",
      outputCostPer1M: "12.00"
    };
    judgeReason = judgeReason + "(rbac_capped->tier2-daily)";
  }

  context.setVariable("target_model_id", chosen.canonicalId);
  context.setVariable("ai.selectedModel", chosen.canonicalId);
  context.setVariable("vertex_model_id", chosen.vertexModelId);
  context.setVariable("target_model_family", chosen.family);
  context.setVariable("ai.targetFamily", chosen.family);
  context.setVariable("target_model_tier", chosen.tier);
  context.setVariable("vertex_region", chosen.region);
  context.setVariable("ai.vertexRegion", chosen.region);
  context.setVariable("vertex_host", chosen.vertexHost);
  context.setVariable("ai.vertexHost", chosen.vertexHost);
  context.setVariable("model_input_cost_1m", chosen.inputCostPer1M);
  context.setVariable("model_output_cost_1m", chosen.outputCostPer1M);
  context.setVariable("smart_judge_reason", judgeReason);
  context.setVariable("ai.smartJudgeReason", judgeReason);
  context.setVariable("smart_router_decision", judgeReason);
  context.setVariable("ai.smartRouterDecision", judgeReason);
  context.setVariable("routing_mode", "smart_auto");
  context.setVariable("ai.routingMode", "smart_auto");
  context.setVariable("recommended_tier", chosen.tier);
  context.setVariable("ai.recommendedTier", chosen.tier);
  context.setVariable("recommended_model", chosen.canonicalId);
  context.setVariable("ai.recommendedModel", chosen.canonicalId);
  context.setVariable("recommended_in_rate", chosen.inputCostPer1M);
  context.setVariable("recommended_out_rate", chosen.outputCostPer1M);

  // Build human-readable Smart Router explanation badge for Codex / CLI auto-mode visibility
  var tierLabelMap = {
    "tier1-fast": "Tier 1 Ultra-Fast · Cheapest",
    "tier2-daily": "Tier 2 Daily Driver · Balanced",
    "tier3-frontier": "Tier 3 Frontier Reasoning · Deepest",
    "tier4-open": "Tier 4 Open-Weight Specialist · High-Efficiency"
  };
  var outRateNum = parseFloat(chosen.outputCostPer1M || "12.00");
  var opusSavingsPct = Math.max(0, Math.round(((75.0 - outRateNum) / 75.0) * 100));
  var costNote =
    chosen.family === "gemini"
      ? "$" +
        chosen.inputCostPer1M +
        "/$" +
        chosen.outputCostPer1M +
        "/1M list · $0 Net via Gemini Credits (" +
        opusSavingsPct +
        "% cheaper vs Opus)"
      : opusSavingsPct > 0
      ? "$" +
        chosen.inputCostPer1M +
        "/$" +
        chosen.outputCostPer1M +
        "/1M (" +
        opusSavingsPct +
        "% cheaper vs Opus)"
      : "$" + chosen.inputCostPer1M + "/$" + chosen.outputCostPer1M + "/1M (Frontier Max)";

  var smartRouterBadge =
    "⚡ **Vertex Smart Router (`auto`)** → **`" +
    chosen.canonicalId +
    "`** (" +
    (tierLabelMap[chosen.tier] || chosen.tier) +
    ") · **Why:** " +
    signalSummary +
    " (`" +
    judgeReason +
    "`) · **Cost:** " +
    costNote;
  context.setVariable("ai.smartRouterBadge", smartRouterBadge);

  // Classifier telemetry (response headers and FinOps log read these).
  //   ai.routerClassifier      rules | custom | decisions | gemini | length-fallback
  //   ai.routerClassifierMs    wall time between the prepare phase and this step, i.e. the
  //                            classifier callout as the gateway experienced it (0 if skipped)
  var calloutBackend = context.getVariable("ai.judgeBackend") || "";
  var judgeStartMs = parseInt(context.getVariable("ai.judgeStartMs") || "0", 10);
  var classifierMs = "";
  if (judgeStartMs > 0) {
    classifierMs =
      calloutBackend === "gemini" ||
      calloutBackend === "custom" ||
      calloutBackend === "decisions"
        ? String(Math.max(0, new Date().getTime() - judgeStartMs))
        : "0";
  }
  context.setVariable("ai.routerClassifier", classifierUsed);
  context.setVariable("ai.routerClassifierAttempted", calloutBackend);
  context.setVariable("ai.routerClassifierMs", classifierMs);
  context.setVariable("ai.routerClassifierModel", classifierModel);
  context.setVariable("ai.routerClassifierConfidence", classifierConfidence);
  if (classifierInputTokens > 0) {
    context.setVariable("ai.routerClassifierInputTokens", String(classifierInputTokens));
    context.setVariable("ai.routerClassifierCostUsd", classifierCostUsd.toFixed(8));
  }
}

if (typeof context !== "undefined") {
  // `properties` is the JavaScript policy's <Properties> block; it only exists in Apigee.
  var smartJudgePolicyProps =
    typeof properties !== "undefined" && properties ? properties : null;
  if (smartJudgePolicyProps && String(smartJudgePolicyProps.phase || "") === "prepare") {
    runPrepareSmartJudge(context, smartJudgePolicyProps);
  } else {
    runApplySmartJudgeSelection(context, smartJudgePolicyProps);
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    runApplySmartJudgeSelection: runApplySmartJudgeSelection,
    runPrepareSmartJudge: runPrepareSmartJudge,
    evaluateSmartRouterRules: evaluateSmartRouterRules,
    parseDecisionsApiResponse: parseDecisionsApiResponse
  };
}
