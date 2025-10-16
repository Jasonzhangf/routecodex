# Monitoring & Offline Routing Dry‑Run (Design)

This document describes a passive monitoring and replay system for RouteCodex.

## Goals
- Zero‑impact observability for OpenAI/Anthropic requests and responses
- Uniform on‑disk artifacts for offline routing simulation and response replay
- Not enabled by default; strictly opt‑in when integrated later

## Architecture
- MonitorModule (passive hooks)
  - onIncoming: capture request snapshot + meta
  - onRouteDecision: save online route/pipeline decision if available
  - onOutgoing: save full response (non‑stream)
  - onStreamChunk: append streaming chunks/SSE events to JSONL
  - finalize: update meta with storage details and optional summary
- Recorder: filesystem writer + redaction utilities
- VirtualRouterDryRunExecutor: use existing executor to simulate routing for recorded requests
- ReplayExecutor (future): replay `response.json` or `stream-events.jsonl`

## Storage Layout
Root: `~/.routecodex/monitor/sessions/<YYYYMMDD>/<protocol>/<reqId>/`

- `meta.json`             — meta + routing snapshot + redaction flags
- `request.json`          — original input (protocol‑native)
- `request.summary.json`  — optional summary for indexing
- `decision.json`         — online routing decision if available
- `response.json`         — non‑stream full response (protocol‑native)
- `stream-events.jsonl`   — streaming chunks/SSE events (one JSON per line)
- `replay.json`           — optional aggregation suitable for direct replay
- `logs-tail.txt`         — optional diagnostics

## Redaction & Sampling
- Never persist Authorization/API keys
- Optional content redaction for messages/tools (config flag)
- Optional sampling by rate/provider/route/model

## Protocols
- OpenAI Chat Completions
- Anthropic Messages
- Streaming and non‑streaming supported

## CLI & Scripts
- Virtual router dry‑run matrix (no provider calls):

```bash
npm run build
node scripts/virtualrouter-dry-run-matrix.mjs --config ~/.routecodex/config/verified_0.46.32/multi-provider.json
```

## Integration Plan (Phased)
1) Skeleton only (this change): code structure + documentation, no runtime wiring
2) Passive recording (opt‑in) with redaction and sampling
3) Dry‑run from records + diff report (simulate route vs config)
4) Replay executor for response (non‑stream & stream)

## Invariants
- Monitoring must not block or slow down the main request path (async writes, backpressure)
- Recording failures must never propagate to API clients
- Redaction is enabled by default for credentials

