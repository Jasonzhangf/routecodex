# REQ02 public consumer black-box result

Status: `TEST PREPARED / DEPENDENCY RED`.

## Scope and artifacts

- Worktree: `/Volumes/Intel/playground/routecodex/dagpipe-req02-blackbox-20261002`
- Base SHA: `3a72ad81320b1c435b08c0d99343c7c22efa5197`
- Test source: `v3/crates/routecodex-v3-server/tests/req02_public_normalization.rs`
- Test source SHA-256: `0ee5f1c593821812eb4ffad9ac357147d2ba27794b265b05c2a5b58f777be329`
- Candidate dependency read-only source:
  `/Volumes/Intel/playground/routecodex/dagpipe-req02-resources-20261003`
- Candidate `operation_runner/mod.rs` SHA-256:
  `2694d90f655083996d2f72fb3c30546f66c2c9d17d247c502e7a10a85fab1686`
- Candidate `request_context_store.rs` SHA-256:
  `bd30031dbdef38e1fa3a95f610f05bad215061ee62ded6ffc55ddfe78bf26c35`

Only the permitted test source and this result document were written.

## Public consumer coverage

The external `routecodex-v3-server` integration test calls the public capture
entry followed by the public normalize entry. It does not call the internal
normalizer, inspect private state, use source text as behavior evidence, or use
a mock.

The five cases cover:

1. Responses function/custom declarations, a complete long exec JSON string,
   multiline apply_patch input, MCP JSON arguments and matching call/output
   history, typed declaration/history identity, unknown top-level/nested fields,
   and client carrier conflicts.
2. OpenAI Chat messages, tool_calls, tool result, function schema, complete long
   command arguments, and unknown fields.
3. Anthropic tool_use/tool_result input and result pairing, call-id pairing,
   cache_control, and unknown siblings.
4. Gemini inline_data/mime_type canonical values and presence, missing mime not
   invented, opaque unknown/unrepresentable media and part siblings, current-turn
   image value, and functionCall/functionResponse declarations/history.
5. Same-handle retry/followup with AlreadyCanonical, unchanged canonical and
   original pair, request isolation, clone non-finalization, one finalizer guard,
   released public access, and exact internal invalid origin/scope failures.

## Real command receipt

Command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_public_normalization -- --nocapture
```

Observed exit code: `101`.

Decision: `DEPENDENCY RED`. The current worktree has only the base runtime API.
Compilation failed because the required public REQ02 dependency symbols are not
present in this worktree:

```text
error[E0432]: unresolved imports `routecodex_v3_runtime::operation_runner::execute_v3_operation_runner_request_normalize_losslessly`, `routecodex_v3_runtime::operation_runner::HistoryPairingReference`, `routecodex_v3_runtime::operation_runner::RequestInvocationContext`, `routecodex_v3_runtime::operation_runner::RequestNormalizationEntry`, `routecodex_v3_runtime::operation_runner::RequestOriginKind`, `routecodex_v3_runtime::operation_runner::RequestScopedContextPair`, `routecodex_v3_runtime::operation_runner::ToolDeclarationReference`, `routecodex_v3_runtime::operation_runner::V3RequestContextHandle`
```

The failure is a missing-public-dependency failure, not a behavioral PASS. No
fallback, dependency modification, product edit, or skipped case was added.

## Targeted check

Command:

```text
git diff --check
```

Observed exit code: `0` (no output).

## Parent combination rerun

This does not claim behavior acceptance. After the parent combines the exact
candidate dependency into this worktree, rerun the same command unchanged:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_public_normalization -- --nocapture
```

Behavior acceptance is `PASS` only when all five public-consumer cases execute
and pass, with the candidate tree/profile/hash recorded. The test currently
proves only that the external public-consumer source is prepared and that the
base worktree lacks the required dependency surface.

No commit, merge, push, install, restart, or global configuration change was
performed.
