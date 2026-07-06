# Hub Pipeline Zero TS Closeout Plan

## Goal

Drive the Hub Pipeline / chat process / provider response runtime surface toward zero TypeScript runtime semantics, with any remaining TypeScript limited to temporary, audited, machine-gated shells that have explicit deletion paths.

## Acceptance Criteria

- No `ts_semantic_debt` remains in the source/doc-only rustification audit.
- Every remaining production TypeScript file under the Hub Pipeline watchlist is either removed or classified in `docs/loops/rustification/minimal-ts-surface.json` with a concrete deletion blocker.
- Dead or unreferenced TypeScript files are physically deleted after dependency proof.
- Active semantic work is moved to Rust owners under `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`.
- Function map, mainline call map, verification map, rustification state, and lessons are updated in the same change set.
- Verification gates pass before any claim of closeout.

## Current Audit Snapshot

Observed from source/doc-only audit on 2026-07-07 after the latest type-shell closeout slices:

- `minimal-ts-surface.json` has 20 entries.
- Current audit metrics:
  - `prodTsFileCount`: 143
  - `prodTsLocTotal`: 28629
  - `nonNativeFileCount`: 19
  - `nonNativeLocTotal`: 3620
- Categories:
  - `type_shell_ok`: 5
  - `ts_io_shell_ok`: 6
  - `diagnostic_io_ok`: 7
  - `native_shell_ok`: 1
- Known high-value active surfaces:
  - `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
  - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
  - diagnostic timing modules under `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing*`
  - type-only shells and contracts that require Rust-generated `.d.ts` or ABI cleanup before deletion.

## Scope

In scope:

- Hub Pipeline request/response/chat-process runtime semantics.
- Provider response semantics and response continuation store semantics.
- Native parser facade collapse or generated binding replacement.
- Diagnostic IO and timing modules if they still carry runtime semantics beyond logging/timing.
- Type shell deletion once Rust-generated declarations or consumer replacements exist.
- Gate updates that prevent TS semantic resurrection.

Out of scope:

- Unrelated WebUI/config feature work unless it blocks build or rustification gates.
- Provider-specific runtime behavior outside the Hub Pipeline boundary.
- Broad cleanup of unrelated dirty worktree changes.
- Fallback, compatibility shims, or dual-path behavior used to hide missing Rust owners.

## Design Rules

- Rust is the semantic source of truth.
- TypeScript may only remain as IO, lifecycle, diagnostic, or generated type shell while a deletion blocker is documented.
- No fallback or parallel semantic implementation.
- No generated artifacts, `dist`, `target`, coverage, `.mempalace`, or local indexes as source-state evidence.
- Use `git ls-files` plus source/doc allowlist and generated denylist for file discovery.
- Prove dependency safety before deletion; delete dead code physically.
- Preserve other workers' dirty changes; stage only files touched for this goal.

## Implementation Steps

1. Establish a fresh source/doc-only baseline:
   - Run `node scripts/ci/llmswitch-rustification-audit.mjs --json`.
   - Compare result with `docs/loops/rustification/minimal-ts-surface.json`.
   - Use `git ls-files` to enumerate Hub Pipeline watchlist files and exclude generated directories.

2. Classify every remaining TS file:
   - Confirm whether it is type shell, IO shell, diagnostic IO, native/parser facade, or semantic debt.
   - For each non-deleted file, record owner, reason allowed, deletion blocker, and required gate.
   - Treat broad files such as `provider-response.ts` as suspect until source inspection proves they are only IO orchestration around Rust planners.

3. Delete dead or unreferenced files:
   - For each candidate, prove no source import or runtime loader reference.
   - Remove from manifests, baselines, exports, tests, and docs in the same commit.
   - Do not leave commented code or unused exports.

4. Rustify remaining semantic slices:
   - Move semantic decisions into `router-hotpath-napi`.
   - Add or extend NAPI exports only for Rust-owned plans, not TS fallback behavior.
   - Collapse TS callers to thin invocation shells or delete them when no longer needed.

5. Gate the boundary:
   - Update rustification audit baseline and `minimal-ts-surface.json`.
   - Add static checks for banned TS semantic files, deleted exports, and stale facade imports.
   - Ensure function map and mainline call map point to Rust owners for semantic nodes.

6. Verify and install:
   - Run focused unit/regression tests for touched slices.
   - Run `npm run verify:llmswitch-rustification-audit`.
   - Run `npm run verify:function-map-compile-gate`.
   - Run `npm run build:base` or stronger build gate required by the touched surface.
   - For runtime-impacting changes, run release/global install and live verification according to project rules.

7. Record and commit:
   - Update `docs/loops/rustification/STATE.md`, loop run log, `MEMORY.md` when a durable fact is proven, and local lessons only for reusable process changes.
   - Commit only relevant files with a concise message.

## Verification Matrix

- Static inventory:
  - `node scripts/ci/llmswitch-rustification-audit.mjs --json`
  - `npm run verify:llmswitch-rustification-audit`
  - minimal TS surface manifest verification if present in package scripts
- Architecture:
  - `npm run verify:function-map-compile-gate`
  - `npm run verify:architecture-mainline-call-map`
- Build:
  - `npm run build:native-hotpath`
  - `npm run build:base`
- Focused tests:
  - Provider response tests for provider-response slices.
  - Responses continuation store tests for store slices.
  - Hub pipeline stage residue audit tests for deleted/facade slices.
- Live:
  - Required only for runtime-impacting changes after global release install.

## Risks

- Current worktree is heavily dirty from other workers; use scoped diffs and scoped staging only.
- Some TS files are type/IO shells and cannot be safely deleted until ABI/type generation is ready.
- `provider-response.ts` and `responses-conversation-store.ts` may still be necessary Node IO shells even after semantic migration; deletion requires replacing IO/lifecycle ownership, not just moving pure logic.
- Passing an aggregate rustification audit is not proof of zero TS closeout.

## Definition of Done

- The current slice reduces or strictly locks the remaining TS surface.
- No new TS semantic owner is introduced.
- Dead files and stale exports are physically removed.
- Gates pass with source/doc-only evidence.
- Runtime-impacting changes are globally installed and live-verified.
- Commit is scoped and does not include unrelated dirty worktree changes.
