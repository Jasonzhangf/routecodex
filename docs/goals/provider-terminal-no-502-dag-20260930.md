# Provider terminal response DAG (2026-09-30)

## Goal and evidence

Bug `705d624` owns this repair and its worktree.

The 4444 `/v1/responses` requests ending `574079-8453` and `574080-8454` received real upstream HTTP 429 with `rate_limit_error`, yet the client received `502 network_error`. Request `574024-8398` had a transport failure with no upstream HTTP response and also produced client 502. The source artifacts are in the corresponding `~/.rcc/codex-samples/openai-responses/ports/4444/` request directories.

The proxy must preserve an eligible real upstream status and compatible error payload. HTTP 502 is excluded by this bug's explicit client boundary. A transport failure with no upstream response cannot be invented as HTTP 502 or successful completion. On a streaming client boundary it may end the stream without a completed response. Do not reinterpret an upstream no-response as a client disconnect.

## Single-entry, single-exit model

```mermaid
flowchart TD
  A[Client request accepted] --> B[Attempt and recovery]
  B -->|valid response| D[Commit compatible response]
  B -->|no success, eligible real HTTP error observed| I[Project selected real external HTTP response]
  B -->|no eligible external response| J[Terminate client transport without fabricated response]
  B -->|client cancelled| M[Record client cancellation]
  D --> K[Request finalizer]
  I --> K
  J --> K
  M --> K
  K --> L[Release attempt and request resources]
```

Candidate selection, provider attempts, Error01-05, cooldown, and recovery are internal to B. B retains the last compatible real upstream HTTP error response across all attempts as a request-local typed witness containing status, headers, and original body bytes; a later transport failure does not erase it. This is error-side evidence, not business payload or Debug state. HTTP 502 is ineligible for client projection under this bug's explicit no-502 contract. Only if no candidate returned an eligible real response does B choose no-response. Each request enters at A and leaves at L once. Client cancellation is independent of upstream no-response. The typed failure side channel owns source attribution, candidate decision and health effects. Provider owns wire and health mutation. Runtime owns attempt buffering and finalizer. Server/SSE owns only transport framing or termination. Debug records evidence and does not decide outcomes.

## Current breaks and repair boundary

1. `routecodex-v3-error` Error06 currently overwrites every exhausted provider failure with `502 network_error`, including real 429. Provider transport already has status, headers, and body; Responses Relay drops headers/body before Error06, while other relay/direct paths also discard them at terminal projection. Preserve the last eligible real upstream HTTP witness through Error05 to Error06, then project status and compatible error semantics without reconstructing them from diagnostic text.
2. `provider_failure_runtime_policy` currently records synthesized transport 502 as `external_error.status`. Carry upstream HTTP presence as a typed distinction so no-response never acquires a fake external status.
3. Server's existing SSE disconnect detector searches for `V3Error04TargetPoolExhaustion`, which is absent from the real Error chain (`V3Error04TargetExhaustionDecision`). Remove status/body/node-name heuristics. Carry a typed terminal disposition from Error/Runtime to Server; for no-response, close only the current Front connection by its `V3FrontConnectionIdentity` before Hyper writes headers. The broker resolves this identity from either `front_sockets` or a bound `connection_leases` entry and its `client_sockets` key. This requires one scoped broker operation; a plain `front_socket(identity)` lookup fails after lease binding. The socket operation must clear a pending restart closeout frame before signaling close, and the connection task must remove its registry entries at termination. The existing SSE body-error primitive sends HTTP 200 headers first and cannot implement this outcome.
4. Keep successful responses and admitted candidate recovery unchanged. A selected HTTP 429 must not be converted to a disconnect; a final no-response must not be converted to HTTP 200, 502, `response.failed` or `response.completed`.

## Acceptance evidence

- Controlled upstream HTTP 429 through the real Responses SSE and JSON entrances retains HTTP 429 and compatible error semantics, with no `502 network_error`.
- Controlled upstream transport failure or upstream HTTP 502 with no eligible response across all candidates closes the exact Front HTTP connection before response headers. Streaming and nonstreaming clients must observe EOF/transport error with zero HTTP status and no 502, completion, or failed event. The broker must resolve the current identity in both unbound and bound socket registries, clear a pending restart frame, close only that socket, then release identity/lease socket entries after the connection task ends. Do not use `close_active_client_transports`, affect a second client, or leave a stale socket entry. Prove zero header bytes through the real HTTP/1 entry, including a reused socket, and prove no restart `503` frame is written. The capability baseline currently fails bound lookup, pending-frame suppression, and registry cleanup; product code for this branch waits for corrected capability proof.
- A failed provider followed by a successful candidate returns the latter's real response, once.
- Client cancellation and provider no-response remain distinct; each finalizer runs once and releases resources.
- The old sample shapes above are replayed through the installed 4444 entry after candidate validation. Exact candidate, binary hash, restart identity and post-restart sample window are recorded separately.
