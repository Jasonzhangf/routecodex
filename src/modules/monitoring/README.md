Monitoring Module (Passive Analysis Skeleton)

Goals
- Passive, zero-impact request/response observability for OpenAI/Anthropic protocols.
- Uniform on-disk records under ~/.routecodex/monitor/ for offline routing dry‑run and response replay.
- Not wired into runtime pipeline by default; importing this module must not change behavior unless explicitly enabled later.

Non-Goals (in this skeleton)
- No runtime interception/registration in modules.json.
- No changes to existing request/response paths.

Interfaces (skeleton)
- MonitorModule
  - initialize(): Promise<void>
  - onIncoming(req, ctx): Promise<void>
  - onRouteDecision(reqId, decision): Promise<void>
  - onOutgoing(res, ctx): Promise<void>
  - onStreamChunk(event, ctx): Promise<void>
- Recorder
  - start(reqId, snapshot)
  - writeDecision(reqId, decision)
  - appendStream(reqId, event)
  - writeResponse(reqId, response)
  - finalize(reqId, summary)

Storage plan (not active by default)
- Root: ~/.routecodex/monitor/sessions/<YYYYMMDD>/<protocol>/<reqId>/
  - meta.json             // request meta + routing summary + redaction flags
  - request.json          // original request (protocol‑native shape)
  - decision.json         // router/pipeline decision if available
  - response.json         // non‑stream full response
  - stream-events.jsonl   // streaming chunks or SSE events
  - replay.json           // optional replay‑ready aggregation
  - logs-tail.txt         // optional log excerpt

Privacy/Redaction (defaults to safe values)
- Never persist Authorization/ApiKey headers.
- Optional content redaction for messages/tools (configurable later).

Status
- This directory only contains a passive skeleton (no runtime wiring).
- It prepares types and utilities so future enabling is low‑risk.

