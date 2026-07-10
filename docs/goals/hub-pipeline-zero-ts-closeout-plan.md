# Hub Pipeline Zero TS Closeout Plan

## Goal

Drive the Hub Pipeline / chat process / provider response runtime surface to literal zero hand-written TypeScript under the Hub Pipeline watchlist by shrinking public references, build outputs, host IO call sites, and type imports until the remaining TS files can be physically deleted.

The current "thin shell" state is an intermediate checkpoint, not the final target. Pure Rust closeout means Hub Pipeline consumers call Rust/NAPI-owned contracts directly or consume generated declarations; no importable TS IO/type facade remains as the Hub owner.

## Acceptance Criteria

- No `ts_semantic_debt` remains in the source/doc-only rustification audit.
- Every remaining production TypeScript file under the Hub Pipeline watchlist is either removed or classified in `docs/loops/rustification/minimal-ts-surface.json` with a concrete deletion blocker and an active reference-shrink wave.
- Public package barrels, ambient declarations, required dist outputs, tests, and runtime bridges no longer import or require deleted Hub Pipeline TS files.
- Dead or unreferenced TypeScript files are physically deleted after dependency proof.
- Active semantic work is moved to Rust owners under `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`.
- Function map, mainline call map, verification map, rustification state, and lessons are updated in the same change set.
- Verification gates pass before any claim of closeout.

## Current Audit Snapshot

Observed from source/doc-only audit on 2026-07-08 after the latest zero-consumer type-shell deletion slice:

- `npm run verify:llmswitch-minimal-ts-surface -- --json`: PASS.
- `minimal-ts-surface.json` has 12 entries and now also gates public-barrel/type-shell shrink rules:
  - 9 current non-native production TS files.
  - 3 explicit native-linked TS shells.
- `sharedmodule/llmswitch-core/src/index.ts` no longer publicly exports `convertProviderResponse` or `telemetry/stats-center`; the minimal TS surface gate rejects their reintroduction and rejects runtime `export *` of `virtual-router-contracts`.
- `npm run verify:llmswitch-rustification-audit -- --json`: PASS.
- Current audit metrics:
- `prodTsFileCount`: 122
- `prodTsLocTotal`: 27304
  - `nonNativeFileCount`: 9
  - `nonNativeLocTotal`: 2427
- Categories:
  - `type_shell_ok`: 5
  - `ts_io_shell_ok`: 4
  - `diagnostic_io_ok`: 1
  - `native_shell_ok`: 2
- Current manifest entries:
  - `conversion/hub/response/provider-response.ts` (`ts_io_shell_ok`, native-linked)
  - `conversion/shared/responses-conversation-store.ts` (`ts_io_shell_ok`)
  - `conversion/hub/pipeline/hub-stage-timing.ts` (`diagnostic_io_ok`)
  - `conversion/hub/types/chat-envelope.ts` (`type_shell_ok`)
  - `conversion/hub/types/json.ts` (`type_shell_ok`)
  - `conversion/hub/types/standardized.ts` (`type_shell_ok`)
  - `native/router-hotpath/native-router-hotpath-policy.ts` (`native_shell_ok`)
  - `native/router-hotpath/virtual-router-contracts.ts` (`type_shell_ok`)
  - `runtime/user-data-paths.ts` (`ts_io_shell_ok`, native-linked; non-Hub runtime lifecycle wave)
  - `servertool/types.ts` (`type_shell_ok`)
  - `telemetry/stats-center.ts` (`ts_io_shell_ok`)
- Current hard reference locks:
- `sharedmodule/llmswitch-core/src/index.ts` still publicly exports native bootstrap/provider ingress/failure policy and type-only VR contracts; provider-response and stats-center root exports are removed and gated.
  - `src/types/llmswitch-core.d.ts` has been physically deleted after source import audit found no remaining `rcc-llmswitch-core/dist/...` ambient module consumers; residue gate blocks restoration.
  - `conversion/hub/pipeline/hub-pipeline-types.ts` has been physically deleted after source/test/script import audit found no runtime/source consumers; residue gate blocks restoration and re-export.
  - `scripts/lib/build-core-utils.mjs` still requires dist outputs for `conversion/hub/response/provider-response.js` and `conversion/shared/responses-conversation-store.js`.
  - `responses.continuation.mainline` edge `rct-06` is still `convertProviderResponse -> recordResponsesResponse`, so store deletion is blocked until the canonical save edge no longer names TS caller/callee.
  - `src/modules/llmswitch/bridge/response-converter.ts` loads `conversion/hub/response/provider-response` as the host response conversion bridge.
  - `src/modules/llmswitch/bridge/state-integrations.ts` loads `telemetry/stats-center` for hit-log/stats consumers.

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

3. Shrink reference owners before deleting implementation files:
   - Remove public barrel exports from `sharedmodule/llmswitch-core/src/index.ts` once no external runtime consumer needs the TS module.
   - Remove ambient declarations from `src/types/llmswitch-core.d.ts` only after consumers use native/generated declarations or local boundary types.
   - Update `scripts/lib/build-core-utils.mjs` so deleted TS modules are not required core dist outputs.
   - Move tests from TS module imports to native contract fixtures, server boundary tests, or generated declaration tests.
   - Add an import-graph gate that fails on new imports of the current deletion candidates outside their approved shrink wave.

4. Delete dead or unreferenced files:
   - For each candidate, prove no source import or runtime loader reference.
   - Remove from manifests, baselines, exports, tests, and docs in the same commit.
   - Do not leave commented code or unused exports.

5. Rustify remaining semantic slices:
   - Move semantic decisions into `router-hotpath-napi`.
   - Add or extend NAPI exports only for Rust-owned plans, not TS fallback behavior.
   - Collapse TS callers to thin invocation shells or delete them when no longer needed.

6. Gate the boundary:
   - Update rustification audit baseline and `minimal-ts-surface.json`.
   - Add static checks for banned TS semantic files, deleted exports, and stale facade imports.
   - Ensure function map and mainline call map point to Rust owners for semantic nodes.

7. Verify and install:
   - Run focused unit/regression tests for touched slices.
   - Run `npm run verify:llmswitch-rustification-audit`.
   - Run `npm run verify:function-map-compile-gate`.
   - Run `npm run build:base` or stronger build gate required by the touched surface.
   - For runtime-impacting changes, run release/global install and live verification according to project rules.

8. Record and commit:
   - Update `docs/loops/rustification/STATE.md`, loop run log, `MEMORY.md` when a durable fact is proven, and local lessons only for reusable process changes.
   - Commit only relevant files with a concise message.

## Reference-Shrink Waves

| Wave | Target | Current reference lock | Delete route | Required gates |
| ---: | --- | --- | --- | --- |
| 1 | Public API and dist surface | `src/index.ts`, `src/types/llmswitch-core.d.ts`, `scripts/lib/build-core-utils.mjs` still publish or require TS files. | Remove exports/declarations/required outputs after consumers move to native/generated contracts. This is the first blocker because public references keep TS files alive even after semantics are Rust-owned. | `npm run verify:llmswitch-minimal-ts-surface`; red import-graph gate for banned public exports; `npm run verify:llmswitch-core-tsc`; `npm run verify:function-map-compile-gate`. |
| 2 | Provider response IO facade | `src/modules/llmswitch/bridge/response-converter.ts` imports `conversion/hub/response/provider-response`; server executor calls the bridge. | Replace the TS facade with a Rust/NAPI response entry plus host-effect executor contract. Server code may own HTTP stream write/read, but Hub response parse/govern/project/save entry must not be a TS module export. | `npm run verify:hub-response-provider-sse-materialization`; provider response converter tests; JSON/SSE parity tests; `npm run verify:architecture-ci`. |
| 3 | Responses continuation store | `provider-response.ts` calls `responses-conversation-store.ts`; tests import the store directly; `rct-06` names TS caller/callee. | Move persistence API behind Rust-backed continuation store or server-owned persistence host effect. Update `rct-06` to Rust/native caller/callee, then delete direct store imports and dist requirement. | `npm run verify:responses-history-protocol-contract`; `npm run verify:architecture-mainline-call-map`; store integration tests converted to native/server boundary tests. |
| 4 | Type shells | Servertool, VR, Hub, and tests import `JsonObject`, `AdapterContext`, `Standardized*`, `ServerTool*`, and `VirtualRouter*` TS files. | Generate `.d.ts` from Rust contracts or localize minimal host boundary types outside Hub Pipeline. Delete shared TS type files only when no runtime/test import references them. | `npm run verify:llmswitch-core-tsc`; `npm run verify:servertool-rust-only`; `npm run verify:vr-no-ts-runtime`; import-graph gate banning old type shell imports. |
| 5 | Diagnostics and stats | `hub-stage-timing.ts` is imported by servertool response orchestration; `stats-center.ts` is exported publicly and loaded by `state-integrations.ts`. | Move stage timing and hit-log/stats emission to Rust event records or a server-owned diagnostic sink. Remove public stats export and state bridge require. | `npm run verify:architecture-custom-payload-carrier-owner-queryability`; `npm run verify:function-map-compile-gate`; focused hit-log/stage-timing tests. |
| 6 | Non-Hub runtime lifecycle | `runtime/user-data-paths.ts` is native-linked TS but feeds CLI/config/server lifecycle and is outside the first Hub closeout unit. | Split into a separate runtime lifecycle pure-Rust plan; do not count it as Hub Pipeline pure-Rust closed until its feature map owner and gates move to runtime lifecycle. | runtime lifecycle gates from `verification-map.yml`; `npm run verify:runtime-lifecycle-loop-gate-matrix`. |

## Current Consumer Map

Source/test/script import audit on 2026-07-07:

| TS file | Active import locks found | Closeout implication |
| --- | ---: | --- |
| `provider-response.ts` | 10 direct import/export locks plus bridge dynamic load | Cannot delete until `response-converter.ts` and public barrel stop loading it. |
| `responses-conversation-store.ts` | 7 direct import locks plus required dist output | Cannot delete until `rct-06` no longer calls the TS store and tests move to native/server boundary. |
| `hub-pipeline-types.ts` | 0 active source/test/script import locks; physically deleted | Keep deleted with residue gate; old generated declaration blocker was stale. |
| `hub-stage-timing.ts` | 4 direct import locks | Diagnostic owner must move before stage timing can disappear. |
| `chat-envelope.ts` | 24 direct import locks | Broad servertool/test type dependency; delete only after generated declarations or local test fixtures replace it. |
| `json.ts` | 36 direct import locks | Base type dependency; needs generated/common boundary replacement first. |
| `standardized.ts` | 13 direct import locks | VR/runtime/test type dependency; migrate with VR and request boundary types. |
| `native-router-hotpath-policy.ts` | 13 direct import locks | Failure policy facade must be replaced by generated/native declaration and host direct native call. |
| `virtual-router-contracts.ts` | 1 direct import lock in public barrel, plus internal type imports from native wrappers | Public export can be removed early; internal native wrapper types need generated declarations. |
| `user-data-paths.ts` | 4 direct import locks | Treat as runtime lifecycle wave, not Hub Pipeline first wave. |
| `servertool/types.ts` | 3 test import locks | Delete after tests consume Rust/generated servertool contracts. |
| `stats-center.ts` | 2 direct import locks | Delete after state integration no longer requires TS stats facade. |

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

## 2026-07-10 Addendum: Delete `responses-openai-bridge.ts`

### Goal And Acceptance

Physically delete `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts` by moving all remaining Responses bridge request/response semantics to Rust-owned NAPI exports and host native exports.

Acceptance criteria:

- `responses-openai-bridge.ts` is deleted from production source.
- No active source/test/script imports `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js` or `sharedmodule/llmswitch-core/dist/conversion/responses/responses-openai-bridge.js`.
- `node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json` shows no `responses-openai-bridge.ts` shell entry.
- Rust/native gates and focused Responses bridge parity tests pass.

### Current State

As of 2026-07-10 audit:

- `responses-openai-bridge.ts` has `prodImportRefs=0`.
- Remaining references are tests/scripts/docs only.
- Already migrated to native exports:
  - `scripts/tests/exec-command-loop.mjs`
  - `scripts/batch-toolcall-report.mjs`
  - `scripts/responses-sse-replay-golden.mjs`
  - `scripts/replay-responses-sse.mjs`
  - `tests/sharedmodule/responses-openai-bridge-metadata-boundary.spec.ts`
- Remaining hard blockers need request-bridge semantics:
  - `buildResponsesRequestFromChat`
  - `captureResponsesContext`
  - selected `buildChatRequestFromResponses` callers where context capture/continuation semantics are tested.

Important direction lock:

- Existing Rust `runResponsesOpenaiRequestCodecJson` / host `convertResponsesRequestToChatNative` is Responses request -> Chat request.
- It is not a replacement for `buildResponsesRequestFromChat`, which is Chat request -> Responses request.
- Do not reverse this direction to make tests pass.

### Scope

In scope:

- Add Rust-owned Chat request -> Responses request builder export.
- Add Rust-owned Responses context capture export if remaining tests/scripts need it.
- Add host native exports in `src/modules/llmswitch/bridge/native-exports.ts`.
- Migrate remaining scripts/tests to Rust/host native exports or test-only direct native helpers.
- Delete the TS bridge and update residue gates/maps.

Out of scope:

- Provider runtime behavior changes.
- Direct/relay routing policy changes.
- Responses continuation store redesign unless needed only to remove this bridge.
- Live server restart unless a runtime behavior path changes.

### Technical Plan

1. Rust export gap closure:
   - Implement or expose `buildResponsesRequestFromChatJson` in the Rust owner that already owns Responses/OpenAI codec semantics.
   - Implement or expose `captureResponsesContextJson` only if the remaining callers cannot be rewritten to an existing Rust context snapshot/export.
   - Add required NAPI export names to `native-router-hotpath-required-exports.ts` gates.

2. Host native export:
   - Add `buildResponsesRequestFromChatNative` and, if needed, `captureResponsesContextNative` to `src/modules/llmswitch/bridge/native-exports.ts`.
   - Keep host wrappers as JSON invocation/parse only; no TS semantic reconstruction.

3. External reference migration:
   - Low-risk first: `tests/sharedmodule/responses-bridge-closed-loop.ts` for payload/response projection.
   - Then migrate request-side users:
     - `scripts/outbound-regression-codex-samples.mjs`
     - `scripts/responses-sse-capture.mjs`
     - `scripts/tools/responses-provider-replay.mjs`
   - Then migrate parity/red tests:
     - `tests/red-tests/request_field_cross_protocol_equivalence_matrix.test.ts`
     - `tests/responses/responses-openai-bridge.spec.ts`
     - `tests/sharedmodule/responses-continuation-store.spec.ts`
     - `tests/server/handlers/handler-response-utils.responses-store-integration.spec.ts`

4. Delete and gate:
   - Delete `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`.
   - Update `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` and red tests to require the file absent.
   - Update `docs/architecture/function-map.yml`, `docs/architecture/verification-map.yml`, and `docs/architecture/mainline-call-map.yml` so request/response bridge owners point to Rust/host native exports, not the deleted TS bridge.

### Verification Plan

Minimum gates:

- `node scripts/ci/llmswitch-ts-shell-reference-audit.mjs --strict --json`
- `npm run verify:llmswitch-rustification-audit`
- `npm run verify:llmswitch-minimal-ts-surface`
- `npm run verify:llmswitch-core-tsc`
- `npm run verify:function-map-compile-gate`
- Focused Jest for migrated bridge tests/scripts.
- Rust tests for the new NAPI request builder/context capture exports.

Additional gates if touched paths require them:

- `npm run verify:servertool-rust-only`
- `npm run verify:architecture-fallback-denylist`
- `npm run build:base`

### Risks And Guardrails

- The bridge contains both request and response direction helpers; migrate by direction and do not mix `Responses -> Chat` with `Chat -> Responses`.
- Do not preserve the TS bridge as a hidden test helper under production source.
- Test-only direct native helpers must live under `tests/`, not `sharedmodule/llmswitch-core/src`.
- Do not stage unrelated dirty worktree files.
