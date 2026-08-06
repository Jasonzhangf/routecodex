# Stopless hook and chat-process closure plan

## Goal

Lock `reasoningStop / stopless` closure into the hook + chat-process owner path only. The server, SSE, and handler layers must stay standard protocol surfaces and must not carry stopless business semantics.

## Acceptance

- The first live response projects the internal stop tool as the client-visible hook command, not as a raw `reasoningStop` leak.
- `submit_tool_outputs` resumes through the real conversation restore path and preserves stopless state across rounds.
- The follow-up round advances the stopless repeat state correctly and terminates only when the schema/stop condition says it should.
- No stopless behavior is implemented in `src/server/handlers/*`, SSE framing, or protocol-specific outbound/inbound code.

## Scope

### In scope

- Hook schema gate, stop decision, and stopless repeat/terminal state.
- Chat-process request/response ownership for tool harvest, resume, and restore.
- Real continuation store / resume path for `/v1/responses submit_tool_outputs`.
- Tests that prove the live hook path and the resume path stay aligned.

### Out of scope

- Any new server/SSE/handler special cases.
- Any fallback, downgrade, or dual-path compensation.
- Any protocol-specific patch that bypasses the hook owner.

## Design rules

- Keep the single truth at the hook + chat-process owner.
- Treat server/SSE as standard transport only.
- Remove stale assertions, stale test names, and stale stopless wording instead of keeping them around.
- Use the minimal unique modification point; do not spread matching logic across layers.

## Files and docs to inspect first

- `docs/architecture/wiki/stopless-session-mainline-source.md`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/design/servertool-stopmessage-lifecycle.md`
- `docs/design/servertool-followup-rebuild-from-origin.md`
- `docs/design/pipeline-type-topology-and-module-boundaries.md`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/*`
- `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`

## Verification

- Add or update a red test that reproduces the live `submit_tool_outputs` restore path.
- Run the focused Rust tests and focused Jest tests for hook / chat-process closure.
- Re-run the live 5555 probe and confirm the raw tool does not leak while repeat/terminal state advances correctly.

## Done

- The stopless flow is closed end to end in the hook + chat-process owner.
- The server/SSE/handler layers remain standard and unchanged in behavior.
- The current verified facts and remaining risk are written back to `note.md` and, if durable, to `MEMORY.md`.
