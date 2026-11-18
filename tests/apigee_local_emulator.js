/**
 * apigee_local_emulator.js
 * Apigee X Pipeline Runtime & Vertex AI Model Garden Gateway.
 * Executes the production JavaScript policies from `src/ai-functions/*.js`
 * and enforces the feature policies from `features/*.yaml`.
 *
 * Supports two backend modes:
 *   - Default (`USE_LIVE_VERTEX != "true"`): Deterministic mock Vertex AI Model Garden
 *     with strict Vertex AI wire-contract validation for CI/offline verification.
 *   - Live GCP (`USE_LIVE_VERTEX="true"`): Calls LIVE Google Cloud Vertex AI Model Garden
 *     endpoints in `GCP_PROJECT_ID` over HTTPS using Application Default Credentials,
 *     supporting real unbuffered SSE streaming.
 */
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const readline = require("readline");
const { execFileSync } = require("child_process");

const { runExtractAuthMode, isJwtFormat } = require("../src/ai-functions/extractAuthMode");
const {
  runSanitizeAntigravityTelemetry,
  isTelemetryPath
} = require("../src/ai-functions/sanitizeAntigravityTelemetry");
const { runParseAndValidateModelRequest } = require("../src/ai-functions/parseAndValidateModelRequest");
const {
  runApplySmartJudgeSelection,
  runPrepareSmartJudge
} = require("../src/ai-functions/applySmartJudgeSelection");
const { runTransformPayload } = require("../src/ai-functions/transformPayload");
const { runTransformResponseAndCost } = require("../src/ai-functions/transformResponseAndCost");
const { runTransformStreamEvent } = require("../src/ai-functions/transformStreamEvent");
const { runPrepareVertexFallbackPayload } = require("../src/ai-functions/prepareVertexFallbackPayload");

class ApigeeContext {
  constructor(initialVars) {
    this.vars = Object.assign({}, initialVars);
  }
  getVariable(name) {
    return this.vars[name];
  }
  setVariable(name, value) {
    this.vars[name] = value;
  }
}

const USE_LIVE_VERTEX =
  process.env.USE_LIVE_VERTEX === "true" || process.env.LIVE_VERTEX === "true";
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "mock-gcp-project";
const MAX_REQUEST_BODY_BYTES = parseInt(
  process.env.MAX_REQUEST_BODY_BYTES || String(10 * 1024 * 1024),
  10
);

let cachedVertexToken = process.env.VERTEX_ACCESS_TOKEN || "";
let cachedVertexTokenAt = cachedVertexToken ? Date.now() : 0;

function fetchMetadataToken() {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "metadata.google.internal",
        port: 80,
        path: "/computeMetadata/v1/instance/service-accounts/default/token",
        headers: { "Metadata-Flavor": "Google" },
        timeout: 2500
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.access_token || "");
          } catch (e) {
            resolve("");
          }
        });
      }
    );
    req.on("error", () => resolve(""));
    req.on("timeout", () => {
      req.destroy();
      resolve("");
    });
  });
}

async function getFreshVertexToken() {
  if (cachedVertexToken && Date.now() - cachedVertexTokenAt < 25 * 60 * 1000) {
    return cachedVertexToken;
  }
  const metaToken = await fetchMetadataToken();
  if (metaToken) {
    cachedVertexToken = metaToken;
    cachedVertexTokenAt = Date.now();
    return cachedVertexToken;
  }
  try {
    const out = execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
      encoding: "utf8",
      timeout: 8000
    }).trim();
    if (out) {
      cachedVertexToken = out;
      cachedVertexTokenAt = Date.now();
    }
  } catch (e) {
    // Fallback to existing cachedVertexToken
  }
  return cachedVertexToken;
}

// Never fall back to hardcoded API keys or static OIDC tokens in live mode.
// Keys must be injected via Secret Manager / environment variables.
const STD_API_KEY =
  process.env.GATEWAY_STD_API_KEY || process.env.TEST_STD_API_KEY || "";
const FRONTIER_API_KEY =
  process.env.GATEWAY_FRONTIER_API_KEY || process.env.TEST_FRONTIER_API_KEY || "";
const QUOTA_TINY_API_KEY =
  process.env.GATEWAY_QUOTA_TINY_API_KEY || process.env.TEST_QUOTA_TINY_API_KEY || "";
const SERVICE_API_KEY =
  process.env.GATEWAY_SERVICE_API_KEY || process.env.TEST_SERVICE_API_KEY || "";
const VALID_OIDC_TOKEN = !USE_LIVE_VERTEX ? process.env.TEST_OIDC_TOKEN || "" : "";
const ALLOW_TEST_HOOKS = !USE_LIVE_VERTEX || process.env.ALLOW_TEST_HOOKS === "true";

// Support per-developer API keys via GATEWAY_API_KEYS_JSON (AUTH-1)
let PER_DEV_API_KEYS = Object.create(null);
try {
  if (process.env.GATEWAY_API_KEYS_JSON) {
    const parsedKeys = JSON.parse(process.env.GATEWAY_API_KEYS_JSON);
    if (parsedKeys && typeof parsedKeys === "object") {
      PER_DEV_API_KEYS = parsedKeys;
    }
  }
} catch (e) {}

const developerTokenLedger = Object.create(null);
const developerUsdLedger = Object.create(null);
const semanticCacheStore = Object.create(null);
const MAX_CACHE_ENTRIES = 1000;

// Enterprise FinOps & Antigravity Gemini Credit Pool Ledger
const finopsLedger = {
  totalRequests: 0,
  totalTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  thoughtsTokens: 0,
  actualCostUsd: 0.0,
  routerCostUsd: 0.0,
  frontierBaselineCostUsd: 0.0,
  routingSavingsUsd: 0.0,
  avoidableFrontierSpendUsd: 0.0,
  frontierOverkillTurns: 0,
  routerOverrideTurns: 0,
  subagentTurns: 0,
  budgetWarningTurns: 0,
  budgetDowngradedTurns: 0,
  budgetHardBlockedTurns: 0,
  postClientFlowLogs: 0,
  failover429Deflections: 0,
  geminiPoolRequests: 0,
  geminiPoolTokens: 0,
  geminiCreditBurnedUsd: 0.0,
  gcpCommitRequests: 0,
  gcpCommitTokens: 0,
  gcpCommitListCostUsd: 0.0,
  netCashCostUsd: 0.0,
  latencyMsSum: 0,
  ttftMsSum: 0,
  ingestionSuppressedTurns: 0,
  byDeveloper: Object.create(null),
  byGatewayKey: Object.create(null),
  byCredentialType: Object.create(null),
  byTeam: Object.create(null),
  byHarness: Object.create(null),
  byModel: Object.create(null),
  byRoutingMode: Object.create(null),
  byWorkloadCategory: Object.create(null),
  byProject: Object.create(null),
  byJudgeDecision: Object.create(null),
  recentFinopsLogs: []
};

const GATEWAY_MODEL_DISCOVERY_CATALOG = [
  {
    id: "auto",
    aliases: ["smart-router", "switchyard-auto"],
    tier: "dynamic",
    family: "smart_router",
    vertex_model_id: "dynamic (tier1-fast | tier4-open | tier2-daily | tier3-frontier)",
    description:
      "Unbiased 4-Tier Smart Router (Gemini 3.8 Flash -> Qwen3 Coder / DeepSeek V4.1 -> Gemini 4 Argon / Sonnet 5.5 -> Claude Opus 5.5 / 4.7)",
    pricing_per_1m_usd: { input: 0.15, output: 0.6 },
    funding_pool: "DYNAMIC_OPTIMIZED"
  },
  {
    id: "gemini-4-argon",
    aliases: ["gemini-4-argon-cyber-permissive"],
    tier: "tier3-frontier",
    family: "gemini",
    vertex_model_id: "gemini-4-argon",
    description: "Google Gemini 4 Argon (GA Oct 2026) — 1M unified context frontier model for deep coding, architecture, and cybersecurity",
    pricing_per_1m_usd: { input: 2.0, output: 12.0 },
    funding_pool: "ANTIGRAVITY_GEMINI_CREDITS"
  },
  {
    id: "gemini-3.8-flash",
    aliases: ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"],
    tier: "tier1-fast",
    family: "gemini",
    vertex_model_id: "gemini-3.8-flash",
    description: "Google Gemini 3.8 Flash (GA Sept 2026) — Intelligent workhorse model for full-stack refactoring & agentic orchestration",
    pricing_per_1m_usd: { input: 0.15, output: 0.6 },
    funding_pool: "ANTIGRAVITY_GEMINI_CREDITS"
  },
  {
    id: "gemini-3.5-flash-lite",
    aliases: ["gemini-3.1-flash-lite-preview"],
    tier: "tier1-fast",
    family: "gemini",
    vertex_model_id: "gemini-3.5-flash-lite",
    description: "Google Gemini 3.5 Flash-Lite (GA July 2026) — Ultra-low-latency model for sub-agents, routing judge, and fast coding tasks",
    pricing_per_1m_usd: { input: 0.075, output: 0.3 },
    funding_pool: "ANTIGRAVITY_GEMINI_CREDITS"
  },
  {
    id: "gemini-decision-1",
    aliases: [],
    tier: "tier1-fast",
    family: "gemini_decisions",
    vertex_model_id: "gemini-decision-1",
    description: "Google Gemini Decision 1 (v1beta Decisions API) — Calibrated yes/no (noul), choice, and score decisions with 0 output tokens ($0.10/1M input)",
    pricing_per_1m_usd: { input: 0.1, output: 0.0 },
    funding_pool: "ANTIGRAVITY_GEMINI_CREDITS"
  },
  {
    id: "gemini-3.1-pro-preview",
    aliases: ["gemini-3.1-pro"],
    tier: "tier2-daily",
    family: "gemini",
    vertex_model_id: "gemini-3.1-pro-preview",
    description: "1M-context daily agentic coding & multi-file refactoring (Zero-Cost Antigravity Credit Pool)",
    pricing_per_1m_usd: { input: 2.0, output: 12.0 },
    funding_pool: "ANTIGRAVITY_GEMINI_CREDITS"
  },
  {
    id: "claude-opus-5-5",
    aliases: ["claude-opus-5", "claude-opus-5-5@default"],
    tier: "tier3-frontier",
    family: "anthropic",
    vertex_model_id: "claude-opus-5-5",
    description: "Anthropic Claude Opus 5.5 on Google Cloud (GA Sept 2026) — 1M input / 128K output flagship frontier model for long-running agents",
    pricing_per_1m_usd: { input: 15.0, output: 75.0 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "claude-fable-5-1",
    aliases: ["claude-fable-5", "fable"],
    tier: "tier3-frontier",
    family: "anthropic",
    vertex_model_id: "claude-fable-5-1",
    description: "Anthropic Claude Fable 5.1 on Google Cloud (GA Sept 2026) — Autonomous multi-day coding & asynchronous agent harness model",
    pricing_per_1m_usd: { input: 15.0, output: 75.0 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "claude-sonnet-5-5",
    aliases: ["claude-sonnet-5", "claude-sonnet-5-5@default"],
    tier: "tier2-daily",
    family: "anthropic",
    vertex_model_id: "claude-sonnet-5-5",
    description: "Anthropic Claude Sonnet 5.5 on Google Cloud (GA Sept 2026) — 1M context daily coding, agents, and tool use at scale",
    pricing_per_1m_usd: { input: 3.0, output: 15.0 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "claude-haiku-5-5",
    aliases: ["claude-haiku-5-5@default"],
    tier: "tier1-fast",
    family: "anthropic",
    vertex_model_id: "claude-haiku-5-5",
    description: "Anthropic Claude Haiku 5.5 on Google Cloud (GA Oct 2026) — High-speed, cost-effective model for coding and sub-agents",
    pricing_per_1m_usd: { input: 0.8, output: 4.0 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "claude-sonnet-4-6",
    aliases: ["sonnet", "claude-sonnet-4-6@default"],
    tier: "tier2-daily",
    family: "anthropic",
    vertex_model_id: "claude-sonnet-4-6",
    description: "Anthropic Claude Sonnet 4.6 on Google Cloud rawPredict (GCP Commit + FSP Discount)",
    pricing_per_1m_usd: { input: 3.0, output: 15.0 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "claude-opus-4-7",
    aliases: ["opus", "claude-opus-4-8", "claude-opus-4-7@default"],
    tier: "tier3-frontier",
    family: "anthropic",
    vertex_model_id: "claude-opus-4-7",
    description: "Anthropic Claude Opus 4.7 / 4.8 Frontier reasoning on Google Cloud (RBAC gated to coding-agent-frontier)",
    pricing_per_1m_usd: { input: 15.0, output: 75.0 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "deepseek-v4.1-flash",
    aliases: ["deepseek-ai/deepseek-v4.1-flash-maas"],
    tier: "tier4-open",
    family: "openapi_maas",
    vertex_model_id: "deepseek-ai/deepseek-v4.1-flash-maas",
    description: "DeepSeek V4.1 Flash (1M context multimodal MoE for agentic coding) on Google Cloud Managed MaaS",
    pricing_per_1m_usd: { input: 0.2, output: 0.8 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "deepseek-v3.2",
    aliases: ["deepseek-ai/deepseek-v3.2-maas", "deepseek-r1"],
    tier: "tier4-open",
    family: "openapi_maas",
    vertex_model_id: "deepseek-ai/deepseek-v3.2-maas",
    description: "DeepSeek V3.2 / R1 Reasoning on Google Cloud Managed MaaS (Zero-Retention VPC)",
    pricing_per_1m_usd: { input: 0.27, output: 1.1 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "glm-5.2",
    aliases: ["glm-5", "glm-4.7", "zai-org/glm-5.2-maas"],
    tier: "tier4-open",
    family: "openapi_maas",
    vertex_model_id: "zai-org/glm-5.2-maas",
    description: "GLM 5.2 (1M context long-horizon agentic coding) on Google Cloud Managed MaaS",
    pricing_per_1m_usd: { input: 0.8, output: 0.8 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "qwen3-coder",
    aliases: ["qwen/qwen3-coder-480b-a35b-instruct-maas"],
    tier: "tier4-open",
    family: "openapi_maas",
    vertex_model_id: "qwen/qwen3-coder-480b-a35b-instruct-maas",
    description: "Qwen3 Coder 480B A35B Instruct on Google Cloud Managed MaaS (Zero-Retention VPC)",
    pricing_per_1m_usd: { input: 0.9, output: 0.9 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "qwen3-next-80b-thinking",
    aliases: ["qwen3-next-80b-instruct", "qwen/qwen3-next-80b-a3b-thinking-maas"],
    tier: "tier4-open",
    family: "openapi_maas",
    vertex_model_id: "qwen/qwen3-next-80b-a3b-thinking-maas",
    description: "Qwen3-Next-80B Thinking & Instruct for complex software reasoning on Google Cloud Managed MaaS",
    pricing_per_1m_usd: { input: 0.45, output: 1.2 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "kimi-k2",
    aliases: ["moonshotai/kimi-k2-thinking-maas"],
    tier: "tier4-open",
    family: "openapi_maas",
    vertex_model_id: "moonshotai/kimi-k2-thinking-maas",
    description: "Kimi K2 Thinking step-by-step tool-calling agent model on Google Cloud Managed MaaS",
    pricing_per_1m_usd: { input: 0.6, output: 2.5 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "kimi-k2.6",
    aliases: ["moonshotai/kimi-k2.6-maas"],
    tier: "tier4-open",
    family: "openapi_maas",
    vertex_model_id: "moonshotai/kimi-k2-thinking-maas",
    description: "Kimi K2.6 Thinking step-by-step tool-calling agent model on Google Cloud Managed MaaS",
    pricing_per_1m_usd: { input: 0.6, output: 2.5 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "gemma-4-26b",
    aliases: ["google/gemma-4-26b-a4b-it-maas", "minimax-m2", "gpt-oss-120b", "llama-4-maverick"],
    tier: "tier4-open",
    family: "openapi_maas",
    vertex_model_id: "google/gemma-4-26b-a4b-it-maas",
    description: "Google DeepMind Gemma 4 26B A4B IT open-weight model on Google Cloud Managed MaaS",
    pricing_per_1m_usd: { input: 0.15, output: 0.45 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "grok-4.7",
    aliases: ["grok-4.6", "grok-4.20-reasoning", "codestral-2"],
    tier: "tier2-daily",
    family: "openapi_maas",
    vertex_model_id: "xai/grok-4.7",
    description: "xAI Grok 4.7 & Mistral Codestral 2 Partner Models on Google Cloud",
    pricing_per_1m_usd: { input: 2.0, output: 10.0 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  },
  {
    id: "muse-spark-1-3",
    aliases: ["meta/muse-spark-1.3", "muse-spark"],
    tier: "tier2-daily",
    family: "openapi_maas",
    vertex_model_id: "meta/muse-spark-1.3",
    description: "Meta Muse Spark 1.3 (1M Context MCP Agentic Coding) Partner Model on Google Cloud",
    pricing_per_1m_usd: { input: 1.5, output: 6.0 },
    funding_pool: "GCP_COMMIT_FSP_DISCOUNT"
  }
];

function recordFinOpsTransaction(ctx, totalTokens) {
  if (!ctx || ctx.getVariable("is_count_tokens") === "true") return;
  const targetModel = ctx.getVariable("target_model_id") || "gemini-3.8-flash";
  const targetFamily = ctx.getVariable("target_model_family") || "gemini";
  const targetTier = ctx.getVariable("target_model_tier") || "tier1-fast";
  const harness = ctx.getVariable("coding_harness") || "unknown";
  const devEmail = ctx.getVariable("developer_email") || "anonymous@example.com";
  const teamName = ctx.getVariable("developer_team") || "platform-engineering";
  const costCenter = ctx.getVariable("developer_cost_center") || "CC-AI-ENG-001";
  const quotaLimit = parseInt(ctx.getVariable("developer_daily_token_quota") || "5000000", 10);

  // Read unary OR streaming flow variables computed by transformResponseAndCost / transformStreamEvent
  const rawEst = ctx.getVariable("estimated_cost_usd") || ctx.getVariable("ai.estimatedCostUsd") || "";
  const rawBase =
    ctx.getVariable("frontier_baseline_cost_usd") ||
    ctx.getVariable("ai.frontierBaselineCostUsd") ||
    "";
  const rawSave =
    ctx.getVariable("routing_savings_usd") || ctx.getVariable("ai.routingSavingsUsd") || "";
  let estCost = parseFloat(rawEst || "0");
  let baselineCost = parseFloat(rawBase || "0");
  let savingsUsd = parseFloat(rawSave || "0");
  const toks = Math.max(0, parseInt(String(totalTokens || 0), 10));

  if (rawEst && !ctx.getVariable("estimated_cost_usd")) {
    ctx.setVariable("estimated_cost_usd", Number(estCost).toFixed(6));
    ctx.setVariable("frontier_baseline_cost_usd", Number(baselineCost).toFixed(6));
    ctx.setVariable("routing_savings_usd", Number(savingsUsd).toFixed(6));
    const sPct = baselineCost > 0 ? ((savingsUsd / baselineCost) * 100.0).toFixed(1) + "%" : "0.0%";
    ctx.setVariable("routing_savings_pct", sPct);
    if (ctx.getVariable("ai.fundingPool") && !ctx.getVariable("funding_pool")) {
      ctx.setVariable("funding_pool", ctx.getVariable("ai.fundingPool"));
    }
  }

  // Fallback only if neither unary nor streaming JS callout computed cost
  if (!rawEst && toks > 0) {
    const promptToks = Math.round(toks * 0.6);
    const compToks = Math.max(0, toks - promptToks);
    const catalogEntry = GATEWAY_MODEL_DISCOVERY_CATALOG.find((m) => m.id === targetModel);
    const inRate = catalogEntry ? catalogEntry.pricing_per_1m_usd.input : 1.0;
    const outRate = catalogEntry ? catalogEntry.pricing_per_1m_usd.output : 3.0;
    estCost = (promptToks * inRate + compToks * outRate) / 1000000.0;
    baselineCost = (promptToks * 15.0 + compToks * 75.0) / 1000000.0;
    savingsUsd = Math.max(0.0, baselineCost - estCost);
    const savingsPct =
      baselineCost > 0 ? ((savingsUsd / baselineCost) * 100.0).toFixed(1) + "%" : "0.0%";
    const pool =
      targetFamily === "gemini" || targetFamily === "gemini_decisions"
        ? "ANTIGRAVITY_GEMINI_CREDITS"
        : "GCP_COMMIT_FSP_DISCOUNT";
    ctx.setVariable("estimated_cost_usd", estCost.toFixed(6));
    ctx.setVariable("frontier_baseline_cost_usd", baselineCost.toFixed(6));
    ctx.setVariable("routing_savings_usd", savingsUsd.toFixed(6));
    ctx.setVariable("routing_savings_pct", savingsPct);
    ctx.setVariable("funding_pool", pool);
  }

  const quotaOwner =
    ctx.getVariable("quota_owner_id") ||
    ctx.getVariable("auth.developer_email") ||
    devEmail;
  developerUsdLedger[quotaOwner] = Number(
    ((developerUsdLedger[quotaOwner] || 0) + estCost).toFixed(6)
  );

  const ingestionMode = ctx.getVariable("ai.finopsIngestionMode") || "USAGE";
  if (ingestionMode === "NONE") {
    finopsLedger.ingestionSuppressedTurns += 1;
    return;
  }

  const gatewayKeyName =
    ctx.getVariable("ai.gatewayKeyName") ||
    ctx.getVariable("gateway_key_name") ||
    "default-gateway-key";
  const credentialType =
    ctx.getVariable("ai.credentialType") ||
    ctx.getVariable("credential_type") ||
    "user_key";
  const netCashCost = parseFloat(
    ctx.getVariable("net_cash_cost_usd") || ctx.getVariable("ai.netCashCostUsd") || "0"
  );
  const totalLatencyMs = parseInt(
    ctx.getVariable("total_latency_ms") || ctx.getVariable("ai.totalLatencyMs") || "1",
    10
  );
  const ttftMs = parseInt(
    ctx.getVariable("ttft_ms") || ctx.getVariable("ai.ttftMs") || String(totalLatencyMs),
    10
  );

  const fundingPool =
    ctx.getVariable("funding_pool") ||
    ctx.getVariable("ai.fundingPool") ||
    (targetFamily === "gemini" || targetFamily === "gemini_decisions"
      ? "ANTIGRAVITY_GEMINI_CREDITS"
      : "GCP_COMMIT_FSP_DISCOUNT");

  const routingMode =
    ctx.getVariable("routing_mode") ||
    ctx.getVariable("ai.routingMode") ||
    (targetTier === "tier3-frontier" ? "manual_frontier_pin" : "daily_direct");
  const recommendedTier =
    ctx.getVariable("recommended_tier") ||
    ctx.getVariable("ai.recommendedTier") ||
    targetTier;
  const recommendedModel =
    ctx.getVariable("recommended_model") ||
    ctx.getVariable("ai.recommendedModel") ||
    targetModel;
  const workloadCategory =
    ctx.getVariable("workload_category") ||
    ctx.getVariable("ai.workloadCategory") ||
    "Feature & Code Editing";
  const projectName =
    ctx.getVariable("project_name") ||
    ctx.getVariable("ai.projectName") ||
    "codingagent-modelrouter";
  const judgeDecision =
    ctx.getVariable("smart_judge_reason") ||
    ctx.getVariable("smart_router_decision") ||
    ctx.getVariable("ai.smartRouterDecision") ||
    "explicit_model";
  const routerCost = parseFloat(
    ctx.getVariable("router_cost_usd") || ctx.getVariable("ai.routerCostUsd") || "0"
  );
  const avoidableSpend = parseFloat(
    ctx.getVariable("avoidable_frontier_spend_usd") ||
      ctx.getVariable("ai.avoidableFrontierSpendUsd") ||
      "0"
  );
  const isOverkill =
    ctx.getVariable("is_frontier_overkill") === "true" ||
    ctx.getVariable("ai.isFrontierOverkill") === "true" ||
    (routingMode === "manual_frontier_pin" &&
      targetTier === "tier3-frontier" &&
      recommendedTier !== "tier3-frontier");
  const isRouterOverride =
    ctx.getVariable("ai.isRouterOverride") === "true" || Boolean(isOverkill);
  const inToks = parseInt(
    ctx.getVariable("prompt_token_count") || ctx.getVariable("ai.inputTokens") || "0",
    10
  );
  const outToks = parseInt(
    ctx.getVariable("completion_token_count") || ctx.getVariable("ai.outputTokens") || "0",
    10
  );
  const cachedToks = parseInt(
    ctx.getVariable("cached_token_count") || ctx.getVariable("ai.cachedTokens") || "0",
    10
  );
  const cacheCreationToks = parseInt(
    ctx.getVariable("cache_creation_token_count") ||
      ctx.getVariable("ai.cacheCreationTokens") ||
      "0",
    10
  );
  const thoughtsToks = parseInt(
    ctx.getVariable("thoughts_token_count") || ctx.getVariable("ai.thoughtsTokens") || "0",
    10
  );

  finopsLedger.totalRequests += 1;
  finopsLedger.totalTokens += toks;
  finopsLedger.inputTokens = (finopsLedger.inputTokens || 0) + (inToks > 0 ? inToks : Math.max(0, toks - outToks));
  finopsLedger.outputTokens = (finopsLedger.outputTokens || 0) + outToks;
  finopsLedger.cachedTokens += cachedToks;
  finopsLedger.cacheCreationTokens += cacheCreationToks;
  finopsLedger.thoughtsTokens += thoughtsToks;
  finopsLedger.actualCostUsd += estCost;
  finopsLedger.netCashCostUsd += netCashCost;
  finopsLedger.latencyMsSum += Math.max(0, totalLatencyMs);
  finopsLedger.ttftMsSum += Math.max(0, ttftMs);
  finopsLedger.routerCostUsd += routerCost;
  finopsLedger.frontierBaselineCostUsd += baselineCost;
  finopsLedger.routingSavingsUsd += savingsUsd;
  finopsLedger.avoidableFrontierSpendUsd += avoidableSpend;
  if (isOverkill) {
    finopsLedger.frontierOverkillTurns += 1;
  }
  if (isRouterOverride) {
    finopsLedger.routerOverrideTurns += 1;
  }
  if (ctx.getVariable("ai.isSubagent") === "true") {
    finopsLedger.subagentTurns += 1;
  }
  if (ctx.getVariable("ai.budgetWarning")) {
    finopsLedger.budgetWarningTurns += 1;
  }
  if (ctx.getVariable("ai.budgetDowngraded") === "true") {
    finopsLedger.budgetDowngradedTurns += 1;
  }
  const rawLogPayload = String(ctx.getVariable("ai.finopsLogPayload") || "");
  if (rawLogPayload.includes("ai_router_finops_turn")) {
    finopsLedger.postClientFlowLogs += 1;
    try {
      const parsedLog = JSON.parse(rawLogPayload);
      finopsLedger.recentFinopsLogs.push(parsedLog);
      if (finopsLedger.recentFinopsLogs.length > 15) {
        finopsLedger.recentFinopsLogs.shift();
      }
    } catch (e) {}
  }
  if (ctx.getVariable("fallback_triggered") === "true") {
    finopsLedger.failover429Deflections += 1;
  }

  if (fundingPool === "ANTIGRAVITY_GEMINI_CREDITS") {
    finopsLedger.geminiPoolRequests += 1;
    finopsLedger.geminiPoolTokens += toks;
    finopsLedger.geminiCreditBurnedUsd += estCost;
  } else {
    finopsLedger.gcpCommitRequests += 1;
    finopsLedger.gcpCommitTokens += toks;
    finopsLedger.gcpCommitListCostUsd += estCost;
  }

  if (!finopsLedger.byDeveloper[devEmail]) {
    finopsLedger.byDeveloper[devEmail] = {
      credential_type: credentialType,
      gateway_key_name: gatewayKeyName,
      requests: 0,
      tokens: 0,
      cached_tokens: 0,
      cache_creation_tokens: 0,
      actual_cost_usd: 0.0,
      net_cash_cost_usd: 0.0,
      frontier_baseline_cost_usd: 0.0,
      routing_savings_usd: 0.0,
      avoidable_frontier_spend_usd: 0.0,
      frontier_overkill_turns: 0,
      router_override_turns: 0,
      daily_token_quota: quotaLimit,
      routing_mode_counts: { smart_auto: 0, daily_direct: 0, manual_frontier_pin: 0 }
    };
  }
  const devEntry = finopsLedger.byDeveloper[devEmail];
  devEntry.requests += 1;
  devEntry.tokens += toks;
  devEntry.cached_tokens += cachedToks;
  devEntry.cache_creation_tokens += cacheCreationToks;
  devEntry.actual_cost_usd = Number((devEntry.actual_cost_usd + estCost).toFixed(6));
  devEntry.net_cash_cost_usd = Number((devEntry.net_cash_cost_usd + netCashCost).toFixed(6));

  if (!finopsLedger.byGatewayKey[gatewayKeyName]) {
    finopsLedger.byGatewayKey[gatewayKeyName] = {
      credential_type: credentialType,
      requests: 0,
      tokens: 0,
      actual_cost_usd: 0.0,
      net_cash_cost_usd: 0.0,
      routing_savings_usd: 0.0
    };
  }
  const gkEntry = finopsLedger.byGatewayKey[gatewayKeyName];
  gkEntry.requests += 1;
  gkEntry.tokens += toks;
  gkEntry.actual_cost_usd = Number((gkEntry.actual_cost_usd + estCost).toFixed(6));
  gkEntry.net_cash_cost_usd = Number((gkEntry.net_cash_cost_usd + netCashCost).toFixed(6));
  gkEntry.routing_savings_usd = Number((gkEntry.routing_savings_usd + savingsUsd).toFixed(6));

  if (!finopsLedger.byCredentialType[credentialType]) {
    finopsLedger.byCredentialType[credentialType] = {
      requests: 0,
      tokens: 0,
      actual_cost_usd: 0.0,
      net_cash_cost_usd: 0.0
    };
  }
  const ctEntry = finopsLedger.byCredentialType[credentialType];
  ctEntry.requests += 1;
  ctEntry.tokens += toks;
  ctEntry.actual_cost_usd = Number((ctEntry.actual_cost_usd + estCost).toFixed(6));
  ctEntry.net_cash_cost_usd = Number((ctEntry.net_cash_cost_usd + netCashCost).toFixed(6));
  devEntry.frontier_baseline_cost_usd = Number(
    (devEntry.frontier_baseline_cost_usd + baselineCost).toFixed(6)
  );
  devEntry.routing_savings_usd = Number((devEntry.routing_savings_usd + savingsUsd).toFixed(6));
  devEntry.avoidable_frontier_spend_usd = Number(
    (devEntry.avoidable_frontier_spend_usd + avoidableSpend).toFixed(6)
  );
  if (isOverkill) {
    devEntry.frontier_overkill_turns += 1;
  }
  if (isRouterOverride) {
    devEntry.router_override_turns += 1;
  }
  if (devEntry.routing_mode_counts[routingMode] !== undefined) {
    devEntry.routing_mode_counts[routingMode] += 1;
  }

  if (!finopsLedger.byTeam[teamName]) {
    finopsLedger.byTeam[teamName] = {
      cost_center: costCenter,
      requests: 0,
      tokens: 0,
      cached_tokens: 0,
      actual_cost_usd: 0.0,
      routing_savings_usd: 0.0,
      avoidable_frontier_spend_usd: 0.0,
      smart_auto_turns: 0,
      router_override_turns: 0
    };
  }
  const teamEntry = finopsLedger.byTeam[teamName];
  teamEntry.requests += 1;
  teamEntry.tokens += toks;
  teamEntry.cached_tokens += cachedToks;
  teamEntry.actual_cost_usd = Number((teamEntry.actual_cost_usd + estCost).toFixed(6));
  teamEntry.routing_savings_usd = Number((teamEntry.routing_savings_usd + savingsUsd).toFixed(6));
  teamEntry.avoidable_frontier_spend_usd = Number(
    (teamEntry.avoidable_frontier_spend_usd + avoidableSpend).toFixed(6)
  );
  if (routingMode === "smart_auto") {
    teamEntry.smart_auto_turns += 1;
  }
  if (isRouterOverride) {
    teamEntry.router_override_turns += 1;
  }

  if (!finopsLedger.byHarness[harness]) {
    finopsLedger.byHarness[harness] = {
      requests: 0,
      tokens: 0,
      actual_cost_usd: 0.0,
      routing_savings_usd: 0.0,
      avoidable_frontier_spend_usd: 0.0
    };
  }
  const hEntry = finopsLedger.byHarness[harness];
  hEntry.requests += 1;
  hEntry.tokens += toks;
  hEntry.actual_cost_usd = Number((hEntry.actual_cost_usd + estCost).toFixed(6));
  hEntry.routing_savings_usd = Number((hEntry.routing_savings_usd + savingsUsd).toFixed(6));
  hEntry.avoidable_frontier_spend_usd = Number(
    (hEntry.avoidable_frontier_spend_usd + avoidableSpend).toFixed(6)
  );

  if (!finopsLedger.byModel[targetModel]) {
    finopsLedger.byModel[targetModel] = {
      tier: targetTier,
      family: targetFamily,
      funding_pool: fundingPool,
      requests: 0,
      tokens: 0,
      actual_cost_usd: 0.0,
      routing_savings_usd: 0.0
    };
  }
  const mEntry = finopsLedger.byModel[targetModel];
  mEntry.requests += 1;
  mEntry.tokens += toks;
  mEntry.actual_cost_usd = Number((mEntry.actual_cost_usd + estCost).toFixed(6));
  mEntry.routing_savings_usd = Number((mEntry.routing_savings_usd + savingsUsd).toFixed(6));

  if (!finopsLedger.byRoutingMode[routingMode]) {
    finopsLedger.byRoutingMode[routingMode] = {
      requests: 0,
      tokens: 0,
      actual_cost_usd: 0.0,
      routing_savings_usd: 0.0,
      avoidable_frontier_spend_usd: 0.0
    };
  }
  const rmEntry = finopsLedger.byRoutingMode[routingMode];
  rmEntry.requests += 1;
  rmEntry.tokens += toks;
  rmEntry.actual_cost_usd = Number((rmEntry.actual_cost_usd + estCost).toFixed(6));
  rmEntry.routing_savings_usd = Number((rmEntry.routing_savings_usd + savingsUsd).toFixed(6));
  rmEntry.avoidable_frontier_spend_usd = Number(
    (rmEntry.avoidable_frontier_spend_usd + avoidableSpend).toFixed(6)
  );

  if (!finopsLedger.byWorkloadCategory[workloadCategory]) {
    finopsLedger.byWorkloadCategory[workloadCategory] = {
      recommended_tier: recommendedTier,
      recommended_model: recommendedModel,
      requests: 0,
      tokens: 0,
      actual_cost_usd: 0.0,
      avoidable_frontier_spend_usd: 0.0
    };
  }
  const wcEntry = finopsLedger.byWorkloadCategory[workloadCategory];
  wcEntry.requests += 1;
  wcEntry.tokens += toks;
  wcEntry.actual_cost_usd = Number((wcEntry.actual_cost_usd + estCost).toFixed(6));
  wcEntry.avoidable_frontier_spend_usd = Number(
    (wcEntry.avoidable_frontier_spend_usd + avoidableSpend).toFixed(6)
  );

  if (!finopsLedger.byProject[projectName]) {
    finopsLedger.byProject[projectName] = {
      requests: 0,
      tokens: 0,
      input_tokens: 0,
      cached_tokens: 0,
      actual_cost_usd: 0.0,
      routing_savings_usd: 0.0
    };
  }
  const pEntry = finopsLedger.byProject[projectName];
  pEntry.requests += 1;
  pEntry.tokens += toks;
  pEntry.input_tokens += inToks > 0 ? inToks : Math.max(0, toks - outToks);
  pEntry.cached_tokens += cachedToks;
  pEntry.actual_cost_usd = Number((pEntry.actual_cost_usd + estCost).toFixed(6));
  pEntry.routing_savings_usd = Number((pEntry.routing_savings_usd + savingsUsd).toFixed(6));

  if (!finopsLedger.byJudgeDecision[judgeDecision]) {
    finopsLedger.byJudgeDecision[judgeDecision] = {
      routed_model: targetModel,
      tier: targetTier,
      requests: 0,
      actual_cost_usd: 0.0
    };
  }
  const jEntry = finopsLedger.byJudgeDecision[judgeDecision];
  jEntry.requests += 1;
  jEntry.actual_cost_usd = Number((jEntry.actual_cost_usd + estCost).toFixed(6));
}

function buildModelsDiscoveryResponse(ctx) {
  const allowedTiersRaw =
    (ctx && ctx.getVariable("allowed_model_tiers")) || "tier1-fast,tier2-daily,tier4-open";
  const allowedSet = new Set(allowedTiersRaw.split(",").map((s) => s.trim()));
  const data = GATEWAY_MODEL_DISCOVERY_CATALOG.map((item) => ({
    id: item.id,
    object: "model",
    created: 1740000000,
    owned_by: "vertex-ai-model-garden",
    aliases: item.aliases,
    tier: item.tier,
    family: item.family,
    vertex_model_id: item.vertex_model_id,
    description: item.description,
    pricing_per_1m_usd: item.pricing_per_1m_usd,
    funding_pool: item.funding_pool,
    allowed_for_caller: item.tier === "dynamic" ? true : allowedSet.has(item.tier)
  }));
  const models = data.map((d) => ({
    name: `models/${d.id}`,
    displayName: d.id,
    description: d.description,
    tier: d.tier,
    family: d.family,
    fundingPool: d.funding_pool,
    allowedForCaller: d.allowed_for_caller
  }));
  return {
    object: "list",
    caller_product_tier: (ctx && ctx.getVariable("product_tier")) || "coding-agent-standard",
    caller_allowed_tiers: Array.from(allowedSet),
    data: data,
    models: models
  };
}

function buildFinOpsReportResponse() {
  const baseline = finopsLedger.frontierBaselineCostUsd;
  const actual = finopsLedger.actualCostUsd;
  const saved = finopsLedger.routingSavingsUsd;
  const avoidable = finopsLedger.avoidableFrontierSpendUsd;
  const savingsPct = baseline > 0 ? ((saved / baseline) * 100.0).toFixed(1) + "%" : "0.0%";
  const seatCount = parseInt(process.env.GEMINI_SEAT_COUNT || "250", 10);
  const creditPerSeat = parseFloat(process.env.GEMINI_CREDIT_PER_SEAT_USD || "50");
  const monthlyGeminiGrant = seatCount * creditPerSeat;
  const fspDiscountPct = parseFloat(process.env.GCP_FSP_DISCOUNT_PCT || "15.0");
  const fspMultiplier = Math.max(0.0, 1.0 - fspDiscountPct / 100.0);
  const geminiBurned = finopsLedger.geminiCreditBurnedUsd;
  const gcpList = finopsLedger.gcpCommitListCostUsd;
  const gcpDiscounted = gcpList * fspMultiplier;
  const denomInput = finopsLedger.inputTokens || finopsLedger.totalTokens;
  const rawHitPct =
    denomInput > 0 ? Math.min(100.0, (finopsLedger.cachedTokens / denomInput) * 100.0) : 0.0;
  const cacheHitPct = rawHitPct.toFixed(1) + "%";
  const netCashSavedVsDirect = Math.max(0.0, baseline - gcpDiscounted);
  const netCashSavingsPct =
    baseline > 0 ? ((netCashSavedVsDirect / baseline) * 100.0).toFixed(1) + "%" : "0.0%";

  return {
    object: "finops.report",
    generated_at: new Date().toISOString(),
    telemetry_architecture: "Apigee PostClientFlow -> Cloud Logging (100% Unary + SSE Parity)",
    governance_policy:
      "One Unified Engineering Policy (All Model Tiers Enabled + Daily Token & USD Spend Guardrails + Routing & Overkill Transparency)",
    unified_console:
      "GCP Cloud Monitoring Dashboard (Coding Agent Enterprise FinOps & Multi-Harness Governance)",
    summary: {
      total_requests: finopsLedger.totalRequests,
      total_tokens: finopsLedger.totalTokens,
      input_tokens: finopsLedger.inputTokens || 0,
      output_tokens: finopsLedger.outputTokens || 0,
      cached_tokens: finopsLedger.cachedTokens,
      cache_creation_tokens: finopsLedger.cacheCreationTokens,
      thoughts_tokens: finopsLedger.thoughtsTokens,
      cache_hit_rate_pct: cacheHitPct,
      actual_list_cost_usd: Number(actual.toFixed(6)),
      router_cost_usd: Number(finopsLedger.routerCostUsd.toFixed(6)),
      frontier_baseline_cost_usd: Number(baseline.toFixed(6)),
      routing_savings_usd: Number(saved.toFixed(6)),
      routing_savings_pct: savingsPct,
      avoidable_frontier_spend_usd: Number(avoidable.toFixed(6)),
      frontier_overkill_turns: finopsLedger.frontierOverkillTurns,
      router_override_turns: finopsLedger.routerOverrideTurns,
      subagent_turns: finopsLedger.subagentTurns,
      budget_warning_turns: finopsLedger.budgetWarningTurns,
      budget_downgraded_turns: finopsLedger.budgetDowngradedTurns,
      budget_hard_blocked_turns: finopsLedger.budgetHardBlockedTurns,
      postclientflow_logs_emitted: finopsLedger.postClientFlowLogs,
      ingestion_suppressed_turns: finopsLedger.ingestionSuppressedTurns,
      avg_latency_ms:
        finopsLedger.totalRequests > 0
          ? Number((finopsLedger.latencyMsSum / finopsLedger.totalRequests).toFixed(1))
          : 0.0,
      avg_ttft_ms:
        finopsLedger.totalRequests > 0
          ? Number((finopsLedger.ttftMsSum / finopsLedger.totalRequests).toFixed(1))
          : 0.0,
      net_effective_cash_spend_usd: Number(gcpDiscounted.toFixed(6)),
      failover_429_deflections_to_gemini: finopsLedger.failover429Deflections
    },
    before_vs_after_roi: {
      unrouted_direct_vendor_baseline_usd: Number(baseline.toFixed(6)),
      routed_vertex_list_cost_usd: Number(actual.toFixed(6)),
      net_incremental_cash_outlay_usd: Number(gcpDiscounted.toFixed(6)),
      total_net_cash_saved_usd: Number(netCashSavedVsDirect.toFixed(6)),
      total_net_cash_savings_pct: netCashSavingsPct
    },
    spend_guardrails: {
      hierarchy_precedence: "User > Team > Org",
      soft_warning_threshold_pct: 80,
      default_100pct_action: "downgrade_to_gemini_3_8_flash_credit_pool",
      strict_100pct_action: "http_402_budget_exceeded_with_reset_timestamp"
    },
    funding_pools: {
      ANTIGRAVITY_GEMINI_CREDITS: {
        description: `Google Antigravity Enterprise Seat Bundle (${seatCount} seats x $${creditPerSeat}/mo = $${monthlyGeminiGrant.toLocaleString()}/mo Gemini Token Credit Pool)`,
        seat_count: seatCount,
        monthly_credit_grant_usd: monthlyGeminiGrant,
        annual_credit_grant_usd: monthlyGeminiGrant * 12.0,
        requests: finopsLedger.geminiPoolRequests,
        tokens: finopsLedger.geminiPoolTokens,
        credit_burned_usd: Number(geminiBurned.toFixed(6)),
        monthly_credit_remaining_usd: Number(Math.max(0, monthlyGeminiGrant - geminiBurned).toFixed(6)),
        net_cash_outlay_usd: 0.0
      },
      GCP_COMMIT_FSP_DISCOUNT: {
        description: `Google Cloud Commit Burndown + ${fspDiscountPct.toFixed(1)}% FSP Discount (Anthropic Claude & Open-Weight MaaS)`,
        fsp_discount_pct: fspDiscountPct.toFixed(1) + "%",
        requests: finopsLedger.gcpCommitRequests,
        tokens: finopsLedger.gcpCommitTokens,
        list_cost_usd: Number(gcpList.toFixed(6)),
        fsp_discounted_cost_usd: Number(gcpDiscounted.toFixed(6))
      }
    },
    by_developer: finopsLedger.byDeveloper,
    top_users_excluding_service_keys: Object.fromEntries(
      Object.entries(finopsLedger.byDeveloper)
        .filter(([, v]) => v.credential_type !== "service_key")
        .sort((a, b) => b[1].actual_cost_usd - a[1].actual_cost_usd)
        .slice(0, 20)
    ),
    by_gateway_key: finopsLedger.byGatewayKey,
    by_credential_type: finopsLedger.byCredentialType,
    by_team: finopsLedger.byTeam,
    by_harness: finopsLedger.byHarness,
    by_model: finopsLedger.byModel,
    by_routing_mode: finopsLedger.byRoutingMode,
    by_workload_category: finopsLedger.byWorkloadCategory,
    by_project: finopsLedger.byProject,
    by_judge_decision: finopsLedger.byJudgeDecision,
    recent_finops_logs: ALLOW_TEST_HOOKS ? finopsLedger.recentFinopsLogs : undefined
  };
}

function safeSecretEqual(candidate, expected) {
  if (typeof candidate !== "string" || typeof expected !== "string") return false;
  if (candidate.length === 0 || expected.length === 0) return false;
  const d1 = crypto.createHash("sha256").update(candidate, "utf8").digest();
  const d2 = crypto.createHash("sha256").update(expected, "utf8").digest();
  const match = crypto.timingSafeEqual(d1, d2);
  return match && candidate.length === expected.length;
}

// Explicit allowlist of client headers safe to forward to Vertex AI (EMU-1, TRN-5)
const FORWARDED_CUSTOM_HEADER_ALLOWLIST = new Set([
  "x-cost-center",
  "x-team-name",
  "x-developer-id",
  "x-session-id",
  "x-request-id",
  "x-client-name",
  "anthropic-beta",
  "anthropic-version"
]);

function sanitizeHeaderValue(val) {
  if (val === undefined || val === null) return "";
  return String(val).replace(/[\r\n\0]/g, "").slice(0, 1024);
}

function extractCustomHeaders(normHeaders) {
  const custom = Object.create(null);
  Object.keys(normHeaders || {}).forEach((lowerKey) => {
    if (!FORWARDED_CUSTOM_HEADER_ALLOWLIST.has(lowerKey)) return;
    custom[lowerKey] = sanitizeHeaderValue(normHeaders[lowerKey]);
  });
  return custom;
}

function buildSecurityHeaders(ctx) {
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Cache-Control": "no-store"
  };
  if (ctx) {
    if (ctx.getVariable("coding_harness")) {
      headers["X-Coding-Harness"] = ctx.getVariable("coding_harness");
    }
    if (ctx.getVariable("target_model_id")) {
      headers["X-Vertex-Target-Model"] = ctx.getVariable("target_model_id");
    }
    if (ctx.getVariable("vertex_model_id")) {
      headers["X-Vertex-Model-Endpoint-Id"] = ctx.getVariable("vertex_model_id");
    }
    if (ctx.getVariable("target_model_family")) {
      headers["X-Vertex-Target-Family"] = ctx.getVariable("target_model_family");
    }
    if (ctx.getVariable("target_model_tier")) {
      headers["X-Vertex-Target-Tier"] = ctx.getVariable("target_model_tier");
    }
    if (ctx.getVariable("smart_judge_reason")) {
      headers["X-Smart-Router-Decision"] = ctx.getVariable("smart_judge_reason");
    }
    if (ctx.getVariable("auth_mode")) {
      headers["X-Auth-Mode"] = ctx.getVariable("auth_mode");
    }
    if (ctx.getVariable("estimated_cost_usd")) {
      headers["X-Estimated-Cost-USD"] = ctx.getVariable("estimated_cost_usd");
    }
    if (ctx.getVariable("frontier_baseline_cost_usd")) {
      headers["X-Frontier-Baseline-Cost-USD"] = ctx.getVariable("frontier_baseline_cost_usd");
    }
    if (ctx.getVariable("routing_savings_usd")) {
      headers["X-Routing-Savings-USD"] = ctx.getVariable("routing_savings_usd");
    }
    if (ctx.getVariable("routing_savings_pct")) {
      headers["X-Routing-Savings-Pct"] = ctx.getVariable("routing_savings_pct");
    }
    if (ctx.getVariable("funding_pool")) {
      headers["X-Funding-Pool"] = ctx.getVariable("funding_pool");
    }
    if (ctx.getVariable("fallback_triggered") === "true") {
      headers["X-Vertex-Fallback-Triggered"] = "true";
      headers["X-Vertex-Primary-Failed-Model"] = ctx.getVariable("primary_failed_model");
    }
    if (ctx.getVariable("antigravity_user_agent")) {
      headers["X-Antigravity-User-Agent-Preserved"] = ctx.getVariable("antigravity_user_agent");
    }
    if (ctx.getVariable("antigravity_goog_api_client")) {
      headers["X-Goog-Api-Client-Preserved"] = ctx.getVariable("antigravity_goog_api_client");
    }
    if (ctx.getVariable("forwarded_custom_headers")) {
      headers["X-Custom-Headers-Forwarded"] = ctx.getVariable("forwarded_custom_headers");
    }
    if (ctx.getVariable("target_model_id")) {
      headers["x-routed-model"] = ctx.getVariable("target_model_id");
      headers["X-Routed-Model"] = ctx.getVariable("target_model_id");
      headers["x-switchyard-model"] = ctx.getVariable("target_model_id");
    }
    if (ctx.getVariable("target_model_tier")) {
      headers["x-routing-tier"] = ctx.getVariable("target_model_tier");
      headers["X-Routing-Tier"] = ctx.getVariable("target_model_tier");
    }
    const rReason =
      ctx.getVariable("smart_judge_reason") ||
      ctx.getVariable("smart_router_decision") ||
      ctx.getVariable("ai.smartRouterDecision") ||
      "explicit_model";
    headers["x-routing-reason"] = rReason;
    headers["X-Routing-Reason"] = rReason;
    if (ctx.getVariable("routing_mode") || ctx.getVariable("ai.routingMode")) {
      headers["X-Gateway-Routing-Mode"] = ctx.getVariable("routing_mode") || ctx.getVariable("ai.routingMode");
    }
    if (ctx.getVariable("recommended_tier") || ctx.getVariable("ai.recommendedTier")) {
      headers["X-Gateway-Recommended-Tier"] = ctx.getVariable("recommended_tier") || ctx.getVariable("ai.recommendedTier");
    }
    if (ctx.getVariable("recommended_model") || ctx.getVariable("ai.recommendedModel")) {
      headers["X-Gateway-Recommended-Model"] = ctx.getVariable("recommended_model") || ctx.getVariable("ai.recommendedModel");
    }
    if (ctx.getVariable("avoidable_frontier_spend_usd") || ctx.getVariable("ai.avoidableFrontierSpendUsd")) {
      headers["X-Gateway-Avoidable-Spend-USD"] = ctx.getVariable("avoidable_frontier_spend_usd") || ctx.getVariable("ai.avoidableFrontierSpendUsd");
    }
    if (ctx.getVariable("workload_category") || ctx.getVariable("ai.workloadCategory")) {
      headers["X-Gateway-Workload-Category"] = ctx.getVariable("workload_category") || ctx.getVariable("ai.workloadCategory");
    }
    if (ctx.getVariable("cache_hit_rate_pct") || ctx.getVariable("ai.cacheHitRatePct")) {
      headers["X-Gateway-Cache-Hit-Rate"] = String(ctx.getVariable("cache_hit_rate_pct") || ctx.getVariable("ai.cacheHitRatePct")) + "%";
    }
    if (ctx.getVariable("session_id") || ctx.getVariable("ai.sessionId")) {
      headers["X-Gateway-Session-ID"] = ctx.getVariable("session_id") || ctx.getVariable("ai.sessionId");
    }
    if (ctx.getVariable("project_name") || ctx.getVariable("ai.projectName")) {
      headers["X-Gateway-Project"] = ctx.getVariable("project_name") || ctx.getVariable("ai.projectName");
    }
    if (ctx.getVariable("ai.isRouterOverride") === "true" || ctx.getVariable("is_frontier_overkill") === "true" || ctx.getVariable("ai.isFrontierOverkill") === "true") {
      headers["X-Gateway-Router-Override"] = "true";
    }
    if (ctx.getVariable("ai.budgetWarning")) {
      headers["X-Switchyard-Budget-Warning"] = ctx.getVariable("ai.budgetWarning");
    }
    if (ctx.getVariable("ai.budgetDowngraded") === "true") {
      headers["X-Switchyard-Budget-Downgraded"] = "true";
    }
    if (ctx.getVariable("ai.gatewayRequestId")) {
      headers["X-Gateway-Request-ID"] = String(ctx.getVariable("ai.gatewayRequestId"));
    }
    if (ctx.getVariable("ai.traceId")) {
      headers["X-Gateway-Trace-ID"] = String(ctx.getVariable("ai.traceId"));
    }
    if (ctx.getVariable("ai.gatewayKeyName") || ctx.getVariable("gateway_key_name")) {
      headers["X-Gateway-Key-Name"] = String(
        ctx.getVariable("ai.gatewayKeyName") || ctx.getVariable("gateway_key_name")
      );
    }
    if (ctx.getVariable("ai.credentialType") || ctx.getVariable("credential_type")) {
      headers["X-Gateway-Credential-Type"] = String(
        ctx.getVariable("ai.credentialType") || ctx.getVariable("credential_type")
      );
    }
    if (ctx.getVariable("ai.finopsIngestionMode")) {
      headers["X-Gateway-Ingestion-Mode"] = String(ctx.getVariable("ai.finopsIngestionMode"));
    }
    if (ctx.getVariable("ai.environment")) {
      headers["X-Gateway-Environment"] = String(ctx.getVariable("ai.environment"));
    }
    if (ctx.getVariable("net_cash_cost_usd") || ctx.getVariable("ai.netCashCostUsd")) {
      headers["X-Net-Cash-Cost-USD"] = String(
        ctx.getVariable("net_cash_cost_usd") || ctx.getVariable("ai.netCashCostUsd")
      );
    }
    if (ctx.getVariable("total_latency_ms") || ctx.getVariable("ai.totalLatencyMs")) {
      headers["X-Gateway-Latency-Ms"] = String(
        ctx.getVariable("total_latency_ms") || ctx.getVariable("ai.totalLatencyMs")
      );
    }
    if (ctx.getVariable("ttft_ms") || ctx.getVariable("ai.ttftMs")) {
      headers["X-Gateway-TTFT-Ms"] = String(
        ctx.getVariable("ttft_ms") || ctx.getVariable("ai.ttftMs")
      );
    }
    if (ctx.getVariable("ai.routerClassifier")) {
      headers["X-Router-Classifier"] = String(ctx.getVariable("ai.routerClassifier"));
      const classifierMs = ctx.getVariable("ai.routerClassifierMs");
      if (classifierMs !== null && classifierMs !== undefined && String(classifierMs) !== "") {
        headers["X-Router-Classifier-Ms"] = String(classifierMs);
      }
      if (ctx.getVariable("ai.routerClassifierModel")) {
        headers["X-Router-Classifier-Model"] = String(ctx.getVariable("ai.routerClassifierModel"));
      }
      if (ctx.getVariable("ai.routerClassifierConfidence")) {
        headers["X-Router-Classifier-Confidence"] = String(
          ctx.getVariable("ai.routerClassifierConfidence")
        );
      }
    }
  }
  return headers;
}

function formatClientErrorBody(status, code, message, ctx) {
  const clientProtocol = ctx ? ctx.getVariable("client_protocol") || "" : "";
  if (clientProtocol === "anthropic_messages") {
    return JSON.stringify({
      type: "error",
      error: {
        type: code || "api_error",
        message: message
      }
    });
  }
  if (clientProtocol === "gemini_generate_content") {
    return JSON.stringify({
      error: {
        code: status,
        status: (code || "INTERNAL").toUpperCase(),
        message: message,
        type: code || "api_error"
      }
    });
  }
  return JSON.stringify({
    error: {
      type: "api_error",
      code: code,
      message: message
    }
  });
}

function makeFaultResponse(status, code, message, ctx) {
  const headers = buildSecurityHeaders(ctx);
  headers["Content-Type"] = "application/json";
  return {
    status: status,
    headers: headers,
    body: formatClientErrorBody(status, code, message, ctx)
  };
}

function buildVertexTargetRequestOptions(ctx, token, forStreaming, customHeaders) {
  const family = ctx.getVariable("target_model_family") || "gemini";
  const isCountTokens = ctx.getVariable("is_count_tokens") === "true";
  const rawRegion = ctx.getVariable("vertex_region") || "global";
  const region = /^(global|[a-z]+-[a-z0-9]+)$/.test(rawRegion) ? rawRegion : "global";
  const rawHost =
    ctx.getVariable("vertex_host") ||
    (region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`);
  const host = /^([a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(rawHost)
    ? rawHost
    : "aiplatform.googleapis.com";
  const rawModelId = ctx.getVariable("vertex_model_id") || "gemini-3.1-pro-preview";
  const vertexModelId =
    /^[a-zA-Z0-9._/@-]+$/.test(rawModelId) && !rawModelId.includes("..")
      ? rawModelId
      : "gemini-3.1-pro-preview";
  let payloadStr = ctx.getVariable("request.content") || "{}";

  try {
    const parsed = JSON.parse(payloadStr);
    if ((family === "anthropic" || family === "openapi_maas") && !isCountTokens) {
      if (forStreaming) {
        parsed.stream = true;
      } else {
        delete parsed.stream;
      }
      payloadStr = JSON.stringify(parsed);
    }
  } catch (e) {}

  let path = "";
  if (family === "gemini") {
    const action = isCountTokens
      ? "countTokens"
      : forStreaming
      ? "streamGenerateContent?alt=sse"
      : "generateContent";
    path = `/v1/projects/${GCP_PROJECT_ID}/locations/${region}/publishers/google/models/${vertexModelId}:${action}`;
  } else if (family === "anthropic") {
    const action = isCountTokens
      ? "countTokens"
      : forStreaming
      ? "streamRawPredict"
      : "rawPredict";
    path = `/v1/projects/${GCP_PROJECT_ID}/locations/${region}/publishers/anthropic/models/${vertexModelId}:${action}`;
  } else {
    path = `/v1/projects/${GCP_PROJECT_ID}/locations/${region}/endpoints/openapi/chat/completions`;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payloadStr),
    "X-Goog-User-Project": GCP_PROJECT_ID
  };

  // Forward User-Agent, X-Goog-Api-Client, and custom headers unchanged per Antigravity contract
  const clientUA = sanitizeHeaderValue(
    ctx.getVariable("antigravity_user_agent") ||
      ctx.getVariable("request.header.user-agent") ||
      ""
  );
  if (clientUA) {
    headers["User-Agent"] = clientUA;
  }
  const googApiClient = sanitizeHeaderValue(
    ctx.getVariable("antigravity_goog_api_client") ||
      ctx.getVariable("request.header.x-goog-api-client") ||
      ""
  );
  if (googApiClient) {
    headers["X-Goog-Api-Client"] = googApiClient;
  }
  if (customHeaders && typeof customHeaders === "object") {
    Object.keys(customHeaders).forEach((hk) => {
      headers[hk] = customHeaders[hk];
    });
  }

  return {
    options: {
      hostname: host,
      port: 443,
      path: path,
      method: "POST",
      headers: headers
    },
    payloadStr: payloadStr
  };
}

async function callLiveVertexAI(ctx, customHeaders) {
  const token = await getFreshVertexToken();
  const isStreaming = ctx.getVariable("is_streaming") === "true";
  const { options, payloadStr } = buildVertexTargetRequestOptions(
    ctx,
    token,
    isStreaming,
    customHeaders
  );

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let respData = "";
      res.on("data", (chunk) => {
        respData += chunk.toString("utf8");
      });
      res.on("end", () => {
        if (isStreaming && res.statusCode === 200) {
          resolve({ status: 200, isSseStream: true, rawSse: respData });
          return;
        }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(respData) });
        } catch (e) {
          resolve({ status: res.statusCode, body: { error: { message: respData } } });
        }
      });
    });

    req.on("error", () => {
      resolve({
        status: 502,
        body: { error: { type: "bad_gateway", message: "Upstream Vertex AI connection failed." } }
      });
    });

    req.write(payloadStr);
    req.end();
  });
}

async function streamLiveVertexAIToResponse(ctx, customHeaders, res, devEmail) {
  const token = await getFreshVertexToken();
  const { options, payloadStr } = buildVertexTargetRequestOptions(
    ctx,
    token,
    true,
    customHeaders
  );

  return new Promise((resolve) => {
    const req = https.request(options, (upstreamRes) => {
      if (upstreamRes.statusCode !== 200) {
        let errBody = "";
        upstreamRes.on("data", (c) => (errBody += c.toString("utf8")));
        upstreamRes.on("end", () => {
          resolve({
            streamed: false,
            status: upstreamRes.statusCode,
            body: errBody
          });
        });
        return;
      }

      const h = buildSecurityHeaders(ctx);
      h["Content-Type"] = "text/event-stream; charset=utf-8";
      h["X-Backend-Mode"] = "LIVE_VERTEX_AI_MODEL_GARDEN";
      res.writeHead(200, h);

      let buffer = "";
      let totalStreamTokens = 0;
      upstreamRes.on("data", (chunk) => {
        buffer += chunk.toString("utf8").replace(/\r\n/g, "\n");
        let sepIdx;
        while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, sepIdx + 2);
          buffer = buffer.slice(sepIdx + 2);
          ctx.setVariable("response.event.current.content", rawEvent);
          runTransformStreamEvent(ctx);
          const transformedChunk = ctx.getVariable("response.event.current.content") || "";
          const evTokens = parseInt(ctx.getVariable("sse_event_token_count") || "0", 10);
          if (evTokens > 0) {
            totalStreamTokens = Math.max(totalStreamTokens, evTokens);
          }
          if (transformedChunk) {
            res.write(transformedChunk);
          }
        }
      });

      upstreamRes.on("end", () => {
        if (buffer.trim().length > 0) {
          ctx.setVariable("response.event.current.content", buffer + "\n\n");
          runTransformStreamEvent(ctx);
          const finalChunk = ctx.getVariable("response.event.current.content") || "";
          if (finalChunk) {
            res.write(finalChunk);
          }
        }
        developerTokenLedger[devEmail] =
          (developerTokenLedger[devEmail] || 0) + (totalStreamTokens || 50);
        recordFinOpsTransaction(ctx, totalStreamTokens || 50);
        res.end();
        resolve({ streamed: true, status: 200 });
      });
    });

    // Abort upstream Vertex request if downstream client disconnects mid-stream (EMU-2)
    if (res && typeof res.on === "function") {
      res.on("close", () => {
        if (!res.writableEnded) {
          req.destroy();
        }
      });
    }

    req.on("error", () => {
      resolve({
        streamed: false,
        status: 502,
        body: JSON.stringify({
          error: { type: "bad_gateway", message: "Upstream Vertex AI stream connection failed." }
        })
      });
    });

    req.write(payloadStr);
    req.end();
  });
}

function validateSchemaNode(schema, pathPrefix) {
  if (!schema || typeof schema !== "object") return null;
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((r) => typeof r !== "string")) {
      return `${pathPrefix}.required must be an array of strings, got ${JSON.stringify(schema.required)}`;
    }
  }
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.some((e) => typeof e === "object" && e !== null)) {
      return `${pathPrefix}.enum must be an array of primitives, got ${JSON.stringify(schema.enum)}`;
    }
  }
  if (schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    for (const k of Object.keys(schema.properties)) {
      const prop = schema.properties[k];
      if (!prop || typeof prop !== "object" || Array.isArray(prop)) {
        return `${pathPrefix}.properties.${k} must be a schema object, got ${JSON.stringify(prop)}`;
      }
      const subErr = validateSchemaNode(prop, `${pathPrefix}.properties.${k}`);
      if (subErr) return subErr;
    }
  }
  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    const itemErr = validateSchemaNode(schema.items, `${pathPrefix}.items`);
    if (itemErr) return itemErr;
  }
  return null;
}

function validateTranslatedBackendPayload(family, modelId, transformed) {
  if (family === "gemini") {
    const maxOut =
      transformed.generationConfig && transformed.generationConfig.maxOutputTokens;
    if (typeof maxOut === "number" && (maxOut < 1 || maxOut >= 65537)) {
      return {
        status: 400,
        body: {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: `Unable to submit request because it has a maxOutputTokens value of ${maxOut} but the supported range is from 1 (inclusive) to 65537 (exclusive). Update the value and try again.`
          }
        }
      };
    }
    // 1. Validate tool declarations schema: $schema must not be inside OpenAPI 3.0 `parameters`
    if (Array.isArray(transformed.tools)) {
      for (const toolGroup of transformed.tools) {
        const decls = toolGroup.functionDeclarations || [];
        for (const decl of decls) {
          if (decl.parameters && decl.parameters.$schema) {
            return {
              status: 400,
              body: {
                error: {
                  code: 400,
                  status: "INVALID_ARGUMENT",
                  message:
                    "Invalid JSON payload received. Unknown name \"$schema\" at 'tools.function_declarations.parameters': Use parametersJsonSchema for JSON Schema."
                }
              }
            };
          }
          const schemaErr = validateSchemaNode(
            decl.parameters || decl.parametersJsonSchema,
            `tools.${decl.name}`
          );
          if (schemaErr) {
            return {
              status: 400,
              body: {
                error: {
                  code: 400,
                  status: "INVALID_ARGUMENT",
                  message: schemaErr
                }
              }
            };
          }
        }
      }
    }
    // 2. Validate multi-turn tool call & functionResponse invariants
    const contents = transformed.contents || [];
    const seenFunctionCalls = new Set();
    for (let i = 0; i < contents.length; i++) {
      const turn = contents[i];
      const parts = (turn && turn.parts) || [];
      for (const p of parts) {
        if (p.functionCall) {
          seenFunctionCalls.add(p.functionCall.name);
          // Gemini 3 requires thoughtSignature on model functionCall turns when echoed back in history
          if (
            String(modelId).startsWith("gemini-3") &&
            i < contents.length - 1 &&
            !p.thoughtSignature
          ) {
            return {
              status: 400,
              body: {
                error: {
                  code: 400,
                  status: "INVALID_ARGUMENT",
                  message:
                    "Function call part in conversation history is missing required thoughtSignature for Gemini 3 model."
                }
              }
            };
          }
        }
        if (p.functionResponse) {
          const respName = p.functionResponse.name || "";
          if (
            respName.startsWith("toolu_") ||
            respName.startsWith("call_") ||
            (seenFunctionCalls.size > 0 && !seenFunctionCalls.has(respName))
          ) {
            return {
              status: 400,
              body: {
                error: {
                  code: 400,
                  status: "INVALID_ARGUMENT",
                  message: `functionResponse.name '${respName}' does not match any preceding functionCall.name (${Array.from(seenFunctionCalls).join(", ")}).`
                }
              }
            };
          }
        }
      }
    }
  } else if (family === "anthropic") {
    if (transformed.model !== undefined) {
      return {
        status: 400,
        body: {
          error: {
            type: "invalid_request_error",
            message: "model: Extra inputs are not permitted in Vertex rawPredict body"
          }
        }
      };
    }
    if (Array.isArray(transformed.tools)) {
      for (const t of transformed.tools) {
        if (!t.input_schema || t.input_schema.type !== "object") {
          return {
            status: 400,
            body: {
              error: {
                type: "invalid_request_error",
                message: `tools.${t.name}.input_schema.type: Input should be 'object', got '${t.input_schema && t.input_schema.type}'`
              }
            }
          };
        }
        const schemaErr = validateSchemaNode(t.input_schema, `tools.${t.name}.input_schema`);
        if (schemaErr) {
          return {
            status: 400,
            body: {
              error: {
                type: "invalid_request_error",
                message: schemaErr
              }
            }
          };
        }
      }
    }
    const msgs = transformed.messages || [];
    const assistantToolIds = new Set();
    for (const m of msgs) {
      if (Array.isArray(m.content) && m.content.length === 0) {
        return {
          status: 400,
          body: {
            error: {
              type: "invalid_request_error",
              message: "messages: content must not be empty"
            }
          }
        };
      }
      if (Array.isArray(m.content)) {
        let sawTextInUser = false;
        for (const block of m.content) {
          if (m.role === "assistant" && block.type === "tool_use") {
            assistantToolIds.add(block.id);
          }
          if (m.role === "user") {
            if (block.type === "text") {
              sawTextInUser = true;
            } else if (block.type === "tool_result") {
              if (sawTextInUser) {
                return {
                  status: 400,
                  body: {
                    error: {
                      type: "invalid_request_error",
                      message:
                        "messages: tool_result blocks must appear before text blocks in user content"
                    }
                  }
                };
              }
              if (
                assistantToolIds.size > 0 &&
                !assistantToolIds.has(block.tool_use_id)
              ) {
                return {
                  status: 400,
                  body: {
                    error: {
                      type: "invalid_request_error",
                      message: `messages: unexpected tool_use_id '${block.tool_use_id}' in tool_result (expected one of: ${Array.from(assistantToolIds).join(", ")})`
                    }
                  }
                };
              }
            }
          }
        }
      }
    }
  } else if (family === "openapi_maas") {
    if (
      typeof transformed.max_tokens === "number" &&
      (transformed.max_tokens < 1 || transformed.max_tokens >= 65537)
    ) {
      return {
        status: 400,
        body: {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: `Unable to submit request because it has a maxOutputTokens value of ${transformed.max_tokens} but the supported range is from 1 (inclusive) to 65537 (exclusive). Update the value and try again.`
          }
        }
      };
    }
    if (Array.isArray(transformed.tools)) {
      for (const t of transformed.tools) {
        const fn = t && t.function;
        if (fn && fn.parameters) {
          const schemaErr = validateSchemaNode(fn.parameters, `tools.${fn.name}.parameters`);
          if (schemaErr) {
            return {
              status: 400,
              body: {
                error: {
                  type: "invalid_request_error",
                  message: schemaErr
                }
              }
            };
          }
        }
      }
    }
    const msgs = transformed.messages || [];
    const seenToolCallIds = new Set();
    for (let mi = 0; mi < msgs.length; mi++) {
      const m = msgs[mi];
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (let tci = 0; tci < m.tool_calls.length; tci++) {
          const tc = m.tool_calls[tci];
          if (tc && tc.id) seenToolCallIds.add(tc.id);
          if (
            tci === 0 &&
            String(transformed.model || "").includes("gemini-3") &&
            !(
              tc &&
              tc.extra_content &&
              tc.extra_content.google &&
              tc.extra_content.google.thought_signature
            )
          ) {
            const fnName = (tc && tc.function && tc.function.name) || "tool";
            return {
              status: 400,
              body: {
                error: {
                  code: 400,
                  status: "INVALID_ARGUMENT",
                  message: `Unable to submit request because function call \`${fnName}\` in the ${mi + 1}. content block is missing a \`thought_signature\`.`
                }
              }
            };
          }
        }
      }
      if (m.role === "tool") {
        if (!m.tool_call_id || (seenToolCallIds.size > 0 && !seenToolCallIds.has(m.tool_call_id))) {
          return {
            status: 400,
            body: {
              error: {
                type: "invalid_request_error",
                message: `Invalid tool_call_id '${m.tool_call_id}' in role='tool' message.`
              }
            }
          };
        }
      }
    }
  }
  return null;
}

const DECISIONS_API_URL =
  process.env.DECISIONS_API_URL || "https://generativelanguage.googleapis.com/v1beta/decisions";
const USE_LIVE_DECISIONS =
  process.env.USE_LIVE_DECISIONS === "true" ||
  (USE_LIVE_VERTEX && Boolean(process.env.GEMINI_API_KEY));

async function callLiveDecisionsApi(payloadObj, timeoutMs) {
  const targetUrl = new URL(DECISIONS_API_URL);
  const bodyStr = JSON.stringify(payloadObj || {});
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(bodyStr)
  };
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (apiKey) {
    headers["x-goog-api-key"] = apiKey;
  } else {
    const token = await getFreshVertexToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      if (GCP_PROJECT_ID && GCP_PROJECT_ID !== "mock-gcp-project") {
        headers["x-goog-user-project"] = GCP_PROJECT_ID;
      }
    }
  }
  return new Promise((resolve) => {
    const transport = targetUrl.protocol === "http:" ? http : https;
    const req = transport.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "http:" ? 80 : 443),
        path: targetUrl.pathname + targetUrl.search,
        method: "POST",
        headers: headers,
        timeout: timeoutMs || 5000
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(data);
          } catch (e) {
            parsed = { raw: data };
          }
          resolve({ status: res.statusCode || 502, body: parsed, raw: data });
        });
      }
    );
    req.on("error", (err) => {
      resolve({ status: 502, body: { error: { code: "upstream_error", message: String(err.message || err) } }, raw: "" });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 504, body: { error: { code: "timeout", message: "Decisions API timed out" } }, raw: "" });
    });
    req.write(bodyStr);
    req.end();
  });
}

function buildSmartRouterDecisionsPayload(promptText) {
  return {
    model: process.env.DECISIONS_MODEL || "gemini-decision-1",
    input: String(promptText || "").slice(0, 16000),
    questions: {
      routing_tier: {
        type: "choice",
        instructions:
          "Select the software engineering complexity tier that best matches this developer request for LLM model routing.",
        criteria: {
          "tier1-fast":
            "A quick factual answer, definition, short explanation, greeting, status check, file listing, grep lookup, or one-line shell command.",
          "tier2-daily":
            "Change, fix, debug, review, migrate, or extend existing code across multiple files, or diagnose a failure or stack trace in an existing codebase.",
          "tier3-frontier":
            "Design a distributed system or architecture, compare major design trade-offs, threat-model security, or reason deeply about concurrency, scale, consistency, or failure modes.",
          "tier4-open":
            "Write one small self-contained piece of code such as a standalone function, unit test, script, SQL query, regex, Dockerfile, config file, or solve a math or algorithmic exercise."
        }
      },
      needs_deep_reasoning: {
        type: "noul",
        instructions:
          "Does this developer request require deep architectural design, distributed systems reasoning, concurrency invariants, security threat modeling, or complex trade-off analysis?",
        criteria: {
          true_description:
            "Requires system architecture design, multi-service consistency or concurrency reasoning, threat modeling, or deep trade-off analysis.",
          false_description:
            "Can be answered with a factual lookup, standalone code snippet, or localized code change or bug fix."
        }
      }
    }
  };
}

function simulateDecisionsBackend(body) {
  if (!body || typeof body !== "object") {
    return { status: 400, body: { error: { code: "invalid_argument", message: "Request body must be a JSON object." } } };
  }
  const model = String(body.model || "");
  if (model !== "gemini-decision-1") {
    return {
      status: 400,
      body: { error: { code: "invalid_argument", message: `Unsupported Decisions API model '${model}'. Expected 'gemini-decision-1'.` } }
    };
  }
  let inputText = "";
  if (typeof body.input === "string") {
    inputText = body.input;
  } else if (Array.isArray(body.input)) {
    inputText = body.input.map((b) => (b && typeof b.text === "string" ? b.text : `[${b && b.type || "media"}]`)).join("");
  } else if (body.input && typeof body.input === "object") {
    inputText = typeof body.input.text === "string" ? body.input.text : `[${body.input.type || "media"}]`;
  }
  if (!inputText || !String(inputText).trim()) {
    return { status: 400, body: { error: { code: "invalid_argument", message: "input cannot be empty." } } };
  }
  const questions = body.questions;
  if (!questions || typeof questions !== "object" || Array.isArray(questions)) {
    return { status: 400, body: { error: { code: "invalid_argument", message: "questions must be a map of 1 to 1,000 questions." } } };
  }
  const qKeys = Object.keys(questions);
  if (qKeys.length < 1 || qKeys.length > 1000) {
    return { status: 400, body: { error: { code: "invalid_argument", message: "questions must contain between 1 and 1,000 entries." } } };
  }
  const lowerInput = inputText.toLowerCase();
  const answers = {};
  for (const qk of qKeys) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(qk)) {
      return {
        status: 400,
        body: { error: { code: "invalid_argument", message: `Invalid question key '${qk}'. Must match [A-Za-z0-9_-]+ (1..64 chars).` } }
      };
    }
    const q = questions[qk];
    if (!q || typeof q !== "object" || !q.instructions) {
      return {
        status: 400,
        body: { error: { code: "invalid_argument", message: `Question '${qk}' requires non-empty instructions.` } }
      };
    }
    const qType = String(q.type || "").toLowerCase();
    if (qType === "noul") {
      const positiveHits =
        /(cracked|damaged|broken|outage|503|refund|charged twice|distributed|deadlock|consensus|threat|architecture)/i.test(
          lowerInput
        );
      const pYes = positiveHits ? 0.94 : 0.08;
      answers[qk] = {
        type: "noul",
        noul: pYes,
        confidence: Math.max(pYes, Number((1 - pYes).toFixed(2)))
      };
    } else if (qType === "choice") {
      if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria)) {
        return {
          status: 400,
          body: { error: { code: "invalid_argument", message: `Choice question '${qk}' requires a criteria map.` } }
        };
      }
      // Decisions API sorts option keys alphabetically in UTF-8 byte order.
      const optKeys = Object.keys(q.criteria).sort();
      if (optKeys.length < 2 || optKeys.length > 255) {
        return {
          status: 400,
          body: { error: { code: "invalid_argument", message: `Choice question '${qk}' must have 2 to 255 options.` } }
        };
      }
      let bestKey = optKeys[0];
      let bestScore = -1;
      const inputTokens = lowerInput.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      for (const ok of optKeys) {
        const desc = `${ok} ${String(q.criteria[ok] || "")}`.toLowerCase();
        let score = 0;
        for (const tok of inputTokens) {
          if (desc.includes(tok)) score += 1;
        }
        if (score > bestScore) {
          bestScore = score;
          bestKey = ok;
        }
      }
      const topProb = bestScore > 0 ? 0.91 : Number((1 / optKeys.length + 0.25).toFixed(3));
      const clampedTop = Math.min(0.95, topProb);
      const remEach = Number(((1 - clampedTop) / (optKeys.length - 1)).toFixed(4));
      const probs = {};
      for (const ok of optKeys) {
        probs[ok] = ok === bestKey ? clampedTop : remEach;
      }
      answers[qk] = {
        type: "choice",
        choice: bestKey,
        probabilities: probs,
        confidence: clampedTop
      };
    } else if (qType === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 255) {
        return {
          status: 400,
          body: { error: { code: "invalid_argument", message: `Score question '${qk}' requires a criteria array of 2 to 255 non-empty strings.` } }
        };
      }
      const nLevels = q.criteria.length;
      const targetIdx = Math.min(nLevels - 1, /(critical|outage|blocked|cancel|503|urgent)/i.test(lowerInput) ? nLevels - 1 : Math.floor(nLevels / 2));
      const legend = {};
      const probs = {};
      const topP = 0.86;
      const otherP = Number(((1 - topP) / (nLevels - 1)).toFixed(4));
      let weighted = 0;
      for (let idx = 0; idx < nLevels; idx++) {
        legend[String(idx)] = String(q.criteria[idx]);
        const p = idx === targetIdx ? topP : otherP;
        probs[String(idx)] = p;
        weighted += idx * p;
      }
      answers[qk] = {
        type: "score",
        score: Number(weighted.toFixed(2)),
        legend: legend,
        probabilities: probs,
        confidence: topP
      };
    } else {
      return {
        status: 400,
        body: { error: { code: "invalid_argument", message: `Unsupported question type '${qType}' for '${qk}'.` } }
      };
    }
  }
  const approxInputTokens = Math.max(24, Math.ceil(JSON.stringify(body).length / 4));
  return {
    status: 200,
    body: {
      answers: answers,
      usage: {
        total_input_tokens: approxInputTokens,
        input_tokens_by_modality: [{ modality: "text", tokens: approxInputTokens }],
        total_output_tokens: 0,
        total_tokens: approxInputTokens
      }
    }
  };
}

function simulateVertexModelGardenBackend(ctx, requestToolExecution, simulate429Primary) {
  if (simulate429Primary && ctx.getVariable("fallback_triggered") !== "true") {
    return {
      status: 429,
      body: { error: { code: 429, message: "Vertex region capacity exhausted" } }
    };
  }

  const family = ctx.getVariable("target_model_family");
  const modelId = ctx.getVariable("target_model_id");
  const isCountTokens = ctx.getVariable("is_count_tokens") === "true";
  const transformedRaw = ctx.getVariable("request.content") || "{}";
  const transformed = JSON.parse(transformedRaw);

  if (family === "gemini_decisions") {
    return simulateDecisionsBackend(transformed);
  }

  if (isCountTokens) {
    const approxTokens = Math.max(12, Math.ceil(transformedRaw.length / 4));
    if (family === "anthropic") {
      return { status: 200, body: { input_tokens: approxTokens } };
    }
    return { status: 200, body: { totalTokens: approxTokens } };
  }

  const validationErr = validateTranslatedBackendPayload(family, modelId, transformed);
  if (validationErr) {
    return validationErr;
  }

  if (family === "gemini") {
    const parts = [];
    const hasTools =
      Array.isArray(transformed.tools) &&
      transformed.tools.length > 0 &&
      Array.isArray(transformed.tools[0].functionDeclarations) &&
      transformed.tools[0].functionDeclarations.length > 0;
    const isGemini3 = String(modelId).startsWith("gemini-3");
    if (hasTools && requestToolExecution) {
      const fnDecl = transformed.tools[0].functionDeclarations[0];
      // Generate realistic ~1,100-char Gemini 3 thoughtSignature to exercise SIG-1 on every run
      const sig = isGemini3
        ? `sig_gemini3_${fnDecl.name}_turn1_` + "S".repeat(1080)
        : undefined;
      if (isGemini3) {
        parts.push({
          thought: true,
          text: `Planning execution of ${fnDecl.name}`,
          thoughtSignature: sig
        });
      }
      const fcPart = {
        functionCall: {
          name: fnDecl.name,
          args: { command: "pytest -q", path: "src/main.py" }
        }
      };
      if (sig) {
        fcPart.thoughtSignature = sig;
      }
      parts.push(fcPart);
    } else {
      parts.push({
        text: `[Vertex Gemini (${modelId})] Processed request via ${ctx.getVariable("coding_harness")}.`
      });
    }
    return {
      status: 200,
      body: {
        candidates: [
          {
            content: { role: "model", parts: parts },
            finishReason: "STOP",
            index: 0
          }
        ],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 80,
          thoughtsTokenCount: isGemini3 ? 20 : 0,
          totalTokenCount: isGemini3 ? 220 : 200
        },
        modelVersion: modelId
      }
    };
  } else if (family === "anthropic") {
    const content = [];
    const hasTools = Array.isArray(transformed.tools) && transformed.tools.length > 0;
    if (hasTools && requestToolExecution) {
      const toolDef = transformed.tools[0];
      content.push({
        type: "tool_use",
        id: "toolu_vertex_anth_" + Date.now(),
        name: toolDef.name,
        input: { command: "git status", file_path: "README.md" }
      });
    } else {
      content.push({
        type: "text",
        text: `[Vertex Anthropic (${modelId})] Processed request via ${ctx.getVariable("coding_harness")}.`
      });
    }
    const simAnthropicCache =
      ALLOW_TEST_HOOKS &&
      ctx.getVariable("request.header.x-test-simulate-anthropic-cache") === "true";
    return {
      status: 200,
      body: {
        id: "msg_vertex_anth_01",
        type: "message",
        role: "assistant",
        model: modelId,
        content: content,
        stop_reason: hasTools && requestToolExecution ? "tool_use" : "end_turn",
        usage: simAnthropicCache
          ? {
              input_tokens: 100,
              cache_read_input_tokens: 2000,
              cache_creation_input_tokens: 400,
              output_tokens: 80
            }
          : {
              input_tokens: 150,
              output_tokens: 90
            }
      }
    };
  } else {
    const hasTools = Array.isArray(transformed.tools) && transformed.tools.length > 0;
    const message = {
      role: "assistant",
      content:
        hasTools && requestToolExecution
          ? null
          : `[Vertex OpenAI MaaS (${modelId})] Processed request via ${ctx.getVariable("coding_harness")}.`
    };
    if (hasTools && requestToolExecution) {
      const fnDef = transformed.tools[0].function;
      const maasSig = `sig_maas_gemini3_${fnDef.name}_` + "M".repeat(512);
      message.tool_calls = [
        {
          id: "call_vertex_maas_" + Date.now(),
          type: "function",
          extra_content: {
            google: {
              thought_signature: maasSig
            }
          },
          function: {
            name: fnDef.name,
            arguments: JSON.stringify({ command: "ls -la", path: "." })
          }
        }
      ];
    }
    return {
      status: 200,
      body: {
        id: "chatcmpl_vertex_maas_01",
        object: "chat.completion",
        model: modelId,
        choices: [
          {
            index: 0,
            message: message,
            finish_reason: hasTools && requestToolExecution ? "tool_calls" : "stop"
          }
        ],
        usage: {
          prompt_tokens: 110,
          completion_tokens: 70,
          total_tokens: 180
        }
      }
    };
  }
}

function renderInteractiveGatewayConsoleHtml() {
  const defaultKey = FRONTIER_API_KEY || STD_API_KEY || "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Coding Agent Model Router — Apigee X + Vertex AI Console</title>
  <style>
    :root { --bg: #0b1120; --card: #151f32; --border: #263554; --accent: #38bdf8; --green: #4ade80; --amber: #fbbf24; --purple: #c084fc; --text: #f1f5f9; --muted: #94a3b8; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Google Sans", Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 24px; }
    .container { max-width: 1200px; margin: 0 auto; }
    header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
    h1 { margin: 0; font-size: 22px; display: flex; align-items: center; gap: 10px; }
    .badge { background: rgba(74, 222, 128, 0.15); color: var(--green); border: 1px solid rgba(74, 222, 128, 0.4); padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
    .grid { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 20px; }
    @media (max-width: 960px) { .grid { grid-template-columns: 1fr; } }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
    .card h2 { margin-top: 0; font-size: 16px; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 10px; }
    label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
    select, textarea, input { width: 100%; background: #0f172a; border: 1px solid var(--border); color: var(--text); padding: 10px 12px; border-radius: 8px; font-size: 14px; margin-bottom: 14px; font-family: inherit; }
    textarea { min-height: 90px; resize: vertical; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .presets { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; }
    .preset-btn { background: #1e293b; color: var(--muted); border: 1px solid var(--border); padding: 6px 10px; border-radius: 6px; font-size: 12px; cursor: pointer; }
    .preset-btn:hover { color: var(--text); border-color: var(--accent); }
    .btn { background: var(--accent); color: #0f172a; border: none; padding: 11px 20px; border-radius: 8px; font-weight: 700; font-size: 14px; cursor: pointer; width: 100%; }
    .btn:hover { background: #7dd3fc; }
    .telemetry { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 16px; }
    .metric { background: #0f172a; border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
    .metric .k { font-size: 11px; color: var(--muted); text-transform: uppercase; }
    .metric .v { font-size: 14px; font-weight: 700; color: var(--green); margin-top: 4px; word-break: break-all; }
    pre { background: #090d16; border: 1px solid var(--border); border-radius: 8px; padding: 14px; overflow-x: auto; font-size: 13px; line-height: 1.5; color: #e2e8f0; white-space: pre-wrap; margin: 12px 0 0; }
    table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-weight: 600; }
    .pill { padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 600; background: #1e293b; color: var(--accent); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>Coding Agent Model Router <span class="badge">LIVE VERTEX AI (${GCP_PROJECT_ID})</span></h1>
        <div style="color:var(--muted);font-size:13px;margin-top:4px;">Apigee X + Vertex AI Model Garden Control Plane for Claude Code, OpenAI Codex, Google Antigravity &amp; Pi</div>
      </div>
      <div style="font-size:12px;color:var(--muted);">Endpoint: <code id="gwOrigin" style="color:var(--accent)">/v1/messages</code></div>
    </header>

    <div class="grid">
      <div class="card">
        <h2>1. Interactive Coding Harness &amp; Smart Router Playground</h2>
        <div class="row">
          <div>
            <label>Coding Agent Wire Protocol</label>
            <select id="harness">
              <option value="claude">Claude Code (POST /v1/messages)</option>
              <option value="codex">OpenAI Codex CLI (POST /v1/responses)</option>
              <option value="antigravity">Google Antigravity (POST /v1beta/models/*)</option>
              <option value="pi">Pi Coding Agent (POST /v1/chat/completions)</option>
            </select>
          </div>
          <div>
            <label>Target Model / Router</label>
            <select id="model">
              <option value="auto">auto (4-Tier Smart Router)</option>
              <option value="gemini-4-argon">gemini-4-argon (Tier 3 Frontier)</option>
              <option value="claude-sonnet-5-5">claude-sonnet-5-5 (Tier 2 Anthropic Claude)</option>
              <option value="claude-sonnet-4-6">claude-sonnet-4-6 (Tier 2 Anthropic Partner)</option>
              <option value="gemini-3.1-pro-preview">gemini-3.1-pro-preview (Tier 2 Daily Pro)</option>
              <option value="gemini-3.8-flash">gemini-3.8-flash (Tier 1 Fast Flash)</option>
              <option value="gemini-3.5-flash-lite">gemini-3.5-flash-lite (Tier 1 Flash-Lite)</option>
              <option value="qwen3-coder">qwen3-coder (Tier 4 Open-Weight + Failover)</option>
            </select>
          </div>
        </div>

        <label>Preset Prompts (Click to test Smart Router tiers)</label>
        <div class="presets">
          <button class="preset-btn" onclick="setPrompt('auto','Write a one-line bash command to list git branches.')">Tier 1 Fast (Grep/Short)</button>
          <button class="preset-btn" onclick="setPrompt('auto','Design a distributed consensus architecture to prevent a multi-node deadlock and race condition.')">Tier 3 Frontier (Architecture/Deadlock)</button>
          <button class="preset-btn" onclick="setPrompt('gemini-4-argon','Confirm your model name and explain how you help coding agents in 2 sentences.')">Pin Gemini 4 Argon</button>
          <button class="preset-btn" onclick="setPrompt('claude-sonnet-5-5','Reply in 2 sentences from Anthropic Claude on Vertex AI.')">Pin Claude Sonnet</button>
        </div>

        <label>Prompt</label>
        <textarea id="prompt">Reply in two short sentences confirming which model is serving this request through the Coding Agent Model Router.</textarea>
        <input type="hidden" id="apiKey" value="${defaultKey}">
        <button class="btn" id="sendBtn" onclick="sendRequest()">Send Live Request Through Gateway</button>

        <div class="telemetry" id="telemetry" style="display:none;">
          <div class="metric"><div class="k">Routed Vertex Model</div><div class="v" id="tModel">-</div></div>
          <div class="metric"><div class="k">Tier &amp; Decision</div><div class="v" id="tTier">-</div></div>
          <div class="metric"><div class="k">Cost &amp; Opus Savings</div><div class="v" id="tCost">-</div></div>
        </div>
        <pre id="output">Click "Send Live Request Through Gateway" above to test live Vertex AI routing.</pre>
      </div>

      <div>
        <div class="card" style="margin-bottom:20px;">
          <h2>2. Live FinOps Cost &amp; Token Ledger (GET /v1/finops/report)</h2>
          <div class="telemetry" style="margin-top:0;margin-bottom:12px;">
            <div class="metric"><div class="k">Total Requests</div><div class="v" id="fReqs">0</div></div>
            <div class="metric"><div class="k">Actual Spend</div><div class="v" id="fActual">$0.00</div></div>
            <div class="metric"><div class="k">Saved vs Opus</div><div class="v" id="fSaved">$0.00 (0%)</div></div>
          </div>
          <div id="finopsTable">Loading FinOps ledger...</div>
        </div>

        <div class="card">
          <h2>3. Vertex AI Model Garden Catalog (GET /v1/models)</h2>
          <div id="modelsTable" style="max-height:320px;overflow-y:auto;">Loading model catalog...</div>
        </div>
      </div>
    </div>
  </div>

  <script>
    function setPrompt(model, text) {
      document.getElementById('model').value = model;
      document.getElementById('prompt').value = text;
    }

    async function sendRequest() {
      const btn = document.getElementById('sendBtn');
      const out = document.getElementById('output');
      const harness = document.getElementById('harness').value;
      const model = document.getElementById('model').value;
      const prompt = document.getElementById('prompt').value;
      const key = document.getElementById('apiKey').value;

      btn.disabled = true;
      btn.textContent = 'Routing to Live Vertex AI...';
      out.textContent = 'Sending request...';

      let path = '/v1/messages';
      let headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
      let body = {};

      if (harness === 'claude') {
        path = '/v1/messages';
        headers['anthropic-version'] = '2023-06-01';
        headers['User-Agent'] = 'claude-cli/1.0.0';
        body = { model, max_tokens: 256, messages: [{ role: 'user', content: prompt }] };
      } else if (harness === 'codex') {
        path = '/v1/responses';
        headers['User-Agent'] = 'codex-cli/1.0.0';
        body = { model, max_output_tokens: 256, input: prompt };
      } else if (harness === 'antigravity') {
        path = '/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
        headers['User-Agent'] = 'antigravity/1.104.0';
        body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 256 } };
      } else {
        path = '/v1/chat/completions';
        headers['User-Agent'] = 'pi-coding-agent/1.0.0';
        body = { model, max_tokens: 256, messages: [{ role: 'user', content: prompt }] };
      }

      try {
        const resp = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
        const data = await resp.json();
        const routed = resp.headers.get('x-vertex-target-model') || model;
        const tier = resp.headers.get('x-vertex-target-tier') || '-';
        const reason = resp.headers.get('x-smart-router-decision') || 'pinned';
        const cost = resp.headers.get('x-estimated-cost-usd') || '0.000000';
        const savings = resp.headers.get('x-routing-savings-pct') || '0%';

        document.getElementById('telemetry').style.display = 'grid';
        document.getElementById('tModel').textContent = routed;
        document.getElementById('tTier').textContent = tier + ' (' + reason + ')';
        document.getElementById('tCost').textContent = '$' + cost + ' (saved ' + savings + ')';
        out.textContent = JSON.stringify(data, null, 2);
        await refreshDashboards();
      } catch (err) {
        out.textContent = 'Error: ' + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send Live Request Through Gateway';
      }
    }

    async function refreshDashboards() {
      const key = document.getElementById('apiKey').value;
      const headers = { 'Authorization': 'Bearer ' + key };
      try {
        const fResp = await fetch('/v1/finops/report', { headers });
        const fData = await fResp.json();
        const s = fData.summary || {};
        document.getElementById('fReqs').textContent = s.total_requests || 0;
        document.getElementById('fActual').textContent = '$' + Number(s.actual_list_cost_usd || 0).toFixed(5);
        document.getElementById('fSaved').textContent = '$' + Number(s.routing_savings_usd || 0).toFixed(5) + ' (' + (s.routing_savings_pct || '0%') + ')';
        const byModel = fData.by_model || {};
        let rows = '<table><tr><th>Model</th><th>Tier</th><th>Reqs</th><th>Tokens</th><th>Cost</th></tr>';
        for (const [m, info] of Object.entries(byModel)) {
          rows += '<tr><td><code>' + m + '</code></td><td><span class="pill">' + info.tier + '</span></td><td>' + info.requests + '</td><td>' + info.tokens + '</td><td>$' + Number(info.actual_cost_usd || 0).toFixed(5) + '</td></tr>';
        }
        rows += '</table>';
        document.getElementById('finopsTable').innerHTML = Object.keys(byModel).length ? rows : '<div style="color:var(--muted);font-size:13px;">No requests logged yet.</div>';
      } catch (e) {}

      try {
        const mResp = await fetch('/v1/models', { headers });
        const mData = await mResp.json();
        let mRows = '<table><tr><th>Model ID</th><th>Tier</th><th>Family</th><th>In/Out ($/1M)</th><th>Access</th></tr>';
        for (const item of (mData.data || [])) {
          const p = item.pricing_per_1m_usd || {};
          mRows += '<tr><td><code>' + item.id + '</code></td><td><span class="pill">' + item.tier + '</span></td><td>' + item.family + '</td><td>$' + p.input + ' / $' + p.output + '</td><td style="color:var(--green)">ALLOWED</td></tr>';
        }
        mRows += '</table>';
        document.getElementById('modelsTable').innerHTML = mRows;
      } catch (e) {}
    }
    document.getElementById('gwOrigin').textContent = window.location.origin;
    refreshDashboards();
  </script>
</body>
</html>`;
}

async function processGatewayRequest(method, url, rawHeaders, rawBody, httpResForStreaming) {
  const normHeaders = {};
  Object.keys(rawHeaders || {}).forEach((k) => {
    normHeaders[k.toLowerCase()] = rawHeaders[k];
  });

  const cleanUrl = (url || "/").split("?")[0];
  const acceptsHtml = String(normHeaders["accept"] || "").includes("text/html");

  if (
    method === "GET" &&
    (cleanUrl === "/ui" ||
      (acceptsHtml && (cleanUrl === "/" || cleanUrl === "/v1/messages" || cleanUrl === "/v1/responses")))
  ) {
    return {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
      },
      body: renderInteractiveGatewayConsoleHtml()
    };
  }

  if (method === "GET" && (cleanUrl === "/healthz" || cleanUrl === "/")) {
    const h = buildSecurityHeaders(null);
    h["Content-Type"] = "application/json";
    return {
      status: 200,
      headers: h,
      body: JSON.stringify({
        status: "ok",
        mode: USE_LIVE_VERTEX ? "LIVE_VERTEX" : "EMULATED"
      })
    };
  }

  if (method === "OPTIONS") {
    return { status: 204, headers: buildSecurityHeaders(null), body: "" };
  }
  const isAllowedGetEndpoint =
    method === "GET" &&
    (cleanUrl === "/v1/models" ||
      cleanUrl === "/models" ||
      cleanUrl === "/v1/v1/models" ||
      cleanUrl === "/v1beta/models" ||
      cleanUrl === "/v1/v1beta/models" ||
      cleanUrl === "/v1/finops" ||
      cleanUrl === "/finops" ||
      cleanUrl === "/v1/finops/report" ||
      cleanUrl === "/finops/report");

  if (method !== "POST" && !isAllowedGetEndpoint) {
    return makeFaultResponse(
      405,
      "method_not_allowed",
      "Only POST and OPTIONS are permitted on the AI Gateway.",
      null
    );
  }

  const customHeaders = extractCustomHeaders(normHeaders);
  const customHeaderNames = Object.keys(customHeaders).sort().join(",");

  // Emulate real Apigee proxy.basepath and proxy.pathsuffix split (APG-1, TST-1)
  const fullUri = url || cleanUrl;
  let proxyBasePath = "/";
  let proxyPathSuffix = fullUri;
  if (cleanUrl === "/v1/messages" || cleanUrl.startsWith("/v1/messages/")) {
    proxyBasePath = "/v1/messages";
    proxyPathSuffix = fullUri.slice("/v1/messages".length);
  } else if (cleanUrl === "/v1" || (cleanUrl.startsWith("/v1/") && !cleanUrl.startsWith("/v1beta") && !cleanUrl.startsWith("/v1internal"))) {
    proxyBasePath = "/v1";
    proxyPathSuffix = fullUri.slice("/v1".length);
  }

  const initialVars = {
    "proxy.basepath": proxyBasePath,
    "proxy.pathsuffix": proxyPathSuffix,
    "request.uri": fullUri,
    "request.content": rawBody || "{}",
    "request.header.x-api-key": normHeaders["x-api-key"] || "",
    "request.header.authorization": normHeaders["authorization"] || "",
    "request.header.user-agent": normHeaders["user-agent"] || "",
    "request.header.x-goog-api-client": normHeaders["x-goog-api-client"] || "",
    "request.header.x-bypass-cache": normHeaders["x-bypass-cache"] || "",
    "request.header.x-team-name": normHeaders["x-team-name"] || "",
    "request.header.x-cost-center": normHeaders["x-cost-center"] || "",
    gcp_project_id: GCP_PROJECT_ID,
    finops_ingestion_mode:
      (ALLOW_TEST_HOOKS && normHeaders["x-test-admin-ingestion-mode"]) ||
      process.env.FINOPS_INGESTION_MODE ||
      "USAGE",
    forwarded_custom_headers: customHeaderNames
  };
  Object.keys(normHeaders).forEach((hk) => {
    initialVars["request.header." + hk] = normHeaders[hk];
  });
  const ctx = new ApigeeContext(initialVars);

  // Step 1: Determine auth mode (supports x-api-key, Authorization: Bearer <API_KEY>, or OIDC JWT)
  runExtractAuthMode(ctx);
  const authMode = ctx.getVariable("auth_mode");
  const extractedKey = ctx.getVariable("auth.extracted_key") || "";
  const authHeader = (ctx.getVariable("request.header.authorization") || "").trim();

  // Official Antigravity Enterprise Gateway contract: acknowledge POST /v1beta:*
  // (e.g. /v1beta:recordClientEvent) and legacy /v1internal:* with HTTP 200 {}.
  // If credentials are provided on telemetry calls, still verify them strictly.
  if (isTelemetryPath(cleanUrl) && authMode === "none") {
    const h = buildSecurityHeaders(null);
    h["Content-Type"] = "application/json";
    h["X-Antigravity-Telemetry-Handled"] = "true";
    return { status: 200, headers: h, body: "{}" };
  }

  if (authMode === "api_key" && extractedKey.length > 0) {
    let matchedPerDev = null;
    for (const devKey of Object.keys(PER_DEV_API_KEYS)) {
      if (safeSecretEqual(extractedKey, devKey)) {
        matchedPerDev = PER_DEV_API_KEYS[devKey];
        break;
      }
    }
    if (matchedPerDev) {
      const rawTier = matchedPerDev.tier || "coding-agent-standard";
      const tier =
        rawTier === "frontier" || rawTier === "coding-agent-frontier"
          ? "coding-agent-frontier"
          : "coding-agent-standard";
      const allowedTiers =
        matchedPerDev.allowed_model_tiers ||
        (tier === "coding-agent-frontier"
          ? "tier1-fast,tier2-daily,tier3-frontier,tier4-open"
          : "tier1-fast,tier2-daily,tier4-open");
      ctx.setVariable(
        "verifyapikey.VA-VerifyApiKey.developer.email",
        matchedPerDev.email || matchedPerDev.developer || "developer@example.com"
      );
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.apiproduct.name", tier);
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.apiproduct.allowed_model_tiers", allowedTiers);
      ctx.setVariable(
        "verifyapikey.VA-VerifyApiKey.apiproduct.daily_token_quota",
        String(matchedPerDev.quota || (tier === "coding-agent-frontier" ? "25000000" : "5000000"))
      );
      if (matchedPerDev.team) {
        ctx.setVariable("verifyapikey.VA-VerifyApiKey.developer.team_name", matchedPerDev.team);
      }
      if (matchedPerDev.cost_center) {
        ctx.setVariable("verifyapikey.VA-VerifyApiKey.developer.cost_center", matchedPerDev.cost_center);
      }
      if (matchedPerDev.daily_usd_limit) {
        ctx.setVariable(
          "verifyapikey.VA-VerifyApiKey.developer.attribute.daily_usd_limit",
          String(matchedPerDev.daily_usd_limit)
        );
      }
      if (matchedPerDev.team_daily_usd_limit) {
        ctx.setVariable(
          "verifyapikey.VA-VerifyApiKey.developer.attribute.team_daily_usd_limit",
          String(matchedPerDev.team_daily_usd_limit)
        );
      }
      if (matchedPerDev.budget_policy) {
        ctx.setVariable(
          "verifyapikey.VA-VerifyApiKey.developer.attribute.budget_policy",
          String(matchedPerDev.budget_policy)
        );
      }
      if (matchedPerDev.app_name) {
        ctx.setVariable("verifyapikey.VA-VerifyApiKey.app.name", String(matchedPerDev.app_name));
      }
      if (matchedPerDev.credential_type) {
        ctx.setVariable(
          "verifyapikey.VA-VerifyApiKey.app.attribute.credential_type",
          String(matchedPerDev.credential_type)
        );
      }
      if (matchedPerDev.finops_ingestion_mode) {
        ctx.setVariable(
          "verifyapikey.VA-VerifyApiKey.apiproduct.finops_ingestion_mode",
          String(matchedPerDev.finops_ingestion_mode)
        );
      }
    } else if (STD_API_KEY && safeSecretEqual(extractedKey, STD_API_KEY)) {
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.developer.email", "alice-std@example.com");
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.app.name", "alice-std-coding-agent-app");
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.apiproduct.name", "coding-agent-standard");
      ctx.setVariable(
        "verifyapikey.VA-VerifyApiKey.apiproduct.allowed_model_tiers",
        "tier1-fast,tier2-daily,tier4-open"
      );
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.apiproduct.daily_token_quota", "5000000");
    } else if (FRONTIER_API_KEY && safeSecretEqual(extractedKey, FRONTIER_API_KEY)) {
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.developer.email", "bob-staff@example.com");
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.app.name", "bob-staff-coding-agent-app");
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.apiproduct.name", "coding-agent-frontier");
      ctx.setVariable(
        "verifyapikey.VA-VerifyApiKey.apiproduct.allowed_model_tiers",
        "tier1-fast,tier2-daily,tier3-frontier,tier4-open"
      );
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.apiproduct.daily_token_quota", "25000000");
    } else if (QUOTA_TINY_API_KEY && safeSecretEqual(extractedKey, QUOTA_TINY_API_KEY)) {
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.developer.email", "quota-test@example.com");
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.app.name", "quota-test-coding-agent-app");
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.apiproduct.name", "coding-agent-standard");
      ctx.setVariable(
        "verifyapikey.VA-VerifyApiKey.apiproduct.allowed_model_tiers",
        "tier1-fast,tier2-daily,tier4-open"
      );
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.apiproduct.daily_token_quota", "300");
    } else if (SERVICE_API_KEY && safeSecretEqual(extractedKey, SERVICE_API_KEY)) {
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.developer.email", "ci-bot@example.com");
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.app.name", "github-actions-ci");
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.app.attribute.credential_type", "service_key");
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.apiproduct.name", "coding-agent-standard");
      ctx.setVariable(
        "verifyapikey.VA-VerifyApiKey.apiproduct.allowed_model_tiers",
        "tier1-fast,tier2-daily,tier4-open"
      );
      ctx.setVariable("verifyapikey.VA-VerifyApiKey.apiproduct.daily_token_quota", "5000000");
    } else {
      return makeFaultResponse(401, "unauthorized", "Invalid Gateway API Key.", ctx);
    }
  } else if (authMode === "oidc_jwt") {
    const token = authHeader.substring(7).trim();
    if (!isJwtFormat(token)) {
      return makeFaultResponse(
        401,
        "unauthorized",
        "Invalid Google OIDC Identity Token format.",
        ctx
      );
    }
    if (VALID_OIDC_TOKEN && safeSecretEqual(token, VALID_OIDC_TOKEN)) {
      ctx.setVariable("jwt.VJ-VerifyGoogleOIDC.decoded.claim.email", "admin@example.com");
      ctx.setVariable("jwt.VJ-VerifyGoogleOIDC.decoded.claim.email_verified", "true");
      ctx.setVariable("AccessEntity.AE-LookupDeveloperByEmail.Developer.Email", "admin@example.com");
      ctx.setVariable("developer.product_tier", "coding-agent-frontier");
    } else {
      return makeFaultResponse(
        401,
        "unauthorized",
        "Invalid or expired Google OIDC Identity Token.",
        ctx
      );
    }
  } else {
    return makeFaultResponse(
      401,
      "unauthorized",
      "Missing authentication. Provide either x-api-key header or Authorization: Bearer <Gateway-Key-or-OIDC-JWT>.",
      ctx
    );
  }

  // Re-run extractAuthMode after VerifyAPIKey / VerifyJWT populates developer & product variables
  runExtractAuthMode(ctx);

  // Handle authenticated GET /v1/models, GET /v1beta/models, and GET /v1/finops/report
  if (isAllowedGetEndpoint) {
    const h = buildSecurityHeaders(ctx);
    h["Content-Type"] = "application/json";
    if (
      cleanUrl === "/v1/models" ||
      cleanUrl === "/models" ||
      cleanUrl === "/v1/v1/models" ||
      cleanUrl === "/v1beta/models" ||
      cleanUrl === "/v1/v1beta/models"
    ) {
      return {
        status: 200,
        headers: h,
        body: JSON.stringify(buildModelsDiscoveryResponse(ctx))
      };
    }
    if (
      cleanUrl === "/v1/finops" ||
      cleanUrl === "/finops" ||
      cleanUrl === "/v1/finops/report" ||
      cleanUrl === "/finops/report"
    ) {
      return {
        status: 200,
        headers: h,
        body: JSON.stringify(buildFinOpsReportResponse())
      };
    }
  }

  const devEmail = ctx.getVariable("developer_email");
  const quotaOwner =
    ctx.getVariable("quota_owner_id") ||
    ctx.getVariable("auth.developer_email") ||
    devEmail;
  const quotaLimit = parseInt(ctx.getVariable("developer_daily_token_quota") || "5000000", 10);
  const currentUsed = developerTokenLedger[quotaOwner] || 0;
  if (currentUsed >= quotaLimit) {
    return makeFaultResponse(
      429,
      "rate_limit_error",
      `Developer daily token quota (${quotaLimit} tokens) exceeded for ${quotaOwner}.`,
      ctx
    );
  }

  runSanitizeAntigravityTelemetry(ctx);
  if (ctx.getVariable("is_telemetry_request") === "true") {
    const h = buildSecurityHeaders(ctx);
    h["Content-Type"] = "application/json";
    h["X-Antigravity-Telemetry-Handled"] = "true";
    return { status: 200, headers: h, body: "{}" };
  }

  ctx.setVariable("developer_daily_spend_usd", String(developerUsdLedger[quotaOwner] || 0));
  runParseAndValidateModelRequest(ctx);
  if (ctx.getVariable("ai.budgetHardBlocked") === "true") {
    finopsLedger.budgetHardBlockedTurns += 1;
    const bh = buildSecurityHeaders(ctx);
    bh["Content-Type"] = "application/json";
    bh["X-Switchyard-Budget-Exceeded-Until"] = ctx.getVariable("ai.budgetExceededUntil") || "";
    return {
      status: 402,
      headers: bh,
      body: JSON.stringify({
        type: "error",
        error: {
          type: "budget_exceeded_error",
          code: "daily_usd_budget_exceeded",
          scope: ctx.getVariable("ai.budgetScope") || "user",
          limit_usd: parseFloat(ctx.getVariable("ai.budgetLimitUsd") || "0"),
          spend_usd: parseFloat(ctx.getVariable("ai.budgetSpendUsd") || "0"),
          exceeded_until: ctx.getVariable("ai.budgetExceededUntil") || "",
          message: `Daily USD spend limit ($${ctx.getVariable("ai.budgetLimitUsd")}) exceeded for ${ctx.getVariable("ai.budgetScope")} scope. Resets at ${ctx.getVariable("ai.budgetExceededUntil")}.`
        }
      })
    };
  }
  if (ctx.getVariable("model_not_found") === "true") {
    return makeFaultResponse(
      404,
      "not_found_error",
      `Model '${ctx.getVariable("requested_model")}' does not exist in the Vertex AI Model Garden catalog.`,
      ctx
    );
  }
  if (ctx.getVariable("rbac_denied") === "true") {
    return makeFaultResponse(
      403,
      "permission_error",
      `Model '${ctx.getVariable("requested_model")}' is not permitted under your assigned API Product tier (${ctx.getVariable("product_tier")}).`,
      ctx
    );
  }

  if (ctx.getVariable("needs_smart_judge") === "true") {
    // Mirrors the stage 06/07 PreFlow: JS-PrepareSmartJudge -> SC-ModelJudge | SC-CustomClassifier
    // | SC-DecisionsClassifier -> JS-ApplySmartJudgeSelection.
    // With test hooks on, X-Test-Custom-Classifier-Response and X-Test-Decisions-Classifier-Response
    // supply the JSON bodies those callouts would have received (absent header = unreachable unless
    // live Decisions API is enabled via USE_LIVE_DECISIONS=true or GEMINI_API_KEY in live mode).
    runPrepareSmartJudge(ctx, {
      phase: "prepare",
      judgeBackend: process.env.SMART_ROUTER_JUDGE_BACKEND || "gemini",
      allowClassifierOverride: ALLOW_TEST_HOOKS ? "true" : "false"
    });
    if (
      ALLOW_TEST_HOOKS &&
      ctx.getVariable("ai.judgeBackend") === "custom" &&
      normHeaders["x-test-custom-classifier-response"]
    ) {
      ctx.setVariable(
        "customClassifierResponse.content",
        String(normHeaders["x-test-custom-classifier-response"])
      );
    }
    if (ctx.getVariable("ai.judgeBackend") === "decisions") {
      if (ALLOW_TEST_HOOKS && normHeaders["x-test-decisions-classifier-response"]) {
        ctx.setVariable(
          "decisionsClassifierResponse.content",
          String(normHeaders["x-test-decisions-classifier-response"])
        );
      } else if (USE_LIVE_DECISIONS && !normHeaders["x-test-decisions-simulate-unreachable"]) {
        const promptForDecisions =
          ctx.getVariable("ai.latestUserPrompt") || ctx.getVariable("prompt_text_for_armor") || "";
        const liveDec = await callLiveDecisionsApi(
          buildSmartRouterDecisionsPayload(promptForDecisions),
          parseInt(process.env.DECISIONS_TIMEOUT_MS || "1500", 10)
        );
        if (liveDec.status === 200 && liveDec.raw) {
          ctx.setVariable("decisionsClassifierResponse.content", liveDec.raw);
        }
      }
    }
    const judgeApplyProps = {
      decisionsModel: process.env.DECISIONS_MODEL || "gemini-decision-1",
      decisionsMinConfidence:
        (ALLOW_TEST_HOOKS && normHeaders["x-test-decisions-min-confidence"]) ||
        process.env.DECISIONS_MIN_CONFIDENCE ||
        "0.50",
      decisionsLowConfidenceTier:
        (ALLOW_TEST_HOOKS && normHeaders["x-test-decisions-low-confidence-tier"]) ||
        process.env.DECISIONS_LOW_CONFIDENCE_TIER ||
        "tier2-daily",
      decisionsEscalationThreshold:
        (ALLOW_TEST_HOOKS && normHeaders["x-test-decisions-escalation-threshold"]) ||
        process.env.DECISIONS_ESCALATION_THRESHOLD ||
        "0.85"
    };
    runApplySmartJudgeSelection(ctx, judgeApplyProps);
  }

  const promptForArmor = (ctx.getVariable("prompt_text_for_armor") || "").toLowerCase();
  if (
    promptForArmor.includes("ignore all previous instructions") ||
    promptForArmor.includes("exfiltrate /etc/passwd") ||
    promptForArmor.includes("reveal system prompt")
  ) {
    return makeFaultResponse(
      400,
      "model_armor_violation",
      "Request blocked by Google Cloud Model Armor: Prompt injection or sensitive data policy violation.",
      ctx
    );
  }

  runTransformPayload(ctx);
  const isStreaming = ctx.getVariable("is_streaming") === "true";
  const isCountTokens = ctx.getVariable("is_count_tokens") === "true";

  // Scope semantic cache strictly per-developer and full transformed payload (all turns & tools)
  const fullPayloadForCache = ctx.getVariable("request.content") || "";
  const cacheKey = crypto
    .createHash("sha256")
    .update(
      `${devEmail}:${ctx.getVariable("product_tier")}:${ctx.getVariable("client_protocol")}:${ctx.getVariable("target_model_id")}:${fullPayloadForCache}`
    )
    .digest("hex");

  const requestToolExec = ALLOW_TEST_HOOKS && normHeaders["x-test-trigger-tool"] === "true";
  const simulate429Primary = ALLOW_TEST_HOOKS && normHeaders["x-test-simulate-vertex-429"] === "true";

  const bypassCache =
    isCountTokens ||
    ctx.getVariable("ai.cacheEligible") !== "true" ||
    normHeaders["x-bypass-cache"] === "true" ||
    normHeaders["cache-control"] === "no-cache" ||
    requestToolExec;

  if (!isStreaming && !bypassCache && semanticCacheStore[cacheKey]) {
    const h = buildSecurityHeaders(ctx);
    h["Content-Type"] = "application/json";
    h["X-Apigee-Semantic-Cache"] = "HIT";
    return { status: 200, headers: h, body: semanticCacheStore[cacheKey] };
  }

  // Live unbuffered SSE streaming directly to HTTP response (with pre-header 429/5xx/unenabled-model fallback per FBK-3)
  if (isStreaming && USE_LIVE_VERTEX && !simulate429Primary && httpResForStreaming) {
    let streamResult = await streamLiveVertexAIToResponse(
      ctx,
      customHeaders,
      httpResForStreaming,
      devEmail
    );
    const isUnenabledStreamModel =
      !streamResult.streamed &&
      (streamResult.status === 404 || streamResult.status === 400) &&
      String(streamResult.body || "").includes("Publisher model");
    if (
      !streamResult.streamed &&
      isUnenabledStreamModel &&
      ctx.getVariable("target_model_family") === "anthropic" &&
      ctx.getVariable("vertex_model_id") !== "claude-sonnet-4-6"
    ) {
      ctx.setVariable("vertex_region", "global");
      ctx.setVariable("vertex_host", "aiplatform.googleapis.com");
      ctx.setVariable("vertex_model_id", "claude-sonnet-4-6");
      ctx.setVariable("target_model_id", "claude-sonnet-4-6");
      streamResult = await streamLiveVertexAIToResponse(
        ctx,
        customHeaders,
        httpResForStreaming,
        devEmail
      );
    }
    if (
      !streamResult.streamed &&
      (streamResult.status === 429 || streamResult.status >= 500) &&
      ctx.getVariable("target_model_family") === "anthropic" &&
      ctx.getVariable("vertex_region") === "global"
    ) {
      ctx.setVariable("vertex_region", "us-east5");
      ctx.setVariable("vertex_host", "us-east5-aiplatform.googleapis.com");
      streamResult = await streamLiveVertexAIToResponse(
        ctx,
        customHeaders,
        httpResForStreaming,
        devEmail
      );
    }
    const stillUnenabledStreamModel =
      !streamResult.streamed &&
      (streamResult.status === 404 || streamResult.status === 400) &&
      String(streamResult.body || "").includes("Publisher model");
    if (
      !streamResult.streamed &&
      (streamResult.status === 429 || streamResult.status >= 500 || stillUnenabledStreamModel)
    ) {
      runPrepareVertexFallbackPayload(ctx);
      ctx.setVariable("request.content", ctx.getVariable("vertex_fallback_payload"));
      streamResult = await streamLiveVertexAIToResponse(
        ctx,
        customHeaders,
        httpResForStreaming,
        devEmail
      );
    }
    if (streamResult.streamed) {
      return { streamedDirect: true, status: 200, headers: buildSecurityHeaders(ctx) };
    }
    let upstreamMsg = "Upstream Vertex AI streaming request failed.";
    try {
      const parsedErr = JSON.parse(streamResult.body || "{}");
      if (parsedErr.error && parsedErr.error.message) upstreamMsg = parsedErr.error.message;
    } catch (e) {}
    return makeFaultResponse(
      streamResult.status || 502,
      "upstream_error",
      upstreamMsg,
      ctx
    );
  }

  let backendResp;
  if (ctx.getVariable("target_model_family") === "gemini_decisions" && USE_LIVE_DECISIONS) {
    let parsedReqBody = {};
    try {
      parsedReqBody = JSON.parse(ctx.getVariable("request.content") || "{}");
    } catch (e) {}
    backendResp = await callLiveDecisionsApi(parsedReqBody, 30000);
  } else if (USE_LIVE_VERTEX && !simulate429Primary) {
    backendResp = await callLiveVertexAI(ctx, customHeaders);
    const isUnenabledModel = (resp) => {
      if (!resp || (resp.status !== 404 && resp.status !== 400)) return false;
      const rawStr = JSON.stringify(resp.body || {});
      return rawStr.includes("Publisher model");
    };
    if (
      isUnenabledModel(backendResp) &&
      ctx.getVariable("target_model_family") === "anthropic" &&
      ctx.getVariable("vertex_model_id") !== "claude-sonnet-4-6"
    ) {
      ctx.setVariable("vertex_region", "global");
      ctx.setVariable("vertex_host", "aiplatform.googleapis.com");
      ctx.setVariable("vertex_model_id", "claude-sonnet-4-6");
      ctx.setVariable("target_model_id", "claude-sonnet-4-6");
      backendResp = await callLiveVertexAI(ctx, customHeaders);
    }
    if (
      (backendResp.status === 429 || backendResp.status >= 500) &&
      ctx.getVariable("target_model_family") === "anthropic" &&
      ctx.getVariable("vertex_region") === "global"
    ) {
      ctx.setVariable("vertex_region", "us-east5");
      ctx.setVariable("vertex_host", "us-east5-aiplatform.googleapis.com");
      backendResp = await callLiveVertexAI(ctx, customHeaders);
    }
    if (backendResp.status === 429 || backendResp.status >= 500 || isUnenabledModel(backendResp)) {
      runPrepareVertexFallbackPayload(ctx);
      ctx.setVariable("request.content", ctx.getVariable("vertex_fallback_payload"));
      backendResp = await callLiveVertexAI(ctx, customHeaders);
    }
  } else {
    backendResp = simulateVertexModelGardenBackend(ctx, requestToolExec, simulate429Primary);
    if (
      ctx.getVariable("target_model_family") !== "gemini_decisions" &&
      (backendResp.status === 429 || backendResp.status >= 500)
    ) {
      runPrepareVertexFallbackPayload(ctx);
      ctx.setVariable("request.content", ctx.getVariable("vertex_fallback_payload"));
      backendResp = simulateVertexModelGardenBackend(ctx, requestToolExec, false);
    }
  }

  // Propagate upstream 4xx/5xx errors in the caller's expected wire error format (EMU-5)
  if (backendResp.status >= 400) {
    const rawErr = (backendResp.body && backendResp.body.error) || {};
    const errMsg = rawErr.message || "Upstream error";
    const errCode = rawErr.type || rawErr.status || "upstream_error";
    return makeFaultResponse(backendResp.status, String(errCode), errMsg, ctx);
  }

  if (isStreaming && backendResp.isSseStream) {
    const normalizedSse = String(backendResp.rawSse || "").replace(/\r\n/g, "\n");
    const chunks = normalizedSse.split("\n\n");
    let combinedOut = "";
    let maxStreamTokens = 0;
    for (const ch of chunks) {
      if (!ch.trim()) continue;
      ctx.setVariable("response.event.current.content", ch + "\n\n");
      runTransformStreamEvent(ctx);
      combinedOut += ctx.getVariable("response.event.current.content") || "";
      const tCount = parseInt(ctx.getVariable("sse_event_token_count") || "0", 10);
      if (tCount > 0) maxStreamTokens = Math.max(maxStreamTokens, tCount);
    }
    developerTokenLedger[devEmail] =
      (developerTokenLedger[devEmail] || 0) + (maxStreamTokens || 50);
    recordFinOpsTransaction(ctx, maxStreamTokens || 50);
    const h = buildSecurityHeaders(ctx);
    h["Content-Type"] = "text/event-stream; charset=utf-8";
    h["X-Total-Tokens-Charged"] = String(maxStreamTokens || 50);
    h["X-Backend-Mode"] = "LIVE_VERTEX_AI_MODEL_GARDEN";
    return { status: 200, headers: h, body: combinedOut };
  }

  if (isStreaming && !USE_LIVE_VERTEX) {
    const targetFamily = ctx.getVariable("target_model_family");
    const targetModelId = ctx.getVariable("target_model_id") || "gemini-3.8-flash";
    const rawChunks = [];
    if (targetFamily === "gemini") {
      // Real Vertex Gemini SSE frames use \r\n\r\n (SSE-1)
      if (requestToolExec) {
        const longSig = `sig_gemini3_Bash_stream_` + "S".repeat(1080);
        rawChunks.push(
          "data: " +
            JSON.stringify({
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      {
                        functionCall: {
                          name: "Bash",
                          args: { command: "pytest -q" }
                        },
                        thoughtSignature: longSig
                      }
                    ]
                  },
                  finishReason: "STOP"
                }
              ],
              usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 35, totalTokenCount: 75 }
            }) +
            "\r\n\r\n"
        );
      } else {
        rawChunks.push(
          "data: " +
            JSON.stringify({
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: `Streaming chunk 1 from ${targetModelId}. ` }]
                  }
                }
              ]
            }) +
            "\r\n\r\n"
        );
        rawChunks.push(
          "data: " +
            JSON.stringify({
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: "Chunk 2 complete." }]
                  },
                  finishReason: "STOP"
                }
              ],
              usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 45, totalTokenCount: 75 }
            }) +
            "\r\n\r\n"
        );
      }
    } else if (targetFamily === "anthropic") {
      const simAnthCacheSse =
        ALLOW_TEST_HOOKS && normHeaders["x-test-simulate-anthropic-cache"] === "true";
      rawChunks.push(
        "event: message_start\ndata: " +
          JSON.stringify({
            type: "message_start",
            message: {
              id: "msg_sim_1",
              type: "message",
              role: "assistant",
              model: targetModelId,
              content: [],
              stop_reason: null,
              usage: simAnthCacheSse
                ? {
                    input_tokens: 100,
                    cache_read_input_tokens: 2000,
                    cache_creation_input_tokens: 400,
                    output_tokens: 0
                  }
                : { input_tokens: 25, output_tokens: 0 }
            }
          }) +
          "\n\n"
      );
      if (requestToolExec) {
        rawChunks.push(
          "event: content_block_start\ndata: " +
            JSON.stringify({
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "toolu_stream_anth_01",
                name: "Bash",
                input: {}
              }
            }) +
            "\n\n"
        );
        rawChunks.push(
          "event: content_block_delta\ndata: " +
            JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: '{"command": '
              }
            }) +
            "\n\n"
        );
        rawChunks.push(
          "event: content_block_delta\ndata: " +
            JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: '"git status"}'
              }
            }) +
            "\n\n"
        );
        rawChunks.push(
          "event: content_block_stop\ndata: " +
            JSON.stringify({
              type: "content_block_stop",
              index: 0
            }) +
            "\n\n"
        );
        rawChunks.push(
          "event: message_delta\ndata: " +
            JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: simAnthCacheSse ? 80 : 75 }
            }) +
            "\n\n"
        );
      } else {
        rawChunks.push(
          "event: content_block_delta\ndata: " +
            JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: {
                type: "text_delta",
                text: `Streaming chunk from ${targetModelId}`
              }
            }) +
            "\n\n"
        );
        rawChunks.push(
          "event: message_delta\ndata: " +
            JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: simAnthCacheSse ? 80 : 75 }
            }) +
            "\n\n"
        );
      }
    } else {
      if (requestToolExec) {
        rawChunks.push(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_stream_maas_01",
                        type: "function",
                        extra_content: {
                          google: {
                            thought_signature: "sig_stream_maas_gemini3_" + "M".repeat(256)
                          }
                        },
                        function: { name: "Bash", arguments: '{"command": ' }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            }) +
            "\n\n"
        );
        rawChunks.push(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { arguments: '"ls -la"}' }
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            }) +
            "\n\n"
        );
        rawChunks.push(
          "data: " +
            JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage: { prompt_tokens: 30, completion_tokens: 45, total_tokens: 75 }
            }) +
            "\n\n"
        );
      } else {
        rawChunks.push(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    content: `Streaming chunk from ${targetModelId}`
                  },
                  finish_reason: null
                }
              ]
            }) +
            "\n\n"
        );
        rawChunks.push(
          "data: " +
            JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 30, completion_tokens: 45, total_tokens: 75 }
            }) +
            "\n\n"
        );
      }
    }

    let sseCombined = "";
    let streamTokens = 0;
    for (const rc of rawChunks) {
      ctx.setVariable("response.event.current.content", rc);
      runTransformStreamEvent(ctx);
      sseCombined += ctx.getVariable("response.event.current.content") || "";
      const cTok = parseInt(ctx.getVariable("sse_event_token_count") || "0", 10);
      if (cTok > 0) streamTokens = Math.max(streamTokens, cTok);
    }
    const finalStreamTotal = parseInt(
      ctx.getVariable("ai.totalTokenCount") || String(streamTokens),
      10
    );
    developerTokenLedger[quotaOwner] = (developerTokenLedger[quotaOwner] || 0) + finalStreamTotal;
    recordFinOpsTransaction(ctx, finalStreamTotal);

    const h = buildSecurityHeaders(ctx);
    h["Content-Type"] = "text/event-stream; charset=utf-8";
    h["X-Total-Tokens-Charged"] = String(finalStreamTotal);
    return {
      status: 200,
      headers: h,
      body: sseCombined
    };
  }

  ctx.setVariable("response.content", JSON.stringify(backendResp.body));
  runTransformResponseAndCost(ctx);

  const totalTokens = parseInt(ctx.getVariable("total_token_count") || "0", 10);
  if (!isCountTokens) {
    developerTokenLedger[quotaOwner] = (developerTokenLedger[quotaOwner] || 0) + totalTokens;
    recordFinOpsTransaction(ctx, totalTokens);
  }

  const finalClientBody = ctx.getVariable("response.content");
  if (!bypassCache) {
    const cacheKeys = Object.keys(semanticCacheStore);
    if (cacheKeys.length >= MAX_CACHE_ENTRIES) {
      delete semanticCacheStore[cacheKeys[0]];
    }
    semanticCacheStore[cacheKey] = finalClientBody;
  }

  const h = buildSecurityHeaders(ctx);
  h["Content-Type"] = "application/json";
  h["X-Apigee-Semantic-Cache"] = "MISS";
  h["X-Total-Tokens-Charged"] = String(totalTokens);
  h["X-Backend-Mode"] = USE_LIVE_VERTEX ? "LIVE_VERTEX_AI_MODEL_GARDEN" : "EMULATED";

  return { status: 200, headers: h, body: finalClientBody };
}

if (process.argv.includes("--stdio")) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const reqObj = JSON.parse(line);
      const rawBodyStr = typeof reqObj.body === "string" ? reqObj.body : "";
      if (Buffer.byteLength(rawBodyStr, "utf8") > MAX_REQUEST_BODY_BYTES) {
        const fault = makeFaultResponse(
          413,
          "payload_too_large",
          `Request body exceeds maximum allowed size (${MAX_REQUEST_BODY_BYTES} bytes).`,
          null
        );
        process.stdout.write(JSON.stringify(fault) + "\n");
        return;
      }
      const out = await processGatewayRequest(
        reqObj.method,
        reqObj.path,
        reqObj.headers,
        rawBodyStr,
        null
      );
      process.stdout.write(JSON.stringify(out) + "\n");
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          status: 500,
          headers: buildSecurityHeaders(null),
          body: JSON.stringify({
            error: {
              type: "gateway_error",
              message: "The request could not be completed due to an internal gateway error."
            }
          })
        }) + "\n"
      );
    }
  });
} else {
  const server = http.createServer((req, res) => {
    const chunks = [];
    let receivedBytes = 0;
    let abortedForSize = false;

    req.on("data", (chunk) => {
      if (abortedForSize) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
        abortedForSize = true;
        const fault = makeFaultResponse(
          413,
          "payload_too_large",
          `Request body exceeds maximum allowed size (${MAX_REQUEST_BODY_BYTES} bytes).`,
          null
        );
        res.writeHead(fault.status, fault.headers);
        res.end(fault.body);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", async () => {
      if (abortedForSize) return;
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const startMs = Date.now();
      const out = await processGatewayRequest(
        req.method,
        req.url,
        req.headers,
        rawBody,
        res
      );
      const elapsedMs = Date.now() - startMs;
      const harness = (out.headers && out.headers["X-Coding-Harness"]) || "internal";
      const targetModel = (out.headers && out.headers["X-Vertex-Target-Model"]) || "-";
      const endpointModel =
        (out.headers && out.headers["X-Vertex-Model-Endpoint-Id"]) || "-";
      const family = (out.headers && out.headers["X-Vertex-Target-Family"]) || "-";
      const cost = (out.headers && out.headers["X-Estimated-Cost-USD"]) || "0.000000";
      console.log(
        `[Gateway] ${harness.padEnd(11)} | ${req.method} ${req.url} -> Vertex ${endpointModel} (${family}, canonical=${targetModel}) | HTTP ${out.status} (${elapsedMs}ms) | Cost $${cost}`
      );
      if (!out.streamedDirect) {
        res.writeHead(out.status, out.headers);
        res.end(out.body);
      }
    });
  });

  // Support >= 60 minute long-running agentic streams per official Antigravity docs,
  // while keeping headersTimeout at 60s to prevent Slowloris socket exhaustion (EMU-3).
  server.timeout = 3600 * 1000;
  server.requestTimeout = 3600 * 1000;
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 60 * 1000;

  const PORT = parseInt(process.env.PORT || process.env.EMULATOR_PORT || "18080", 10);
  const BIND_HOST = process.env.BIND_HOST || (process.env.K_SERVICE ? "0.0.0.0" : "127.0.0.1");
  server.listen(PORT, BIND_HOST, () => {
    console.log(`====================================================================`);
    console.log(` Apigee X Enterprise AI Gateway listening on http://${BIND_HOST}:${PORT}`);
    console.log(` Backend Mode : ${USE_LIVE_VERTEX ? "LIVE GCP VERTEX AI MODEL GARDEN" : "EMULATED"}`);
    console.log(` GCP Project  : ${GCP_PROJECT_ID}`);
    console.log(` Auth Status  : ${STD_API_KEY || FRONTIER_API_KEY ? "API Keys configured via env" : "No static keys configured"}`);
    console.log(`====================================================================`);
  });
}
