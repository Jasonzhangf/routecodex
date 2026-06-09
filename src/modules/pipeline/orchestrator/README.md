# Pipeline Orchestrator Compatibility

This directory no longer owns Hub Pipeline orchestration.

## Live Files

- `pipeline-context.ts`: exports the `TargetMetadata` compatibility type consumed by provider runtime, debug replay, and llmswitch-core host-effect bridge code.

## Boundary

- Do not add request/response stage execution, lifecycle coordination, retry, recovery, or error policy here.
- Hub Pipeline orchestration and node semantics are Rust-owned under `sharedmodule/llmswitch-core`.
- Error policy must follow the explicit `ErrorErr*` chain and current provider failure-policy owners.
