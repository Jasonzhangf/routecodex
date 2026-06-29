# ServerTool / Stopless Lifecycle

## Scope

This document defines the current stopless lifecycle. Stopless is a request-closed-loop runtime-metadata flow and must not use transparent reenter, file persistence, or transparent reenter.

## Contract

- Stopless does not persist by `session:<sessionId>` and does not own a file-backed continuation scope.
- Stopless CLI command / CLI stdout must not require `sessionId`, `requestId`, or `sessionDir`.
- If runtime metadata already carries `sessionId`, it may still participate in broader stop-message / pending-session scope decisions, but stopless CLI progression itself must only depend on current request tool output + runtime metadata truth.
- `tmuxSessionId`, `conversationId`, `default`, and `stopMessageClientInject*` are forbidden as stopless state fallback keys.
- req_chatprocess must always inject the same stop hook contract for stopless-managed turns; if the hook is not injected, the model cannot be expected to call it.
- Stopless must emit a client-visible `exec_command` CLI projection for non-terminal stop flows.
- Stopless must not reenter the normal Hub pipeline as ordinary `user` input.
- Stopless CLI command input is status-only; continuationPrompt/schemaGuidance belong to CLI stdout only.
- Stopless CLI stdout must explicitly tell the model: it cannot terminate unless it proactively calls the same stop hook and provides the full stop schema.
- If the stop hook was auto-projected because the model stopped without proactively calling it, the returned CLI result must be rewritten on the next request into text guidance, not replayed as model-owned tool-call history.
- Internal runtime metadata (`__rt`, snapshot/debug carriers, provider/runtime state) must not appear in client-visible response bodies.
- Generic servertool CLI projection remains available only for non-stopless client-exec flows such as `servertool_fixture`.

## Lifecycle

```text
request injection phase
  -> req_chatprocess always injects stop hook contract
  -> model is told:
     - if you want to stop, you must provide stop schema
     - if you want to stop through the hook path, call the same stop hook

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
              -> emit exec_command(routecodex hook run stop_message_auto --input-json {"flowId","repeatCount","maxRepeats"})
              -> client executes hook with empty input
              -> hook stdout tells model:
                 - you must provide full stop schema
                 - schema format and stop conditions
                 - if you want to stop next round, call the same stop hook
              -> client submits ordinary tool result
              -> req_chatprocess rewrites this auto-injected stopless CLI result into text input
                 for the next model turn, instead of preserving tool-call history
              -> normal request chain
           -> schema present + terminal-valid stopreason(0|1)
              -> terminal_final
              -> return final client response
           -> schema present + terminal-invalid / continue_needed(2)
              -> cli_projection
              -> emit exec_command(routecodex hook run stop_message_auto --input-json {"flowId","repeatCount","maxRepeats"})
              -> client executes hook
              -> hook stdout tells model:
                 - why current schema cannot stop
                 - which fields / values are invalid
                 - what to do next
              -> client submits ordinary tool result
              -> req_chatprocess rewrites this auto-injected stopless CLI result into text input
                 for the next model turn, instead of preserving tool-call history
              -> normal request chain
           -> schema present + parse/argument-invalid
              -> cli_projection
              -> schema payload is treated as invalid arguments
              -> hook must return:
                 - parsed/attempted interpretation result
                 - which fields / values / structure are invalid
                 - canonical schema contract
                 - what the model must fix before stop can pass
              -> next turn still goes through req_chatprocess text rewrite
              -> normal request chain

budget guard
  -> repeated `finish_reason=stop` with no schema and no effective stop-hook closure may still be force-stopped after 3 rounds
  -> this is the loop guard for missing hook/schema capability, not a schema-pass stop
```

`StoplessOrchestrationAction` has only two valid actions: `terminal_final` and `cli_projection`. Any `followup_mainline` stopless action is invalid.

The closed loop is:

1. response-side stop detection projects client-visible `exec_command`
2. client runs `routecodex hook run reasoning_stop` with status-only input
3. CLI stdout returns schema guidance only
4. next request brings that stdout back as ordinary tool output
5. req-side rewrite materializes guidance from current request tool output/runtime metadata

No stopless step in this loop may depend on tmux, `ROUTECODEX_SESSION_DIR`, file-backed writeback, or server-side reenter.

## Owners

- Scope / persisted lookup: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`
- Goal state scope: removed; do not reintroduce stopless goal state.
- Orchestration action: `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs`
- Native bridge: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool_core_blocks.rs`
- TS thin shell: `sharedmodule/llmswitch-core/src/native/router-hotpath/native-servertool-core-semantics.ts`
- Runtime side effect shell: `sharedmodule/llmswitch-core/src/servertool/engine.ts`

## Stop Schema

When the model tries to stop, the final text must include a stop schema object with numeric `stopreason`:

- `0`: finished
- `1`: blocked
- `2`: continue needed

Missing schema, invalid schema, malformed schema arguments, or `stopreason=2` without `next_step` causes `cli_projection` until the Rust loop guard is exhausted. Valid `stopreason=2` with `next_step` continues with that exact next-step text and does not consume the consecutive invalid/no-schema budget. Valid `stopreason=0` requires `has_evidence=1` plus non-empty `evidence` and becomes `terminal_final`; evidence content is not semantically judged. Valid `stopreason=1` requires only non-empty `reason` and becomes `terminal_final`; `blocked + needs_user_input=true` must return the summary plus the user decision question and stop with `finish_reason=stop`.

## Validation

- `cargo test -p servertool-core stopless --lib -- --nocapture`
- `cargo test -p servertool-core persisted_lookup --lib -- --nocapture`
- `cargo test -p servertool-cli --test cli_blackbox -- --nocapture`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/cli-projection-runtime-shell.spec.ts --runInBand`
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `git diff --check`

Live validation must prove the client-visible response uses CLI projection, the command string is status-only, stopless does not call reenter, and the returned guidance requires the model to call the same stop hook before terminal stop.
