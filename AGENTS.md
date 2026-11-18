# AGENTS.md

Instructions for AI coding agents working in `codingagent-modelrouter`.

## 1. Project Goal & Product Requirements

Build a **100% native Google Cloud Apigee X model router** (Switchyard) in front of **Vertex AI Model Garden** that gives enterprise engineering teams a unified model routing layer without running self-managed LiteLLM proxies or MCP model-switching bridges:

1. **Bring-Your-Own Coding Harness (Native Model Picker)**: Developers keep their preferred CLI/IDE harness—**Claude Code** (`claude`), **OpenAI Codex** (`codex`), **Google Antigravity IDE/CLI** (`agy`), **VS Code / Cursor**, **Pi / Oh-My-Pi / Super-Pi** (`pi`), **OpenCode** (`opencode`), and **DeepSeek Harness** (`dsh`)—and switch Vertex AI models natively via `/model <id>`, `--model <id>`, or IDE model dropdowns.
2. **Nexus-Style CLI & Manual Config Parity**:
   - **CLI Helper (`./vertex-connect.sh`)**: Zero-friction setup (`claude`, `codex`, `pi`, `agy`, `opencode`, `deepseek`), health check (`status`), live catalog (`models`), and spend inspection (`finops`), plus clean restore (`off`).
   - **Manual Setup (`DEVELOPER_SETUP_GUIDE.md`)**: Copy-pasteable env vars and config files (`~/.claude/settings.json`, `~/.codex/config.toml`, `~/.pi/agent/models.json`, Antigravity `admin_settings.json`).
3. **4-Tier Smart Router (`model: "auto"`)**: Heuristic + pluggable classifier routing supporting Vertex LLM Judge (`gemini`), Google Gemini Decisions API (`decisions` / `decisions-only` via `gemini-decision-1` at `POST /v1beta/decisions` with calibrated probabilities & 0 output tokens), custom HTTPS classifiers (`custom`), and zero-network heuristics (`heuristic`). Sends background grep/search/sub-agent turns to fast or open-weight models (`gemini-3.8-flash`, `deepseek-v4.1-flash`, `qwen3-coder`) and reserves frontier reasoning (`gemini-4-argon`, `claude-opus-5-5`) for complex architecture and debugging. Also proxies governed direct `POST /v1beta/decisions` (`gemini-decision-1`) calls on `antigravity-gateway`.
4. **Centralized Enterprise Governance & FinOps**:
   - **2-Hop Zero-Trust Auth**: Hop 1 authenticates developers at Apigee X via `<VerifyAPIKey>` (per-developer Apigee Consumer Key) or `<VerifyJWT>` + `<AccessEntity>` (Google OIDC). Hop 2 mints short-lived GCP OAuth2 tokens via `<Authentication><GoogleAccessToken>` (`apigee-vertex-router-sa`).
   - **Quotas, Safety & Chargeback**: Enforces per-developer daily token budgets (`<LLMTokenQuota>`), Model Armor guardrails (`<SanitizeUserPrompt>` / `<SanitizeModelResponse>`), 429/5xx regional failover, and per-developer/team/harness FinOps telemetry (`<DataCapture>`, `GET /v1/finops/report`).

---

## 2. Architecture & Wire-Protocol Matrix

| Inbound Client Protocol | Proxy Template & Base Path | Coding Harnesses | Southbound Vertex AI Translation |
| :--- | :--- | :--- | :--- |
| **Anthropic Messages** | `templates/claude-code-gateway.yaml` (`/v1/messages`) | Claude Code CLI & VS Code Extension | Translates to/from Vertex Gemini (`:generateContent`), Vertex Anthropic (`:rawPredict`), or Vertex OpenAPI MaaS (`/endpoints/openapi/chat/completions`) |
| **OpenAI Responses** | `templates/codex-gateway.yaml` (`/v1/responses`) | OpenAI Codex CLI & Desktop | Any-to-any request, tool-call, and SSE translation |
| **OpenAI Chat Completions** | `templates/codex-gateway.yaml` (`/v1/chat/completions`) | Pi / Oh-My-Pi, OpenCode, DeepSeek (`dsh`), Cursor, VS Code Copilot/Cline | Any-to-any request, tool-call, and SSE translation |
| **Vertex GenAI** | `templates/antigravity-gateway.yaml` (`/v1beta`, `/v1beta1`) | Google Antigravity IDE & CLI (`agy`) | Native passthrough to Gemini; translates when targeting Claude or MaaS models |

---

## 3. Repository Layout

- `templates/` — Apigee X proxy endpoint and southbound target templates (`claude-code-gateway.yaml`, `antigravity-gateway.yaml`, `codex-gateway.yaml`).
- `features/` — Composable Apigee policy fragments (`ai-auth-dual.yaml`, `ai-token-quota.yaml`, `ai-security-modelarmor.yaml`, `ai-semantic-cache.yaml`, `ai-model-preprocess.yaml`, `ai-pluggable-classifier.yaml`, `ai-model-postprocess.yaml`, `ai-vertex-fallback.yaml`).
- `stages/` — Apigee proxy stages (`05-add-vertex-fallback.yaml`, `06-add-pluggable-classifier.yaml`, `07-mvp-pilot.yaml`); `stages/params/` holds environment-specific parameter files passed as `STAGE_PARAMS`.
- `src/ai-functions/` — Apigee JavaScript callouts for auth extraction, model catalog & RBAC validation, 4-tier smart routing, request/response/SSE translation, and FinOps cost calculation.
- `deploy.sh` — Compiles YAML stages + JS callouts into validated Apigee X XML proxy bundles (`build/<stage>/`).
- `vertex-connect.sh` — Developer CLI helper for harness configuration, `/v1/models`, and `/v1/finops/report`.
- `infra/` — Terraform for GCP IAM, PSC networking, internal load balancer, Model Armor, Apigee proxy deployments, API Products, Developers/Apps, and FinOps monitoring.
- `tests/` — Local Apigee X emulator (`apigee_local_emulator.js`), offline E2E suite (`verify_e2e.py`), live Vertex suite (`verify_live_vertex.py`), Smart Router and latency benchmarks (`bench_router_classifiers.py`, `bench_llm_judge.py`, `bench_decisions_api.py`, `bench_gateway_latency.py`, `bench_semantic_cache.py`), and the labelled routing prompt sets they use (`tests/data/`).
- `tools/apigee_lab_env.py` — Creates and removes an isolated Apigee lab environment (own environment, environment group, API products and apps).
- `DEVELOPER_SETUP_GUIDE.md` — Developer quickstart, CLI reference, manual setup, and per-harness guides for each IDE/CLI.

---

## 4. Critical Engineering Rules & Invariants

When modifying JS callouts (`src/ai-functions/`), policy YAML (`features/`, `templates/`), or `deploy.sh`, enforce these invariants:

1. **Apigee X JavaScript Runtime Compatibility**:
   - Files in `src/ai-functions/*.js` execute inside Apigee's Rhino JS sandbox (`context.getVariable` / `context.setVariable`) **and** the Node emulator.
   - **Never** rely on Node-only globals (`Buffer`, `require`, `process`) or in-memory `globalThis` state persisting across requests in Apigee mode.
2. **Protocol & Tool-Loop Fidelity**:
   - **JSON Schema Preservation**: When normalizing tool schemas for Gemini `parametersJsonSchema` or Anthropic `input_schema`, never corrupt string arrays such as `required: ["cmd"]`, `enum: ["a","b"]`, or `type: ["string","null"]`. Only recurse into schema-bearing keywords (`properties`, `items`, `anyOf`, `oneOf`, `allOf`, `$defs`).
   - **CRLF Streaming**: Vertex AI `:streamGenerateContent?alt=sse` separates events with `\r\n\r\n`. Always split SSE buffers on `/\r?\n\r?\n/` and flush chunks immediately without full-response buffering.
   - **Streaming Tool Arguments**: Accumulate Anthropic `input_json_delta` and OpenAI/MaaS `tool_calls[].function.arguments` fragments across SSE chunks in flow state before emitting completed tool calls to non-streaming-delta targets.
   - **Stateless Gemini 3 `thoughtSignature` Round-Tripping**: Encode `thoughtSignature` into `tool_use_id` / `call_id` using pure-JS base64url on both unary and streaming paths so multi-turn Gemini 3 tool loops survive stateless Apigee workers. Never fall back to a cross-tenant `fn:<name>` lookup. On cross-model failover to Gemini 3, set `thoughtSignature: "skip_thought_signature_validator"` when prior turns lack Gemini signatures.
   - **Apigee Basepath Detection**: In Apigee, `proxy.pathsuffix` strips `proxy.basepath`. Always resolve wire protocol using `proxy.basepath + proxy.pathsuffix` (or `request.path`), and handle `/v1/messages/count_tokens` without triggering full LLM inference.
3. **Apigee XML Schema & Policy Ordering**:
   - In PostFlow, `JS-TransformResponseAndCalculateCost` **must** execute before `SMR-ValidateResponse`, `LTQ-CountTokensUnary`, `SCP-PopulateResponse`, and `DC-CaptureFinOpsMetrics`.
   - In EventFlow (`content-type="text/event-stream"`), `JS-TransformStreamEvent` **must** execute before `LTQ-CountTokensStream`.
   - `<LLMTokenQuota>` must use child elements (`<SharedName>`, `<Distributed>`, `<EnforceOnly>`, `<CountOnly>`, `<LLMTokenUsageSource>{ai.totalTokenCount}</LLMTokenUsageSource>`), not root attributes.
4. **Security & Test Hygiene**:
   - Never hardcode API keys, static OIDC tokens, or `ya29.*` auth bypasses. Read test keys from environment variables or generate ephemeral random keys per run.
   - Verification scripts (`tests/*.py`) must **never** mutate production Apigee control-plane state or roll back deployed revisions.

---

## 5. Build, Test & Verify Commands

Always run the offline verification suite and bundle compiler after any code or config change:

```bash
# 1. Compile all Apigee X XML proxy bundles (validates YAML + XML generation)
./deploy.sh --build-only

# 2. Run the offline E2E verification suite (Apigee emulator + 6 protocol/security suites)
/usr/bin/python3 tests/verify_e2e.py

# 3. Test the developer CLI helper
GATEWAY_API_KEY="test_key" ./vertex-connect.sh claude auto
GATEWAY_API_KEY="test_key" ./vertex-connect.sh codex gemini-4-argon
GATEWAY_API_KEY="test_key" ./vertex-connect.sh pi deepseek-v4.1-flash
./vertex-connect.sh agy

# 4. Run live Vertex AI / Apigee verification (requires active GCP ADC credentials)
GCP_PROJECT_ID="your-gcp-project-id" /usr/bin/python3 tests/verify_live_vertex.py
```
