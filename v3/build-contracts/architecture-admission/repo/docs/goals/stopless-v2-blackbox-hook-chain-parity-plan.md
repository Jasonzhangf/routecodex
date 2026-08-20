# Stopless V2 Black-box Hook-chain Parity Plan

## 1. Goal and acceptance

Align the V3 stopless / `reasoningStop` behavior with the V2 black-box contract on the non-production 5555 server by wiring the existing hook skeleton into a real request/response chain. The result must preserve trigger state across the correct save/restore boundaries and must not invent any standalone lifecycle, fallback path, or direct-path stopless behavior.

Acceptance:

- The important V2 black-box cases reproduce on V3:
  - missing schema → round 1/2 CLI repair prompt, round 3 budget-exhausted passthrough
  - forcestop bypass
  - `needs_user_input` bypass
  - `<rcc_stop_schema>` fence
  - `reasoning.stop.arguments`
  - field-level missing prompt
  - forbidden-token red path
  - multi-round `stopreason=2` followup
  - SSE + stopless
  - mixed tool kinds + stopless
  - `stopreason=1` vs `stopreason=0` equivalence lock
- Direct routes never activate stopless.
- Stopless behavior happens only:
  - on the response side before continuation save, and
  - on the request side after continuation restore.
- Provider wire, client wire, and logs show the same trigger state with no silent failure.
- A live 5555 replay of the same failing payloads matches the V2 black-box result set.

## 2. Scope and boundaries

### In scope

- Connecting the existing hook chain around the chat-process boundary:
  - response intercept
  - schema validation
  - hook-response projection
  - outbound handoff
  - request restore
  - result parse
  - text rewrite
  - schema reinjection
  - request finalize
- Threading stopless state through the existing Rust-owned control path for one request only.
- Adding or updating black-box and white-box tests that prove the V2 parity matrix.
- Adding the minimum logging/observability required to prove provider wire shape, trigger state, and save/restore placement.
- Live validation on 5555 only.

### Out of scope

- Any new standalone server-side followup lifecycle.
- Any fallback, downgrade, or dual-path compensation.
- Any production port mutation or production-server interference.
- Any unrelated provider capability, model-context, or quota work.
- Any direct-path business semantics change other than preventing stopless activation.
- Any payload truncation or semantic clipping.

## 3. Design principles

- Single owner: stopless belongs to the hook skeleton plus chat-process boundary only.
- No separate lifecycle.
- No fallback.
- No direct-path stopless.
- No semantic mutation outside the save/restore boundary.
- Black-box parity with V2 is the proof, not the printed command shape alone.
- Real payloads only; do not “fix” the problem by shortening or rewriting the truth we are trying to validate.
- Transport layers remain transport-only.

## 4. Technical plan

1. Lock the current owner, mainline, and verification docs before touching runtime behavior.
2. Reproduce the current mismatch with failing samples and record the exact V2-vs-V3 black-box gap.
3. Add or repair red tests for the V2 matrix on both request and response sides.
4. Verify the response hook chain is actually connected:
   - `ServertoolRespHook01Intercepted`
   - `ServertoolRespHook02SchemaValidated`
   - `ServertoolRespHook03HookResponseInjected`
   - `ServertoolRespHook06ProjectionFinalized`
5. Verify the request hook chain is actually connected:
   - `ChatProcReqContinuation03CanonicalRestored`
   - `ServertoolReqHook01ResultParsed`
   - `ServertoolReqHook02TextRewritten`
   - `ServertoolReqHook03ToolInjected`
   - `ServertoolReqHook04RequestFinalized`
6. Keep stopless state writes only at the response save boundary and stopless state reads only at the request restore boundary.
7. Make sure direct routes cannot enter stopless activation or schema reinjection.
8. Capture provider-wire request/response evidence and client-visible wire evidence from real runs.
9. Re-run live 5555 on the same failing payloads until the black-box behavior matches V2.
10. Commit and push only after live validation is green.

## 5. Key files and surfaces

Source owner surfaces to inspect and, if needed, change:

- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/hook_skeleton_contract.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_hook_runtime.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_stopless_hook.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/stopless_auto_handler_bridge.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`

Tests and verification surfaces:

- `tests/servertool/*`
- `tests/sharedmodule/*`
- `scripts/tests/*`
- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/wiki/stopless-session-mainline-source.md`

## 6. Risk and mitigation

- Risk: direct routes accidentally activate stopless.
  - Mitigation: add explicit direct-negative tests and keep the hook owner guard in the Rust chain.
- Risk: trigger state is lost across save/restore.
  - Mitigation: lock the exact response-save / request-restore boundary and test repeat counting across rounds.
- Risk: fixing the wrong layer.
  - Mitigation: keep SSE, handler, and provider transport as transport-only; do not move stopless semantics there.
- Risk: logging proves command shape but not real behavior.
  - Mitigation: require provider-wire and client-wire evidence from live 5555 replays.
- Risk: live testing affects production.
  - Mitigation: use 5555 only and keep production ports untouched.

## 7. Test plan

### White-box gates

- Hook contract and phase ordering tests.
- Response-side schema and projection tests.
- Request-side restore / rewrite / reinjection tests.
- Direct-negative tests that prove stopless does not activate there.

### Black-box gates

- Positive and negative pairs for the V2 case matrix:
  - missing → round 1/2 CLI repair prompt, round 3 budget-exhausted passthrough
  - forcestop bypass
  - `needs_user_input` bypass
  - fence / schema cases
  - forbidden token red path
  - multi-round followup
  - SSE + stopless
  - mixed tool kinds
  - `stopreason=1` vs `stopreason=0`
- Cross-round tests that prove the state survives save/restore.
- Provider-wire and client-wire observation for the exact same sample set.

### Live gates

- Non-production 5555 live replay only.
- Same payloads that currently reproduce the mismatch.
- Real JSON and SSE entry points.
- Proof that the direct path stays negative.
- Proof that the response side triggers before save and the request side restores after restore.
- Proof that there is no silent failure and no hidden fallback.

## 8. Implementation order

1. Freeze the current docs and owner maps for the stopless feature.
2. Reproduce the V2-vs-V3 black-box mismatch with the current failing samples.
3. Write the red tests for the most important cases first.
4. Connect the Rust hook chain at the existing owner surfaces.
5. Validate save/restore boundary placement.
6. Lock the direct-negative path.
7. Green the white-box and black-box tests.
8. Run live 5555 replays with the same payloads.
9. Confirm the live results match the V2 black-box behavior.
10. Commit and push the final fix.

## 9. Done definition

This task is done only when all of the following are true:

- The V2 black-box parity cases pass on V3.
- Stopless is connected through the hook chain, not through a separate lifecycle.
- Direct never triggers stopless.
- Stopless state is preserved across the correct save/restore boundaries.
- Live 5555 replay on the same payloads matches the expected V2 result set.
- The final evidence is written into the repo notes / memory if it is durable enough to keep.

## 10. 2026-07-18 corrected closeout contract

This section overrides any stale statement above that conflicts with the current V2 parity target. The task is to match the old production/V2 black-box result, not to preserve a V3-invented interpretation.

### Corrected target

- On managed V3 relay requests, when stopless is enabled and the stopless budget is not exhausted, the final provider request must:
  - preserve the original client tool declarations in the same order and shape;
  - append or otherwise expose the V2-compatible `reasoningStop` tool expected by the provider/model;
  - inject the V2-compatible schema guidance into the provider-facing system/instructions channel;
  - preserve normal conversation history and ordinary client tools such as `exec_command`;
  - remove only stopless shell artifacts from the next provider request (`call_stopless_reasoning`, `routecodex hook run reasoningStop`, `function_call_output` for the stopless shell).
- The wording, tool schema, and schema guidance must be derived from the V2 production implementation / tests. Do not invent a new prompt, a new tool schema, new field requirements, or a new lifecycle.
- If current V3 docs say that managed relay must not declare provider-facing `reasoningStop`, treat those docs as stale for this task after verifying the V2 source. Update docs/maps/tests together with the implementation.
- Direct / same-protocol passthrough remains a negative case: direct must not activate stopless and must not inject stopless guidance/tooling.

### Budget and counter contract

- Stopless budget exhaustion means the stopless hook does not intercept. It must return the original provider response unchanged.
- Budget exhaustion must not synthesize a terminal response, must not strip or repair provider output, must not remove ordinary tool calls, and must not project another `exec_command(routecodex hook run reasoningStop ...)`.
- The consecutive counter increases only for consecutive stop responses that fail the stop schema contract (`no_schema`, `invalid_schema`, or equivalent V2 schema-error trigger).
- Any non-stop progress must reset the stopless counter to zero:
  - ordinary tool calls;
  - valid terminal schema;
  - valid continue schema with progress semantics;
  - normal assistant progress;
  - session/conversation change;
  - direct-path response because stopless is not active there.
- If a test produces two consecutive stops, the test must also prove that the second provider request still contains the original tools, the injected `reasoningStop` tool, and schema instructions. Without that provider-wire proof, repeated stop is likely a tool/schema-injection failure, not a valid loop-counter test.

### Required implementation shape

- Keep stopless/servertool as Chat Process hooks only:
  - request side after continuation/context restore and before provider outbound governance finalization;
  - response side before continuation save.
- Do not add a standalone lifecycle, background executor, fallback path, SSE/handler patch, provider-runtime patch, or resp_outbound repair.
- Do not change production ports for validation. Use 5555 only.
- Do not modify user/provider config to mask a code bug.

### Required tests

White-box:

- Request hook, no prior CLI output:
  - original tools preserved exactly;
  - `reasoningStop` injected once;
  - schema guidance instructions present;
  - input/history unchanged.
- Request hook after current stopless CLI output:
  - stopless shell pair is replaced by one ordinary user continuation;
  - original tools are still present;
  - `reasoningStop` is still present exactly once;
  - schema guidance remains present.
- Response hook, budget not exhausted:
  - missing/invalid stop projects client-visible `exec_command(routecodex hook run reasoningStop ...)`;
  - provider visible text is preserved where V2 preserved it;
  - raw provider `reasoningStop` does not leak to the client.
- Response hook, budget exhausted:
  - original provider response is byte/JSON-semantic passthrough from the stopless hook;
  - ordinary tool calls remain ordinary tool calls for the normal response governance path.
- Counter reset:
  - consecutive no-schema/invalid stops advance 1 -> 2;
  - non-stop progress resets to the next projection being repeatCount 1;
  - valid terminal and direct path do not consume the schema-error budget.

Black-box:

- Cross-request `/v1/responses` relay on controlled runtime:
  - first provider request has original tools + `reasoningStop` + schema instructions;
  - first client response projects stopless CLI when schema is missing/invalid;
  - second provider request preserves original tools + `reasoningStop` + schema instructions and contains only ordinary user continuation, not stopless shell artifacts;
  - third consecutive schema-error stop passes through unchanged when budget is exhausted.
- Direct negative:
  - direct `/v1/responses` never emits stopless CLI and never injects stopless tool/guidance.
- Live 5555:
  - provider-request dry-run proves final provider body shape;
  - real JSON/SSE replay proves client-visible behavior;
  - repeated stop samples include provider-wire evidence for tool preservation and schema guidance before interpreting repeatCount.

### Required live closeout

Completion requires all of:

1. source tests red before the fix or failing sample captured before the fix;
2. focused white-box and controlled black-box tests green;
3. V3 build succeeds;
4. global install updates the `rccv3` binary actually used by 5555;
5. only 5555 is restarted;
6. 5555 `/health` passes;
7. provider-request dry-run on the old failing payload proves tools/guidance shape;
8. real 5555 replay proves no silent stop, no tool loss, no direct activation, and budget-exhausted passthrough;
9. final changes are committed and pushed.
