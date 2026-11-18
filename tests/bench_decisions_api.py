#!/usr/bin/env python3
"""Benchmark Google's Gemini Decisions API (gemini-decision-1) on the Smart Router eval set.

Sends the exact payload `SC-DecisionsClassifier` sends (features/ai-pluggable-classifier.yaml)
to POST https://generativelanguage.googleapis.com/v1beta/decisions and compares its calibrated
tier selection against a labelled prompt set (default: tests/data/routing_eval.jsonl).

Compares directly with `tests/bench_llm_judge.py` (gemini-3.5-flash-lite:generateContent):
  - Same-tier agreement rate, under-routing, over-routing, and 4x4 confusion matrix
  - Latency percentiles (min/p50/p90/p95/max/mean)
  - Calibrated confidence distribution, low-confidence escalations, and parallel noul escalations
  - Input token counts, verified 0 output tokens, and exact USD cost at $0.10 / 1M input tokens

Authentication:
  - Default: GEMINI_API_KEY env var (or --api-key-file), sent as `x-goog-api-key`
  - OAuth fallback: `--auth oauth` uses Application Default Credentials + `x-goog-user-project`

Prompt text is never written to the output JSON file (row IDs only). Standard library only.

    GEMINI_API_KEY=... python3 tests/bench_decisions_api.py --out /tmp/decisions-bench.json
    python3 tests/bench_decisions_api.py --dry-run --limit 5
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

TIERS = ("tier1-fast", "tier4-open", "tier2-daily", "tier3-frontier")  # cheapest first
DEFAULT_URL = "https://generativelanguage.googleapis.com/v1beta/decisions"
DEFAULT_MODEL = "gemini-decision-1"
INPUT_COST_PER_1M_USD = 0.10

TIER_CRITERIA = {
    "tier1-fast": (
        "A quick factual answer, definition, short explanation, greeting, status check, "
        "file listing, grep lookup, or one-line shell command."
    ),
    "tier2-daily": (
        "Change, fix, debug, review, migrate, or extend existing code across multiple files, "
        "or diagnose a failure or stack trace in an existing codebase."
    ),
    "tier3-frontier": (
        "Design a distributed system or architecture, compare major design trade-offs, "
        "threat-model security, or reason deeply about concurrency, scale, consistency, "
        "or failure modes."
    ),
    "tier4-open": (
        "Write one small self-contained piece of code such as a standalone function, unit test, "
        "script, SQL query, regex, Dockerfile, config file, or solve a math or algorithmic exercise."
    ),
}


def build_decisions_request(prompt: str, model: str = DEFAULT_MODEL, include_noul: bool = True) -> Dict[str, Any]:
    questions: Dict[str, Any] = {
        "routing_tier": {
            "type": "choice",
            "instructions": (
                "Select the software engineering complexity tier that best matches this "
                "developer request for LLM model routing."
            ),
            "criteria": TIER_CRITERIA,
        }
    }
    if include_noul:
        questions["needs_deep_reasoning"] = {
            "type": "noul",
            "instructions": (
                "Does this developer request require deep architectural design, distributed "
                "systems reasoning, concurrency invariants, security threat modeling, or "
                "complex trade-off analysis?"
            ),
            "criteria": {
                "true_description": (
                    "Requires system architecture design, multi-service consistency or "
                    "concurrency reasoning, threat modeling, or deep trade-off analysis."
                ),
                "false_description": (
                    "Can be answered with a factual lookup, standalone code snippet, or "
                    "localized code change or bug fix."
                ),
            },
        }
    return {
        "model": model,
        "input": prompt[:16000],
        "questions": questions,
    }


def resolve_tier_from_response(
    payload: Dict[str, Any],
    min_confidence: float = 0.50,
    low_confidence_tier: str = "tier2-daily",
    escalation_threshold: float = 0.85,
) -> Tuple[Optional[str], Optional[float], str]:
    """Mirrors parseDecisionsApiResponse() in src/ai-functions/applySmartJudgeSelection.js."""
    if not isinstance(payload, dict) or payload.get("error"):
        return None, None, "error"
    feedback = payload.get("prompt_feedback") or {}
    if feedback.get("block_reason"):
        return None, None, "blocked:" + str(feedback["block_reason"])
    answers = payload.get("answers") or {}
    tier_ans = answers.get("routing_tier") or {}
    if tier_ans.get("type") != "choice":
        return None, None, "invalid"
    choice = str(tier_ans.get("choice") or "").strip().lower()
    if choice not in TIERS:
        return None, None, "unknown_choice"
    conf_raw = tier_ans.get("confidence")
    confidence = float(conf_raw) if conf_raw is not None else None
    reason = "choice"
    if confidence is not None and min_confidence > 0 and confidence < min_confidence:
        if low_confidence_tier in TIERS:
            return low_confidence_tier, confidence, "low_confidence_escalation"
        return None, confidence, "low_confidence_abstain"
    deep_ans = answers.get("needs_deep_reasoning") or {}
    if choice != "tier3-frontier" and deep_ans.get("type") == "noul":
        noul_val = deep_ans.get("noul")
        if noul_val is not None and float(noul_val) >= escalation_threshold and (confidence is None or confidence < 0.75):
            return "tier3-frontier", confidence, "noul_escalation"
    return choice, confidence, reason


def access_token() -> str:
    env_token = os.environ.get("GCP_ACCESS_TOKEN", "").strip()
    if env_token:
        return env_token
    return subprocess.check_output(
        ["gcloud", "auth", "application-default", "print-access-token", "--quiet"],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()


def call_decisions(
    url: str,
    model: str,
    prompt: str,
    auth_mode: str,
    api_key: str,
    oauth_token: str,
    project: str,
    include_noul: bool,
    timeout: float,
) -> Dict[str, Any]:
    body = build_decisions_request(prompt, model=model, include_noul=include_noul)
    headers = {"Content-Type": "application/json"}
    if auth_mode == "oauth":
        headers["Authorization"] = "Bearer " + oauth_token
        if project:
            headers["x-goog-user-project"] = project
    else:
        headers["x-goog-api-key"] = api_key
    request = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"), method="POST", headers=headers
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
            status = response.status
    except urllib.error.HTTPError as error:
        return {
            "status": error.code,
            "ms": (time.perf_counter() - started) * 1000.0,
            "payload": {},
            "error": error.read().decode("utf-8", "ignore")[:300],
        }
    except (urllib.error.URLError, OSError) as error:
        return {
            "status": 0,
            "ms": (time.perf_counter() - started) * 1000.0,
            "payload": {},
            "error": type(error).__name__,
        }
    elapsed = (time.perf_counter() - started) * 1000.0
    usage = payload.get("usage") or {}
    return {
        "status": status,
        "ms": elapsed,
        "payload": payload,
        "input_tokens": int(usage.get("total_input_tokens") or usage.get("total_tokens") or 0),
        "output_tokens": int(usage.get("total_output_tokens") or 0),
    }


def percentile(values: List[float], fraction: float) -> float:
    ordered = sorted(values)
    position = fraction * (len(ordered) - 1)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] * (1 - (position - lower)) + ordered[upper] * (position - lower)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", default=os.environ.get("DECISIONS_API_URL", DEFAULT_URL))
    parser.add_argument("--model", default=os.environ.get("DECISIONS_MODEL", DEFAULT_MODEL))
    parser.add_argument("--eval", default="tests/data/routing_eval.jsonl")
    parser.add_argument("--auth", choices=("api_key", "oauth"), default="api_key")
    parser.add_argument("--api-key-file", default="")
    parser.add_argument("--project", default=os.environ.get("GCP_PROJECT_ID", ""))
    parser.add_argument("--min-confidence", type=float, default=0.50)
    parser.add_argument("--low-confidence-tier", default="tier2-daily")
    parser.add_argument("--escalation-threshold", type=float, default=0.85)
    parser.add_argument("--no-noul", action="store_true", help="Send only the routing_tier choice question")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=15.0)
    parser.add_argument("--dry-run", action="store_true", help="Validate payload generation offline without network calls")
    parser.add_argument("--out", default="")
    args = parser.parse_args(argv)

    with open(args.eval, encoding="utf-8") as handle:
        rows = [json.loads(line) for line in handle if line.strip()]
    if args.limit:
        rows = rows[: args.limit]

    if args.dry_run:
        sample = build_decisions_request(rows[0]["prompt"], model=args.model, include_noul=not args.no_noul)
        print(json.dumps({"dry_run": True, "rows": len(rows), "url": args.url, "sample_request": sample}, indent=2))
        return 0

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if args.api_key_file:
        with open(os.path.expanduser(args.api_key_file), encoding="ascii") as handle:
            api_key = handle.read().strip()
    oauth_token = ""
    if args.auth == "oauth":
        oauth_token = access_token()
    elif not api_key:
        raise SystemExit("Set GEMINI_API_KEY (or pass --api-key-file, or use --auth oauth).")

    # Warm-up call so connection setup is excluded and auth/model errors fail fast.
    warm = call_decisions(
        args.url, args.model, "hello", args.auth, api_key, oauth_token, args.project, not args.no_noul, args.timeout
    )
    if warm["status"] != 200:
        raise SystemExit("Warm-up failed: HTTP %s %s" % (warm["status"], warm.get("error", "")))

    order = {tier: idx for idx, tier in enumerate(TIERS)}
    results: List[Dict[str, Any]] = []
    for row in rows:
        resp = call_decisions(
            args.url,
            args.model,
            row["prompt"],
            args.auth,
            api_key,
            oauth_token,
            args.project,
            not args.no_noul,
            args.timeout,
        )
        tier, conf, reason = (
            resolve_tier_from_response(
                resp["payload"],
                min_confidence=args.min_confidence,
                low_confidence_tier=args.low_confidence_tier,
                escalation_threshold=args.escalation_threshold,
            )
            if resp["status"] == 200
            else (None, None, "http_%s" % resp["status"])
        )
        results.append(
            {
                "id": row["id"],
                "gold": row["tier"],
                "status": resp["status"],
                "tier": tier,
                "confidence": round(conf, 4) if conf is not None else None,
                "reason": reason,
                "ms": round(resp["ms"], 1),
                "input_tokens": resp.get("input_tokens", 0),
                "output_tokens": resp.get("output_tokens", 0),
            }
        )

    ok = [r for r in results if r["status"] == 200 and r["tier"] in order]
    latencies = [r["ms"] for r in ok]
    confidences = [r["confidence"] for r in ok if r["confidence"] is not None]
    total_input_tokens = sum(r["input_tokens"] for r in ok)
    total_output_tokens = sum(r["output_tokens"] for r in ok)
    confusion = {gold: {pred: 0 for pred in TIERS} for gold in TIERS}
    for r in ok:
        confusion[r["gold"]][r["tier"]] += 1

    summary = {
        "model": args.model,
        "url": args.url,
        "n": len(results),
        "ok": len(ok),
        "same_tier_rate": round(sum(1 for r in ok if r["tier"] == r["gold"]) / len(ok), 3) if ok else None,
        "under_routed": sum(1 for r in ok if order[r["tier"]] < order[r["gold"]]),
        "over_routed": sum(1 for r in ok if order[r["tier"]] > order[r["gold"]]),
        "low_confidence_escalations": sum(1 for r in ok if r["reason"] == "low_confidence_escalation"),
        "noul_escalations": sum(1 for r in ok if r["reason"] == "noul_escalation"),
        "mean_confidence": round(statistics.fmean(confidences), 3) if confidences else None,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "estimated_cost_usd": round((total_input_tokens * INPUT_COST_PER_1M_USD) / 1_000_000.0, 6),
        "latency_ms": (
            {
                "min": round(min(latencies), 1),
                "p50": round(percentile(latencies, 0.50), 1),
                "p90": round(percentile(latencies, 0.90), 1),
                "p95": round(percentile(latencies, 0.95), 1),
                "max": round(max(latencies), 1),
                "mean": round(statistics.fmean(latencies), 1),
            }
            if latencies
            else {}
        ),
        "confusion": confusion,
    }
    print(json.dumps(summary, indent=2))
    if args.out:
        with open(os.path.expanduser(args.out), "w", encoding="utf-8") as handle:
            json.dump({"summary": summary, "results": results}, handle, indent=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
