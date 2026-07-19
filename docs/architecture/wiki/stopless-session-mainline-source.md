# Stopless Session Mainline Source

## Purpose

This page is the review surface for the stopless runtime-metadata session mainline. It is the only canonical place to read the current owner binding, mainline edges, gate coverage, and the current "sessionId-only for stopless counting, no other identity source, no Responses continuation mutation" closure status proved by `tests/servertool/stopless-cli-continuation.spec.ts`.

This is not a second source of truth. The mechanical edges live in `docs/architecture/mainline-call-map.yml` (`chain_id: stopless.session.mainline`) and the owner / gate policy lives in `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` (`feature_id: hub.servertool_stopless_cli_continuation`). The Mermaid figure below is a render artifact and must not be hand-edited.

Stopless does not own or mutate the `/v1/responses` continuation store. Continuation store / restore / materialize is its own owner (`responses-continuation-store`); stopless only operates after that owner has restored the current request. ReqChatProcess may read the current `responsesResume.toolOutputsDetailed` control evidence, but stopless never re-shapes or replaces continuation scope.

Runtime-control rule: `MetadataCenter.runtime_control.stopless` is the canonical request-scoped stopless control slot. Request Chat Process Rust governance emits `metadata.runtime_control.stopless`; the TS request-stage shell may only commit that Rust output into the bound MetadataCenter and must fail fast if no center is bound. Response Chat Process reads that same slot. `requestTruth.runtimeControl`, top-level metadata mirrors, file persistence, and sessionDir writeback are not legal stopless control sources.

Hook placement rule: response-side stopless hooks run after `HubRespChatProcess03Governed` and before `HubRespOutbound04ClientSemantic`. Request-side stopless hooks run after `HubReqInbound02Standardized` and before `HubReqChatProcess03Governed`. They must not be placed inside the Responses continuation store / restore edges (`responses-request-context-capture` or `responses-resume`), or they will compete with continuation semantics.

Ordering rule:

- every managed relay provider request must contain the complete stop schema as
  a system instruction and declare exactly one model-facing/internal
  `reasoningStop` tool; direct/provider-direct requests must declare neither
  the tool nor the stopless guidance
- response-side stopless interception/schema judgment must complete before the response continuation owner persists the canonical response truth
- next-turn stopless restore must run only after the Responses continuation owner restores/materializes the request
- stopless 3-round no-schema/invalid-schema guard is evaluated on that restored current-turn truth, not on stale pre-hook saved context
- the latest real user turn is a hard reset boundary for every inbound/history/codec collapse owner; older stopless pairs are removed, the user text is preserved verbatim, and no automatic guidance is rebuilt
- the Responses-to-chat codec must remove internal stopless declarations from embedded `toolsNormalized` while preserving ordinary client tools
- if save happens before stopless interception/projection, the next restore will miss the injected guidance/shape change and the loop becomes misaligned

## Three-Round Lock

### Round 1 request

This round owns only server-side per-request injection:

1. complete stop-schema/system guidance for the `finish_reason=stop` path;
2. exactly one provider-facing/model-visible internal `reasoningStop` tool
   declaration on managed relay only;
3. unchanged normal client tool surface, including `exec_command`.

These are injected by chat-process/servertool owner on every stopless-managed
request. They are not client input.

### Round 1 response

This round owns only:

1. intercept `finish_reason=stop`;
2. evaluate the assistant text/fence through the stop schema gate;
3. if stop is denied, project client-visible CLI;
4. save canonical continuation context after the normalized client-visible
   response exists;
5. then return to client.

### Round 2 request

This round owns only:

1. restore continuation context first;
2. consume Round-1 CLI execution result as private control evidence;
3. remove the stopless CLI call/result pair from provider-visible history;
4. emit one ordinary user message: exact valid `next_step`, otherwise the
   fixed transparent continuation prompt;
5. inject the same system stop-schema contract and one internal
   `reasoningStop` tool again for the new managed relay request.

If a real user message already follows the stopless pair, that message starts a
new turn: preserve it verbatim, reset the streak, remove only the older
stopless pair, and do not emit automatic guidance.

### Round 3 guard

This round adds one extra rule only:

- after the 3rd consecutive `no_schema` / invalid-schema stop, pass the
  original `finish_reason=stop` through to the client instead of projecting
  another `reasoningStop` CLI command; do not synthesize a budget-exhausted
  terminal payload;
- any non-stop progress, ordinary tool call, valid terminal schema,
  `simple_question=true`, or session change resets the streak to zero, so the
  next missing/invalid stop starts again at `repeatCount=1`;
- CLI/manual input with `repeatCount >= maxRepeats` is invalid and must fail
  fast instead of being clamped into a terminal success result.

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
| stl-02 | runtime snapshot resolved | `hub.servertool_stopless_cli_continuation` | anchored | stopless state is restored from runtime metadata or the current request `tool_outputs` after the request shape is materialized; never from another identity source. |
| stl-03 | CLI projection planned | `hub.servertool_stopless_cli_continuation` | anchored | Rust `plan_client_exec_cli_projection_output` plus native projection shell builds the client-visible CLI command with concise structured input: `flowId/repeatCount/maxRepeats/triggerHint` plus optional `schemaFeedback{reasonCode,missingFields}`. |
| stl-04 | client executes the CLI | `hub.servertool_stopless_cli_continuation` | anchored | `routecodex hook run reasoningStop` executes as the public client CLI alias with status/control input. The provider never receives this shell alias or its history; managed relay receives only the fresh internal `reasoningStop` tool declaration injected by ReqChatProcess. |
| stl-05 | CLI result restored into next request scope | `hub.servertool_stopless_cli_continuation` | anchored | after Responses continuation restore, ReqChatProcess reads current `responsesResume.toolOutputsDetailed` plus the bound MetadataCenter snapshot to restore private repeat state. It never derives repeatCount from provider-visible text and never writes back into continuation store. |
| stl-06 | next-turn guidance rewritten | `hub.servertool_stopless_cli_continuation` | anchored | inbound normalization removes the stopless shell call/result pair and emits one ordinary user turn. A valid `stopreason=2 + next_step` uses `next_step` verbatim; missing/invalid schema uses the fixed transparent continuation prompt. No internal feedback fields survive into the provider request. |
| stl-07 | req-side schema contract rebound | `hub.servertool_stopless_cli_continuation` | anchored | req_chatprocess must physically rebind the stopless schema contract onto the next request mainline: chat/messages use a system message, `/v1/responses` uses `instructions` which the bridge must materialize back into the outbound system message. |
| stl-08 | VR routes stopless turn to thinking | `hub.servertool_stopless_cli_continuation` | anchored | route selection forces the next turn into thinking rather than reusing the stopless CLI result as history. |

## Owner / Allowed / Forbidden Path Summary

- Owner module: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src`.
- Allowed paths include Rust `servertool-core`, Rust `router-hotpath-napi`, and owner-specific `src/modules/llmswitch/bridge/*-host.ts` shells. `src/modules/llmswitch/bridge/native-exports.ts` is allowed only as the private loader behind those hosts and must not be the stopless semantic owner surface.
- Forbidden paths: `src/providers`, `src/server/runtime/http-server/executor`, and deleted `sharedmodule/llmswitch-core/src/servertool/**` TS surfaces.

## Required Gates

- `cargo test -p servertool-core cli_contract --lib`
- `cargo test -p servertool-core persisted_lookup --lib`
- `cargo test -p servertool-cli --test cli_blackbox`
- `cargo test -p router-hotpath-napi test_req_process_responses_input_still_materializes_stopless_contract --lib -- --nocapture`
- `npm run verify:stopless-contract-blackbox`
- `npm run verify:stopless-invalid-schema-blackbox`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/responses/responses-openai-bridge.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/cli/servertool-command.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-vr-route-hint.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/execution-stage-shell.spec.ts --runInBand`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:function-map-compile-gate`

## Active Gaps

- `stopless-gap-01`: broader docs/wiki/html artifacts outside this page still contain some older persisted/sessionDir wording and need a follow-up sweep.
- `stopless-gap-03`: stopless 曾被误读为 session-scoped persisted continuation；当前已改成 session-keyed runtime metadata/current-turn `tool_outputs` owner，但历史命名和审计路径仍需持续防回潮。
- `stopless-gap-04`: stopless 与 Responses continuation store / restore 的边界此前不显式；当前已明确 stopless 不写 continuation store，但仍需要在更大 session/state 审计里持续复核。
- `stopless-gap-05`: `ROUTECODEX_SESSION_DIR` 仍是共享 runtime workdir root；虽然 stopless 已不依赖任何其它身份源，但目录物理拆分是否推进仍待后续总体 closeout 决策。

## Recent Closures

- stopless loop counter is keyed strictly by the active request `sessionId`; no other runtime scope is admitted.
- `sessionDir` is treated as a server/CLI shared persisted-state directory, not as session identity; persistence path is decided per request and never derived from conversation/default identity.
- CLI command and stdout stay status/control-only; model-facing schema guidance comes from the system instruction, while ReqChatProcess generates the ordinary user continuation.
- next-turn private state restoration is locked to current `responsesResume.toolOutputsDetailed` / MetadataCenter truth after Responses continuation restore; stopless does not own continuation store / materialize.
- stopless collapses completed shell call/result pairs into one ordinary user message and keeps no provider-facing stopless shell history; managed relay re-injects a fresh internal `reasoningStop` tool declaration exactly once per request.
- old shell-projected stop history (`exec_command(cmd="reasoningStop")`, `reasoning_stop`, paired `command not found`) is legacy pollution and is removed during req-side normalization instead of replayed.
- `/v1/responses` stopless turns now have an explicit two-owner contract: req owner preserves schema contract in `instructions`, bridge owner materializes it back into the outbound system message.
- `/v1/responses` stopless turns have an explicit two-owner contract: req owner preserves schema contract in `instructions`, bridge owner materializes it back into the outbound system message. This is independent of Responses continuation store and must not mutate continuation scope.
- `responsesRequestContext.sessionId/conversationId` is Responses continuation context only; it must not be promoted into stopless session truth, stopless activation input, or stopless state key material.
- client-visible stopless projection prose is ordinary assistant text; reasoning fields are not the display surface, and stopless `function_call_output` is never projected back to the provider.
- provider-request dry-run is the black-box gate for the system contract. It must stop before upstream send and inspect the final `providerRequest.body`, not an intermediate Hub payload.

## Review Checklist

- stopless does not admit conversation, default, client-inject scope, or Responses continuation scope as session identity.
- CLI projection stays in the stopless owner.
- CLI input/output is concise structured control only; provider-visible natural language comes from ReqChatProcess rewrite.
- the next turn's private state is materialized from current resume evidence / runtime metadata after continuation restore, with no extra identity fallback path.
- request-side stopless runtime control is written as `MetadataCenter.runtime_control.stopless`, not `requestTruth.runtimeControl` or top-level metadata.
- response canonical save must happen after stopless response interception/projection; saving pre-hook truth is invalid because the next restore would lose stopless-visible modifications.
- old stopless tool pairs never survive into continuation history; only the latest guidance is allowed to cross turns.
- a real user turn after a stopless pair wins over automatic guidance in inbound normalization, continuation history, and the final Responses-to-chat codec.
- `/v1/responses` next turn cannot lose the schema contract between req_chatprocess and responses bridge; provider-request must still contain the stopless system/schema instruction.
- provider-request messages/history and embedded `toolsNormalized` must not contain `servertool`, `routecodex hook`, stale `reasoningStop`, `reasoning_stop`, `stop_message_auto`, stopless `function_call_output`, `repeatCount`, `reasonCode`, `missingFields`, `schemaGuidance`, or malformed-CLI diagnostics. Managed relay top-level `tools` must contain exactly one fresh internal `reasoningStop`; direct/provider-direct must contain none.
- filtering internal stopless declarations must preserve ordinary client tools such as `exec_command`.
- VR still routes the rewritten stopless turn to `thinking`, not `tools`, even when historical tool route hints exist.
- `responsesRequestContext` remains a Responses continuation carrier only and never materializes request `sessionId/conversationId` into stopless scope.
