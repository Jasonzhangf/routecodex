# Responses Request Bridge Total Plan Shrink Test Design

## 1. Scope

Goal: shrink `src/modules/llmswitch/bridge/responses-request-bridge.ts` so it is only host IO and NAPI/JSON glue. Request-side protocol semantics must be owned by Rust total plans.

Covered in this slice:

- MetadataCenter write writer/stage selection for Responses pipeline metadata.
- `/v1/responses` handler payload finalization, including stream forcing and optional system prompt merge.
- Malformed inbound tool-history errorsample classification and write payload planning.
- Continuation lookup effect argument planning for submit/scope resume paths.
- Closed continuation effect argument and result-projection planning for lookup,
  direct provider-owned submit materialization, relay resume, and scope
  materialization.
- Resume-error projection decision, defaults, status, and client body descriptor planning.
- Residue lock against reintroducing local TS semantic branches in the request bridge.

Out of scope:

- ErrorErr provider-response closeout.
- Live install/restart/replay.

## 2. Node Contract

```text
Node: ServerReqInbound01ClientRaw -> HubReqInbound02Standardized
Owner: Rust shared_responses_conversation_utils
Caller -> Callee: responses-request-bridge.ts -> responses-request-handler-host.ts
Input: current /v1/responses payload, stream plan, request ids, optional host-read prompt override, and continuation metadata.
Output: finalized payload plus typed MetadataCenter write effects, errorsample write effects, closed continuation effect descriptors/final results, and closed resume-error projection descriptors.
Normal path: TS reads host-only prompt/config state, calls Rust plans, executes the exact returned IO effect, passes the opaque effect result and `resultPlanInput` back to Rust, then returns the exact Rust final descriptor.
Error path: malformed native plan, malformed effect result, unknown action/operation, missing response id, missing continuation owner, or malformed continuation fails explicitly; no TS default or alternate path is allowed.
Unexpected path: TS local family branching, local writer constants, direct `applySystemPromptOverride`, local prompt merge, local tool-history classification, local continuation lookup parsing, response-id selection, payload mutation, endpoint/default selection, owner classification, resume-meta parsing, or materialized-result merge is residue and must fail the gate.
Blackbox observable: stream finalization, metadata center projections, and request payload instructions remain equivalent.
```

## 3. Closed Effect Contract

Rust returns exactly one of:

```text
execute_effect
  effect.operation =
    lookup_continuation
    | materialize_provider_owned_submit
    | resume_relay
    | materialize_scope
  effect.args = complete Node/native IO arguments
  resultPlanInput = opaque Rust-owned continuation token

complete
  result.kind = ok | scope_continuation_expired | client_error
  result = complete host-facing descriptor with no TS defaults
```

TS may switch only on the validated `effect.operation`, call the matching host
IO with `effect.args`, and pass `{ operation, result, resultPlanInput }` back to
the same Rust planner. TS must not read `resultPlanInput`, infer continuation
owner, or assemble/patch the final payload.

## 4. Whitebox Coverage

Positive:

1. Rust metadata plan emits complete writer descriptors for `runtime_control` and `continuation_context`.
2. TS metadata bridge passes `writer` from the Rust plan unchanged to `writeMetadataCenterSlot`.
3. Rust finalize payload plan applies host-read prompt text to `/v1/responses.instructions` and preserves existing instructions.
4. Rust errorsample plan emits a `write_errorsample` descriptor only for malformed Responses tool-history contract violations.
5. Rust continuation plan emits `lookup_continuation` with complete `responseId` and scope options.
6. Direct submit emits complete provider-owned materialization args and Rust merges only the validated materialized input into the Rust-planned payload.
7. Relay submit emits complete `responseId`, payload, and resume options.
8. Scope materialize emits complete payload/request/session/conversation/entry/owner/port/group args.
9. Attach/none paths return complete final results without host defaults.
10. Rust resume-error plan emits `rethrow` for non-client errors and a complete `client_error` status/body descriptor for client-origin errors.

Negative:

1. Gate fails if request bridge imports or calls `applySystemPromptOverride`.
2. Gate fails if request bridge keeps local writer constants or `write.family` conditional writer selection.
3. Gate fails if native wrapper accepts metadata writes without a writer object.
4. Gate fails if Rust metadata plan omits writer descriptors.
5. Gate fails if request bridge locally classifies `MALFORMED_REQUEST`, `Tool history contract violated`, or `toolHistoryContractViolation`.
6. Gate fails if request bridge locally parses continuation lookup, derives response ids, mutates `previous_response_id`, classifies owner, supplies endpoint defaults, parses resume metadata, or merges materialized payload input.
7. Native wrapper rejects unknown plan actions, unknown effect operations, missing/malformed effect args, malformed opaque result tokens, and malformed final result descriptors.
8. Rust rejects missing effect results, mismatched operation/result tokens, malformed continuation records, and unknown continuation owners.
9. Gate fails if request bridge/native host restores separate resume-error builder/projectability helpers or TS-local client-error defaults.

## 5. Lifecycle Matrix

- Positive: direct submit, relay submit, relay scope materialize, unowned scope
  materialize, attach resume metadata, and no-continuation completion.
- Negative: missing response id, missing/unknown owner after explicit lookup,
  malformed continuation, missing/malformed effect result, mismatched effect
  operation/token, unknown native action, and unknown effect operation.
- Module blackbox: direct/relay/scope host IO receives byte-equivalent payload
  semantics and exact scope options.
- Project blackbox: submit_tool_outputs handler still reaches the same
  direct/relay request path; no handler/SSE continuation semantics are added.

## 6. Gates

- `npm run verify:responses-request-bridge-total-plan-shrink`
- `npm run test:responses-request-bridge-total-plan-shrink-red-fixtures`
- `npm run test:responses-pipeline-metadata-plan-cargo`
- `npm run test:responses-pipeline-metadata-plan-bridge`
- `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi continuation_request_action --lib -- --nocapture`
- `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi responses_resume_error_plan --lib -- --nocapture`
- `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml -p router-hotpath-napi inbound_tool_history_errorsample_plan --lib -- --nocapture`
- `npm run verify:function-map-compile-gate`
- `npm run verify:hub-pipeline-native-reference-gate`
- `npm run verify:llmswitch-rustification-audit`
- `npm run build:native-hotpath`
- `ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base`

## 7. Completion Boundary

This design proves source/build movement only. Live closure requires explicit Jason authorization for release/global install, aggregate restart, and same-entry `/v1/responses` replay.
