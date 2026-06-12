# Uncommitted Code Audit And Modular Commit Plan

## Goal And Acceptance

Goal: audit the current uncommitted work by module, commit only modules that pass review and verification, and report blocking modules before touching their code.

Acceptance:
- Each commit contains one coherent owner-family/module slice only.
- No module with known blocker is modified or committed before the blocker report is delivered.
- Staged and unstaged state is checked before every commit.
- Every committed slice has explicit verification evidence.

## Scope

In scope:
- Current uncommitted changes in the RouteCodex worktree.
- Module-level review, targeted verification, precise staging, and commits for clean slices.
- Blocking report for failing or architecturally ambiguous slices.

Out of scope:
- Fixing code during the audit pass unless Jason explicitly authorizes after the blocker report.
- Reverting user/other-worker changes.
- Broad cleanup, bulk checkout, migration, release, or restart unless required by a verified clean slice and explicitly allowed by the normal project workflow.

## Design Principles

- Findings first: if a module has blockers, stop that module and report before edits.
- Commit only proven slices: no test evidence, no commit.
- Preserve dirty work: never stage unrelated files into a module commit.
- Respect RouteCodex guards: no fallback, no silent success, no direct passthrough relay changes without explicit architecture approval.
- Rust runtime remains the semantic truth for Hub Pipeline, Virtual Router, provider health, and servertool governance.

## Known Initial Blockers

These blockers were found before this plan:
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/forwarder.rs` is `MM`; staged index references `target_check` without staging the signature hunk.
- `cargo test -p router-hotpath-napi forwarder --lib -- --nocapture` fails in `forwarder_does_not_consume_unselected_persisted_cooldown_target` because the test describes `shadow.key1.gpt-test` while the fixture writes `cooldown.key1.gpt-test`.
- Provider health cooldown semantics conflict with project docs: current code disables persisted cooldown import/export while `AGENTS.md` still states `__http_503_daily_cooldown__` is persisted.
- Router same-protocol direct now relays client-tool requests through Hub Pipeline, which conflicts with the direct passthrough hard guard unless Jason confirms the new architecture direction.

## Module Audit Order

1. Worktree and index hygiene
   - Run `git status --short --branch --untracked-files=all`.
   - Split staged vs unstaged with `git diff --cached --name-status` and `git diff --name-status`.
   - Refuse to commit `MM` files until index and worktree state are intentional.

2. Virtual Router forwarder/selection
   - Review `forwarder.rs`, `engine/selection.rs`, forwarder tests, and function/verification map changes.
   - Required gates: Rust forwarder tests and relevant VR selection tests.

3. Provider health/cooldown
   - Review `health.rs`, `engine/events.rs`, startup health tests, docs/map updates.
   - Required gates: health tests, provider-startup-health tests, architecture map gates.
   - Must resolve persisted-cooldown baseline before commit.

4. Router direct / provider direct
   - Review `index.ts`, direct passthrough payload/route tests, direct contract error helpers.
   - Required gates: direct passthrough route/payload tests, error-pipeline contract tests.
   - Must resolve direct relay architecture conflict before commit.

5. Servertool/stopless CLI projection
   - Review servertool Rust crates, native wrappers, CLI tests, stop-message docs, servertool rust-only gate.
   - Required gates: focused servertool Jest, Rust servertool tests, `npm run verify:servertool-rust-only`.

6. Responses provider/runtime/SSE
   - Review Responses provider runtime, SSE error guard, response handler/store changes.
   - Required gates: focused provider/runtime tests and Responses handler blackbox tests.

7. Docs/version/build metadata
   - Commit docs only when tied to a verified module slice.
   - Commit generated version/build files only when the slice includes a verified build/install requirement.

## Verification Matrix

Minimum per committed module:
- `git diff --check`
- Targeted unit/regression tests for the module
- Relevant architecture/function-map gate when feature-map files changed
- Rust `cargo test` or TS `jest/tsc` matching touched owner
- Live/runtime smoke only for runtime-impacting slices after build/install/restart authorization

## Execution Steps

1. Produce blocker report for all currently known failing modules.
2. For each remaining candidate module, inspect diff and owner docs.
3. Run the module's targeted gates.
4. If clean, stage only that module's files and commit with a concise Conventional Commit message.
5. If any gate fails or architecture rule conflicts, stop that module and report. Do not fix.
6. Repeat until no clean candidate modules remain.

## Done Definition

- All clean modules are committed in separate module-scoped commits.
- All blocked modules have a concise report with file/line, evidence, verification command, and required decision/fix.
- Final status lists remaining dirty files and whether each is blocked, unreviewed, or intentionally left uncommitted.
