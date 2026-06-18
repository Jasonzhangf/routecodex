# Stopless Session Mainline Source

## Purpose

This page is the review surface for the stopless runtime-metadata continuation mainline. It is the only canonical place to read the current owner binding, mainline edges, gate coverage, and the current "no file / no tmux / no sessionDir dependency" closure status proved by `tests/servertool/stopless-cli-continuation.spec.ts`.

This is not a second source of truth. The mechanical edges live in `docs/architecture/mainline-call-map.yml` (`chain_id: stopless.session.mainline`) and the owner / gate policy lives in `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` (`feature_id: hub.servertool_stopless_cli_continuation`). The Mermaid figure below is a render artifact and must not be hand-edited.

Continuation behavior around stopless must now converge on the standardized continuation contract:

- `docs/design/continuation-metadata-center-standard-contract.md`
- `docs/architecture/wiki/continuation-standard-contract.md`

That means further stopless continuation work must be framed as canonical `save / restore / materialize / release`, not as one-off field patches on `responsesResume`-adjacent shapes.

## Stopless Session Mainline

```mermaid
flowchart LR
  StoplessResp01StopDetected["StoplessResp01StopDetected"]
  StoplessResp02SchemaGateEvaluated["StoplessResp02SchemaGateEvaluated"]
  StoplessState03RuntimeSnapshotResolved["StoplessState03RuntimeSnapshotResolved"]
  StoplessCli04ProjectionPlanned["StoplessCli04ProjectionPlanned"]
  StoplessCli06ClientExecuted["StoplessCli06ClientExecuted"]
  StoplessReq07ContinuationRestored["StoplessReq07ContinuationRestored"]
  StoplessReq08GuidanceRewritten["StoplessReq08GuidanceRewritten"]
  StoplessReq09SchemaContractInjected["StoplessReq09SchemaContractInjected"]
  VrRoute04SelectedTarget["VrRoute04SelectedTarget"]

  StoplessResp01StopDetected -->|stl-01| StoplessResp02SchemaGateEvaluated
  StoplessResp02SchemaGateEvaluated -->|stl-02| StoplessState03RuntimeSnapshotResolved
  StoplessState03RuntimeSnapshotResolved -->|stl-03| StoplessCli04ProjectionPlanned
  StoplessCli04ProjectionPlanned -.->|stl-04| StoplessCli06ClientExecuted
  StoplessCli06ClientExecuted -.->|stl-05| StoplessReq07ContinuationRestored
  StoplessReq07ContinuationRestored -->|stl-06| StoplessReq08GuidanceRewritten
  StoplessReq08GuidanceRewritten -->|stl-07| StoplessReq09SchemaContractInjected
  StoplessReq09SchemaContractInjected -->|stl-08| VrRoute04SelectedTarget
```

## Edge Owners and Current Status

| step | transition | owner_feature_id | status | mainline edge note |
| --- | --- | --- | --- | --- |
| stl-01 | stop response detected | `hub.servertool_stopless_cli_continuation` | anchored | `runServerToolOrchestration` routes stopless detection into the servertool handler. |
| stl-02 | runtime snapshot resolved | `hub.servertool_stopless_cli_continuation` | anchored | stopless state is restored from runtime metadata or the current request `tool_outputs`, not from persisted file state. |
| stl-03 | CLI projection planned | `hub.servertool_stopless_cli_continuation` | anchored | `buildServertoolCliProjectionForAutoFlow` builds the client-visible CLI command with concise structured input: `flowId/repeatCount/maxRepeats/triggerHint` plus optional `schemaFeedback{reasonCode,missingFields}`. |
| stl-04 | client executes the CLI | `hub.servertool_stopless_cli_continuation` | anchored | `routecodex hook run reasoning_stop` executes without `sessionDir/sessionId/requestId` flags. |
| stl-05 | CLI result restored into next request scope | `hub.servertool_stopless_cli_continuation` | anchored | auto-projected CLI result is restored from the next request body/runtime metadata; no file persistence/sessionDir fallback is allowed. |
| stl-06 | next-turn guidance rewritten | `hub.servertool_stopless_cli_continuation` | anchored | responses/chat bridge collapses the stopless tool pair into model-transparent natural-language guidance plus missing/error feedback; only the latest stopless guidance may survive, and raw historical tool pairs must not replay into later turns. |
| stl-07 | req-side schema contract rebound | `hub.servertool_stopless_cli_continuation` | anchored | req_chatprocess must physically rebind the stopless schema contract onto the next request mainline: chat/messages use a system message, `/v1/responses` uses `instructions` which the bridge must materialize back into the outbound system message. |
| stl-08 | VR routes stopless turn to thinking | `hub.servertool_stopless_cli_continuation` | anchored | route selection forces the next turn into thinking rather than reusing the stopless CLI result as history. |

## Owner / Allowed / Forbidden Path Summary

- Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src`.
- Allowed paths include `sharedmodule/llmswitch-core/src/servertool/{cli-projection,engine}.ts`, `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`, and `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`.
- Forbidden paths: `src/providers`, `src/server/runtime/http-server/executor`, and unrelated `sharedmodule/llmswitch-core/src/servertool/handlers` surfaces that do not own stopless CLI semantics.

## Required Gates

- `cargo test -p servertool-core cli_contract --lib`
- `cargo test -p servertool-core persisted_lookup --lib`
- `cargo test -p servertool-cli --test cli_blackbox`
- `cargo test -p router-hotpath-napi test_req_process_responses_input_still_materializes_stopless_contract --lib -- --nocapture`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/responses/responses-openai-bridge.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/cli/servertool-command.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-vr-route-hint.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/servertool-cli-projection.spec.ts --runInBand`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:function-map-compile-gate`

## Active Gaps

- `stopless-gap-01`: broader docs/wiki/html artifacts outside this page still contain some older persisted/sessionDir wording and need a follow-up sweep.
- `stopless-gap-03`: stopless 曾被误读为 session-scoped persisted continuation；当前已改成 runtime metadata/current-turn `tool_outputs` owner，但历史命名和审计路径仍需持续防回潮。
- `stopless-gap-04`: stopless 与 protocol-independent continuation 的边界此前不显式；当前已补文档，但仍需要在更大 session/state 审计里持续复核。
- `stopless-gap-05`: `ROUTECODEX_SESSION_DIR` 仍是共享 runtime workdir root；虽然 stopless 已脱离它，但目录物理拆分是否推进仍待后续总体 closeout 决策。

## Recent Closures

- stopless no longer depends on file persistence, tmux, or `ROUTECODEX_SESSION_DIR`.
- stopless CLI command and CLI stdout no longer require `sessionId/requestId`.
- CLI command payload stays concise/structured; natural-language corrective guidance is generated in req_chatprocess from `schemaFeedback + schemaGuidance`, not embedded into the command itself.
- next-turn restoration is now locked to current request `tool_outputs` / runtime metadata.
- continuation / restore / materialize must collapse completed stopless `function_call + function_call_output` pairs into a single guidance message and keep only the latest guidance.
- `/v1/responses` stopless turns now have an explicit two-owner contract: req owner preserves schema contract in `instructions`, bridge owner materializes it back into the outbound system message.
- next-step closeout is no longer "patch whichever continuation field is missing"; stopless continuation must converge on the standardized `MetadataCenter.continuation_context` contract for `save / restore / materialize / release`.
- stopless is not treated as protocol-independent continuation; it must stay out of persisted continuation/file-state owners.
- `responsesRequestContext.sessionId/conversationId` is continuation context only for `/v1/responses` owner flows; it must not be upgraded into request session truth, stopless activation input, stop-message scope, or state-key material.

## Review Checklist

- stopless does not depend on tmux, file state, or `sessionDir`.
- CLI projection stays in the stopless owner.
- CLI input is concise structured feedback only; model-visible natural language comes from req_chatprocess rewrite.
- the next turn is materialized from current request CLI truth / runtime metadata, not from a second fallback path.
- old stopless tool pairs never survive into continuation history; only the latest guidance is allowed to cross turns.
- `/v1/responses` next turn cannot lose the schema contract between req_chatprocess and responses bridge; provider-request must still contain the stopless system/schema instruction.
- VR still routes the rewritten stopless turn to `thinking`, not `tools`, even when historical tool route hints exist.
- `responsesRequestContext` remains a continuation carrier only and never materializes request `sessionId/conversationId`.
