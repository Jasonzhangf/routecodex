# ServerTool / Stopless Lifecycle

## Scope

This document defines the current stopless lifecycle. Stopless is a request-closed-loop runtime-metadata flow and must not use transparent reenter, file persistence, or transparent reenter.

## Contract

- Stopless does not persist by `session:<sessionId>` and does not own a file-backed continuation scope.
- Stopless CLI command / CLI stdout must not require `sessionId`, `requestId`, or `sessionDir`.
- If runtime metadata already carries `sessionId`, it may still participate in broader stop-message / pending-session scope decisions, but stopless CLI progression itself must only depend on current request tool output + runtime metadata truth.
- `tmuxSessionId`, `conversationId`, `default`, and `stopMessageClientInject*` are forbidden as stopless state fallback keys.
- req_chatprocess must always inject the complete stop schema as a system instruction for stopless-managed turns.
- Stopless must emit a client-visible `exec_command` CLI projection for non-terminal stop flows.
- Stopless must not perform server-side reenter; the client executes the projected CLI and submits its result through the normal request entry.
- V3 stopless CLI command/stdout are no-input no-op only; they never carry status, control, schema feedback, `next_step`, or prompt text. Model-facing guidance exists only in the system instruction plus the ReqChatProcess-generated ordinary user guideline.
- The submitted stopless CLI call/result pair is private control evidence. ReqChatProcess must replace it with one ordinary user message and must not replay it as model-owned tool-call history.
- Internal runtime metadata (`__rt`, snapshot/debug carriers, provider/runtime state) must not appear in client-visible response bodies.
- Generic servertool CLI projection remains available only for non-stopless client-exec flows such as `servertool_fixture`.

## Lifecycle

```text
request injection phase
  -> req_chatprocess always injects complete stop schema as a system instruction
  -> model is told:
     - every final summary must include the schema
     - exact field types, required/optional relations, values, output shape, examples

provider response
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
  -> check finish_reason
     -> not stop
        -> return normal response
     -> stop
        -> classify stop payload
           -> no schema
              -> cli_projection
              -> emit exec_command(routecodex hook run reasoningStop)
              -> client executes public CLI alias and submits ordinary tool result
              -> req_chatprocess consumes current resume output privately
              -> req_chatprocess removes the shell pair and emits the fixed transparent user prompt
              -> provider sees only that user prompt plus the system schema
              -> normal request chain
           -> schema present + terminal-valid stopreason(0|1)
              -> terminal_final
              -> return final client response
           -> schema present + terminal-invalid / continue_needed(2)
              -> cli_projection
              -> emit exec_command(routecodex hook run reasoningStop)
              -> client executes hook
              -> client submits ordinary tool result
              -> req_chatprocess consumes only no-op evidence and StoplessCenter state
              -> StoplessCenter policy selects the complete transparent current-turn user guideline
              -> provider sees no stopless result/tool pair
              -> normal request chain
           -> schema present + parse/argument-invalid
              -> cli_projection
              -> schema payload is treated as invalid arguments
              -> Resp03 classification is stored in StoplessCenter, never in CLI stdout
              -> next turn still goes through req_chatprocess transparent user rewrite
              -> normal request chain

budget guard
  -> repeated `finish_reason=stop` with no schema and no effective stop-hook closure may still be force-stopped after 3 rounds
  -> this is the loop guard for missing hook/schema capability, not a schema-pass stop
```

`StoplessOrchestrationAction` has only two valid actions: `terminal_final` and `cli_projection`. Any `followup_mainline` stopless action is invalid.

The closed loop is:

1. response-side stop detection projects client-visible `exec_command`
2. client runs no-input `routecodex hook run reasoningStop`
3. next request brings only no-op completion output back as ordinary tool output
4. ReqChatProcess reads current no-op evidence and MetadataCenter StoplessCenter for private state
5. req-side rewrite removes the tool pair and emits one ordinary user prompt
6. req-side system instruction supplies the complete schema contract

No stopless step in this loop may depend on tmux, `ROUTECODEX_SESSION_DIR`, file-backed writeback, or server-side reenter.

## Owners

- Scope / persisted lookup: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`
- Goal state scope: removed; do not reintroduce stopless goal state.
- Orchestration action: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs`
- Native bridge: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- TS host call surface: owner-specific `src/modules/llmswitch/bridge/*-host.ts` shells; `src/modules/llmswitch/bridge/native-exports.ts` is only the private loader and must not become the servertool/stopless semantic owner surface.
- Runtime side effects: Rust effect plans executed by Host IO; old `sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts` is deleted and must not be restored.

## Stop Schema

When the model tries to stop, the final text must include a stop schema object with numeric `stopreason`:

- `0`: finished
- `1`: blocked
- `2`: continue needed

Missing schema, invalid schema, malformed schema arguments, or `stopreason=2`/need_continue causes `cli_projection` only on consecutive rounds 1 and 2. On consecutive round 3, the Rust loop guard must stop intercepting and pass the original `finish_reason=stop` response to the client; it must not project another CLI or synthesize a budget-exhausted terminal response. Any normal progress, ordinary tool call, valid terminal schema, `simple_question=true`, or session change resets the consecutive counter. CLI/manual inputs must not carry `repeatCount` / `maxRepeats`. `simple_question=true` is the only schema option that may allow natural stop without `stopreason`; it is reserved for very simple user inputs and must pass through to the client without CLI projection. Valid `stopreason=2` / need_continue writes StoplessCenter state and the next request uses the complete model-transparent current-turn guideline selected by policy; it does not consume schema-error budget. Valid `stopreason=0` requires `has_evidence=1` plus non-empty `evidence` and becomes `terminal_final`; evidence content is not semantically judged. Valid `stopreason=1` requires non-empty `reason`, `has_evidence=1`, and non-empty `evidence`, and becomes `terminal_final`; `blocked + needs_user_input=true` must return the summary plus the user decision question and stop with `finish_reason=stop`.

## Validation

- `cargo test -p servertool-core stopless --lib -- --nocapture`
- `cargo test -p servertool-core persisted_lookup --lib -- --nocapture`
- `cargo test -p servertool-cli --test cli_blackbox -- --nocapture`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/execution-stage-shell.spec.ts --runInBand`
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `git diff --check`

Live validation must prove the client-visible response uses no-input CLI projection, the command string/stdout carry no state/control/prompt, stopless does not call server-side reenter, and the next provider request contains only the complete system schema plus the ordinary model-transparent current-turn guideline with no no-op/CLI/client bridge wording.
