# V3 Console Human-Readable Layering Test Design

## Scope

Console projection owner: `v3/crates/routecodex-v3-server/src/lib.rs`. The adjacent
`V3Error01SourceRaised -> ... -> V3Error06ClientProjected` chain remains solely owned by
`v3.debug_error_foundation.mainline`; Console consumes only the already-built Error01 or Error06.
SSE closeout Error01 raise owner: `v3/crates/routecodex-v3-error/src/lib.rs`.

This change affects console/debug presentation only. It must not change request payloads,
routing, provider selection, response payloads, timing ownership, or error policy.
The routed request/response assertions cover Responses Direct/Relay, the paths that currently
publish real `V3RuntimeObservability`. OpenAI Chat, Anthropic, and Gemini Relay remain outside
the routed observability block until their runtime owners publish equivalent truth.

## Lifecycle

1. Runtime observability resolves request scope, project, selected provider/model, and route.
2. Server builds one human headline containing stable request or response facts.
3. Server inserts one blank separator line.
4. Server builds one diagnostic line containing request/session/provider-switch internals.
5. Both lines enter the existing human console sink and stdout together.
6. SSE terminal failures enter `routecodex-v3-error` as typed Error01 and project that source to
   the red console block after the response has been committed.
7. Direct SSE stream errors retain the existing typed Error01 source, including source kind,
   source stage, code, message, and external/internal links, without fabricating Error02→06
   route/default exhaustion after response commit.
8. Client disconnect creates Error01 at `V3ServerRespOutbound06ClientFrame`, the actual
   client/server transport boundary, remains health-neutral, and does not manufacture Error06.
   Body `Drop` is only a closeout trigger: Server must first consume the Runtime-owned stream
   observation and may classify a disconnect only when no terminal success or failure was observed.

## Positive Tests

- Request headline contains port, protocol, project, selected provider/model, route, endpoint,
  and timestamp.
- Port/protocol, project, and route/model use exact terminal display-width columns 24, 20, and
  36; oversized ASCII and CJK values are middle-truncated before padding.
- Request diagnostic line contains request id, session id, stream mode, input counts, and event.
- Response headline contains project, success/failure marker, status, response status,
  `finish_reason`, elapsed time, and transport.
- Response headline reports numeric Runtime-owned `time_i` and `time_e`;
  Server-owned total elapsed remains `time_t`. Missing Runtime timing is an
  explicit observability contract failure, never a successful `unreported`
  headline.
- Missing response status or finish reason is the same explicit observability
  contract failure. Missing usage is omitted from the human headline and
  remains visible only as `usage=unreported` in the dim diagnostic line.
- Diagnostic line is separated from headline by exactly one blank line.
- Color mode keeps one request/session color across the complete human line; the human line never
  contains `ANSI_DEBUG_DIM`, and only the complete diagnostic line is dim.
- Plain mode preserves the same two-line text hierarchy without ANSI escapes.
- Short, UUID-length, and oversized session identities keep `req=` at the same diagnostic column.
  Oversized values are middle-truncated only in the fixed-width scope and retained completely as
  `sessionIDFull`.
- A Direct SSE error retains its exact Error01 stage, code, message, and source kind instead of a
  reconstructed RuntimeFailure or fabricated Error06.
- Client disconnect is raised at `V3ServerRespOutbound06ClientFrame`, renders status 499, and
  does not mutate provider health or enter the provider action gate.
- Direct and Relay body drop after Runtime observed `completed`, `done`, or `requires_action`
  closes as terminal success without `client_disconnect`.
- Direct and Relay body drop after Runtime observed `failed`, `incomplete`, `cancelled`,
  `canceled`, or `error` closes as explicit provider terminal failure without success or 499.
- Direct and Relay body drop without any Runtime terminal observation closes as typed,
  health-neutral `client_disconnect` 499.

## Negative Tests

- Diagnostic fields must not remain appended to the headline.
- Headline must not lose provider/model or route scopes.
- Error lines remain red and Stopless lines remain orange.
- Server must not fabricate completed status, relay finish reason, provider/model, usage, or
  attempt counts for OpenAI Chat, Anthropic, or Gemini Relay.
- Server must not synthesize `V3RuntimeObservability` from any provider-request dry-run output.
- Server must not emit a second pre-route request block with placeholder
  route/model truth; raw HTTP receipt remains in the debug event ledger.
- Retired `pool_id=dry_run` or dry-run target-path observability must panic instead of becoming a
  successful route label.
- Missing `pool_id` and `routing_group_id` must panic instead of projecting `route:selected`.
- Server must not copy total elapsed into internal timing or synthesize external timing as zero.
- The bright human headline must never contain `unreported`.
- SSE closeout must not hand-build JSON plus constant node ids and label it Error06; no Error06
  ledger event may be recorded without a typed terminal Error05 backed by route/default proof.
- SSE closeout must not reduce typed Error01 to text and build a second Error01.
- Client disconnect must not be attributed to `V3ProviderResp14Raw` or any provider node.
- Server closeout and SSE transport must not parse SSE event names or `data` JSON to determine
  terminal status; they consume only the Runtime-owned stream observation.
- Console mainline edges must distinguish post-commit Error01 console projection from pre-commit
  terminal Error06 console projection; they must not duplicate the canonical Error01-to-Error06
  chain.
- Every direct stdout/stderr emitter must be registered as a writer of
  `v3.console.terminal_output`; normal console edges must not claim they read an existing debug
  artifact.
- Startup stdout and debug-sink failure stderr must write `v3.console.terminal_output`, not claim a
  successful `v3.debug.artifact` write.
- Rendered text must not be split or reparsed to recover typed headline/diagnostic identity.
- No request/response payload field is added, removed, or rewritten.
- Existing provider switch, usage, complete, and request-start observability events remain present.

## Gates

- `cargo +stable test --manifest-path v3/Cargo.toml -p routecodex-v3-server console --lib -- --nocapture`
- `cargo +stable test --manifest-path v3/Cargo.toml -p routecodex-v3-error --lib`
- `cargo +stable test --manifest-path v3/Cargo.toml -p routecodex-v3-server --lib`
- `cargo +stable check --manifest-path v3/Cargo.toml -p routecodex-v3-server -p routecodex-v3-runtime`
- `rustfmt +stable --edition 2021 --check v3/crates/routecodex-v3-server/src/lib.rs`
- function/resource/mainline/manifest/V3 architecture gates from the verification map
- live managed V3 install, restart, 5520 replay, and console screenshot/log inspection
- Codex review verdict PASS
