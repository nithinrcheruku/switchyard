# Vertex AI Enterprise AI Coding Gateway (Switchyard)

> **A 100% native Google Cloud Apigee X model routing and governance layer in front of Vertex AI Model Garden.**  
> Unifies **Claude Code**, **OpenAI Codex**, **Google Antigravity IDE/CLI (`agy`)**, **VS Code / Cursor / Cline**, and **Pi** across Gemini, Claude, and open-weight models with zero DIY proxy containers, zero credential sprawl, 4-tier smart routing, and centralized FinOps governance.

![Switchyard Architecture: Any harness. Any frontier model. One governed endpoint.](assets/switchyard-architecture.jpg)

---

> 🚀 **Are you a developer looking to connect your laptop or IDE right now?**  
> Jump straight to the **[Developer Setup Guide](DEVELOPER_SETUP_GUIDE.md)** for 1-minute automated setup and per-IDE instructions for Antigravity, Claude Code, Codex, VS Code, Cursor, and Pi.

---

## 📑 Table of Contents

- [The Problems This Gateway Solves](#-the-problems-this-gateway-solves)
- [Wire-Protocol Normalization Matrix](#-wire-protocol-normalization-matrix)
- [End-to-End Architecture & Security Flow](#-end-to-end-architecture--security-flow)
- [How Auto Routing & Classification Works](#-how-auto-routing--classification-works)
- [Platform Administrator Setup & Deployment](#-platform-administrator-setup--deployment)
- [Enterprise FinOps, Observability & Metrics](#-enterprise-finops-observability--metrics)
- [Build, Test & Verification Commands](#-build-test--verification-commands)

---

## 🎯 The Problems This Gateway Solves

Enterprise engineering organizations adopting AI coding tools face four critical operational bottlenecks:

| Problem | The DIY / Unmanaged Reality | How This Apigee X Gateway Solves It |
| :--- | :--- | :--- |
| **1. Fragile DIY Proxies** | Running self-hosted LiteLLM containers or custom Python bridges introduces single points of failure, scaling bottlenecks, CVE patch burdens, and memory leaks on long-running agentic streams. | **100% Native Serverless**: Runs on Google Cloud Apigee X with 99.99% enterprise SLA, automated scaling, zero container maintenance, and multi-region failover. |
| **2. Tool & Model Silos** | Developers are locked into vendor ecosystems: Claude Code only talks to Claude, Codex only talks to OpenAI, and custom IDE extensions require separate configurations. | **Universal Wire Translation**: Normalizes Anthropic Messages, OpenAI Responses, OpenAI Chat, and Vertex GenAI protocols. Developers use their favorite IDE/CLI with *any* Vertex AI model. |
| **3. Runaway Frontier Spend** | Developers leave their tools pinned to \$15/\$75 per million token frontier models (`claude-opus`, `gemini-4-argon`) for simple file searches, unit test boilerplates, and syntax lookups. | **4-Tier Smart Router (`model: "auto"`)**: Automatically classifies intent and routes 65–80% of routine turns to fast models (`gemini-3.8-flash`, `qwen3-coder`) while reserving frontier models for complex architecture. |
| **4. Security & Compliance Gaps** | Cloud service account keys or raw API keys are distributed to individual developer laptops, bypassing corporate security, DLP, and token budgets. | **2-Hop Zero-Trust Governance**: Developers authenticate with Apigee consumer keys or Google OIDC. Apigee enforces Model Armor prompt guardrails, daily token quotas, and mints short-lived OAuth2 tokens to Vertex AI. |

---

## 🔌 Wire-Protocol Normalization Matrix

The gateway exposes all 4 coding harness protocols on standard base paths, translating payloads, streaming events, and tool definitions to the required Southbound Vertex AI format:

| Inbound Protocol | Base Paths Accepted | Supported Coding Tools | Southbound Vertex AI Target | Translation Handling |
| :--- | :--- | :--- | :--- | :--- |
| **Anthropic Messages** | `/v1/messages`<br>`/v1/messages/count_tokens` | **Claude Code CLI**<br>Claude Code VS Code/JetBrains | Vertex Gemini (`:generateContent`)<br>Vertex Claude (`:rawPredict`)<br>Vertex MaaS (`/endpoints/openapi/...`) | Translates `tools` schemas, preserves Gemini 3 `thoughtSignature`, streams CRLF SSE chunks, preserves prompt caching. |
| **OpenAI Responses** | `/v1/responses`<br>`/responses` | **OpenAI Codex CLI**<br>Codex Desktop | Vertex Gemini (`:generateContent`)<br>Vertex Claude (`:rawPredict`)<br>Vertex MaaS | Any-to-any response streaming, tool-call items, and call ID mapping. |
| **OpenAI Chat Completions** | `/v1/chat/completions`<br>`/v1/models` | **Pi / Oh-My-Pi**<br>**VS Code Copilot Chat**<br>**Cursor / Cline / Continue**<br>**OpenCode**<br>**DeepSeek Harness (`dsh`)** | Vertex Gemini<br>Vertex Claude<br>Vertex MaaS (Qwen, DeepSeek, GLM, Kimi) | Transforms standard `choices[].delta.tool_calls` and emits standard OpenAI SSE chunks with `[DONE]`. |
| **Vertex GenAI** | `/v1beta/models/...`<br>`/v1beta1/models/...` | **Google Antigravity IDE & CLI (`agy`)**<br>Google GenAI SDKs | Native Vertex Gemini passthrough<br>Vertex Claude<br>Vertex MaaS | Native passthrough for Gemini; translates to Anthropic or OpenAI MaaS schemas when non-Gemini models are requested. |
| **Gemini Decisions API** | `/v1beta/decisions` | **Google GenAI SDKs** (`google-genai` / `@google/genai` >= 3.2)<br>Agent Routers & Policy Engines | Gemini Developer API (`POST /v1beta/decisions`, `gemini-decision-1`) | Native passthrough preserving calibrated `noul`, `choice`, and `score` probabilities (`0` output tokens, \$0.10/1M input) under Apigee Auth, quotas, Model Armor, and FinOps. |

### Protocol Engineering Invariants
- **Schema Preservation**: When converting tool definitions between Anthropic `input_schema`, OpenAI `parameters`, and Gemini `parametersJsonSchema`, string arrays (`required`, `enum`, `type`) are strictly preserved.
- **CRLF SSE Streaming**: Vertex AI SSE separates chunks with `\r\n\r\n`. The gateway splits buffers cleanly without waiting for full response termination, ensuring zero streaming latency.
- **Stateless Tool Loops**: Gemini 3 `thoughtSignature` tokens are encoded directly into tool call IDs via base64url, allowing multi-turn tool loops to succeed across stateless Apigee gateway workers without requiring shared cross-tenant session databases.

---

## 🏗️ End-to-End Architecture & Security Flow

Every request entering the gateway passes through an enterprise zero-trust pipeline before reaching Vertex AI:

```
[Developer IDE / CLI]
       │
       ▼  (1) Inbound Request + Client Auth (Apigee Key or Corporate OIDC)
┌────────────────────────────────────────────────────────────────────────┐
│                        Apigee X Gateway Layer                          │
│                                                                        │
│  [Hop 1: Auth & RBAC]  Verify identity, validate API Product & tier    │
│  [Quota Check]         Enforce developer daily token budget            │
│  [Model Armor]         Sanitize inbound prompt (DLP, prompt injection) │
│  [Smart Router]        Heuristic / LLM Judge classification (auto mode)│
│  [Protocol Normalizer] Translate wire payload to Southbound format     │
│  [Hop 2: GCP IAM]      Mint short-lived OAuth2 bearer token            │
└────────────────────────────────────────────────────────────────────────┘
       │
       ▼  (2) Southbound Invocation + Ephemeral OAuth2 Token
[Vertex AI Model Garden] (Gemini, Claude, or OpenAPI MaaS)
       │
       ▼  (3) Streaming Response Chunks (\r\n\r\n CRLF SSE)
┌────────────────────────────────────────────────────────────────────────┐
│                        Apigee X Gateway Layer                          │
│                                                                        │
│  [Stream Translator]   Convert chunks to client wire protocol          │
│  [Model Armor Egress]  Inspect outbound response against DLP policies  │
│  [FinOps Engine]       Extract token counts, calculate exact cost      │
│  [Telemetry & Logs]    Stream metrics to Cloud Monitoring & BigQuery   │
└────────────────────────────────────────────────────────────────────────┘
       │
       ▼  (4) Normalized SSE Stream to IDE / CLI
[Developer IDE / CLI]
```

### 2-Hop Zero-Trust Security Model
1. **Hop 1 (Client → Apigee X)**:
   - Developers authenticate via an **Apigee Consumer API Key** (`x-api-key`, `Authorization: Bearer <key>`, or `x-goog-api-key`) or corporate **Google OIDC JWT**.
   - Apigee validates the key in memory, extracts the developer identity and cost center, checks the developer's assigned **API Product** (`coding-agent-standard` or `coding-agent-frontier`), and strips the client credential before forwarding.
2. **Hop 2 (Apigee X $\rightarrow$ Vertex AI Model Garden)**:
   - Apigee uses native `<Authentication><GoogleAccessToken>` configured with the `apigee-vertex-router-sa` service account (`roles/aiplatform.user`).
   - Short-lived GCP OAuth2 tokens are minted automatically. Developers never possess GCP IAM credentials on their laptops.

### Enterprise Guardrails & Resilience
- **Google Cloud Model Armor**: Sanitizes inbound prompts (`<SanitizeUserPrompt>`) and outbound responses (`<SanitizeModelResponse>`) to block jailbreaks, prompt injection, and credential exfiltration.
- **Token Quotas (`<LLMTokenQuota>`)**: Enforces daily token limits (e.g. 500K tokens for Standard, 2M tokens for Frontier). When a budget is exhausted, Apigee returns HTTP 429 without calling Vertex AI.
- **Regional High Availability**: Configured with automatic `<HTTPTargetConnection>` fallback to alternate regions (`us-central1`, `us-east5`, `global`) on Vertex AI 429 or 5xx errors, preserving multi-turn context.

---

## 🧠 How Auto Routing & Classification Works

When a developer sets `model: "auto"` (or header `x-routing-mode: auto`), the gateway activates the **4-Tier Smart Router**.

Requests that explicitly name a model (e.g., `gemini-4-argon`, `claude-sonnet-5-5`, `qwen3-coder`) **bypass classification completely (0 ms overhead)**.

```
Incoming Turn (model: "auto")
      │
      ▼
┌────────────────────────────────────────────────────────────────────┐
│ Step 1: Deterministic Heuristic Rules (0 ms network)               │
│ (Skipped when JudgeBackend = "decisions-only")                     │
│ • Slash commands (/models, /finops) ───► Tier 1 Fast               │
│ • Architecture/Concurrency keywords ──► Tier 3 Frontier            │
│ • Code/Unit test generation ───────────► Tier 4 Open               │
│ • Mathematical reasoning ──────────────► Tier 4 Open               │
│ • Daily refactoring / code review ─────► Tier 2 Daily              │
└────────────────────────┬───────────────────────────────────────────┘
                         │ (No rule matched, or decisions-only)
                         ▼
┌────────────────────────────────────────────────────────────────────┐
│ Step 2: Pluggable Classifier / Judge                               │
│ • decisions / decisions-only (~150 ms, 0 output tokens, $0.10/1M): │
│     POST /v1beta/decisions (gemini-decision-1) evaluates parallel  │
│     `routing_tier` (choice) + `needs_deep_reasoning` (noul) with   │
│     calibrated confidence thresholding & escalation                │
│ • gemini (~520 ms, default):                                       │
│     gemini-3.5-flash-lite classifies SIMPLE/MEDIUM/COMPLEX/REASONING│
│ • custom: Bring-Your-Own HTTPS classifier (Google ID Token auth)   │
│ • heuristic: Rules + prompt-length fallback only (0 ms network)    │
└────────────────────────┬───────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────────────────────┐
│ Step 3: RBAC Capping & Fail-Open Fallback                          │
│ • Low-confidence Decisions split (<0.50) ─► Tier 2 Daily (safe)    │
│ • If classifier times out/errors: <180 chars ─► Tier 1 Fast        │
│ • Standard Key: Tier 3 Frontier capped ───────► Tier 2 Daily       │
│ • Frontier Key: All 4 tiers permitted                              │
└────────────────────────────────────────────────────────────────────┘
```

### The 4 Routing Tiers

| Tier | Category | Default Models | Cost / 1M Tokens | Typical Tasks |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1** | **Fast / Subagent** | `gemini-3.8-flash`<br>`gemini-3.5-flash-lite`<br>`deepseek-v4.1-flash` | **\$0.10 – \$0.25** | Subagent tasks, grep searches, file listings, syntax lookups, test execution checks |
| **Tier 2** | **Daily Workhorse** | `claude-sonnet-5-5`<br>`gemini-3.8-flash`<br>`qwen3-coder` | **\$1.00 – \$3.00** | Standard feature implementation, refactoring, multi-file edits, code review |
| **Tier 3** | **Frontier Reasoning**| `gemini-4-argon`<br>`claude-opus-5-5`<br>`claude-opus-4-7` | **\$5.00 – \$15.00** | Distributed system architecture, concurrency bugs, deadlocks, performance bottlenecks |
| **Tier 4** | **Open / Math** | `deepseek-r1`<br>`glm-5.2`<br>`kimi-k2`<br>`llama-4-maverick` | **\$0.40 – \$2.00** | Algorithmic optimization, formal logic, mathematical proofs, multilingual code |

### Pluggable Classifier Backends (Including Gemini Decisions API)

Switchyard supports five `JudgeBackend` modes in [`features/ai-pluggable-classifier.yaml`](features/ai-pluggable-classifier.yaml), selectable at bundle build time via `STAGE_PARAMS` (or per-request via `X-Router-Classifier` in lab environments with `AllowClassifierOverride: "true"`):

| `JudgeBackend` | Step 1 (0 ms Rules) | Step 2 Classifier | Auth | Latency / Cost |
| :--- | :--- | :--- | :--- | :--- |
| **`gemini`** *(default)* | Enabled | `SC-ModelJudge` (`gemini-3.5-flash-lite:generateContent`) | Vertex OAuth2 (`GoogleAccessToken`) | ~520 ms · \$0.075/\$0.30 per 1M |
| **`decisions`** | Enabled | `SC-DecisionsClassifier` (`POST /v1beta/decisions`, `gemini-decision-1`) | Encrypted Apigee KVM `x-goog-api-key` or OAuth2 (`DecisionsAuthMode`) | ~150 ms · \$0.10 per 1M input · **0 output tokens** |
| **`decisions-only`** | Bypassed | `SC-DecisionsClassifier` (`gemini-decision-1`) on **every** `model: "auto"` turn | Encrypted Apigee KVM `x-goog-api-key` or OAuth2 (`DecisionsAuthMode`) | ~150 ms · \$0.10 per 1M input · **0 output tokens** |
| **`custom`** | Enabled | `SC-CustomClassifier` (`CustomClassifierUrl`) | Google ID Token (`CustomClassifierAudience`) | Custom endpoint SLA |
| **`heuristic`** | Enabled | None (prompt-length fallback only) | None | 0 ms · \$0 |

#### How Gemini Decisions API Classification Works (`gemini-decision-1`)
On every classified turn, `SC-DecisionsClassifier` sends a single forward-pass request to `POST https://generativelanguage.googleapis.com/v1beta/decisions` with two parallel, independent questions over the shared input (billed once at \$0.10 / 1M input tokens, **0 output tokens**):
1. **`routing_tier` (`choice`)**: Evaluates `tier1-fast`, `tier2-daily`, `tier3-frontier`, and `tier4-open`, returning the top choice, calibrated per-tier probabilities, and `confidence`.
2. **`needs_deep_reasoning` (`noul`)**: Independent yes/no check (`0.01`–`0.99`) that escalates borderline choices (`confidence < 0.75` and `noul >= DecisionsEscalationThreshold`, default `0.85`) to `tier3-frontier` (still subject to RBAC capping).
3. **Confidence Guardrail**: When `routing_tier.confidence < DecisionsMinConfidence` (default `0.50`), Switchyard escalates conservatively to `DecisionsLowConfidenceTier` (default `tier2-daily`, or `"fallback"` to defer to length fallback) instead of under-routing ambiguous prompts.
4. **Fail-Open Safety**: Safety blocks (`prompt_feedback.block_reason`), HTTP errors, or timeouts (`DecisionsTimeoutMs`, default `1500` ms) fail open cleanly to prompt-length fallback.

#### Deploying & Benchmarking with Gemini Decisions API

```bash
# 1. Compile Stage 07 bundles using the committed Decisions API parameter profile:
STAGE_PARAMS=stages/params/decisions-router.json ./deploy.sh --stage 07-mvp-pilot --build-only

#    Or use pure Decisions API mode (bypassing deterministic keyword rules):
STAGE_PARAMS='{"JudgeBackend":"decisions-only","DecisionsAuthMode":"api_key"}' \
  ./deploy.sh --stage 07-mvp-pilot --build-only

#    Or authenticate via Google OAuth 2.0 + x-goog-user-project instead of KVM API key:
STAGE_PARAMS='{"JudgeBackend":"decisions","DecisionsAuthMode":"oauth"}' \
  ./deploy.sh --stage 07-mvp-pilot --build-only

# 2. Provision the encrypted Apigee KVM (Terraform) & populate your Gemini API key out-of-band:
cd infra && terraform apply -var="project_id=${GCP_PROJECT_ID}" -var="enable_gemini_decisions_api=true"
# Then insert `gemini_decisions_api_key` into the `switchyard-secrets` KVM via Apigee KVM Entries API.

# 3. Benchmark gemini-decision-1 directly on the 100-prompt routing eval set:
GEMINI_API_KEY="your-key" /usr/bin/python3 tests/bench_decisions_api.py --out /tmp/decisions-bench.json

# 4. Compare heuristic vs. gemini vs. decisions end-to-end through a lab gateway:
GATEWAY_API_KEY="your-key" /usr/bin/python3 tests/bench_router_classifiers.py \
  --gateway-url https://your-lab-gateway --backends heuristic,gemini,decisions
```

### Classification Accuracy & Benchmarks
- **Rule-First Speed**: Deterministic rules resolve high-frequency turns in **0 ms**, avoiding classifier latency for ~40% of standard coding requests (can be bypassed with `JudgeBackend: "decisions-only"`).
- **LLM Judge Latency (`gemini`)**: The `gemini-3.5-flash-lite` judge adds a median of **~520 ms** on ambiguous turns, achieving **97% agreement** with human software architects across a 100-prompt benchmark.
- **Gemini Decisions API (`decisions` / `decisions-only`)**: Dedicated `gemini-decision-1` endpoint evaluates parallel `choice` + `noul` questions in a single prefill pass (~150 ms, \$0.10 / 1M input tokens, 0 output tokens) with calibrated confidence attribution (`X-Router-Classifier: decisions`, `X-Router-Classifier-Model: gemini-decision-1`, `X-Router-Classifier-Confidence`).
- **Overall Gateway Overhead**: Median TTFB overhead through Apigee X is **~32 ms** over warm HTTP/2 keep-alive connections.

---

## 🛠️ Platform Administrator Setup & Deployment

Platform and cloud engineers can deploy the complete infrastructure in under 5 minutes:

### 1. Infrastructure Provisioning (Terraform)
Provision GCP IAM, VPC Private Service Connect, and Model Armor:

```bash
cd infra
terraform init
terraform apply -var="project_id=YOUR_GCP_PROJECT_ID" -var="region=us-central1"
```

This provisions:
- The least-privilege `apigee-vertex-router-sa` service account with `roles/aiplatform.user`.
- Model Armor prompt and response sanitization templates.
- Apigee X environment group bindings and load balancers.

### 2. Compile & Deploy Apigee X Proxy Bundles
Run the automated deployment script from repository root:

```bash
gcloud auth application-default login
export GCP_PROJECT_ID="YOUR_GCP_PROJECT_ID"

# Build and deploy all proxies to your Apigee X organization:
./deploy.sh
```

`./deploy.sh` performs the following steps:
1. Validates all JavaScript callouts against Rhino JS runtime constraints.
2. Compiles XML bundles for `claude-code-gateway`, `antigravity-gateway`, and `codex-gateway`.
3. Deploys the bundles to your target Apigee X environment.
4. Provisions the `coding-agent-standard` and `coding-agent-frontier` API Products.
5. Generates developer apps and prints your `GATEWAY_URL` and `GATEWAY_API_KEY`.

*(Note: To test XML bundle compilation without deploying, run `./deploy.sh --build-only`.)*

### 3. API Products & Developer Key Management

Apigee controls access using two pre-configured API Products:

| API Product | Allowed Tiers | Default Daily Token Quota | Intended Audience |
| :--- | :--- | :--- | :--- |
| **`coding-agent-standard`** | Tier 1 (Fast), Tier 2 (Daily), Tier 4 (Open) | 500,000 tokens / day | General engineering teams, automated CI/CD runners, background subagents |
| **`coding-agent-frontier`** | All Tiers (including Tier 3 Frontier Reasoning) | 2,000,000 tokens / day | Principal architects, performance engineers, complex troubleshooting |

---

### 4. How Platform Admins Retrieve the Gateway URL & Provision Developer API Keys

Platform administrators can retrieve the gateway endpoint and provision developer credentials through Terraform, the Google Cloud Console, or the `gcloud` CLI:

#### A. Finding the `GATEWAY_URL`
- **Via Terraform (`infra/`)**:
  ```bash
  cd infra && terraform output -raw gateway_url
  # Output: https://switchyard.internal (or your custom domain)
  ```
- **Via Google Cloud Console**:
  Navigate to **Apigee > Admin > Environments > Groups**. Look under the **Hostnames** column (or **Network Services > Load Balancing** for your Internal Application Load Balancer IP/DNS).
- **Via `gcloud` CLI**:
  ```bash
  gcloud apigee envgroups list --organization="${GCP_PROJECT_ID}"
  ```

#### B. Generating & Retrieving Developer API Keys (Apigee Consumer Keys)
When using API key authentication, each developer requires an **Apigee Consumer Key** associated with a Developer App authorized for `coding-agent-standard` or `coding-agent-frontier`:

1. **Option 1 — Pre-Configured via Terraform (`infra/main.tf`)**:
   If developers are defined in `infra/variables.tf`, Terraform automatically creates the developers and developer apps, and provides a secure retrieval command in its outputs:
   ```bash
   cd infra
   eval "$(terraform output -raw fetch_developer_api_key_command)"
   ```
2. **Option 2 — Via Google Cloud Console UI**:
   - In Google Cloud Console, open **Apigee > Publish > Apps**.
   - Click the developer's app (e.g. `alex-rivera-coding-agent-app`).
   - Under **Credentials**, locate the credential assigned to `coding-agent-standard` or `coding-agent-frontier`.
   - Click **Show** next to **Key** (Consumer Key) and copy it. This is the `GATEWAY_API_KEY`.
3. **Option 3 — Scriptable On-Demand Creation via `gcloud` CLI**:
   ```bash
   # 1. Create a developer
   gcloud apigee developers create \
     --email="developer@company.com" \
     --first-name="Alex" --last-name="Rivera" --user-name="alexr" \
     --organization="${GCP_PROJECT_ID}"

   # 2. Create a developer app bound to the standard coding agent tier
   gcloud apigee apps create "alexr-coding-app" \
     --developer="developer@company.com" \
     --api-products="coding-agent-standard" \
     --organization="${GCP_PROJECT_ID}"

   # 3. Fetch the generated Consumer Key
   gcloud apigee apps describe "alexr-coding-app" \
     --developer="developer@company.com" \
     --organization="${GCP_PROJECT_ID}" \
     --format="value(credentials[0].consumerKey)"
   ```

---

### 5. Enterprise OAuth 2.0 & Google OIDC Integration (Recommended)

For enterprise security compliance, enterprises often prohibit static API keys on developer laptops. The router natively implements **Dual-Mode Enterprise Authentication** ([`features/ai-auth-dual.yaml`](features/ai-auth-dual.yaml)) supporting passwordless **Google OpenID Connect (OIDC)** and **OAuth 2.0 Bearer Tokens**.

#### Why Choose OAuth 2.0 / Google OIDC over Static API Keys?
- **Zero Secrets on Developer Laptops**: No long-lived API keys stored in plaintext dotfiles (`~/.claude/settings.json`, `~/.codex/config.toml`).
- **Automated Lifecycle & Instant Revocation**: When an engineer offboards or moves teams, their Google Workspace / Cloud Identity account is deactivated, instantly revoking gateway access without rotating shared secrets.
- **Short-Lived 1-Hour Ephemeral Tokens**: Identity tokens expire in 60 minutes and rotate continuously via `gcloud auth print-identity-token` or corporate SSO daemons.
- **Automatic Identity & Quota Mapping**: Apigee extracts the verified `email` claim from the JWT, automatically associates the request with the developer's Apigee entity, and enforces the assigned API Product and daily token quota.

#### Architecture: How Apigee Validates Google OIDC
```
[ Developer Laptop ]
   │
   │ 1. gcloud auth print-identity-token (or corporate SSO)
   │    Sends: Authorization: Bearer eyJhbGciOiJSUzI1Ni...
   ▼
[ Apigee X Inbound PreFlow (features/ai-auth-dual.yaml) ]
   │
   ├─► JS-ExtractAuthMode: Detects Bearer JWT (splits header, checks format)
   │
   ├─► <VerifyJWT> (VJ-VerifyGoogleOIDC):
   │     • Algorithm: RS256
   │     • JWKS URI: https://www.googleapis.com/oauth2/v3/certs (Google Public Keys)
   │     • Issuer: https://accounts.google.com
   │     • Audience: {GoogleOidcAudience} (e.g., https://ai-gw.internal.example.com)
   │
   ├─► <AccessEntity> (AE-LookupDeveloperByEmail):
   │     • Looks up Apigee Developer using claim: jwt.VJ-VerifyGoogleOIDC.decoded.claim.email
   │     • Binds developer profile, team metadata, and assigned API Product
   │
   ├─► <LLMTokenQuota>: Enforces developer's daily token budget (e.g. 500k or 2M)
   │
   └─► <AssignMessage> (AM-RemoveClientCredentials):
         • Strips Authorization & client headers before routing southbound
```

#### Step-by-Step Setup Guide on Google Cloud

##### Step 1: Configure OAuth 2.0 Audience / Client ID in Google Cloud Console
1. Navigate to [Google Cloud Console > APIs & Services > Credentials](https://console.cloud.google.com/apis/credentials).
2. Click **+ CREATE CREDENTIALS** $\rightarrow$ **OAuth client ID**.
3. Select **Application type**:
   - For internal developer CLI tools: choose **Desktop app** or **Web application**.
   - Set the name (e.g. `Coding Agent Enterprise Gateway Client`).
4. Note the generated **Client ID** (e.g., `123456789012-abcdefg.apps.googleusercontent.com`) or use your Apigee gateway URI (e.g. `https://switchyard.internal`).

##### Step 2: Configure the OIDC Audience in Apigee Stage Parameters
In your environment parameter file (`stages/params/prod.yaml` or `features/ai-auth-dual.yaml`):
```yaml
defaultParameters:
  - name: GoogleOidcJwksUri
    value: https://www.googleapis.com/oauth2/v3/certs
  - name: GoogleOidcIssuer
    value: https://accounts.google.com
  - name: GoogleOidcAudience
    value: "https://switchyard.internal" # Or your OAuth 2.0 Client ID
```
Recompile and deploy your proxy bundles with `./deploy.sh`.

##### Step 3: Register Corporate Developers in Apigee
Ensure the developer's corporate email matches their Google Cloud / Workspace email:
```bash
gcloud apigee developers create \
  --email="developer@company.com" \
  --first-name="Jane" --last-name="Doe" --user-name="jdoe" \
  --organization="${GCP_PROJECT_ID}"

gcloud apigee apps create "jdoe-corporate-app" \
  --developer="developer@company.com" \
  --api-products="coding-agent-standard" \
  --organization="${GCP_PROJECT_ID}"
```

##### Step 4: How Developers Connect Using Google OIDC
Developers authenticate with their Google identity:
```bash
# Developer authenticates to Google Cloud once per workday:
gcloud auth login

# Pass the short-lived ID token to any coding harness:
export GATEWAY_API_KEY="$(gcloud auth print-identity-token --audiences="https://switchyard.internal")"

# Configure Claude Code, Codex, or Pi with zero static keys:
./vertex-connect.sh claude auto
./vertex-connect.sh codex auto
./vertex-connect.sh pi auto
```

#### Integrating External Identity Providers (Okta, Azure AD, Ping)
If your enterprise uses a third-party IdP rather than Google Workspace:
1. **Google Cloud Workforce Identity Federation**: Federate Okta, Azure AD (Entra ID), or Ping with GCP IAM using SAML 2.0 or OIDC. Developers authenticate via `gcloud auth login --login-config=...` and mint Google identity tokens.
2. **Apigee Native `<OAuthV2>` or `<VerifyJWT>` with Custom JWKS**: Point `GoogleOidcJwksUri` in `features/ai-auth-dual.yaml` to your Okta/Entra JWKS endpoint (e.g. `https://dev-12345.okta.com/oauth2/v1/keys`) and configure `GoogleOidcIssuer` to your IdP URL.

#### Official Google Cloud Documentation Links
- 📘 [Apigee Verify JWT Policy Documentation](https://cloud.google.com/apigee/docs/api-platform/reference/policies/verify-jwt-policy) — Syntax and reference for validating RS256/ES256 signed JWTs with JWKS endpoints.
- 📘 [Authenticating with Google ID Tokens](https://cloud.google.com/docs/authentication/token-types#id) — How Google Cloud mints and validates OIDC identity tokens for service-to-service and user-to-service auth.
- 📘 [Setting up OAuth 2.0 in Google Cloud Console](https://support.google.com/cloud/answer/6158849) — Creating OAuth 2.0 Client IDs, redirect URIs, and consent screens.
- 📘 [Apigee OAuthV2 Policy Documentation](https://cloud.google.com/apigee/docs/api-platform/reference/policies/oauthv2-policy) — Setting up Apigee as a standalone OAuth 2.0 authorization server (authorization codes, client credentials, refresh tokens).
- 📘 [Apigee Access Entity Policy Documentation](https://cloud.google.com/apigee/docs/api-platform/reference/policies/access-entity-policy) — Querying developer, company, or app entities during runtime policy execution.
- 📘 [Google Cloud Workforce Identity Federation](https://cloud.google.com/iam/docs/workforce-identity-federation) — Extending Google Cloud IAM to external identity providers (Azure AD, Okta, Ping).

---

## 📊 Enterprise FinOps, Observability & Metrics

Every turn processed by the gateway records detailed telemetry via Apigee `<DataCapture>` and `<MessageLogging>` policies directly into **Google Cloud Logging**, **Cloud Monitoring**, and **BigQuery**.

### The 6 Core Log-Based Metrics

Administrators can inspect these metrics across developers, teams, repositories, and harnesses:

| Metric Name | Type | Description |
| :--- | :--- | :--- |
| `ai_router_turn_count` | Counter | Total turns processed, segmented by harness (`claude`, `codex`, `agy`, `pi`), routing mode (`smart_auto` vs. `manual_pin`), and model. |
| `ai_router_actual_cost_usd` | Gauge | Exact USD spend per turn based on published Vertex AI Model Garden pricing and disjoint cache math. |
| `ai_router_savings_usd` | Gauge | Real-time dollar savings delivered by the Smart Router compared to a baseline where every turn used Claude Opus / Gemini 4 Argon. |
| `ai_router_avoidable_frontier_spend_usd` | Gauge | **"Left-on-the-Table Overkill Metric"**: Dollar waste incurred when developers manually pin frontier models for simple tasks that Tier 1 or Tier 2 could have handled. |
| `ai_router_total_tokens` | Counter | Total input and output tokens consumed. |
| `ai_router_cached_tokens` | Counter | Total tokens served via prompt/context cache. |

### Enterprise Cloud Monitoring Dashboard

The repository includes a production-ready, 12-column mosaic Cloud Monitoring dashboard definition in [`infra/finops-dashboard.json`](infra/finops-dashboard.json) titled **"Coding Agent Enterprise FinOps & Multi-Harness Governance"**.

#### Where & How Platform Admins Access the Dashboard in Google Cloud Console

Platform administrators can access, inspect, and share the dashboard through several direct paths:

##### 1. Direct Console Navigation
1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Select your Google Cloud project from the top project dropdown.
3. In the left navigation menu (**$\equiv$**), scroll to **Operations** and click **Monitoring** $\rightarrow$ **Dashboards** (or browse directly to [console.cloud.google.com/monitoring/dashboards](https://console.cloud.google.com/monitoring/dashboards)).
4. Under the **Custom Dashboards** tab, click **Coding Agent Enterprise FinOps & Multi-Harness Governance**.

##### 2. Direct Console URL
You can navigate directly to your provisioned dashboard using the project and dashboard resource IDs:
```text
https://console.cloud.google.com/monitoring/dashboards/builder/projects/<PROJECT_ID>/dashboards/<DASHBOARD_ID>?project=<PROJECT_ID>
```

##### 3. How to Retrieve the Dashboard ID & URL via Terraform
When you deploy via Terraform (`infra/`), the dashboard is automatically created via `resource "google_monitoring_dashboard" "coding_agent_finops_dashboard"`. Retrieve its exact ID and URL:
```bash
cd infra

# Print the Dashboard Resource ID:
terraform output -raw finops_cloud_monitoring_dashboard_id

# Example Output:
# projects/123456789012/dashboards/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

##### 4. Manual Dashboard Creation / Update via `gcloud` CLI
If you wish to create or update the dashboard independently of Terraform:
```bash
# Substitute your Project ID into the dashboard template:
sed "s/@GCP_PROJECT_ID@/${GCP_PROJECT_ID}/g" infra/finops-dashboard.json > /tmp/finops-dashboard.json

# Create the dashboard in Cloud Monitoring:
gcloud monitoring dashboards create --config-from-file=/tmp/finops-dashboard.json --project="${GCP_PROJECT_ID}"
```

---

#### Key Visualizations & What Admins Can See

| Dashboard Widget | Metrics Used | Business Purpose |
| :--- | :--- | :--- |
| **Executive Spend & ROI Scorecard** | `ai_router_actual_cost_usd`<br>`ai_router_savings_usd` | Shows total monthly spend vs. net dollars saved by the Smart Router compared to a 100% frontier model baseline. |
| **Avoidable Frontier Overkill Gauge** | `ai_router_avoidable_frontier_spend_usd` | **Primary Waste KPI**: Highlights dollars lost when engineers manually pin Opus / Argon for simple subagent tasks, syntax checks, or grep lookups. |
| **Context Cache Efficiency** | `ai_router_cached_tokens`<br>`ai_router_total_tokens` | Tracks the cache-hit percentage from Gemini 3 context caching and Anthropic prompt caching, saving up to 75% on repeated turns. |
| **Top-20 Developer Leaderboard** | `ai_router_turn_count` by `developer_email` | Ranks developers by activity and displays their `auto` routing adoption rate (encouraging smart tier adoption). |
| **Cost Center & Team Waterfall** | `ai_router_actual_cost_usd` by `team_name` / `cost_center` | Financial chargeback breakdown for engineering directors and finance teams. |
| **Cross-Harness Latency Heatmap** | Gateway response time by `client_harness` | Compares latency profiles across Claude Code, Codex, Antigravity, and Pi. |

---

#### How to Inspect Metrics in Cloud Monitoring Metrics Explorer

To create custom charts, run ad-hoc queries, or set up alerting policies on specific developer turns:

1. Navigate to **Google Cloud Console > Monitoring > Metrics Explorer** ([console.cloud.google.com/monitoring/metrics-explorer](https://console.cloud.google.com/monitoring/metrics-explorer)).
2. In the **Metric** dropdown, filter by:
   - Resource Type: **Global (`global`)**
   - Metric: `logging.googleapis.com/user/ai_router_turn_count` (or any `ai_router_*` metric).
3. Under **Group By**, select labels to segment your analysis:
   - `developer_email` — Isolate individual developer activity.
   - `client_harness` — Compare harness volume (`claude`, `codex`, `agy`, `pi`).
   - `selected_model` — See which models are being called southbound.
   - `routing_decision` — Track `smart_auto` vs. `manual_pin`.
   - `team_name` / `cost_center` — Department-level attribution.

---

#### How to Query Raw Turn Telemetry in Google Cloud Logging (Logs Explorer)

Every request processed by Apigee writes a structured JSON payload to Cloud Logging. To inspect individual turns, analyze routing decisions, or debug token usage:

1. Navigate to **Google Cloud Console > Logging > Logs Explorer** ([console.cloud.google.com/logs/query](https://console.cloud.google.com/logs/query)).
2. Run any of the following queries:

```sql
-- 1. View all router turns in real time
logName="projects/YOUR_GCP_PROJECT_ID/logs/ai-platform-finops"

-- 2. Find turns with high avoidable frontier spend (overkill waste > $0.10)
logName="projects/YOUR_GCP_PROJECT_ID/logs/ai-platform-finops"
jsonPayload.avoidable_frontier_spend_usd > 0.10

-- 3. Inspect turns routed by the Smart Router (Tier & reasoning)
logName="projects/YOUR_GCP_PROJECT_ID/logs/ai-platform-finops"
jsonPayload.routing_decision="auto"

-- 4. Audit a specific developer's activity across harnesses
logName="projects/YOUR_GCP_PROJECT_ID/logs/ai-platform-finops"
jsonPayload.developer_email="developer@company.com"
```

Each log entry includes:
- `developer_email`, `gateway_key_name`, `team_name`, `cost_center`
- `client_harness`, `inbound_protocol`, `requested_model`, `selected_model`
- `prompt_tokens`, `completion_tokens`, `cached_tokens`, `total_tokens`
- `cost_usd`, `smart_route_savings_usd`, `avoidable_frontier_spend_usd`
- `routing_tier`, `routing_rule_hit`, `judge_latency_ms`

#### Official Google Cloud Monitoring Documentation Links
- 📘 [Cloud Monitoring Dashboards Overview](https://cloud.google.com/monitoring/dashboards) — Creating, editing, and managing dashboards in GCP.
- 📘 [Managing Dashboards with gcloud or Terraform](https://cloud.google.com/monitoring/dashboards/api-dashboard) — Programmatic dashboard provisioning via the Cloud Monitoring API.
- 📘 [Using Google Cloud Metrics Explorer](https://cloud.google.com/monitoring/charts/metrics-explorer) — Building custom visualizations and MQL/PromQL queries.
- 📘 [Configuring Log-Based Metrics in Cloud Logging](https://cloud.google.com/logging/docs/logs-based-metrics) — How structured log fields map to real-time Counter and Gauge metrics.
- 📘 [Managing Alerting Policies](https://cloud.google.com/monitoring/alerts) — Setting up budget alerts and notification channels (Slack, PagerDuty, Email).

### Administrator FinOps CLI Inspection

Platform leads can inspect organization-wide adoption and spend directly from their terminal:

```bash
# 1. Organization-wide FinOps rollup and Month-1 ROI comparator:
./vertex-connect.sh finops --admin

# 2. Team-level breakdown with repository spend and adoption scorecard:
./vertex-connect.sh finops --team core-platform

# 3. Machine-readable JSON output for ingestion into custom enterprise dashboards:
./vertex-connect.sh finops --json
```

---

## 🧪 Build, Test & Verification Commands

Enforce repository invariants and verify all 4 wire protocols before deploying changes:

```bash
# 1. Compile all Apigee X XML proxy bundles (validates YAML + XML structure)
./deploy.sh --build-only

# 2. Run the offline E2E verification suite (runs 97 checks in 15 seconds, no GCP auth needed)
/usr/bin/python3 tests/verify_e2e.py

# 3. Test the developer CLI helper across harnesses
GATEWAY_API_KEY="test_key" ./vertex-connect.sh claude auto
GATEWAY_API_KEY="test_key" ./vertex-connect.sh codex gemini-4-argon
GATEWAY_API_KEY="test_key" ./vertex-connect.sh pi deepseek-v4.1-flash
./vertex-connect.sh agy

# 4. Run live Vertex AI / Apigee verification (requires active GCP credentials)
GCP_PROJECT_ID="your-gcp-project-id" /usr/bin/python3 tests/verify_live_vertex.py
```

---

## 📚 Related Documentation

- **[Developer Setup Guide](DEVELOPER_SETUP_GUIDE.md)** — Step-by-step laptop and IDE onboarding guide for developers.
- **[AGENTS.md](AGENTS.md)** — Core engineering rules, wire-protocol invariants, and repository layout for AI coding agents.
