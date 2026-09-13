# Servertool CLI Projection Migration

This document covers generic servertool CLI projection only. The former V3
Stopless / `stop_message_auto` projection was retired; it is not a compatible
variant of this contract.

## Active Scope

- Generic client-exec servertools may project a client-visible `exec_command`.
- `servertool_fixture` remains the focused coverage path for generic CLI projection.
- `apply_patch` remains client-native/freeform and is not a servertool CLI projection.

## Generic CLI Projection Contract

```text
ProviderRespInbound01Raw
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
  -> ServertoolCliProjection01Planned
  -> HubRespOutbound04ClientSemantic
  -> ServerRespOutbound05ClientFrame
       emits client-visible exec_command for registered servertools
  -> client submits normal exec_command result
  -> HubReqInbound02Standardized
  -> normal request pipeline
```

## Validation

- Generic CLI projection runtime branch tests stay in `tests/servertool/execution-stage-shell.spec.ts`.
- `npm run verify:servertool-rust-only` must keep generic servertool projection
  separate from the native `apply_patch` path.
