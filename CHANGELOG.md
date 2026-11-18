# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-18

### Added
- **Gemini Decisions API (`gemini-decision-1`) Smart Router Integration**: Added `JudgeBackend: "decisions"` (rule-first + Decisions API) and `JudgeBackend: "decisions-only"` (pure Decisions API bypassing keyword rules) to `features/ai-pluggable-classifier.yaml` and `src/ai-functions/applySmartJudgeSelection.js`, evaluating parallel `routing_tier` (`choice`) and `needs_deep_reasoning` (`noul`) questions in a single forward pass with calibrated confidence thresholding, escalation, 0 output tokens, and `$0.10 / 1M` input token cost attribution.
- **Dual Decisions API Authentication**: Added Apigee `<KeyValueMapOperations>` (`KVM-GetDecisionsApiKey` -> `private.decisions.apiKey` -> `x-goog-api-key`) and OAuth 2.0 (`GoogleAccessToken` + `x-goog-user-project`) support in `deploy.sh`, plus optional Terraform enablement (`enable_gemini_decisions_api`) for `generativelanguage.googleapis.com` and the encrypted `switchyard-secrets` KVM.
- **Direct Governed `POST /v1beta/decisions` Proxying**: Registered `gemini-decision-1` in `MODEL_CATALOG` and added `gemini-decisions-target` on `antigravity-gateway` for direct `google-genai` SDK Decisions API calls under Apigee Auth, quotas, Model Armor, and FinOps telemetry.
- **Benchmarking & Verification**: Added `stages/params/decisions-router.json`, `tests/bench_decisions_api.py`, emulator mock & live Decisions API support in `tests/apigee_local_emulator.js`, and E2E Suite 12 (`DEC-1`..`DEC-10`) in `tests/verify_e2e.py`.

## [1.0.0] - 2026-11-15

### Added
- **Switchyard Gateway Core**: Native Apigee X model routing for Claude Code, OpenAI Codex, Google Antigravity, and OpenAI-compatible clients (Pi, OpenCode, Cursor, Cline).
- **Vertex AI Model Garden Integration**: Support for Gemini (Gemini 4 Argon, 3.8 Flash, 3.1 Pro/Flash), Anthropic on Vertex (Claude 4.x/5.x), and Vertex MaaS Open-Weight models (GLM 5.2, DeepSeek V4.1 Flash, gpt-oss 120B, Llama 4 Maverick/Scout, Gemma 4).
- **4-Tier Smart Router**: Heuristic and LLM judge classifier routing requests across Tier 1 (fast), Tier 2 (daily), Tier 3 (frontier), and Tier 4 (open-weight).
- **Enterprise Governance & FinOps**: Dual-auth (API Key and OIDC), token quota enforcement with HTTP 429 blocking, Model Armor security guardrails, and detailed FinOps metrics capture.
- **Offline E2E Verification Suite**: Local Apigee X emulation and comprehensive verification covering protocol translation, tool loop fidelity, streaming CRLF handling, and security boundaries.
- **Stage 07 MVP Pilot**: Streamlined deployment profile tailored for enterprise pilot rollouts.
