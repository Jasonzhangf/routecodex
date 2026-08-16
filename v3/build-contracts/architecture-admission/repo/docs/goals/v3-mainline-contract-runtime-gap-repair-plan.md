# V3 mainline contract runtime gap repair plan

## 1. Goal and acceptance

Repair the runtime gaps that violate the approved V3 mainline contract, without changing live config or provider credentials.

Acceptance:
- Req04 no longer silently deletes non-injected tool calls or tool outputs.
- Continuation local context restore/materialize is owned by Req04 only; runtime wrappers may pass scope/lookup but must not merge payload after Req04.
- Anthropic/OpenAI/Gemini Relay provider errors use the same target-local failure, health, and reselect semantics as Responses Relay where the contract applies.
- Provider success is recorded only after provider response parse/govern/commit succeeds.
- Anthropic response closeout has one response governance/commit/projection helper path, not branch-local repeated Resp03-Resp06 logic.
- P0/P1 closeout gates pass; live closure is claimed only after global install, managed restart, and old-sample replay.

## 2. Scope

In scope:
- Rust V3 runtime source under `v3/crates/routecodex-v3-runtime/src/hub_v1/`.
- Shared Rust helper extraction if needed to avoid duplicate provider failure or response closeout logic.
- Rust tests and architecture verifiers/red fixtures directly covering the runtime gaps.
- Minimal map/doc updates required to keep source bindings honest.

Out of scope:
- Provider config changes, credential changes, route priority changes, V2 behavior, UI changes.
- Direct/P6 behavior except where a shared error/resource helper must remain compatible.
- Any `start` command. If live closeout is reached, use only managed `routecodex restart --port 5555`.

## 3. Design principles

- Rust is the only owner for Hub Pipeline / Chat Process / servertool / continuation / provider error policy semantics.
- No fallback, no silent cleanup, no client/provider payload semantic trimming.
- Fix provider-bound request generation before provider send; do not hide errors in projection.
- Req04 owns request tool governance and local continuation restore.
- Resp03 owns response tool harvest/servertool governance; Resp04 owns continuation commit.
- Error path enters `V3Error01SourceRaised -> ... -> V3Error06ClientProjected`.
- Metadata/debug/error/provider health are side-channel resources, never normal payload.

## 4. Technical plan

1. Lock red tests before editing:
   - Tool call/output preservation when the bad tool is not RouteCodex-injected.
   - Malformed function arguments must not cause Req04 to delete the call/output pair.
   - Provider wire codec must either build legal provider request shape or fail-fast at the owning codec; no Req04 history deletion.
   - Continuation restore must fail if runtime or post-Req04 code attempts to merge context outside Req04.
   - Protocol Relay provider HTTP/transport/decode errors must reselect while candidates/default remain.
2. Remove or narrow `prune_malformed_shell_like_responses_history_at_req04`:
   - Delete generic shell/write_stdin deletion.
   - If internal stopless/servertool cleanup is still needed, require explicit RouteCodex-injected provenance and keep it transparent to client/provider normal payload.
   - Update or delete stale tests that expect silent deletion.
3. Centralize continuation restore:
   - Runtime may identify continuation IDs and build scoped lookup.
   - Actual `restore_at_req04`, validation, and merge must be inside Req04 owner or a Req04-owned helper.
   - Remove Anthropic runtime post-Req04 `merge_restored_local_context_at_req04`.
4. Unify provider failure policy:
   - Extract a shared Relay provider failure/reselect/health helper or make Anthropic/OpenAI/Gemini consume the existing Responses Relay semantics without duplicating policy.
   - Include provider HTTP, transport, JSON decode, SSE body/event codec errors.
   - Record provider success only after response governance/commit succeeds.
5. Collapse Anthropic response closeout duplication:
   - All Anthropic JSON/SSE branches should call one helper that performs Resp01/Compat/Resp02/Resp03/Resp04/Resp05/Resp06 and local continuation commit/release in the correct order.
6. Update verifiers only after runtime is fixed:
   - Do not weaken gates to pass.
   - Replace brittle occurrence counts only with stronger semantic checks if needed.
7. If source gates pass and live closeout is in scope:
   - Build/install globally.
   - Use `routecodex restart --port 5555` only.
   - Verify `routecodex --version`, install package version, `/health.version`, and binary hashes.
   - Replay old 5555 samples for tool continuity, continuation, provider error reselect, JSON/SSE parity.

## 5. Risks and guardrails

- Removing bad deletion can expose provider codec bugs; fix codec owner instead of reintroducing cleanup.
- Error reselect must not become fallback-as-success; if all pools are exhausted, project explicit Error06.
- Pinned/remote continuation must not reroute to another provider when owner contract forbids it.
- Do not mutate `~/.rcc` or `/Volumes/extension/.rcc` config to make tests pass.
- Do not claim live closure from static tests.

## 6. Verification plan

Source gates:
- `npm run verify:v3-hub-v1-node-file-topology`
- `npm run test:v3-relay-request-semantics`
- `npm run verify:v3-relay-request-semantics`
- `npm run test:v3-relay-request-semantics-red-fixtures`
- `npm run test:v3-relay-response-semantics`
- `npm run verify:v3-relay-response-semantics`
- `npm run test:v3-relay-response-semantics-red-fixtures`
- `npm run test:v3-hub-relay-runtime-closeout`
- `npm run verify:v3-hub-relay-runtime-closeout`
- `npm run test:v3-hub-relay-runtime-closeout-red-fixtures`
- `npm run test:v3-relay-tool-servertool-multiturn-parity-closeout`
- `npm run verify:v3-relay-tool-servertool-multiturn-parity-closeout`
- `npm run test:v3-relay-tool-servertool-multiturn-parity-closeout-red-fixtures`
- `npm run verify:v3-architecture-docs`
- `cargo fmt --manifest-path v3/Cargo.toml --all -- --check`
- `git diff --check`

Live closeout, only when source gates are clean:
- `npm run install:global`
- `routecodex restart --port 5555`
- `/health` and version/hash checks
- same-entry old-sample replay under `~/.rcc/codex-samples/openai-responses/ports/5555/`

## 7. Done definition

- P0 runtime gaps are fixed in source and tests.
- Static architecture/runtime gates are green.
- Old tests that asserted silent cleanup are deleted or rewritten to the new contract.
- If live closeout is performed, evidence includes installed V3 binary identity and old-sample replay; otherwise report source-only completion explicitly.
