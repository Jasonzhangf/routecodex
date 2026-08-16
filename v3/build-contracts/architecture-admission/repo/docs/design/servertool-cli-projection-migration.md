# Servertool CLI Projection Migration

This document now covers generic servertool CLI projection only.

Stopless / `stop_message_auto` is part of CLI projection. It is a session-scoped Rust-owned CLI continuation flow documented in `docs/stop-message-auto.md` and `docs/design/servertool-stopmessage-lifecycle.md`.

## Active Scope

- Generic client-exec servertools may project a client-visible `exec_command`.
- `servertool_fixture` remains the focused coverage path for generic CLI projection.
- `stop_message_auto` is the focused coverage path for stopless CLI projection.
- `apply_patch` remains client-native/freeform and is not a servertool CLI projection.

## Stopless Contract

- Stopless must emit a client-visible `exec_command`.
- The command string must not contain `continuationPrompt`, `schemaGuidance`, or raw stop prompt text.
- CLI stdout must carry the continuationPrompt + schemaGuidance needed for the next stop-schema check.
- Stopless must not call server-side followup/reenter.

## Generic CLI Projection Contract

```text
ProviderRespInbound01Raw
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
  -> ServertoolCliProjection01Planned
  -> HubRespOutbound04ClientSemantic
  -> ServerRespOutbound05ClientFrame
       emits client-visible exec_command for servertool, including stopless
  -> client submits normal exec_command result
  -> HubReqInbound02Standardized
  -> normal request pipeline
```

## Validation

- Generic CLI projection runtime branch tests stay in `tests/servertool/execution-stage-shell.spec.ts`.
- Stopless CLI continuation tests stay in `tests/servertool/stopless-cli-continuation.spec.ts`.
- `npm run verify:servertool-rust-only` must keep the two paths separated.
