/**
 * parseAndValidateModelRequest.js
 * Identifies the calling coding agent harness & wire protocol:
 *   - Claude Code: POST /v1/messages (anthropic_messages)
 *   - Google Antigravity:
 *       * POST /v1beta/models/{model}:{action} (vertex_gemini)
 *       * POST /v1beta1/projects/{project}/locations/{region}/publishers/google/models/{model}:{action} (vertex_gemini)
 *       * POST /v1/chat/completions with User-Agent: Antigravity/* (openai_chat)
 *   - OpenAI Codex CLI / Desktop: POST /v1/responses (openai_responses) or /v1/chat/completions (openai_chat)
 *
 * Validates the requested model against the Vertex AI Model Garden catalog (returning 404
 * for unknown models rather than silently substituting a different model) and enforces
 * API Product RBAC tier entitlements (coding-agent-standard vs coding-agent-frontier).
 */
var MODEL_CATALOG = {
  // ── Google Gemini First-Party Models (GA on global endpoint) ─────────────────
  "gemini-4-argon": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gemini-4-argon-cyber-permissive": {
    canonicalId: "gemini-4-argon-cyber-permissive",
    vertexModelId: "gemini-4-argon-cyber-permissive",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gemini-3.8-flash": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gemini-3.7-flash": {
    canonicalId: "gemini-3.7-flash",
    vertexModelId: "gemini-3.7-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gemini-3.6-flash": {
    canonicalId: "gemini-3.6-flash",
    vertexModelId: "gemini-3.6-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gemini-3.5-flash": {
    canonicalId: "gemini-3.5-flash",
    vertexModelId: "gemini-3.5-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gemini-3.5-flash-lite": {
    canonicalId: "gemini-3.5-flash-lite",
    vertexModelId: "gemini-3.5-flash-lite",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.30
  },
  "gemini-3-flash-preview": {
    canonicalId: "gemini-3-flash-preview",
    vertexModelId: "gemini-3-flash-preview",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gemini-3.1-flash-lite": {
    canonicalId: "gemini-3.1-flash-lite-preview",
    vertexModelId: "gemini-3.1-flash-lite-preview",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.30
  },
  "gemini-3.1-flash-lite-preview": {
    canonicalId: "gemini-3.1-flash-lite-preview",
    vertexModelId: "gemini-3.1-flash-lite-preview",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.30
  },
  "gemini-2.5-flash-lite": {
    canonicalId: "gemini-2.5-flash-lite",
    vertexModelId: "gemini-2.5-flash-lite",
    family: "gemini",
    tier: "tier1-fast",
    region: "us-central1",
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.30
  },
  "gemini-2.5-flash": {
    canonicalId: "gemini-2.5-flash",
    vertexModelId: "gemini-2.5-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "us-central1",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gemini-3.1-pro": {
    canonicalId: "gemini-3.1-pro-preview",
    vertexModelId: "gemini-3.1-pro-preview",
    family: "gemini",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gemini-3.1-pro-preview": {
    canonicalId: "gemini-3.1-pro-preview",
    vertexModelId: "gemini-3.1-pro-preview",
    family: "gemini",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gemini-2.5-pro": {
    canonicalId: "gemini-2.5-pro",
    vertexModelId: "gemini-2.5-pro",
    family: "gemini",
    tier: "tier2-daily",
    region: "us-central1",
    inputCostPer1M: 1.25,
    outputCostPer1M: 5.00
  },
  "gemini-decision-1": {
    canonicalId: "gemini-decision-1",
    vertexModelId: "gemini-decision-1",
    family: "gemini_decisions",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.10,
    outputCostPer1M: 0.00
  },

  // ── Anthropic Claude Partner Models on Google Cloud ──────────────────────────
  "claude-opus-5-5": {
    canonicalId: "claude-opus-5-5",
    vertexModelId: "claude-opus-5-5",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "claude-opus-5-5@default": {
    canonicalId: "claude-opus-5-5",
    vertexModelId: "claude-opus-5-5",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "claude-opus-5": {
    canonicalId: "claude-opus-5",
    vertexModelId: "claude-opus-5",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "claude-fable-5-1": {
    canonicalId: "claude-fable-5-1",
    vertexModelId: "claude-fable-5-1",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "claude-fable-5": {
    canonicalId: "claude-fable-5",
    vertexModelId: "claude-fable-5",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "fable": {
    canonicalId: "claude-fable-5-1",
    vertexModelId: "claude-fable-5-1",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "claude-sonnet-5-5": {
    canonicalId: "claude-sonnet-5-5",
    vertexModelId: "claude-sonnet-5-5",
    family: "anthropic",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00
  },
  "claude-sonnet-5-5@default": {
    canonicalId: "claude-sonnet-5-5",
    vertexModelId: "claude-sonnet-5-5",
    family: "anthropic",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00
  },
  "claude-sonnet-5": {
    canonicalId: "claude-sonnet-5",
    vertexModelId: "claude-sonnet-5",
    family: "anthropic",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00
  },
  "claude-haiku-5-5": {
    canonicalId: "claude-haiku-5-5",
    vertexModelId: "claude-haiku-5-5",
    family: "anthropic",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.80,
    outputCostPer1M: 4.00
  },
  "claude-haiku-5-5@default": {
    canonicalId: "claude-haiku-5-5",
    vertexModelId: "claude-haiku-5-5",
    family: "anthropic",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.80,
    outputCostPer1M: 4.00
  },
  "claude-opus-4-8": {
    canonicalId: "claude-opus-5-5",
    vertexModelId: "claude-opus-5-5",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "claude-sonnet-4-6": {
    canonicalId: "claude-sonnet-4-6",
    vertexModelId: "claude-sonnet-4-6",
    family: "anthropic",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00
  },
  "claude-sonnet-4-6@default": {
    canonicalId: "claude-sonnet-4-6",
    vertexModelId: "claude-sonnet-4-6",
    family: "anthropic",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00
  },
  "claude-opus-4-7": {
    canonicalId: "claude-opus-4-7",
    vertexModelId: "claude-opus-4-7",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "claude-opus-4-7@default": {
    canonicalId: "claude-opus-4-7",
    vertexModelId: "claude-opus-4-7",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "claude-opus-4-6": {
    canonicalId: "claude-opus-4-6",
    vertexModelId: "claude-opus-4-6",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "claude-haiku-4-5": {
    canonicalId: "claude-haiku-4-5",
    vertexModelId: "claude-haiku-4-5@20251001",
    family: "anthropic",
    tier: "tier1-fast",
    region: "us-east5",
    inputCostPer1M: 0.80,
    outputCostPer1M: 4.00
  },
  "claude-haiku-4-5@20251001": {
    canonicalId: "claude-haiku-4-5",
    vertexModelId: "claude-haiku-4-5@20251001",
    family: "anthropic",
    tier: "tier1-fast",
    region: "us-east5",
    inputCostPer1M: 0.80,
    outputCostPer1M: 4.00
  },
  "claude-haiku-4-5-20251001": {
    canonicalId: "claude-haiku-4-5",
    vertexModelId: "claude-haiku-4-5@20251001",
    family: "anthropic",
    tier: "tier1-fast",
    region: "us-east5",
    inputCostPer1M: 0.80,
    outputCostPer1M: 4.00
  },
  "claude-sonnet-4-5-20250929": {
    canonicalId: "claude-sonnet-4-5@20250929",
    vertexModelId: "claude-sonnet-4-5@20250929",
    family: "anthropic",
    tier: "tier2-daily",
    region: "us-east5",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00
  },
  "sonnet": {
    canonicalId: "claude-sonnet-5-5",
    vertexModelId: "claude-sonnet-5-5",
    family: "anthropic",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00
  },
  "opus": {
    canonicalId: "claude-opus-5-5",
    vertexModelId: "claude-opus-5-5",
    family: "anthropic",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 15.00,
    outputCostPer1M: 75.00
  },
  "haiku": {
    canonicalId: "claude-haiku-4-5",
    vertexModelId: "claude-haiku-4-5@20251001",
    family: "anthropic",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.80,
    outputCostPer1M: 4.00
  },

  // ── Open-Weight Managed Models (MaaS on Vertex OpenAI-Compatible Endpoint) ──
  "qwen3-coder": {
    canonicalId: "qwen3-coder",
    vertexModelId: "qwen/qwen3-coder-480b-a35b-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.90,
    outputCostPer1M: 0.90
  },
  "qwen3-next-80b-thinking": {
    canonicalId: "qwen3-next-80b-thinking",
    vertexModelId: "qwen/qwen3-next-80b-a3b-thinking-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.45,
    outputCostPer1M: 1.20
  },
  "qwen/qwen3-next-80b-a3b-thinking-maas": {
    canonicalId: "qwen3-next-80b-thinking",
    vertexModelId: "qwen/qwen3-next-80b-a3b-thinking-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.45,
    outputCostPer1M: 1.20
  },
  "qwen3-next-80b-instruct": {
    canonicalId: "qwen3-next-80b-instruct",
    vertexModelId: "qwen/qwen3-next-80b-a3b-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.35,
    outputCostPer1M: 0.80
  },
  "qwen/qwen3-next-80b-a3b-instruct-maas": {
    canonicalId: "qwen3-next-80b-instruct",
    vertexModelId: "qwen/qwen3-next-80b-a3b-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.35,
    outputCostPer1M: 0.80
  },
  "glm-5.2": {
    canonicalId: "glm-5.2",
    vertexModelId: "zai-org/glm-5.2-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.80,
    outputCostPer1M: 0.80
  },
  "zai-org/glm-5.2-maas": {
    canonicalId: "glm-5.2",
    vertexModelId: "zai-org/glm-5.2-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.80,
    outputCostPer1M: 0.80
  },
  "glm-5": {
    canonicalId: "glm-5",
    vertexModelId: "zai-org/glm-5-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.70,
    outputCostPer1M: 0.70
  },
  "zai-org/glm-5-maas": {
    canonicalId: "glm-5",
    vertexModelId: "zai-org/glm-5-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.70,
    outputCostPer1M: 0.70
  },
  "glm-4.7": {
    canonicalId: "glm-4.7",
    vertexModelId: "zai-org/glm-4.7-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.40,
    outputCostPer1M: 0.40
  },
  "zai-org/glm-4.7-maas": {
    canonicalId: "glm-4.7",
    vertexModelId: "zai-org/glm-4.7-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.40,
    outputCostPer1M: 0.40
  },
  "deepseek-v4.1-flash": {
    canonicalId: "deepseek-v4.1-flash",
    vertexModelId: "deepseek-ai/deepseek-v4.1-flash-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.20,
    outputCostPer1M: 0.80
  },
  "deepseek-ai/deepseek-v4.1-flash-maas": {
    canonicalId: "deepseek-v4.1-flash",
    vertexModelId: "deepseek-ai/deepseek-v4.1-flash-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.20,
    outputCostPer1M: 0.80
  },
  "deepseek-v3.2": {
    canonicalId: "deepseek-v3.2",
    vertexModelId: "deepseek-ai/deepseek-v3.2-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.27,
    outputCostPer1M: 1.10
  },
  "deepseek-r1": {
    canonicalId: "deepseek-r1",
    vertexModelId: "deepseek-ai/deepseek-r1-0528-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.55,
    outputCostPer1M: 2.19
  },
  "deepseek-ai/deepseek-r1-0528-maas": {
    canonicalId: "deepseek-r1",
    vertexModelId: "deepseek-ai/deepseek-r1-0528-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.55,
    outputCostPer1M: 2.19
  },
  "kimi-k2": {
    canonicalId: "kimi-k2",
    vertexModelId: "moonshotai/kimi-k2-thinking-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.60,
    outputCostPer1M: 2.50
  },
  "kimi-k2.6": {
    canonicalId: "kimi-k2.6",
    vertexModelId: "moonshotai/kimi-k2-thinking-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.60,
    outputCostPer1M: 2.50
  },
  "moonshotai/kimi-k2.6-maas": {
    canonicalId: "kimi-k2.6",
    vertexModelId: "moonshotai/kimi-k2-thinking-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.60,
    outputCostPer1M: 2.50
  },
  "gemma-4-26b": {
    canonicalId: "gemma-4-26b",
    vertexModelId: "google/gemma-4-26b-a4b-it-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.45
  },
  "google/gemma-4-26b-a4b-it-maas": {
    canonicalId: "gemma-4-26b",
    vertexModelId: "google/gemma-4-26b-a4b-it-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.45
  },
  "minimax-m2": {
    canonicalId: "minimax-m2",
    vertexModelId: "minimaxai/minimax-m2-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.30,
    outputCostPer1M: 1.20
  },
  "minimaxai/minimax-m2-maas": {
    canonicalId: "minimax-m2",
    vertexModelId: "minimaxai/minimax-m2-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.30,
    outputCostPer1M: 1.20
  },
  "gpt-oss-120b": {
    canonicalId: "gpt-oss-120b",
    vertexModelId: "openai/gpt-oss-120b-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.40,
    outputCostPer1M: 1.20
  },
  "openai/gpt-oss-120b-maas": {
    canonicalId: "gpt-oss-120b",
    vertexModelId: "openai/gpt-oss-120b-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.40,
    outputCostPer1M: 1.20
  },
  "llama-4-maverick": {
    canonicalId: "llama-4-maverick",
    vertexModelId: "meta/llama-4-maverick-17b-128e-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-east5",
    inputCostPer1M: 0.25,
    outputCostPer1M: 0.75
  },
  "meta/llama-4-maverick-17b-128e-instruct-maas": {
    canonicalId: "llama-4-maverick",
    vertexModelId: "meta/llama-4-maverick-17b-128e-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-east5",
    inputCostPer1M: 0.25,
    outputCostPer1M: 0.75
  },
  "llama-4-scout": {
    canonicalId: "llama-4-scout",
    vertexModelId: "meta/llama-4-scout-17b-16e-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-east5",
    inputCostPer1M: 0.25,
    outputCostPer1M: 0.75
  },
  "meta/llama-4-scout-17b-16e-instruct-maas": {
    canonicalId: "llama-4-scout",
    vertexModelId: "meta/llama-4-scout-17b-16e-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-east5",
    inputCostPer1M: 0.25,
    outputCostPer1M: 0.75
  },
  "moonshotai/kimi-k2-thinking-maas": {
    canonicalId: "kimi-k2",
    vertexModelId: "moonshotai/kimi-k2-thinking-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.60,
    outputCostPer1M: 2.50
  },
  "qwen/qwen3-coder-480b-a35b-instruct-maas": {
    canonicalId: "qwen3-coder",
    vertexModelId: "qwen/qwen3-coder-480b-a35b-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.90,
    outputCostPer1M: 0.90
  },
  "deepseek-ai/deepseek-v3.2-maas": {
    canonicalId: "deepseek-v3.2",
    vertexModelId: "deepseek-ai/deepseek-v3.2-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.27,
    outputCostPer1M: 1.10
  },

  // ── Other Partner Models on Google Cloud (xAI Grok, Meta Muse Spark, Mistral) ─
  "grok-4.7": {
    canonicalId: "grok-4.7",
    vertexModelId: "xai/grok-4.7",
    family: "openapi_maas",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 10.00
  },
  "xai/grok-4.7": {
    canonicalId: "grok-4.7",
    vertexModelId: "xai/grok-4.7",
    family: "openapi_maas",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 10.00
  },
  "grok-4.6": {
    canonicalId: "grok-4.6",
    vertexModelId: "xai/grok-4.6",
    family: "openapi_maas",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 10.00
  },
  "grok-4.20-reasoning": {
    canonicalId: "grok-4.20-reasoning",
    vertexModelId: "xai/grok-4.20-reasoning",
    family: "openapi_maas",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 10.00
  },
  "muse-spark-1-3": {
    canonicalId: "muse-spark-1-3",
    vertexModelId: "meta/muse-spark-1-3",
    family: "openapi_maas",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 1.50,
    outputCostPer1M: 6.00
  },
  "meta/muse-spark-1-3": {
    canonicalId: "muse-spark-1-3",
    vertexModelId: "meta/muse-spark-1-3",
    family: "openapi_maas",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 1.50,
    outputCostPer1M: 6.00
  },
  "codestral-2": {
    canonicalId: "codestral-2",
    vertexModelId: "mistralai/codestral-2",
    family: "openapi_maas",
    tier: "tier1-fast",
    region: "us-central1",
    inputCostPer1M: 0.30,
    outputCostPer1M: 0.90
  },
  "mistral-medium-3": {
    canonicalId: "mistral-medium-3",
    vertexModelId: "mistralai/mistral-medium-3",
    family: "openapi_maas",
    tier: "tier2-daily",
    region: "us-central1",
    inputCostPer1M: 0.40,
    outputCostPer1M: 2.00
  },

  // ── OpenAI Codex / SDK Default Placeholder Model Aliases (Nexus Gateway Parity) ─
  "default": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gpt-5": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gpt-5.4": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gpt-5.2": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gpt-5.1-codex-max": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gpt-5-codex": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gpt-5.3-codex": {
    canonicalId: "qwen3-coder",
    vertexModelId: "qwen/qwen3-coder-480b-a35b-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.90,
    outputCostPer1M: 0.90
  },
  "gpt-5.2-codex": {
    canonicalId: "gemini-3.1-pro-preview",
    vertexModelId: "gemini-3.1-pro-preview",
    family: "gemini",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gpt-5.1-codex": {
    canonicalId: "gemini-3.1-pro-preview",
    vertexModelId: "gemini-3.1-pro-preview",
    family: "gemini",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "o3": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gpt-4o": {
    canonicalId: "gemini-3.1-pro-preview",
    vertexModelId: "gemini-3.1-pro-preview",
    family: "gemini",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gpt-4.1": {
    canonicalId: "gemini-3.1-pro-preview",
    vertexModelId: "gemini-3.1-pro-preview",
    family: "gemini",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gpt-5.4-mini": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gpt-5.3-codex-spark": {
    canonicalId: "deepseek-v4.1-flash",
    vertexModelId: "deepseek-ai/deepseek-v4.1-flash-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.20,
    outputCostPer1M: 0.80
  },
  "gpt-5.1-codex-mini": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gpt-5-codex-mini": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gpt-5-mini": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gpt-5-nano": {
    canonicalId: "gemini-3.5-flash-lite",
    vertexModelId: "gemini-3.5-flash-lite",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.30
  },
  "o4-mini": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "codex-mini-latest": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gpt-4o-mini": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gpt-4.1-mini": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },

  // ── Short Memorable Aliases for '/model <alias>' in Claude Code / Codex / Pi ─
  "argon": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gemini": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "gemini-pro": {
    canonicalId: "gemini-3.1-pro-preview",
    vertexModelId: "gemini-3.1-pro-preview",
    family: "gemini",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "flash": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "gemini-flash": {
    canonicalId: "gemini-3.8-flash",
    vertexModelId: "gemini-3.8-flash",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.60
  },
  "flash-lite": {
    canonicalId: "gemini-3.5-flash-lite",
    vertexModelId: "gemini-3.5-flash-lite",
    family: "gemini",
    tier: "tier1-fast",
    region: "global",
    inputCostPer1M: 0.075,
    outputCostPer1M: 0.30
  },
  "qwen": {
    canonicalId: "qwen3-coder",
    vertexModelId: "qwen/qwen3-coder-480b-a35b-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.90,
    outputCostPer1M: 0.90
  },
  "deepseek": {
    canonicalId: "deepseek-v4.1-flash",
    vertexModelId: "deepseek-ai/deepseek-v4.1-flash-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.20,
    outputCostPer1M: 0.80
  },
  "r1": {
    canonicalId: "deepseek-r1",
    vertexModelId: "deepseek-ai/deepseek-r1-0528-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.55,
    outputCostPer1M: 2.19
  },
  "glm": {
    canonicalId: "glm-5.2",
    vertexModelId: "zai-org/glm-5.2-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.80,
    outputCostPer1M: 0.80
  },
  "kimi": {
    canonicalId: "kimi-k2",
    vertexModelId: "moonshotai/kimi-k2-thinking-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.60,
    outputCostPer1M: 2.50
  },
  "llama": {
    canonicalId: "llama-4-maverick",
    vertexModelId: "meta/llama-4-maverick-17b-128e-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-east5",
    inputCostPer1M: 0.25,
    outputCostPer1M: 0.75
  },
  "scout": {
    canonicalId: "llama-4-scout",
    vertexModelId: "meta/llama-4-scout-17b-16e-instruct-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-east5",
    inputCostPer1M: 0.25,
    outputCostPer1M: 0.75
  },
  "gpt": {
    canonicalId: "gpt-oss-120b",
    vertexModelId: "openai/gpt-oss-120b-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.40,
    outputCostPer1M: 1.20
  },
  "grok": {
    canonicalId: "grok-4.7",
    vertexModelId: "xai/grok-4.7",
    family: "openapi_maas",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 10.00
  },
  "gemma": {
    canonicalId: "gemma-4-26b",
    vertexModelId: "google/gemma-4-26b-a4b-it-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "global",
    inputCostPer1M: 0.15,
    outputCostPer1M: 0.45
  },
  "minimax": {
    canonicalId: "minimax-m2",
    vertexModelId: "minimaxai/minimax-m2-maas",
    family: "openapi_maas",
    tier: "tier4-open",
    region: "us-central1",
    inputCostPer1M: 0.30,
    outputCostPer1M: 1.20
  },
  "mistral": {
    canonicalId: "mistral-medium-3",
    vertexModelId: "mistralai/mistral-medium-3",
    family: "openapi_maas",
    tier: "tier2-daily",
    region: "us-central1",
    inputCostPer1M: 0.40,
    outputCostPer1M: 2.00
  },
  "codestral": {
    canonicalId: "codestral-2",
    vertexModelId: "mistralai/codestral-2",
    family: "openapi_maas",
    tier: "tier1-fast",
    region: "us-central1",
    inputCostPer1M: 0.30,
    outputCostPer1M: 0.90
  },
  "gemini-3.5-pro": {
    canonicalId: "gemini-4-argon",
    vertexModelId: "gemini-4-argon",
    family: "gemini",
    tier: "tier3-frontier",
    region: "global",
    inputCostPer1M: 2.00,
    outputCostPer1M: 12.00
  },
  "claude": {
    canonicalId: "claude-sonnet-5-5",
    vertexModelId: "claude-sonnet-5-5",
    family: "anthropic",
    tier: "tier2-daily",
    region: "global",
    inputCostPer1M: 3.00,
    outputCostPer1M: 15.00
  }
};

function getHeaderFirst(context, names) {
  for (var i = 0; i < names.length; i++) {
    var val = context.getVariable("request.header." + names[i]);
    if (val && String(val).trim()) {
      return String(val).trim();
    }
  }
  return "";
}

function extractReasoningEffortSuffix(modelId) {
  if (!modelId) return "";
  var s = String(modelId).trim();
  if (s.indexOf("models/") === 0) {
    s = s.substring("models/".length);
  }
  s = s.replace(/\[\d+m\]$/i, "");
  if (s.indexOf("@") !== -1) {
    s = s.substring(0, s.indexOf("@"));
  }
  if (MODEL_CATALOG[s]) return "";
  var m = s.match(/^(.+)-(minimal|extra-low|low|medium|high|xhigh|max)(?:-thinking)?$/i);
  if (m && m[1] && m[2]) {
    var base = m[1];
    var baseLow = base.toLowerCase();
    if (
      MODEL_CATALOG[base] ||
      MODEL_CATALOG[baseLow] ||
      baseLow === "auto" ||
      baseLow === "smart-router" ||
      baseLow === "switchyard-auto"
    ) {
      return m[2].toLowerCase();
    }
  }
  return "";
}

function normalizeModelCandidate(modelId) {
  if (!modelId) return "";
  var clean = String(modelId).trim();
  if (clean.indexOf("models/") === 0) {
    clean = clean.substring("models/".length);
  }
  clean = clean.replace(/\[\d+m\]$/i, "");
  if (!MODEL_CATALOG[clean] && clean.indexOf("@") !== -1) {
    clean = clean.substring(0, clean.indexOf("@"));
  }
  if (!MODEL_CATALOG[clean]) {
    var low = clean.toLowerCase();
    if (
      MODEL_CATALOG[low] ||
      low === "auto" ||
      low === "smart-router" ||
      low === "switchyard-auto"
    ) {
      return low;
    }
    var m = clean.match(/^(.+)-(minimal|extra-low|low|medium|high|xhigh|max)(?:-thinking)?$/i);
    if (m && m[1]) {
      var base = m[1];
      var baseLow = base.toLowerCase();
      if (MODEL_CATALOG[base]) return base;
      if (
        MODEL_CATALOG[baseLow] ||
        baseLow === "auto" ||
        baseLow === "smart-router" ||
        baseLow === "switchyard-auto"
      ) {
        return baseLow;
      }
    }
  }
  return clean;
}

function isOpenAiPlaceholderModel(cleanLow) {
  return (
    cleanLow === "gpt-5" ||
    cleanLow === "gpt-5.4" ||
    cleanLow === "gpt-5.2" ||
    cleanLow === "gpt-5.1-codex-max" ||
    cleanLow === "gpt-5-codex" ||
    cleanLow === "o3" ||
    cleanLow === "gpt-5.3-codex" ||
    cleanLow === "gpt-5.2-codex" ||
    cleanLow === "gpt-5.1-codex" ||
    cleanLow === "gpt-4o" ||
    cleanLow === "gpt-4.1" ||
    cleanLow === "gpt-5.4-mini" ||
    cleanLow === "gpt-5.3-codex-spark" ||
    cleanLow === "gpt-5.1-codex-mini" ||
    cleanLow === "gpt-5-codex-mini" ||
    cleanLow === "gpt-5-mini" ||
    cleanLow === "gpt-5-nano" ||
    cleanLow === "o4-mini" ||
    cleanLow === "codex-mini-latest" ||
    cleanLow === "gpt-4o-mini" ||
    cleanLow === "gpt-4.1-mini"
  );
}

function isDefaultHeaderPlaceholder(rawModelId, normalizedModelId, clientProtocol) {
  var raw = String(rawModelId || "").trim();
  if (!raw) return true;
  var rawLow = raw.toLowerCase();
  var cleanLow = String(normalizedModelId || "").trim().toLowerCase();
  if (!cleanLow || rawLow === "default" || cleanLow === "default") return true;
  if (isOpenAiPlaceholderModel(cleanLow)) return true;
  if (clientProtocol === "anthropic_messages") {
    // `vertex-connect claude` sets `"model": "opus[1m]"` in ~/.claude/settings.json, which
    // Claude Code expands to its default Opus slot (`claude-opus-5-5`, `claude-opus-5`,
    // `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, with or without `[1m]`).
    // Explicit `/model sonnet`, `/model haiku`, `/model fable`, `/model qwen`, `/model argon`,
    // `/model flash`, or `/model auto` must NOT be treated as default placeholders.
    if (
      cleanLow === "opus" ||
      cleanLow.indexOf("claude-opus-") === 0 ||
      cleanLow.indexOf("claude-3-opus") === 0
    ) {
      return true;
    }
  }
  return false;
}

function getClientModelSlot(modelId) {
  var clean = normalizeModelCandidate(modelId).toLowerCase();
  if (!clean || clean === "default") return "opus";
  if (
    clean === "opus" ||
    clean.indexOf("claude-opus-") === 0 ||
    clean.indexOf("claude-3-opus") === 0
  ) {
    return "opus";
  }
  if (clean === "fable" || clean.indexOf("claude-fable-") === 0) {
    return "fable";
  }
  if (
    clean === "sonnet" ||
    clean.indexOf("claude-sonnet-") === 0 ||
    clean.indexOf("claude-3-5-sonnet") === 0 ||
    clean.indexOf("claude-3-7-sonnet") === 0
  ) {
    return "sonnet";
  }
  if (
    clean === "haiku" ||
    clean.indexOf("claude-haiku-") === 0 ||
    clean.indexOf("claude-3-5-haiku") === 0 ||
    clean.indexOf("claude-3-haiku") === 0
  ) {
    return "haiku";
  }
  if (
    clean === "gpt-5" ||
    clean === "gpt-5.4" ||
    clean === "gpt-5.2" ||
    clean === "gpt-5.1-codex-max" ||
    clean === "gpt-5-codex" ||
    clean === "o3"
  ) {
    return "opus";
  }
  if (
    clean === "gpt-5.3-codex" ||
    clean === "gpt-5.2-codex" ||
    clean === "gpt-5.1-codex" ||
    clean === "gpt-4o" ||
    clean === "gpt-4.1"
  ) {
    return "sonnet";
  }
  if (
    clean === "gpt-5.4-mini" ||
    clean === "gpt-5.3-codex-spark" ||
    clean === "gpt-5.1-codex-mini" ||
    clean === "gpt-5-codex-mini" ||
    clean === "gpt-5-mini" ||
    clean === "gpt-5-nano" ||
    clean === "o4-mini" ||
    clean === "codex-mini-latest" ||
    clean === "gpt-4o-mini" ||
    clean === "gpt-4.1-mini"
  ) {
    return "haiku";
  }
  return null;
}

function parseModelMapHeader(rawHeader) {
  var map = {};
  if (!rawHeader) return map;
  var pairs = String(rawHeader).split(",");
  for (var i = 0; i < pairs.length; i++) {
    var pair = pairs[i].trim();
    var eqIdx = pair.indexOf("=");
    if (eqIdx === -1) eqIdx = pair.indexOf(":");
    if (eqIdx !== -1) {
      var k = pair.substring(0, eqIdx).trim().toLowerCase();
      var v = pair.substring(eqIdx + 1).trim();
      if (k && v) {
        map[k] = v;
      }
    }
  }
  return map;
}

function detectAndSanitizeSubagent(body, requestedModel) {
  var result = {
    isSubagent: false,
    subagentModel: "",
    mutated: false
  };
  if (
    requestedModel &&
    String(requestedModel).toLowerCase().indexOf("subagent") !== -1
  ) {
    result.isSubagent = true;
  }
  if (!body || typeof body !== "object") return result;

  var tagRegex = /<(?:CCR-)?SUBAGENT-MODEL>\s*([^<]+?)\s*<\/(?:CCR-)?SUBAGENT-MODEL>/i;
  var stripRegex = /<(?:CCR-)?SUBAGENT-MODEL>[\s\S]*?<\/(?:CCR-)?SUBAGENT-MODEL>\s*/gi;

  function inspectText(txt) {
    if (!txt || typeof txt !== "string") return txt;
    var match = txt.match(tagRegex);
    if (match && match[1]) {
      result.isSubagent = true;
      result.subagentModel = match[1].trim();
    }
    var lower = txt.toLowerCase();
    if (
      lower.indexOf("builtin:claude-code-subagent") !== -1 ||
      lower.indexOf("you are a subagent") !== -1 ||
      lower.indexOf("command execution specialist") !== -1 ||
      lower.indexOf("file search specialist") !== -1
    ) {
      result.isSubagent = true;
    }
    if (txt.indexOf("SUBAGENT-MODEL>") !== -1) {
      result.mutated = true;
      return txt.replace(stripRegex, "");
    }
    return txt;
  }

  if (typeof body.system === "string") {
    body.system = inspectText(body.system);
  } else if (Array.isArray(body.system)) {
    for (var s = 0; s < body.system.length; s++) {
      if (body.system[s] && typeof body.system[s].text === "string") {
        body.system[s].text = inspectText(body.system[s].text);
      }
    }
  }
  if (Array.isArray(body.messages)) {
    for (var m = 0; m < body.messages.length && m < 2; m++) {
      var msg = body.messages[m];
      if (!msg) continue;
      if (typeof msg.content === "string") {
        msg.content = inspectText(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (var c = 0; c < msg.content.length; c++) {
          if (msg.content[c] && typeof msg.content[c].text === "string") {
            msg.content[c].text = inspectText(msg.content[c].text);
          }
        }
      }
    }
  }
  return result;
}

function escapeJsonStringContent(str) {
  if (!str) return "";
  var jsonQuoted = JSON.stringify(String(str));
  return jsonQuoted.slice(1, -1);
}

function fnv1aHashHex(str) {
  var s = String(str || "");
  var h1 = 0x811c9dc5;
  var h2 = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul
      ? Math.imul(h1, 0x01000193)
      : (h1 * 0x01000193) | 0;
    h2 ^= c ^ (i & 0xff);
    h2 = Math.imul
      ? Math.imul(h2, 0x01000193)
      : (h2 * 0x01000193) | 0;
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

function extractPromptSnippet(body, protocol) {
  if (!body || typeof body !== "object") return "";
  var parts = [];
  if (protocol === "anthropic_messages" || protocol === "openai_chat") {
    var msgs = body.messages || [];
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m) continue;
      if (typeof m.content === "string") {
        parts.push(m.content);
      } else if (Array.isArray(m.content)) {
        for (var j = 0; j < m.content.length; j++) {
          var blk = m.content[j];
          if (!blk) continue;
          if (blk.text) {
            parts.push(blk.text);
          } else if (blk.type === "tool_result" && typeof blk.content === "string") {
            parts.push(blk.content);
          }
        }
      }
    }
  } else if (protocol === "openai_responses") {
    if (typeof body.input === "string") {
      parts.push(body.input);
    } else if (Array.isArray(body.input)) {
      for (var k = 0; k < body.input.length; k++) {
        var item = body.input[k];
        if (!item) continue;
        if (typeof item.content === "string") {
          parts.push(item.content);
        } else if (typeof item.output === "string") {
          parts.push(item.output);
        } else if (Array.isArray(item.content)) {
          for (var l = 0; l < item.content.length; l++) {
            if (item.content[l] && item.content[l].text) {
              parts.push(item.content[l].text);
            }
          }
        }
      }
    }
  } else if (protocol === "gemini_decisions") {
    if (typeof body.input === "string") {
      parts.push(body.input);
    } else if (Array.isArray(body.input)) {
      for (var di = 0; di < body.input.length; di++) {
        var dblk = body.input[di];
        if (dblk && typeof dblk.text === "string") {
          parts.push(dblk.text);
        }
      }
    } else if (body.input && typeof body.input === "object" && typeof body.input.text === "string") {
      parts.push(body.input.text);
    }
  } else if (protocol === "vertex_gemini") {
    var contents = body.contents || [];
    for (var c = 0; c < contents.length; c++) {
      var pList = (contents[c] && contents[c].parts) || [];
      for (var p = 0; p < pList.length; p++) {
        if (pList[p] && pList[p].text) {
          parts.push(pList[p].text);
        }
      }
    }
  }
  var joined = parts.join("\n");
  // Slice the trailing 4,000 chars so the latest user turn in multi-turn sessions is inspected
  return joined.length > 4000 ? joined.slice(joined.length - 4000) : joined;
}

function stripSmartRouterBadgeText(text) {
  if (!text || typeof text !== "string" || text.indexOf("Vertex Smart Router") === -1) {
    return { text: text, mutated: false };
  }
  var stripped = text.replace(
    /\n*(?:---\s*\n+)?⚡\s*\*{0,2}Vertex Smart Router[\s\S]*$/g,
    ""
  );
  return { text: stripped, mutated: stripped !== text };
}

function stripSmartRouterBadgesFromHistory(body) {
  var mutated = false;
  if (!body || typeof body !== "object") return false;
  var i, j, item, blk, res;

  if (Array.isArray(body.input)) {
    for (i = 0; i < body.input.length; i++) {
      item = body.input[i];
      if (!item || item.role === "user") continue;
      if (typeof item.content === "string") {
        res = stripSmartRouterBadgeText(item.content);
        if (res.mutated) {
          item.content = res.text;
          mutated = true;
        }
      } else if (Array.isArray(item.content)) {
        for (j = 0; j < item.content.length; j++) {
          blk = item.content[j];
          if (blk && typeof blk.text === "string") {
            res = stripSmartRouterBadgeText(blk.text);
            if (res.mutated) {
              blk.text = res.text;
              mutated = true;
            }
          }
        }
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (i = 0; i < body.messages.length; i++) {
      item = body.messages[i];
      if (!item || item.role === "user") continue;
      if (typeof item.content === "string") {
        res = stripSmartRouterBadgeText(item.content);
        if (res.mutated) {
          item.content = res.text;
          mutated = true;
        }
      } else if (Array.isArray(item.content)) {
        for (j = 0; j < item.content.length; j++) {
          blk = item.content[j];
          if (blk && typeof blk.text === "string") {
            res = stripSmartRouterBadgeText(blk.text);
            if (res.mutated) {
              blk.text = res.text;
              mutated = true;
            }
          }
        }
      }
    }
  }

  if (Array.isArray(body.contents)) {
    for (i = 0; i < body.contents.length; i++) {
      item = body.contents[i];
      if (!item || item.role === "user") continue;
      var parts = item.parts || [];
      for (j = 0; j < parts.length; j++) {
        blk = parts[j];
        if (blk && typeof blk.text === "string") {
          res = stripSmartRouterBadgeText(blk.text);
          if (res.mutated) {
            blk.text = res.text;
            mutated = true;
          }
        }
      }
    }
  }

  return mutated;
}

function cleanUserPromptEnvelope(rawText) {
  if (!rawText || typeof rawText !== "string") return "";
  var s = rawText;
  // If Antigravity IDE/CLI (`agy`) wrapped the turn in <USER_REQUEST>...</USER_REQUEST>, extract the user's actual request
  var urRegex = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/gi;
  var urMatch;
  var lastUserReq = null;
  while ((urMatch = urRegex.exec(s)) !== null) {
    if (urMatch[1] && urMatch[1].trim()) {
      lastUserReq = urMatch[1];
    }
  }
  if (lastUserReq !== null) {
    s = lastUserReq;
  }
  // Strip OpenAI Codex / Claude Code / Antigravity auto-injected XML context envelopes
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "");
  s = s.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "");
  s = s.replace(/<permissions[\s\S]*?<\/permissions>/gi, "");
  s = s.replace(/<collaboration_mode>[\s\S]*?<\/collaboration_mode>/gi, "");
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "");
  s = s.replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, "");
  s = s.replace(/# AGENTS\.md instructions[\s\S]*$/gi, "");
  s = stripSmartRouterBadgeText(s).text;
  s = s.trim();
  // Normalize Codex TUI slash-command bypasses (/models/, /finops/, /finops-admin/, /vertex/, /switch/, /route/)
  s = s.replace(
    /^\/(models|finops|finops-admin|vertex|switch|route|cost|quota)\/(?=\s|$)/i,
    "/$1"
  );
  return s.trim();
}

function extractLatestUserPrompt(body, protocol) {
  if (!body || typeof body !== "object") return "";
  var i, j, m, blk, cleaned;
  var sawToolResult = false;
  if (protocol === "openai_responses") {
    if (typeof body.input === "string") {
      return cleanUserPromptEnvelope(body.input);
    }
    if (Array.isArray(body.input)) {
      for (i = body.input.length - 1; i >= 0; i--) {
        var item = body.input[i];
        if (!item) continue;
        if (item.type === "function_call_output") {
          sawToolResult = true;
          continue;
        }
        if (item.type === "function_call") {
          continue;
        }
        if (item.role && item.role !== "user") continue;
        if (typeof item.content === "string") {
          cleaned = cleanUserPromptEnvelope(item.content);
          if (cleaned) return cleaned;
        } else if (Array.isArray(item.content)) {
          var subParts = [];
          for (j = 0; j < item.content.length; j++) {
            blk = item.content[j];
            if (blk && blk.text) subParts.push(blk.text);
          }
          cleaned = cleanUserPromptEnvelope(subParts.join("\n"));
          if (cleaned) return cleaned;
        }
      }
      if (sawToolResult) return "(tool_result_followup)";
    }
  } else if (protocol === "anthropic_messages" || protocol === "openai_chat") {
    var msgs = body.messages || [];
    for (i = msgs.length - 1; i >= 0; i--) {
      m = msgs[i];
      if (!m || m.role !== "user") continue;
      if (typeof m.content === "string") {
        cleaned = cleanUserPromptEnvelope(m.content);
        if (cleaned) return cleaned;
      } else if (Array.isArray(m.content)) {
        var textBlocks = [];
        for (j = 0; j < m.content.length; j++) {
          blk = m.content[j];
          if (!blk) continue;
          if (blk.type === "tool_result") sawToolResult = true;
          else if (blk.text) textBlocks.push(blk.text);
        }
        cleaned = cleanUserPromptEnvelope(textBlocks.join("\n"));
        if (cleaned) return cleaned;
      }
    }
    if (sawToolResult) return "(tool_result_followup)";
  } else if (protocol === "gemini_decisions") {
    return cleanUserPromptEnvelope(extractPromptSnippet(body, protocol));
  } else if (protocol === "vertex_gemini") {
    var contents = body.contents || [];
    for (i = contents.length - 1; i >= 0; i--) {
      var c = contents[i];
      if (!c || (c.role && c.role !== "user")) continue;
      var pList = c.parts || [];
      var gTexts = [];
      for (j = 0; j < pList.length; j++) {
        if (pList[j] && pList[j].functionResponse) sawToolResult = true;
        else if (pList[j] && pList[j].text) gTexts.push(pList[j].text);
      }
      cleaned = cleanUserPromptEnvelope(gTexts.join("\n"));
      if (cleaned) return cleaned;
    }
    if (sawToolResult) return "(tool_result_followup)";
  }
  return cleanUserPromptEnvelope(extractPromptSnippet(body, protocol));
}

function isSingleTurnCacheEligible(body, protocol) {
  if (!body || typeof body !== "object") return false;
  if (protocol === "gemini_decisions") return false;
  if (Array.isArray(body.tools) && body.tools.length > 0) return false;
  if (protocol === "anthropic_messages" || protocol === "openai_chat") {
    var msgs = body.messages || [];
    if (msgs.length !== 1) return false;
    var first = msgs[0];
    if (!first || first.role !== "user") return false;
    if (Array.isArray(first.content)) {
      for (var i = 0; i < first.content.length; i++) {
        var b = first.content[i];
        if (b && (b.type === "tool_result" || b.type === "tool_use")) return false;
      }
    }
    return true;
  } else if (protocol === "openai_responses") {
    if (typeof body.input === "string") return true;
    if (Array.isArray(body.input)) {
      if (body.input.length !== 1) return false;
      var item = body.input[0];
      if (!item || item.type === "function_call" || item.type === "function_call_output") {
        return false;
      }
      return true;
    }
    return false;
  } else if (protocol === "vertex_gemini") {
    var contents = body.contents || [];
    if (contents.length !== 1) return false;
    var pList = (contents[0] && contents[0].parts) || [];
    for (var p = 0; p < pList.length; p++) {
      if (pList[p] && (pList[p].functionCall || pList[p].functionResponse)) return false;
    }
    return true;
  }
  return false;
}

function classifyWorkloadAndRecommendation(promptText, isSubagent) {
  var lower = (promptText || "").toLowerCase();
  if (isSubagent) {
    return {
      workloadCategory: "Codebase Search & Subagents",
      recommendedTier: "tier1-fast",
      recommendedModel: "gemini-3.8-flash",
      recommendedInRate: 0.15,
      recommendedOutRate: 0.6
    };
  }
  if (
    lower.indexOf("architect") !== -1 ||
    lower.indexOf("deadlock") !== -1 ||
    lower.indexOf("race condition") !== -1 ||
    lower.indexOf("security") !== -1 ||
    lower.indexOf("distributed") !== -1 ||
    lower.indexOf("root cause") !== -1 ||
    lower.indexOf("concurrency") !== -1 ||
    lower.indexOf("consensus") !== -1 ||
    lower.indexOf("vulnerability") !== -1
  ) {
    return {
      workloadCategory: "Architecture & Deep Reasoning",
      recommendedTier: "tier3-frontier",
      recommendedModel: "gemini-4-argon",
      recommendedInRate: 2.0,
      recommendedOutRate: 12.0
    };
  }
  if (
    lower.indexOf("pytest") !== -1 ||
    lower.indexOf("unit_test") !== -1 ||
    lower.indexOf("unit test") !== -1 ||
    lower.indexOf("jest") !== -1 ||
    lower.indexOf("cargo test") !== -1 ||
    lower.indexOf("go test") !== -1 ||
    lower.indexOf("npm test") !== -1 ||
    lower.indexOf("bash") !== -1 ||
    lower.indexOf("build") !== -1 ||
    lower.indexOf("compile") !== -1 ||
    lower.indexOf("ci/cd") !== -1
  ) {
    return {
      workloadCategory: "Test, Build & Execution",
      recommendedTier: "tier4-open",
      recommendedModel: "qwen3-coder",
      recommendedInRate: 0.9,
      recommendedOutRate: 0.9
    };
  }
  if (
    lower.indexOf("algebra") !== -1 ||
    lower.indexOf("polynomial") !== -1 ||
    /\bfactor\s+/i.test(promptText || "") ||
    /\bfactorize\b/i.test(promptText || "") ||
    lower.indexOf("simplify ") !== -1 ||
    lower.indexOf("simultaneous") !== -1 ||
    lower.indexOf("inequality") !== -1 ||
    lower.indexOf("logarithm") !== -1 ||
    lower.indexOf("equation") !== -1 ||
    lower.indexOf("quadratic") !== -1 ||
    lower.indexOf("derivative") !== -1 ||
    lower.indexOf("integral") !== -1 ||
    lower.indexOf("eigenvalue") !== -1 ||
    lower.indexOf("calculus") !== -1 ||
    /\bsolve\s+/i.test(promptText || "") ||
    /\b[a-z]\s*\^\s*\d+/i.test(promptText || "") ||
    /\b\d+[a-z]\s*[\+\-\=]\s*-?\d+/i.test(promptText || "")
  ) {
    return {
      workloadCategory: "Analytical Math & Reasoning",
      recommendedTier: "tier4-open",
      recommendedModel: "deepseek-r1",
      recommendedInRate: 0.55,
      recommendedOutRate: 2.19
    };
  }
  if (
    lower.indexOf("grep") !== -1 ||
    lower.indexOf("find all") !== -1 ||
    lower.indexOf("list files") !== -1 ||
    lower.indexOf("search") !== -1 ||
    lower.indexOf("where is") !== -1 ||
    lower.indexOf("git status") !== -1 ||
    lower.indexOf("git branch") !== -1 ||
    lower.indexOf("ls ") !== -1 ||
    lower.length < 120
  ) {
    return {
      workloadCategory: "Codebase Search & Subagents",
      recommendedTier: "tier1-fast",
      recommendedModel: "gemini-3.8-flash",
      recommendedInRate: 0.15,
      recommendedOutRate: 0.6
    };
  }
  if (
    lower.indexOf("refactor") !== -1 ||
    lower.indexOf("implement") !== -1 ||
    lower.indexOf("function") !== -1 ||
    lower.indexOf("class ") !== -1 ||
    lower.indexOf("module") !== -1 ||
    lower.indexOf("fix ") !== -1 ||
    lower.indexOf("edit ") !== -1 ||
    lower.indexOf("patch") !== -1 ||
    lower.indexOf("python") !== -1 ||
    lower.indexOf("typescript") !== -1 ||
    lower.indexOf("sql") !== -1
  ) {
    return {
      workloadCategory: "Feature & Code Editing",
      recommendedTier: "tier2-daily",
      recommendedModel: "claude-sonnet-5-5",
      recommendedInRate: 3.0,
      recommendedOutRate: 15.0
    };
  }
  return {
    workloadCategory: "General Q&A",
    recommendedTier: "tier2-daily",
    recommendedModel: "gemini-3.1-pro-preview",
    recommendedInRate: 2.0,
    recommendedOutRate: 12.0
  };
}

function extractProjectWorkspace(context, rawBody, promptSnippet) {
  var hdrProj = getHeaderFirst(context, [
    "x-project-name",
    "X-Project-Name",
    "x-workspace-name",
    "X-Workspace-Name",
    "x-repo-name",
    "X-Repo-Name"
  ]);
  if (hdrProj) return hdrProj;
  var source = (promptSnippet || "") + "\n" + (rawBody || "").slice(0, 3000);
  var cwdMatch = source.match(/(?:Working Directory|cwd|workspace|repo)[:=\s]+([A-Za-z0-9_.\-\/]+)/i);
  if (cwdMatch && cwdMatch[1]) {
    var segs = cwdMatch[1].replace(/\/+$/, "").split("/");
    var lastSeg = segs[segs.length - 1];
    if (lastSeg && lastSeg.length > 1) return lastSeg;
  }
  return "codingagent-modelrouter";
}

function sanitizeTraceField(val, maxLen, allowSpaces) {
  if (!val || typeof val !== "string") return "";
  var cleaned = val.replace(/[\r\n\t\0]/g, "").trim();
  if (!cleaned) return "";
  var safe = allowSpaces
    ? cleaned.replace(/[^A-Za-z0-9@._:\-\/ ]/g, "_")
    : cleaned.replace(/[^A-Za-z0-9@._:\-\/]/g, "_");
  if (maxLen && safe.length > maxLen) {
    safe = safe.substring(0, maxLen);
  }
  return safe;
}

function parseBaggageHeader(rawBaggage) {
  var map = {};
  if (!rawBaggage || typeof rawBaggage !== "string") return map;
  var bounded = rawBaggage.slice(0, 1024);
  var pairs = bounded.split(",");
  for (var i = 0; i < pairs.length && i < 20; i++) {
    var item = pairs[i].split(";")[0].trim();
    var eqIdx = item.indexOf("=");
    if (eqIdx <= 0) continue;
    var k = item.substring(0, eqIdx).trim().toLowerCase();
    var v = item.substring(eqIdx + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch (e) {}
    if (k) {
      map[k] = v;
    }
  }
  return map;
}

function resolveTraceAndEnrichment(context, seedStr) {
  var traceId = "";
  var spanId = "";
  var traceSource = "gateway_generated";

  var traceparent = getHeaderFirst(context, ["traceparent", "Traceparent"]);
  if (traceparent) {
    var tpMatch = traceparent.trim().match(/^00-([0-9a-fA-F]{32})-([0-9a-fA-F]{16})-[0-9a-fA-F]{2}$/);
    if (tpMatch && !/^0+$/.test(tpMatch[1]) && !/^0+$/.test(tpMatch[2])) {
      traceId = tpMatch[1].toLowerCase();
      spanId = tpMatch[2].toLowerCase();
      traceSource = "w3c_traceparent";
    }
  }

  if (!traceId) {
    var cloudTrace = getHeaderFirst(context, [
      "x-cloud-trace-context",
      "X-Cloud-Trace-Context"
    ]);
    if (cloudTrace) {
      var ctMatch = cloudTrace.trim().match(/^([0-9a-fA-F]{32})(?:\/([0-9]{1,20}))?/);
      if (ctMatch && !/^0+$/.test(ctMatch[1])) {
        traceId = ctMatch[1].toLowerCase();
        if (ctMatch[2]) {
          var decNum = parseInt(ctMatch[2], 10);
          if (!isNaN(decNum) && decNum > 0) {
            var hexSpan = decNum.toString(16);
            while (hexSpan.length < 16) hexSpan = "0" + hexSpan;
            spanId = hexSpan.slice(-16);
          }
        }
        traceSource = "cloud_trace_context";
      }
    }
  }

  if (!traceId) {
    var clientTrace = getHeaderFirst(context, [
      "x-trace-id",
      "X-Trace-Id",
      "langfuse-trace-id",
      "Langfuse-Trace-Id"
    ]);
    if (clientTrace) {
      var cleanHex = clientTrace.replace(/-/g, "").trim();
      if (/^[0-9a-fA-F]{32}$/.test(cleanHex) && !/^0+$/.test(cleanHex)) {
        traceId = cleanHex.toLowerCase();
        traceSource = "client_trace_id";
      }
    }
  }

  if (!traceId) {
    traceId =
      fnv1aHashHex("t0:" + seedStr) +
      fnv1aHashHex("t1:" + seedStr) +
      fnv1aHashHex("t2:" + seedStr) +
      fnv1aHashHex("t3:" + seedStr);
  }
  if (!spanId) {
    spanId = fnv1aHashHex("s0:" + seedStr) + fnv1aHashHex("s1:" + seedStr);
  }

  var baggageMap = parseBaggageHeader(
    getHeaderFirst(context, ["baggage", "Baggage"])
  );

  var rawEnv =
    getHeaderFirst(context, [
      "x-environment",
      "X-Environment",
      "langfuse-environment",
      "Langfuse-Environment"
    ]) ||
    baggageMap["langfuse.environment"] ||
    baggageMap["deployment.environment"] ||
    baggageMap["environment"] ||
    "production";
  var cleanEnv = sanitizeTraceField(rawEnv, 40, false).replace(/[^A-Za-z0-9._\-]/g, "-");
  if (!cleanEnv) cleanEnv = "production";

  var rawTags =
    getHeaderFirst(context, [
      "x-tags",
      "X-Tags",
      "langfuse-tags",
      "Langfuse-Tags"
    ]) ||
    baggageMap["langfuse.tags"] ||
    baggageMap["tags"] ||
    "";
  var tagsList = [];
  if (rawTags) {
    var rawSplit = String(rawTags).slice(0, 512).split(",");
    for (var ti = 0; ti < rawSplit.length && tagsList.length < 10; ti++) {
      var cleanTag = sanitizeTraceField(rawSplit[ti], 40, false);
      if (cleanTag) tagsList.push(cleanTag);
    }
  }

  var rawTraceName =
    getHeaderFirst(context, [
      "x-trace-name",
      "X-Trace-Name",
      "langfuse-trace-name",
      "Langfuse-Trace-Name"
    ]) ||
    baggageMap["langfuse.trace.name"] ||
    "";
  var traceName = sanitizeTraceField(rawTraceName, 80, true);

  var baggageSession = sanitizeTraceField(
    getHeaderFirst(context, ["langfuse-session-id", "Langfuse-Session-Id"]) ||
      baggageMap["langfuse.session.id"] ||
      baggageMap["session.id"] ||
      "",
    80,
    false
  );

  return {
    traceId: traceId,
    spanId: spanId,
    traceSource: traceSource,
    environment: cleanEnv,
    tagsCsv: tagsList.join(","),
    traceName: traceName,
    baggageSession: baggageSession
  };
}

function normalizeIngestionModeValue(raw) {
  var u = String(raw || "").trim().toUpperCase();
  if (u === "FULL" || u === "USAGE" || u === "NONE") return u;
  return "";
}

function ingestionModeRank(mode) {
  if (mode === "FULL") return 2;
  if (mode === "NONE") return 0;
  return 1; // USAGE default
}

function rankToIngestionMode(rank) {
  if (rank >= 2) return "FULL";
  if (rank <= 0) return "NONE";
  return "USAGE";
}

function resolveFinopsIngestionMode(context) {
  var propIngestion =
    typeof properties !== "undefined" && properties && properties.finopsIngestionMode
      ? String(properties.finopsIngestionMode)
      : "";
  var adminRaw =
    context.getVariable("verifyapikey.VA-VerifyApiKey.apiproduct.finops_ingestion_mode") ||
    context.getVariable("verifyapikey.VA-VerifyDeveloperKey.apiproduct.finops_ingestion_mode") ||
    context.getVariable("finops_ingestion_mode") ||
    propIngestion ||
    "USAGE";
  var adminMode = normalizeIngestionModeValue(adminRaw) || "USAGE";
  var clientHeaderRaw = getHeaderFirst(context, [
    "x-finops-ingestion-mode",
    "X-Finops-Ingestion-Mode",
    "x-gateway-ingestion-mode",
    "X-Gateway-Ingestion-Mode",
    "langfuse-ingestion-mode",
    "Langfuse-Ingestion-Mode"
  ]);
  var clientMode = normalizeIngestionModeValue(clientHeaderRaw);
  // Security invariant: client headers may ONLY tighten privacy (FULL -> USAGE -> NONE),
  // never escalate USAGE -> FULL or NONE -> USAGE beyond the admin policy.
  if (!clientMode) {
    return adminMode;
  }
  var effectiveRank = Math.min(
    ingestionModeRank(adminMode),
    ingestionModeRank(clientMode)
  );
  return rankToIngestionMode(effectiveRank);
}

function runParseAndValidateModelRequest(context) {
  var basePath = context.getVariable("proxy.basepath") || "";
  var rawSuffix = context.getVariable("proxy.pathsuffix") || "";
  var reqUri =
    context.getVariable("request.uri") ||
    context.getVariable("request.path") ||
    "";

  var combinedPath = reqUri;
  if (!combinedPath) {
    if (basePath && rawSuffix && rawSuffix.indexOf(basePath) !== 0) {
      combinedPath =
        (basePath.charAt(basePath.length - 1) === "/"
          ? basePath.slice(0, -1)
          : basePath) +
        (rawSuffix.charAt(0) === "/" ? rawSuffix : "/" + rawSuffix);
    } else {
      combinedPath = rawSuffix || basePath;
    }
  }

  var pathParts = combinedPath.split("?");
  var pathSuffix = pathParts[0] || "";
  var queryString =
    pathParts[1] || context.getVariable("request.querystring") || "";
  var rawSuffixOnly = (rawSuffix.split("?")[0] || "").trim();
  var reqVerb = (context.getVariable("request.verb") || "POST").toUpperCase();

  var nowStartMs = Date.now();
  if (!context.getVariable("ai.requestStartMs")) {
    context.setVariable("ai.requestStartMs", String(nowStartMs));
  }
  if (
    !context.getVariable("gcp_project_id") &&
    typeof properties !== "undefined" &&
    properties &&
    properties.gcpProjectId
  ) {
    context.setVariable("gcp_project_id", String(properties.gcpProjectId));
  }
  if (
    !context.getVariable("ai.decisionsApiUrl") &&
    typeof properties !== "undefined" &&
    properties &&
    properties.decisionsApiUrl
  ) {
    context.setVariable("ai.decisionsApiUrl", String(properties.decisionsApiUrl));
  }
  var gatewayReqSeed =
    String(nowStartMs) +
    ":" +
    String(context.getVariable("messageid") || Math.random()) +
    ":" +
    String(pathSuffix);
  var gatewayRequestId =
    "req_" + nowStartMs.toString(36) + "_" + fnv1aHashHex(gatewayReqSeed);
  var clientRequestId = sanitizeTraceField(
    getHeaderFirst(context, ["x-request-id", "X-Request-Id"]),
    128,
    false
  );
  var traceMeta = resolveTraceAndEnrichment(context, gatewayReqSeed);
  var effectiveIngestionMode = resolveFinopsIngestionMode(context);

  context.setVariable("ai.gatewayRequestId", gatewayRequestId);
  context.setVariable("ai.clientRequestId", clientRequestId);
  context.setVariable("ai.traceId", traceMeta.traceId);
  context.setVariable("ai.spanId", traceMeta.spanId);
  context.setVariable("ai.traceSource", traceMeta.traceSource);
  context.setVariable("ai.environment", traceMeta.environment);
  context.setVariable("ai.tags", traceMeta.tagsCsv);
  context.setVariable("ai.traceName", traceMeta.traceName);
  context.setVariable("ai.finopsIngestionMode", effectiveIngestionMode);
  context.setVariable("finops_ingestion_mode_effective", effectiveIngestionMode);

  if (
    reqVerb === "GET" &&
    (pathSuffix === "/v1/models" ||
      rawSuffixOnly === "/models" ||
      pathSuffix === "/v1beta/models" ||
      pathSuffix === "/v1/finops" ||
      pathSuffix === "/v1/finops/report" ||
      rawSuffixOnly === "/finops" ||
      rawSuffixOnly === "/finops/report")
  ) {
    var allowedTiersGet =
      context.getVariable("allowed_model_tiers") ||
      context.getVariable("auth.allowed_models") ||
      "tier1-fast,tier2-daily,tier4-open";
    var allowedPartsGet = allowedTiersGet.split(",");
    var prodTierGet =
      context.getVariable("product_tier") ||
      context.getVariable("auth.product_tier") ||
      "coding-agent-standard";
    var devEmailGet =
      context.getVariable("developer_email") ||
      context.getVariable("auth.developer_email") ||
      "developer@enterprise.internal";

    var directPayload = {};
    if (
      pathSuffix.indexOf("finops") !== -1 ||
      rawSuffixOnly.indexOf("finops") !== -1
    ) {
      var dailyQuotaGet =
        parseInt(context.getVariable("developer_daily_token_quota") || "5000000", 10) || 5000000;
      var orgSeatsGet =
        parseInt(context.getVariable("org_gemini_seats") || "1250", 10) || 1250;
      var seatCreditGet =
        parseFloat(context.getVariable("org_gemini_seat_credit_usd") || "10.0") || 10.0;
      var monthlyGeminiPoolUsd = Math.round(orgSeatsGet * seatCreditGet * 100.0) / 100.0;
      var annualGeminiPoolUsd = Math.round(monthlyGeminiPoolUsd * 12.0 * 100.0) / 100.0;
      var fspDiscountPctNum =
        parseFloat(context.getVariable("org_fsp_discount_pct") || "15.0") || 15.0;
      var userUsdCapGet =
        parseFloat(
          getHeaderFirst(context, ["x-daily-usd-limit", "X-Daily-Usd-Limit"]) ||
            context.getVariable("developer_daily_usd_limit") ||
            "0"
        ) || 0;
      directPayload = {
        object: "finops.report",
        generated_at: new Date().toISOString(),
        gateway: "apigee-x-vertex-model-router",
        caller: {
          developer_email: devEmailGet,
          gateway_key_name:
            context.getVariable("ai.gatewayKeyName") ||
            context.getVariable("gateway_key_name") ||
            "default-gateway-key",
          credential_type:
            context.getVariable("ai.credentialType") ||
            context.getVariable("credential_type") ||
            "user_key",
          user_id_source:
            context.getVariable("ai.userIdSource") ||
            context.getVariable("user_id_source") ||
            "api_key_owner",
          product_tier: prodTierGet,
          allowed_tiers: allowedPartsGet
        },
        ingestion_policy: {
          active_mode: effectiveIngestionMode,
          supported_modes: ["FULL", "USAGE", "NONE"],
          client_escalation_allowed: false
        },
        // daily_token_limit is enforced by <LLMTokenQuota>. The 5h / weekly windows are
        // advisory guardrails for the developer CLI, derived from the daily budget so they
        // never contradict it (standard 5M/day -> 2M per 5h, 25M per 5-day week).
        org_quotas: {
          five_hour_token_limit: Math.round(dailyQuotaGet * 0.4),
          daily_token_limit: dailyQuotaGet,
          weekly_token_limit: dailyQuotaGet * 5,
          daily_usd_limit: userUsdCapGet > 0 ? userUsdCapGet : null,
          enforced: ["daily_token_limit", "usd_spend_guardrail"],
          advisory: ["five_hour_token_limit", "weekly_token_limit"]
        },
        spend_guardrails: {
          precedence: ["user", "team", "org"],
          warning_threshold_pct: 80,
          default_action_at_100_pct: "downgrade_to_gemini_credit_pool",
          supported_policies: ["downgrade", "hard_block"]
        },
        funding_pools: {
          ANTIGRAVITY_GEMINI_CREDITS: {
            description:
              "Google Antigravity Enterprise Seat Bundle ($" +
              seatCreditGet.toFixed(0) +
              "/user/mo x " +
              orgSeatsGet +
              " users = $" +
              monthlyGeminiPoolUsd.toFixed(0) +
              "/mo | $" +
              annualGeminiPoolUsd.toFixed(0) +
              "/yr Gemini Token Credit Pool)",
            monthly_credit_grant_usd: monthlyGeminiPoolUsd,
            annual_credit_grant_usd: annualGeminiPoolUsd,
            net_cash_outlay_usd: 0.0
          },
          GCP_COMMIT_FSP_DISCOUNT: {
            description:
              "Google Cloud Commit Burndown + " +
              fspDiscountPctNum.toFixed(0) +
              "% FSP Discount (Anthropic Claude & Open-Weight MaaS)",
            fsp_discount_pct: fspDiscountPctNum.toFixed(1) + "%"
          }
        },
        summary: {
          telemetry_pipeline: "Apigee DataCapture + PostClientFlow Cloud Logging (apigee-ai-finops) -> Single Unified GCP Cloud Monitoring Dashboard",
          governance_policy: "One Unified Engineering Policy (All Model Tiers Enabled + Daily Token/USD Guardrails + Routing & Overkill Transparency)",
          unified_console: "GCP Cloud Monitoring Dashboard (Coding Agent Enterprise FinOps & Multi-Harness Governance)",
          active_data_collectors: 31,
          smart_router_enabled: true,
          baseline_comparison_model: "claude-opus-5-5 ($15/$75 per 1M tokens)",
          routing_modes: ["smart_auto", "daily_direct", "manual_frontier_pin"],
          avoidable_frontier_spend_tracking: true,
          subagent_spend_isolation: true,
          router_judge_auditability: true,
          w3c_traceparent_turn_grouping: true,
          cloud_trace_linked: true,
          service_key_leaderboard_isolation: true,
          net_cash_invoice_accounting: true,
          supported_harnesses: ["claude-code", "codex", "antigravity", "oh-my-pi", "opencode", "cursor", "deepseek"],
          chargeback_dimensions: [
            "developer_email",
            "gateway_key_name",
            "credential_type",
            "team_name",
            "cost_center",
            "coding_harness",
            "model",
            "tier",
            "routing_mode",
            "recommended_tier",
            "workload_category",
            "project_name",
            "environment",
            "ingestion_mode",
            "funding_pool",
            "is_subagent",
            "is_router_override"
          ]
        }
      };
    } else {
      var seenCanonical = { auto: true };
      var dataArr = [
        {
          id: "auto",
          object: "model",
          owned_by: "vertex-ai-model-garden",
          tier: "dynamic",
          family: "smart-router",
          vertex_model_id: "dynamic",
          allowed_for_caller: true
        }
      ];
      var modelKeys = Object.keys(MODEL_CATALOG);
      for (var mk = 0; mk < modelKeys.length; mk++) {
        var mKey = modelKeys[mk];
        var mEntry = MODEL_CATALOG[mKey];
        if (!mEntry || seenCanonical[mEntry.canonicalId]) continue;
        seenCanonical[mEntry.canonicalId] = true;
        var callerAllowed = false;
        for (var ai = 0; ai < allowedPartsGet.length; ai++) {
          var aItem = allowedPartsGet[ai].trim();
          if (aItem === mEntry.tier || aItem === mEntry.canonicalId) {
            callerAllowed = true;
            break;
          }
        }
        dataArr.push({
          id: mEntry.canonicalId,
          object: "model",
          owned_by: "vertex-ai-model-garden",
          tier: mEntry.tier,
          family: mEntry.family,
          vertex_model_id: mEntry.vertexModelId,
          region: mEntry.region,
          pricing_per_1m_usd: {
            input: mEntry.inputCostPer1M,
            output: mEntry.outputCostPer1M
          },
          allowed_for_caller: callerAllowed
        });
      }
      var modelsArr = [];
      for (var mi = 0; mi < dataArr.length; mi++) {
        modelsArr.push({
          name: "models/" + dataArr[mi].id,
          displayName: dataArr[mi].id,
          tier: dataArr[mi].tier,
          family: dataArr[mi].family,
          allowedForCaller: dataArr[mi].allowed_for_caller
        });
      }
      directPayload = {
        object: "list",
        caller_product_tier: prodTierGet,
        caller_allowed_tiers: allowedPartsGet,
        data: dataArr,
        models: modelsArr
      };
    }

    context.setVariable("ai.isCatalogOrFinopsRequest", "true");
    context.setVariable("ai.directResponseJson", JSON.stringify(directPayload));
    context.setVariable("model_not_found", "false");
    context.setVariable("ai.modelNotFound", "false");
    context.setVariable("rbac_denied", "false");
    context.setVariable("ai.modelAllowed", "true");
    context.setVariable("needs_smart_judge", "false");
    context.setVariable("ai.useSmartJudge", "false");
    context.setVariable("ai.cacheEligible", "false");
    return;
  }

  var rawBody = context.getVariable("request.content") || "{}";
  var body = {};
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    body = {};
  }
  if (stripSmartRouterBadgesFromHistory(body)) {
    rawBody = JSON.stringify(body);
    context.setVariable("request.content", rawBody);
  }

  var userAgent = (
    context.getVariable("request.header.user-agent") ||
    context.getVariable("request.header.User-Agent") ||
    ""
  ).toLowerCase();

  var clientProtocol = "anthropic_messages";
  var codingHarness = "claude-code";
  var requestedModel = body.model ? String(body.model).trim() : "";
  var isStreaming = Boolean(body.stream);
  var isCountTokens =
    pathSuffix.indexOf("/count_tokens") !== -1 ||
    rawSuffixOnly.indexOf("/count_tokens") !== -1 ||
    pathSuffix.indexOf(":countTokens") !== -1;

  if (pathSuffix.indexOf("/publishers/anthropic/models/") !== -1) {
    clientProtocol = "anthropic_messages";
    codingHarness = "claude-code";
    var afterAnthropicModels = pathSuffix.substring(
      pathSuffix.lastIndexOf("/publishers/anthropic/models/") +
        "/publishers/anthropic/models/".length
    );
    var anthColonIdx = afterAnthropicModels.indexOf(":");
    if (anthColonIdx !== -1) {
      requestedModel = afterAnthropicModels.substring(0, anthColonIdx);
      var anthAction = afterAnthropicModels.substring(anthColonIdx + 1);
      isStreaming =
        anthAction.indexOf("streamRawPredict") === 0 || Boolean(body.stream);
      if (anthAction.indexOf("countTokens") === 0) {
        isCountTokens = true;
      }
    } else if (afterAnthropicModels) {
      requestedModel = afterAnthropicModels;
    }
  } else if (
    pathSuffix === "/v1beta/decisions" ||
    pathSuffix === "/v1beta/decisions/" ||
    rawSuffixOnly === "/v1beta/decisions" ||
    rawSuffixOnly === "/v1beta/decisions/" ||
    (basePath === "/v1beta" &&
      (rawSuffixOnly === "/decisions" || rawSuffixOnly === "/decisions/"))
  ) {
    clientProtocol = "gemini_decisions";
    codingHarness = "gemini-decisions";
    requestedModel = body.model ? String(body.model).trim() : "gemini-decision-1";
    isStreaming = false;
    isCountTokens = false;
  } else if (
    pathSuffix.indexOf("/v1beta/models/") === 0 ||
    pathSuffix.indexOf("/v1beta1/") === 0 ||
    pathSuffix.indexOf("/models/") !== -1 ||
    basePath.indexOf("/v1beta") === 0
  ) {
    clientProtocol = "vertex_gemini";
    codingHarness = "antigravity";
    var afterModels = "";
    if (pathSuffix.indexOf("/v1beta/models/") === 0) {
      afterModels = pathSuffix.substring("/v1beta/models/".length);
    } else if (pathSuffix.indexOf("/models/") !== -1) {
      afterModels = pathSuffix.substring(
        pathSuffix.lastIndexOf("/models/") + "/models/".length
      );
    } else {
      afterModels =
        rawSuffixOnly.charAt(0) === "/"
          ? rawSuffixOnly.substring(1)
          : rawSuffixOnly;
    }
    var colonIdx = afterModels.indexOf(":");
    if (colonIdx !== -1) {
      requestedModel = afterModels.substring(0, colonIdx);
      var action = afterModels.substring(colonIdx + 1);
      isStreaming =
        action.indexOf("streamGenerateContent") === 0 ||
        queryString.indexOf("alt=sse") !== -1;
      if (action.indexOf("countTokens") === 0) {
        isCountTokens = true;
      }
    } else if (afterModels) {
      requestedModel = afterModels;
    }
  } else if (
    pathSuffix.indexOf("/v1/responses") === 0 ||
    rawSuffixOnly === "/responses" ||
    rawSuffixOnly.indexOf("/responses/") === 0
  ) {
    clientProtocol = "openai_responses";
    codingHarness = "codex";
  } else if (
    pathSuffix.indexOf("/v1/chat/completions") === 0 ||
    rawSuffixOnly === "/chat/completions" ||
    rawSuffixOnly.indexOf("/chat/completions/") === 0
  ) {
    clientProtocol = "openai_chat";
    var clientNameHdr = (
      context.getVariable("request.header.x-client-name") ||
      context.getVariable("request.header.X-Client-Name") ||
      ""
    ).toLowerCase();
    if (userAgent.indexOf("antigravity") !== -1 || clientNameHdr.indexOf("antigravity") !== -1) {
      codingHarness = "antigravity";
    } else if (
      userAgent.indexOf("oh-my-pi") !== -1 ||
      userAgent.indexOf("super-pi") !== -1 ||
      userAgent.indexOf("pi-agent") !== -1 ||
      clientNameHdr.indexOf("pi") !== -1
    ) {
      codingHarness = "pi-agent";
    } else if (userAgent.indexOf("cursor") !== -1 || clientNameHdr.indexOf("cursor") !== -1) {
      codingHarness = "cursor";
    } else {
      codingHarness = "codex";
    }
  } else {
    clientProtocol = "anthropic_messages";
    codingHarness = "claude-code";
  }

  var promptSnippet = extractPromptSnippet(body, clientProtocol);
  var latestUserPrompt = extractLatestUserPrompt(body, clientProtocol);
  var judgePromptSource = latestUserPrompt || promptSnippet;
  var escapedSnippet = escapeJsonStringContent(judgePromptSource);

  var devId =
    context.getVariable("developer_email") ||
    context.getVariable("auth.developer_id") ||
    "";
  var prodTier =
    context.getVariable("product_tier") ||
    context.getVariable("auth.product_tier") ||
    "coding-agent-standard";
  var bypassHeader = (
    context.getVariable("request.header.x-bypass-cache") ||
    context.getVariable("request.header.X-Bypass-Cache") ||
    ""
  ).toLowerCase();
  var singleTurnEligible =
    !isStreaming &&
    !isCountTokens &&
    bypassHeader !== "true" &&
    devId.length > 0 &&
    devId !== "anonymous" &&
    isSingleTurnCacheEligible(body, clientProtocol);
  var bodyHash = fnv1aHashHex(rawBody);
  var scopedCacheSource = escapeJsonStringContent(
    "[tenant:" +
      devId +
      "|tier:" +
      prodTier +
      "|proto:" +
      clientProtocol +
      "|model:" +
      requestedModel +
      "|hash:" +
      bodyHash +
      "] " +
      promptSnippet
  );

  // Normalize Claude Code v2.1+ suffixes ("[1m]", "@YYYYMMDD") and Antigravity/Codex reasoning-effort suffixes ("-high", "-medium", "-low")
  var rawClientModel = requestedModel;
  var extractedEffort = extractReasoningEffortSuffix(rawClientModel);
  if (extractedEffort) {
    context.setVariable("ai.reasoningEffort", extractedEffort);
  }
  if (requestedModel && !MODEL_CATALOG[requestedModel]) {
    var normalizedCandidate = normalizeModelCandidate(requestedModel);
    if (
      MODEL_CATALOG[normalizedCandidate] ||
      normalizedCandidate === "auto" ||
      normalizedCandidate === "smart-router" ||
      normalizedCandidate === "switchyard-auto"
    ) {
      requestedModel = normalizedCandidate;
    }
  }

  // Switchyard Gateway Header-Driven Routing & Subagent Detection:
  // Allows Claude Code (and Codex / Antigravity / Pi) to keep native UI model names
  // (e.g. "claude-opus-5[1m]", "claude-sonnet-5", "claude-haiku-4-5") with zero warnings,
  // while routing on the gateway via ANTHROPIC_CUSTOM_HEADERS / X-Routing-Mode / X-Model-Override / X-Model-Map / X-Switchyard-*.
  var clientRequestedModel = requestedModel;
  context.setVariable("ai.clientRequestedModel", clientRequestedModel);

  var subagentCheck = detectAndSanitizeSubagent(body, requestedModel);
  if (subagentCheck.mutated) {
    rawBody = JSON.stringify(body);
    context.setVariable("request.content", rawBody);
  }
  context.setVariable("ai.isSubagent", subagentCheck.isSubagent ? "true" : "false");

  var headerModelOverride = getHeaderFirst(context, [
    "x-model-override",
    "X-Model-Override",
    "x-target-model",
    "X-Target-Model"
  ]);
  var headerSwitchyardBaseline = getHeaderFirst(context, [
    "x-switchyard-baseline",
    "X-Switchyard-Baseline",
    "x-switchyard-baseline-model",
    "X-Switchyard-Baseline-Model"
  ]);
  var headerSwitchyardRatio = getHeaderFirst(context, [
    "x-switchyard-ratio",
    "X-Switchyard-Ratio",
    "x-switchyard-traffic-ratio",
    "X-Switchyard-Traffic-Ratio"
  ]);
  var headerRoutingMode = getHeaderFirst(context, [
    "x-routing-mode",
    "X-Routing-Mode",
    "x-router-config",
    "X-Router-Config",
    "x-router-profile",
    "X-Router-Profile",
    "x-switchyard-route-override",
    "X-Switchyard-Route-Override"
  ]).toLowerCase();
  var headerModelMapRaw = getHeaderFirst(context, [
    "x-model-map",
    "X-Model-Map",
    "x-switchyard-model-map",
    "X-Switchyard-Model-Map"
  ]);

  var tierMap = parseModelMapHeader(headerModelMapRaw);
  if (tierMap.high || tierMap.opus) {
    context.setVariable(
      "ai.switchyardModelHigh",
      normalizeModelCandidate(tierMap.high || tierMap.opus)
    );
  }
  if (tierMap.mid || tierMap.sonnet) {
    context.setVariable(
      "ai.switchyardModelMid",
      normalizeModelCandidate(tierMap.mid || tierMap.sonnet)
    );
  }
  if (tierMap.low || tierMap.haiku) {
    context.setVariable(
      "ai.switchyardModelLow",
      normalizeModelCandidate(tierMap.low || tierMap.haiku)
    );
  }

  var clientSlot = getClientModelSlot(requestedModel);
  var isDefaultPlaceholder = isDefaultHeaderPlaceholder(
    rawClientModel,
    requestedModel,
    clientProtocol
  );
  var routingReasonOverride = "";

  if (subagentCheck.subagentModel && MODEL_CATALOG[subagentCheck.subagentModel]) {
    requestedModel = subagentCheck.subagentModel;
    routingReasonOverride = "subagent_tag_override->" + requestedModel;
  } else if (headerModelOverride && (isDefaultPlaceholder || !requestedModel || subagentCheck.isSubagent)) {
    var cleanOverride = normalizeModelCandidate(headerModelOverride);
    if (subagentCheck.isSubagent && cleanOverride === "auto") {
      requestedModel = "gemini-3.8-flash";
      routingReasonOverride = "subagent_detector->gemini-3.8-flash";
    } else {
      requestedModel = cleanOverride;
      routingReasonOverride = "header_model_override->" + requestedModel;
    }
  } else if (
    (headerModelMapRaw ||
      headerRoutingMode === "tiered" ||
      headerRoutingMode === "rule_based" ||
      headerRoutingMode === "tiered_reasoning" ||
      headerRoutingMode === "map") &&
    (clientSlot !== null || !requestedModel || subagentCheck.isSubagent)
  ) {
    var mappedTarget = "";
    var defaultHigh = headerSwitchyardBaseline
      ? normalizeModelCandidate(headerSwitchyardBaseline)
      : "gemini-4-argon";
    if (subagentCheck.isSubagent) {
      mappedTarget =
        tierMap.subagent || tierMap.haiku || tierMap.low || "gemini-3.8-flash";
      routingReasonOverride = "subagent_tier_map->" + mappedTarget;
    } else if (clientSlot === "fable") {
      mappedTarget =
        tierMap.fable || tierMap.opus || tierMap.high || defaultHigh;
      routingReasonOverride = "tier_map:fable->" + mappedTarget;
    } else if (clientSlot === "opus" || !clientSlot) {
      mappedTarget = tierMap.opus || tierMap.high || defaultHigh;
      routingReasonOverride = "tier_map:opus->" + mappedTarget;
    } else if (clientSlot === "sonnet") {
      mappedTarget = tierMap.sonnet || tierMap.mid || "qwen3-coder";
      routingReasonOverride = "tier_map:sonnet->" + mappedTarget;
    } else if (clientSlot === "haiku") {
      mappedTarget = tierMap.haiku || tierMap.low || "gemini-3.8-flash";
      routingReasonOverride = "tier_map:haiku->" + mappedTarget;
    }
    if (mappedTarget) {
      requestedModel = normalizeModelCandidate(mappedTarget);
    }
  } else if (
    (headerRoutingMode === "auto" ||
      headerRoutingMode === "smart" ||
      headerRoutingMode === "smart-router" ||
      headerRoutingMode === "llm" ||
      headerRoutingMode === "dynamic" ||
      headerRoutingMode === "default" ||
      headerRoutingMode === "variant_a" ||
      headerRoutingMode === "variant_b" ||
      headerSwitchyardRatio.length > 0) &&
    (isDefaultPlaceholder || !requestedModel || requestedModel === "auto" || subagentCheck.isSubagent)
  ) {
    if (subagentCheck.isSubagent) {
      requestedModel = "gemini-3.8-flash";
      routingReasonOverride = "subagent_detector->gemini-3.8-flash";
    } else {
      requestedModel = "auto";
      routingReasonOverride = headerSwitchyardRatio
        ? "switchyard_ratio(" + headerSwitchyardRatio + ")->auto"
        : "header_routing_mode:auto";
    }
  } else if (headerSwitchyardBaseline && (isDefaultPlaceholder || !requestedModel || clientProtocol === "vertex_gemini")) {
    var cleanBaseline = normalizeModelCandidate(headerSwitchyardBaseline);
    requestedModel = cleanBaseline;
    routingReasonOverride = "switchyard_baseline->" + requestedModel;
  } else if (subagentCheck.isSubagent && clientSlot !== null) {
    requestedModel = "gemini-3.8-flash";
    routingReasonOverride = "subagent_detector->gemini-3.8-flash";
  }

  if (routingReasonOverride) {
    context.setVariable("smart_router_decision", routingReasonOverride);
    context.setVariable("ai.smartRouterDecision", routingReasonOverride);
  }

  var workloadMeta = classifyWorkloadAndRecommendation(
    judgePromptSource,
    subagentCheck.isSubagent
  );
  var projectName = extractProjectWorkspace(context, rawBody, promptSnippet);
  var hdrSessionId =
    getHeaderFirst(context, [
      "x-session-id",
      "X-Session-Id",
      "x-claude-session-id",
      "X-Claude-Session-Id",
      "x-conversation-id",
      "X-Conversation-Id"
    ]) || traceMeta.baggageSession;
  var sessionId =
    sanitizeTraceField(hdrSessionId, 80, false) ||
    "sess_" + fnv1aHashHex((devId || "dev") + ":" + codingHarness + ":" + projectName);

  context.setVariable("workload_category", workloadMeta.workloadCategory);
  context.setVariable("ai.workloadCategory", workloadMeta.workloadCategory);
  context.setVariable("recommended_tier", workloadMeta.recommendedTier);
  context.setVariable("ai.recommendedTier", workloadMeta.recommendedTier);
  context.setVariable("recommended_model", workloadMeta.recommendedModel);
  context.setVariable("ai.recommendedModel", workloadMeta.recommendedModel);
  context.setVariable("recommended_in_rate", String(workloadMeta.recommendedInRate));
  context.setVariable("recommended_out_rate", String(workloadMeta.recommendedOutRate));
  context.setVariable("project_name", projectName);
  context.setVariable("ai.projectName", projectName);
  context.setVariable("session_id", sessionId);
  context.setVariable("ai.sessionId", sessionId);

  scopedCacheSource = escapeJsonStringContent(
    "[tenant:" +
      devId +
      "|tier:" +
      prodTier +
      "|proto:" +
      clientProtocol +
      "|model:" +
      requestedModel +
      "|hash:" +
      bodyHash +
      "] " +
      promptSnippet
  );

  // Enterprise USD Spend Guardrails (User > Group/Team > Org precedence).
  // Security invariant: client headers can opt into a STRICTER cap or hard_block,
  // but can NEVER raise an admin-configured cap or lower tracked spend.
  function resolveMonotonicCap(adminRaw, headerRaw) {
    var a = parseFloat(adminRaw || "0") || 0;
    var h = parseFloat(headerRaw || "0") || 0;
    if (a > 0 && h > 0) return Math.min(a, h);
    return a > 0 ? a : h;
  }

  var userUsdCap = resolveMonotonicCap(
    context.getVariable("verifyapikey.VA-VerifyApiKey.developer.attribute.daily_usd_limit") ||
      context.getVariable("developer_daily_usd_limit"),
    getHeaderFirst(context, ["x-daily-usd-limit", "X-Daily-Usd-Limit"])
  );
  var teamUsdCap = resolveMonotonicCap(
    context.getVariable("verifyapikey.VA-VerifyApiKey.developer.attribute.team_daily_usd_limit") ||
      context.getVariable("team_daily_usd_limit"),
    getHeaderFirst(context, ["x-team-daily-usd-limit", "X-Team-Daily-Usd-Limit"])
  );
  var orgUsdCap = resolveMonotonicCap(
    context.getVariable("verifyapikey.VA-VerifyApiKey.apiproduct.org_daily_usd_limit") ||
      context.getVariable("org_daily_usd_limit"),
    getHeaderFirst(context, ["x-org-daily-usd-limit", "X-Org-Daily-Usd-Limit"])
  );
  var effectiveUsdCap = 0;
  var budgetScope = "none";
  if (userUsdCap > 0) {
    effectiveUsdCap = userUsdCap;
    budgetScope = "user";
  } else if (teamUsdCap > 0) {
    effectiveUsdCap = teamUsdCap;
    budgetScope = "team";
  } else if (orgUsdCap > 0) {
    effectiveUsdCap = orgUsdCap;
    budgetScope = "org";
  }

  var trackedSpendUsd = parseFloat(context.getVariable("developer_daily_spend_usd") || "0") || 0;
  var simulatedSpendUsd =
    parseFloat(
      getHeaderFirst(context, [
        "x-simulated-daily-spend-usd",
        "X-Simulated-Daily-Spend-Usd"
      ]) || "0"
    ) || 0;
  var currentDailySpendUsd = Math.max(trackedSpendUsd, simulatedSpendUsd);

  var adminBudgetPolicy = (
    context.getVariable("verifyapikey.VA-VerifyApiKey.developer.attribute.budget_policy") ||
    context.getVariable("developer_budget_policy") ||
    ""
  ).toLowerCase();
  var headerBudgetPolicy = (
    getHeaderFirst(context, ["x-budget-policy", "X-Budget-Policy"]) || ""
  ).toLowerCase();
  var budgetPolicy =
    adminBudgetPolicy === "hard_block" || headerBudgetPolicy === "hard_block"
      ? "hard_block"
      : adminBudgetPolicy || headerBudgetPolicy || "downgrade";

  context.setVariable("ai.budgetHardBlocked", "false");
  context.setVariable("ai.budgetDowngraded", "false");
  context.setVariable("ai.budgetWarning", "");
  context.setVariable("ai.budgetAction", "within_budget");
  context.setVariable("ai.budgetScope", budgetScope);

  if (effectiveUsdCap > 0 && !isCountTokens) {
    var spendPct = (currentDailySpendUsd / effectiveUsdCap) * 100.0;
    var nowUtc = new Date();
    var resetUtcIso = new Date(
      Date.UTC(
        nowUtc.getUTCFullYear(),
        nowUtc.getUTCMonth(),
        nowUtc.getUTCDate() + 1,
        0,
        0,
        0
      )
    ).toISOString();
    context.setVariable("ai.budgetExceededUntil", resetUtcIso);
    context.setVariable("ai.budgetLimitUsd", effectiveUsdCap.toFixed(2));
    context.setVariable("ai.budgetSpendUsd", currentDailySpendUsd.toFixed(2));

    if (spendPct >= 100.0) {
      if (budgetPolicy === "hard_block") {
        context.setVariable("ai.budgetHardBlocked", "true");
        context.setVariable("ai.budgetAction", "hard_blocked_402");
        return;
      } else {
        // Default enterprise policy: Graceful Auto-Cutover to Gemini Token Credit Pool ($0 incremental cash)
        requestedModel = "gemini-3.8-flash";
        routingReasonOverride =
          "budget_cap_downgrade(" + budgetScope + ")->gemini-3.8-flash";
        context.setVariable("smart_router_decision", routingReasonOverride);
        context.setVariable("ai.smartRouterDecision", routingReasonOverride);
        context.setVariable("ai.budgetDowngraded", "true");
        context.setVariable("ai.budgetAction", "downgraded_to_gemini_pool");
        context.setVariable(
          "ai.budgetWarning",
          "100% of $" +
            effectiveUsdCap.toFixed(2) +
            "/day " +
            budgetScope +
            " USD budget reached ($" +
            currentDailySpendUsd.toFixed(2) +
            "); gracefully routed to gemini-3.8-flash ($0 Gemini Credit Pool) until " +
            resetUtcIso
        );
      }
    } else if (spendPct >= 80.0) {
      context.setVariable("ai.budgetAction", "warning_80_pct");
      context.setVariable(
        "ai.budgetWarning",
        spendPct.toFixed(0) +
          "% of $" +
          effectiveUsdCap.toFixed(2) +
          "/day " +
          budgetScope +
          " USD budget consumed ($" +
          currentDailySpendUsd.toFixed(2) +
          ")"
      );
    }
  }

  // Set both flat and dot-scoped variables for Apigee YAML + JS policy compatibility
  context.setVariable("client_protocol", clientProtocol);
  context.setVariable("coding_harness", codingHarness);
  context.setVariable("ai.harnessType", codingHarness);
  context.setVariable("requested_model", requestedModel);
  context.setVariable("ai.requestedModel", requestedModel);
  context.setVariable("is_streaming", isStreaming ? "true" : "false");
  context.setVariable("ai.isStreaming", isStreaming ? "true" : "false");
  context.setVariable("is_count_tokens", isCountTokens ? "true" : "false");
  context.setVariable("ai.isCountTokens", isCountTokens ? "true" : "false");
  context.setVariable("ai.cacheEligible", singleTurnEligible ? "true" : "false");
  context.setVariable("ai.semanticCacheKeySource", scopedCacheSource);
  context.setVariable("prompt_text_for_armor", promptSnippet);
  context.setVariable("ai.latestUserPrompt", judgePromptSource);
  context.setVariable("ai.extractedPrompt", escapedSnippet);
  context.setVariable("prompt_summary_for_judge", escapedSnippet);
  context.setVariable("ai.escapedPrompt", escapedSnippet);
  context.setVariable("model_not_found", "false");
  context.setVariable("ai.modelNotFound", "false");
  context.setVariable("ai.isRouterOverride", "false");

  var headerAutoBadge = getHeaderFirst(context, [
    "x-auto-route-badge",
    "X-Auto-Route-Badge"
  ]).toLowerCase();
  var trimmedUserPrompt = (latestUserPrompt || "").trim();
  var isSlashCommandTurn =
    /^\/(models|finops|finops-admin|vertex|switch|route|status)(\s|$)/i.test(trimmedUserPrompt) ||
    /^(models|finops|finops-admin|route|status)$/i.test(trimmedUserPrompt);

  if (
    requestedModel === "smart-router" ||
    requestedModel === "auto" ||
    requestedModel === "switchyard-auto"
  ) {
    if (headerAutoBadge === "true" && !isSlashCommandTurn) {
      context.setVariable("ai.autoRouteBadge", "true");
    } else {
      context.setVariable("ai.autoRouteBadge", "false");
    }
    context.setVariable("routing_mode", "smart_auto");
    context.setVariable("ai.routingMode", "smart_auto");
    context.setVariable("needs_smart_judge", "true");
    context.setVariable("ai.useSmartJudge", "true");
    context.setVariable("rbac_denied", "false");
    context.setVariable("ai.modelAllowed", "true");
    return;
  }

  context.setVariable("ai.autoRouteBadge", "false");

  context.setVariable("needs_smart_judge", "false");
  context.setVariable("ai.useSmartJudge", "false");

  var modelMeta = MODEL_CATALOG[requestedModel];
  if (!modelMeta) {
    // Unknown model: reject with HTTP 404 instead of silently substituting Gemini Pro
    context.setVariable("model_not_found", "true");
    context.setVariable("ai.modelNotFound", "true");
    context.setVariable("rbac_denied", "false");
    context.setVariable("ai.modelAllowed", "false");
    return;
  }

  var allowedTiers =
    context.getVariable("allowed_model_tiers") ||
    context.getVariable("auth.allowed_models") ||
    "tier1-fast,tier2-daily,tier4-open";
  var allowedList = allowedTiers.split(",");
  var isAllowed = false;
  for (var idx = 0; idx < allowedList.length; idx++) {
    var entry = allowedList[idx].trim();
    if (entry === modelMeta.tier || entry === requestedModel || entry === modelMeta.canonicalId) {
      isAllowed = true;
      break;
    }
  }

  if (!isAllowed) {
    context.setVariable("rbac_denied", "true");
    context.setVariable("ai.modelAllowed", "false");
    return;
  }

  var vertexHost =
    modelMeta.region === "global"
      ? "aiplatform.googleapis.com"
      : modelMeta.region + "-aiplatform.googleapis.com";

  var resolvedRoutingMode = "daily_direct";
  if (
    subagentCheck.isSubagent ||
    context.getVariable("ai.budgetDowngraded") === "true" ||
    headerRoutingMode === "auto" ||
    headerRoutingMode === "tiered" ||
    headerModelMapRaw.length > 0 ||
    headerSwitchyardRatio.length > 0
  ) {
    resolvedRoutingMode = "smart_auto";
  } else if (modelMeta.tier === "tier3-frontier") {
    resolvedRoutingMode = "manual_frontier_pin";
  }

  // Track Engineering Manager Router Override metric: caller explicitly pinned a costlier tier
  // than Smart Router recommended (or manually overrode header-level auto routing via /model).
  var isRouterOverride =
    context.getVariable("ai.budgetDowngraded") !== "true" &&
    !subagentCheck.isSubagent &&
    ((resolvedRoutingMode === "manual_frontier_pin" &&
      workloadMeta.recommendedTier !== "tier3-frontier") ||
      ((headerRoutingMode === "auto" || headerRoutingMode === "smart") &&
        !isDefaultPlaceholder &&
        requestedModel !== "auto"));
  context.setVariable("ai.isRouterOverride", isRouterOverride ? "true" : "false");

  context.setVariable("routing_mode", resolvedRoutingMode);
  context.setVariable("ai.routingMode", resolvedRoutingMode);
  context.setVariable("rbac_denied", "false");
  context.setVariable("ai.modelAllowed", "true");
  context.setVariable("target_model_id", modelMeta.canonicalId);
  context.setVariable("ai.selectedModel", modelMeta.canonicalId);
  context.setVariable("vertex_model_id", modelMeta.vertexModelId);
  context.setVariable("target_model_family", modelMeta.family);
  context.setVariable("ai.targetFamily", modelMeta.family);
  context.setVariable("target_model_tier", modelMeta.tier);
  context.setVariable("vertex_region", modelMeta.region);
  context.setVariable("ai.vertexRegion", modelMeta.region);
  context.setVariable("vertex_host", vertexHost);
  context.setVariable("ai.vertexHost", vertexHost);
  context.setVariable("model_input_cost_1m", String(modelMeta.inputCostPer1M));
  context.setVariable("model_output_cost_1m", String(modelMeta.outputCostPer1M));
}

if (typeof context !== "undefined") {
  runParseAndValidateModelRequest(context);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MODEL_CATALOG: MODEL_CATALOG,
    escapeJsonStringContent: escapeJsonStringContent,
    extractPromptSnippet: extractPromptSnippet,
    runParseAndValidateModelRequest: runParseAndValidateModelRequest
  };
}
