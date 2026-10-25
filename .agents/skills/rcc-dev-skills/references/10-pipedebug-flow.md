# First-Divergence Pipe Debug

## When

Use for wrong provider request, malformed provider response, missing tool/reasoning, SSE failure, incorrect client projection, or unexplained 4xx/5xx.

## Evidence Set

For one request id, collect:

```text
client request
-> final provider-bound request
-> raw provider response or source error
-> client response
```

Record entry protocol/port, Direct or Relay decision, selected provider/model/protocol, node trace, and installed runtime identity. Logs locate time/order; raw artifacts prove payload meaning.

## Slice Order

1. Server entry: method, endpoint, headers, body, session/scope.
2. Request inbound/Chat Process: normalized input, tool/history governance, continuation restore.
3. Virtual Router/Target: one route hit, opaque target, candidate selection.
4. Provider outbound/transport: URL, headers, wire protocol, exact body, raw status/body/stream.
5. Response inbound/Chat Process: decode, tool/reasoning governance, continuation save.
6. Client outbound/Server frame: target protocol, JSON/SSE terminal shape, status.
7. Error path: source through Error01–Error06 without local bypass.

At each slice compare actual input with previous slice output. First mismatch owns diagnosis; final error location does not.

## Dry-Run Then Live

Request-side issue:

```bash
node scripts/replay-codex-sample.mjs \
  --sample <client-request.json> \
  --dry-run provider-request \
  --base http://127.0.0.1:<port>
```

Require final provider URL/body/headers and proof provider network send stopped. Response-side issue requires a complete raw JSON/SSE provider snapshot through `POST /_routecodex/debug/dry-run`; lazy or partial stream trace is not response evidence.

Use the controlled path that answers the current request- or response-side hypothesis; use both only when the failure crosses those boundaries. Reuse its evidence in the main skill's applicable install and same-entry replay steps, rather than running a second lifecycle sequence here. Specialized Toolreason flow: `26-toolreason-dryrun-diagnostic.md`.

## Stop Conditions

- Missing the artifact needed to distinguish the suspected boundary: keep attribution unconfirmed and collect that artifact. If execution never reached provider send, use the request-side failure evidence; do not require a nonexistent provider response.
- Wrong entry/provider/protocol/runtime identity: scope invalidated; recapture.
- New first divergence in another owner: stop patch and reopen diagnosis.
- Do not repair provider/request meaning in handler, SSE framer, debug, or client projection.
