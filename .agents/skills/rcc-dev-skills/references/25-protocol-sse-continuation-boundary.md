# Protocol, SSE, Continuation Debug

## When

Use for protocol conversion, malformed/partial SSE, continuation replay, missing history, duplicated tool calls, or cache-prefix drift.

## Separate Three Questions

1. Protocol: did the adjacent codec preserve mapped semantics and unknown-but-representable business fields, without rejecting traffic because of a local schema preference?
2. SSE: did transport preserve business event boundaries, order, legal terminal events and client disconnect state, without projecting Provider/control errors to the client?
3. Continuation: did Chat Process save finalized canonical response and restore it before current delta governance?

Do not use success in one question as evidence for another.

## Request Procedure

1. Query V3 resource/function/mainline/verification maps for source and target protocols.
2. Capture client input and final provider-bound payload.
3. Compare stable history prefix, current delta, tool call/result pairs, reasoning, media, model, and stream intent.
4. Locate first changed field and mapped adjacent codec owner.
5. Reuse or add tests for the affected mappings, opaque-field preservation and genuine unrepresentable boundaries. Do not assert local rejection for forwardable business content.

## Response Procedure

1. Capture complete raw provider JSON/SSE, including terminal or source error.
2. Replay through current response dry-run entry.
3. Check provider decode, canonical response, Resp03 governance, continuation save, client projection, then framing.
4. For successful SSE, verify the protocol's legal terminal before EOF. Provider/control failure remains explicit in the typed Error chain; exhaustion terminates only the affected transport without a client error payload or fabricated completion.

## Continuation Procedure

1. Capture provider-bound request N and N+1.
2. Prove persisted prefix is unchanged; N+1 may append only finalized assistant output and current incoming delta.
3. Locate any proxy-introduced partial replay, duplicate output, scope mismatch or guessed repair and fix its owner. Preserve client-supplied model errors and their paired tool results; do not turn this diagnostic check into a request-admission gate.
4. Keep continuation state separate from routing, health, debug, and client/provider payload.

## Verification

- Run affected behavior tests and mapped `required_gates`, reusing unchanged evidence.
- Use request or response dry-run for the boundary under diagnosis; use both when the failure crosses them. A response replay requires the complete raw response.
- Follow the main skill's runtime acceptance once for affected entry/protocol modes. JSON and SSE, or Direct and Relay, require separate evidence only when both are affected or explicitly required.
- Supply owner and boundary evidence to the existing Review; this reference does not create another review step.
