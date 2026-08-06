# Provider Response Dead/Legacy Host Surface Test Design

## Scope

Close `docs/goals/hubpipeline-full-rust-closeout-plan.md` section 11.16 item 4 without changing provider/client payload semantics or the Rust response plan.

The production host contract is:

1. Rust materializes `rawPayload` and runtime effects.
2. `executeProviderResponseNativeServertoolEffects` accepts an empty retired-action list and returns no semantic result, or writes the Rust-planned stop-gateway control signal and fails fast for non-empty retired actions.
3. Body delivery uses `rawPayload`; stream delivery uses the Rust-planned `streamPipe.payload`.
4. Root provider-response metadata helpers expose only live MetadataCenter IO. The zero-production-caller metadata write projection wrapper and its `{}` malformed-result fallback are forbidden.

## Lifecycle Cases

| Case | Input | Required result |
| --- | --- | --- |
| success body | empty `servertoolRuntimeActions`, no stream pipe | host returns `rawPayload` body |
| success stream | empty `servertoolRuntimeActions`, valid stream pipe | host frames `streamPipe.payload` |
| retired action | non-empty `servertoolRuntimeActions` | stop-gateway write executes when planned, then explicit error |
| malformed actions | missing/non-array `servertoolRuntimeActions` | Rust/native planner error propagates |
| dead stage revival | host/effect helper returns or branches on `HubRespChatProcess03Governed` / `unchanged` | architecture gate fails |
| dead metadata wrapper revival | root metadata/native-call helper re-exports the zero-caller projector or returns `{}` for malformed native output | architecture gate fails |

## White-Box Tests

- `verify:provider-response-host-split` must reject `respProcessEffect.stage`, the legacy stage-result union, `projectNativeMetadataWritePlanToRuntimeControlWritePlan`, the root `projectMetadataWritePlanToRuntimeControlWritePlanWithNative` wrapper, and its `{}` malformed-result fallback.
- `test:provider-response-host-split-red-fixtures` must prove each forbidden surface makes the verifier red.
- `hub-pipeline-stage-residue-audit.spec.ts` must assert the servertool retirement host call is fail-fast/no-result, body truth remains `rawPayload`, stream truth remains `streamPipe.payload`, and the dead wrappers stay absent.

## Module Black-Box Tests

- `provider-response.metadata-center-provider-protocol.spec.ts` covers positive body/stream delivery, malformed action rejection, and retired action rejection through `convertProviderResponse`.
- Existing provider-response Rust plan tests continue to prove exact response materialization and stream effect semantics.

## Project Black-Box Impact

- No HTTP handler, provider runtime, direct passthrough, or Rust pipeline behavior changes.
- `build:native-hotpath` and `build:base` prove the root bridge still compiles and packages against the current Rust exports.
- Release/global install/restart/live replay are outside this slice unless Jason explicitly authorizes them.

## Positive And Negative Locks

- Positive: empty retired-action list cannot alter body or stream semantic truth.
- Positive: non-empty retired-action list still writes only the Rust-planned stop-gateway control signal before failing.
- Negative: no host stage branch can reintroduce a second `HubRespChatProcess03Governed` response owner.
- Negative: malformed metadata projection cannot silently become `{}` through a dead root wrapper.
- Negative: Rust projector tests remain intact; deleting the root wrapper must not delete the Rust semantic owner.

## Known Gaps

- This slice does not fix `failure_policy.rs` 401/402/403/404 recoverability, which remains owned by active `gate_id:default_pool_last_provider_no_remove`.
- This slice is source/native/build closure only without authorized release/global install/restart/live replay.
