#!/usr/bin/env python3
"""Measure the Smart Router's classifier backends through a deployed gateway.

Sends every prompt of a labelled eval set to `model: auto` once per classifier backend and
reads the gateway's own attribution headers:

    X-Router-Classifier      which step decided: rules | custom | decisions | gemini | length-fallback
    X-Router-Classifier-Ms   time the classifier callout added inside the gateway
    X-Vertex-Target-Tier     tier the request was routed to

so the classifier's latency is reported separately from the model call that follows it.
The backend is chosen per request with the X-Router-Classifier request header, which only
works where the proxy was built with AllowClassifierOverride=true (a lab environment).

Data-plane requests only: nothing here touches the Apigee control plane. The API key comes
from --api-key-file or $GATEWAY_API_KEY and is never printed; prompt text is never written
to the results file (row ids only). Standard library only.

    GATEWAY_API_KEY=... python3 tests/bench_router_classifiers.py \
        --gateway-url http://lab.example.nip.io --out /tmp/router-bench.json

Routed requests reach real models, so each one costs a few tokens (max_tokens is small).
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

TIERS = ("tier1-fast", "tier4-open", "tier2-daily", "tier3-frontier")  # cheapest first
HEADERS_OF_INTEREST = (
    "X-Router-Classifier", "X-Router-Classifier-Ms", "X-Router-Classifier-Model",
    "X-Router-Classifier-Confidence", "X-Vertex-Target-Tier", "X-Vertex-Target-Model",
    "X-Smart-Router-Decision", "X-Vertex-Fallback-Triggered",
)


def percentile(values: List[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    position = fraction * (len(ordered) - 1)
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] * (1 - (position - lower)) + ordered[upper] * (position - lower)


def summarize(values: List[float]) -> Dict[str, Any]:
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "min": round(min(values), 1),
        "p50": round(percentile(values, 0.50), 1),
        "p90": round(percentile(values, 0.90), 1),
        "p95": round(percentile(values, 0.95), 1),
        "max": round(max(values), 1),
        "mean": round(statistics.fmean(values), 1),
    }


def header(headers: Dict[str, str], name: str) -> str:
    wanted = name.lower()
    for key, value in headers.items():
        if key.lower() == wanted:
            return value
    return ""


def send(opener: Any, url: str, api_key: str, backend: str, prompt: str, max_tokens: int,
         timeout: float) -> Dict[str, Any]:
    body = json.dumps({
        "model": "auto", "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "User-Agent": "claude-code/router-bench",
        "X-Router-Classifier": backend,
        # Keep the semantic cache out of a routing measurement.
        "X-Bypass-Cache": "true",
    })
    started = time.perf_counter()
    try:
        with opener.open(request, timeout=timeout) as response:
            response.read()
            status, headers = response.status, dict(response.headers)
    except urllib.error.HTTPError as error:
        error.read()
        status, headers = error.code, dict(error.headers)
    except (urllib.error.URLError, OSError) as error:
        return {"status": 0, "error": type(error).__name__, "total_ms": (time.perf_counter() - started) * 1000.0}
    record: Dict[str, Any] = {"status": status, "total_ms": round((time.perf_counter() - started) * 1000.0, 1)}
    for name in HEADERS_OF_INTEREST:
        value = header(headers, name)
        if value:
            record[name] = value
    return record


def report(backend: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    order = {tier: index for index, tier in enumerate(TIERS)}
    answered = [r for r in rows if r.get("X-Vertex-Target-Tier") in order]
    decided_by: Dict[str, int] = {}
    for r in rows:
        key = r.get("X-Router-Classifier", "(no header)")
        decided_by[key] = decided_by.get(key, 0) + 1
    statuses: Dict[str, int] = {}
    for r in rows:
        statuses[str(r["status"])] = statuses.get(str(r["status"]), 0) + 1

    def agreement(subset: List[Dict[str, Any]]) -> Dict[str, Any]:
        if not subset:
            return {"n": 0}
        same = sum(1 for r in subset if r["X-Vertex-Target-Tier"] == r["gold"])
        return {
            "n": len(subset),
            "same_tier": same,
            "rate": round(same / len(subset), 3),
            "under_routed": sum(1 for r in subset if order[r["X-Vertex-Target-Tier"]] < order[r["gold"]]),
            "over_routed": sum(1 for r in subset if order[r["X-Vertex-Target-Tier"]] > order[r["gold"]]),
        }

    callout_ms = [float(r["X-Router-Classifier-Ms"]) for r in rows
                  if r.get("X-Router-Classifier") in ("custom", "decisions", "gemini") and r.get("X-Router-Classifier-Ms")]
    failed_callout_ms = [float(r["X-Router-Classifier-Ms"]) for r in rows
                         if r.get("X-Router-Classifier") == "length-fallback"
                         and float(r.get("X-Router-Classifier-Ms") or 0) > 0]
    return {
        "backend": backend,
        "requests": len(rows),
        "http_status": statuses,
        "decided_by": decided_by,
        # Callouts that produced the decision.
        "classifier_callout_ms": summarize(callout_ms),
        # Callouts that were attempted but did not answer (timeout or error) before fallback.
        "failed_callout_ms": summarize(failed_callout_ms),
        "total_request_ms": summarize([r["total_ms"] for r in rows if r["status"] == 200]),
        "tier_vs_gold_all": agreement(answered),
        "tier_vs_gold_when_classifier_decided": agreement(
            [r for r in answered if r.get("X-Router-Classifier") in ("custom", "decisions", "gemini")]),
        "tier_vs_gold_when_rule_decided": agreement(
            [r for r in answered if r.get("X-Router-Classifier") == "rules"]),
    }


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--gateway-url", default=os.environ.get("GATEWAY_URL", ""), help="e.g. http://lab.host")
    parser.add_argument("--eval", default="tests/data/routing_eval.jsonl")
    parser.add_argument("--backends", default="heuristic,gemini")
    parser.add_argument("--api-key-file", default="")
    parser.add_argument("--max-tokens", type=int, default=16)
    parser.add_argument("--limit", type=int, default=0, help="only the first N prompts (0 = all)")
    parser.add_argument("--timeout", type=float, default=120.0)
    parser.add_argument("--pause-ms", type=int, default=0, help="wait between requests")
    parser.add_argument("--out", default="")
    args = parser.parse_args(argv)

    if not args.gateway_url:
        raise SystemExit("--gateway-url (or GATEWAY_URL) is required.")
    api_key = os.environ.get("GATEWAY_API_KEY", "").strip()
    if args.api_key_file:
        with open(os.path.expanduser(args.api_key_file), encoding="ascii") as handle:
            api_key = handle.read().strip()
    if not api_key:
        raise SystemExit("Set GATEWAY_API_KEY or pass --api-key-file.")

    rows = []
    with open(args.eval, encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                rows.append(json.loads(line))
    if args.limit:
        rows = rows[: args.limit]
    backends = [b.strip() for b in args.backends.split(",") if b.strip()]
    url = args.gateway_url.rstrip("/") + "/v1/messages"
    # Reuse nothing between requests and ignore proxy settings: each call is one fresh hop.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    results: Dict[str, List[Dict[str, Any]]] = {backend: [] for backend in backends}
    # Interleave backends per prompt so drift over the run affects all of them equally.
    for index, row in enumerate(rows):
        for backend in backends:
            record = send(opener, url, api_key, backend, row["prompt"], args.max_tokens, args.timeout)
            record.update({"id": row["id"], "gold": row["tier"]})
            results[backend].append(record)
            if args.pause_ms:
                time.sleep(args.pause_ms / 1000.0)
        if (index + 1) % 10 == 0:
            print("  %d/%d prompts" % (index + 1, len(rows)), file=sys.stderr, flush=True)

    summary = [report(backend, results[backend]) for backend in backends]
    print(json.dumps(summary, indent=2))
    if args.out:
        with open(os.path.expanduser(args.out), "w", encoding="utf-8") as handle:
            json.dump({"gateway": args.gateway_url, "prompts": len(rows), "max_tokens": args.max_tokens,
                       "summary": summary, "rows": results}, handle, indent=1)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
