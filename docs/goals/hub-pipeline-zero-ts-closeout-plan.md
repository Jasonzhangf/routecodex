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
   - Add required NAPI export names to `native-router-hotpath-loader.ts` gates.

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
     - bridge/Rust-owner continuation tests only; stale handler response-store assertions must not be used as continuation owner gates.

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

### 2026-07-10 Progress: Chat -> Responses script refs moved to Rust/native

- `buildResponsesRequestFromChatJson` is now the Rust/native owner for the remaining Chat -> Responses request-builder script surface needed by the first deletion wave.
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_outbound_format_build.rs` now covers the legacy bridge parity required by external scripts: `parameters` flattening, chat-parameter precedence for `tool_choice` / `parallel_tool_calls`, `toolCallIdStyle=fc|preserve`, bridge-history input merge, and oversized Responses input id compaction.
- These scripts now import root host `dist/modules/llmswitch/bridge/native-exports.js::buildResponsesRequestFromChatNative` instead of `sharedmodule/llmswitch-core/dist/conversion/responses/responses-openai-bridge.js`:
  - `sharedmodule/llmswitch-core/scripts/tests/responses-request-no-parameters-wrapper.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-create-parameters-single-source.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-tool-choice-single-source.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-tool-call-id-style-route-wins.mjs`
- Verification passed: focused Rust `hub_req_outbound_format_build::tests::test_build_responses_request_from_chat_json_*` 6/6, `npm run build:native-hotpath`, all four migrated scripts, strict shell reference audit (`prodTsShellCount=13`, `shellsWithProdImporters=11`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`), exact source-tracked ref scan, and `git diff --check`.
- Remaining active script blockers for deleting the bridge are Responses -> Chat / context-capture users:
  - `sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-context-snapshot-no-tool-control.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-local-image-path-autoload.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-overlong-function-name-regression.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-roundtrip.mjs`

### 2026-07-10 Progress: stale sharedmodule Responses bridge suite removed

- `sharedmodule/llmswitch-core/tests/responses/responses-openai-bridge.spec.ts` was a stale duplicate suite outside the root active Jest gate. After production `responses-openai-bridge.ts` and `openai-message-normalize.ts` were physically deleted, the suite either failed to load old deleted TS owners or asserted old TS compatibility/fallback contracts that contradict current Rust fail-fast behavior.
- The active coverage remains root `tests/responses/responses-openai-bridge.spec.ts`, `tests/sharedmodule/responses-openai-bridge-metadata-boundary.spec.ts`, and residue/deleted-path gates. These use `tests/sharedmodule/helpers/responses-openai-bridge-direct-native.ts` and Rust/NAPI helpers instead of production TS bridge shells.
- Test-only helper imports were corrected to point at test-only direct native helpers: `responses-openai-bridge-direct-native.ts` now imports `native-shared-conversion-direct-native.ts` and same-directory `resp-semantics-direct-native.ts`; `anthropic-response-direct-native.ts` now imports same-directory `resp-semantics-direct-native.ts`.
- `hub.req_inbound_responses_context_capture` is now marked as a file-scoped Rust owner in `function-map.yml`, so map coverage does not rely on a second helper comment pretending to define canonical builders.
- Verification passed: focused root Responses bridge + metadata + residue Jest 214/214, strict TS shell reference audit (`prodTsShellCount=12`, `shellsWithProdImporters=10`, `coreModuleSubpathRefs=3`), `npm run verify:llmswitch-minimal-ts-surface -- --json`, `npm run verify:llmswitch-rustification-audit -- --json` (`prodTsFileCount=12`, `nonNativeFileCount=0`), `npm run verify:function-map-compile-gate`, `npm run verify:architecture-deleted-path`, and `npm run verify:architecture-thin-wrapper-only`.

### 2026-07-10 Progress: context snapshot script ref moved to Rust/native

- `sharedmodule/llmswitch-core/scripts/tests/responses-context-snapshot-no-tool-control.mjs` now imports root host `dist/modules/llmswitch/bridge/native-exports.js::captureReqInboundResponsesContextSnapshotJson` instead of the old `responses-openai-bridge.js` dist path.
- Rust request-inbound context capture now strips host-only `metadata.extraFields` in `hub_req_inbound_context_capture.rs`, closing the previous TS bridge post-processing gap in the Rust owner.
- Verification passed: `cargo test -p router-hotpath-napi capture_responses_context_strips_host_only_metadata_extra_fields -- --nocapture` 1/1, `cargo test -p router-hotpath-napi capture_responses_context_ -- --nocapture` 3/3, `npm run build:native-hotpath`, `node --check sharedmodule/llmswitch-core/scripts/tests/responses-context-snapshot-no-tool-control.mjs`, `node sharedmodule/llmswitch-core/scripts/tests/responses-context-snapshot-no-tool-control.mjs`, strict shell reference audit (`prodTsShellCount=13`, `shellsWithProdImporters=11`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`), exact source-tracked ref scan, and scoped `git diff --check`.
- Remaining active script blockers for deleting the bridge are Responses -> Chat users:
  - `sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-local-image-path-autoload.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-overlong-function-name-regression.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-roundtrip.mjs`

### 2026-07-10 Progress: overlong function-name script ref moved to Rust/native

- `sharedmodule/llmswitch-core/scripts/tests/responses-overlong-function-name-regression.mjs` now imports root host `dist/modules/llmswitch/bridge/native-exports.js` and composes Rust/native `captureReqInboundResponsesContextSnapshotJson`, `convertResponsesRequestToChatNative`, and `buildResponsesRequestFromChatNative` instead of the old `responses-openai-bridge.js` dist path.
- The script still proves overlong Responses function calls are removed from captured context, Responses -> Chat messages, and Chat -> Responses roundtrip payload while valid `exec_command` calls survive.
- Verification passed: `node --check sharedmodule/llmswitch-core/scripts/tests/responses-overlong-function-name-regression.mjs`, `node sharedmodule/llmswitch-core/scripts/tests/responses-overlong-function-name-regression.mjs`, `cargo test -p router-hotpath-napi capture_responses_context_ -- --nocapture` 3/3, and `cargo test -p router-hotpath-napi hub_req_outbound_format_build::tests::test_build_responses_request_from_chat_json_ -- --nocapture` 6/6.
- Remaining active script blockers for deleting the bridge are:
  - `sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-local-image-path-autoload.mjs`

### 2026-07-10 Progress: local-image autoload script ref moved to Rust/native

- `sharedmodule/llmswitch-core/scripts/tests/responses-local-image-path-autoload.mjs` now imports root host `dist/modules/llmswitch/bridge/native-exports.js::convertResponsesRequestToChatNative` instead of the old `responses-openai-bridge.js` dist path.
- Existing Rust/native local image path autoload handles readable local images as `image_url` data URLs and unreadable path notices without script-side semantic repair.
- Verification passed: direct native local-image probe, `node --check sharedmodule/llmswitch-core/scripts/tests/responses-local-image-path-autoload.mjs`, `node sharedmodule/llmswitch-core/scripts/tests/responses-local-image-path-autoload.mjs`, and `cargo test -p router-hotpath-napi local_image -- --nocapture` 1/1.
- Remaining active script blocker for deleting the bridge:
  - `sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs`

### 2026-07-10 Progress: cross-protocol matrix script ref moved to Rust/native

- `sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs` now imports root host `dist/modules/llmswitch/bridge/native-exports.js` and uses Rust/native `buildResponsesRequestFromChatNative` plus `convertResponsesRequestToChatNative` for the Chat -> Responses -> Chat leg instead of the old `responses-openai-bridge.js` dist path.
- Source-tracked exact scan now shows no active script references to `responses-openai-bridge.js`; remaining references are goal/history docs and residue/deleted-path tests.
- Verification passed: `node --check sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs`; script execution preserved its existing no-sample behavior and skipped because `~/.routecodex/codex-samples/openai-chat` had no qualifying tool-call sample in this environment.
- Remaining deletion blockers are no longer script imports; next step is to audit active test/runtime/source imports for `responses-openai-bridge.ts` itself, then delete only after exact source/test/package scans prove no active consumer remains.
  - `sharedmodule/llmswitch-core/scripts/tests/responses-roundtrip.mjs`

### 2026-07-10 Progress: roundtrip script ref moved to Rust/native

- `sharedmodule/llmswitch-core/scripts/tests/responses-roundtrip.mjs` now imports root host `dist/modules/llmswitch/bridge/native-exports.js` and uses Rust/native `convertResponsesRequestToChatNative` plus `buildResponsesRequestFromChatNative` instead of the old `responses-openai-bridge.js` dist path.
- `buildResponsesRequestFromChatJson` now restores `instructions` from explicit Chat payload instructions first and `context.systemInstruction` second, closing the roundtrip parity gap in the Rust Chat -> Responses owner instead of script-side patching.
- Verification passed: direct native fixture probe 1/1, `node --check sharedmodule/llmswitch-core/scripts/tests/responses-roundtrip.mjs`, `node sharedmodule/llmswitch-core/scripts/tests/responses-roundtrip.mjs`, `cargo test -p router-hotpath-napi hub_req_outbound_format_build::tests::test_build_responses_request_from_chat_json_ -- --nocapture` 8/8, `cargo test -p router-hotpath-napi capture_responses_context_ -- --nocapture` 3/3, and `npm run build:native-hotpath`.
- Remaining active script blockers for deleting the bridge are:
  - `sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-local-image-path-autoload.mjs`

### 2026-07-10 Progress: response-payload freeform script ref moved to Rust/native

- `sharedmodule/llmswitch-core/scripts/tests/responses-freeform-tool-args.mjs` now imports root host `dist/modules/llmswitch/bridge/native-exports.js::buildResponsesPayloadFromChatNative` instead of the old `responses-openai-bridge.js` dist path.
- Rust freeform tool format recognition now treats `format: "freeform"` the same as grammar/text freeform declarations in `hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`; the client-facing contract remains Rust-owned `custom_tool_call.input` plus raw patch in `required_action`.
- Verification passed: `cargo test -p router-hotpath-napi freeform_apply_patch -- --nocapture` 3/3, `npm run build:native-hotpath`, `node sharedmodule/llmswitch-core/scripts/tests/responses-freeform-tool-args.mjs`, strict shell reference audit (`prodTsShellCount=13`, `shellsWithProdImporters=11`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`), exact source-tracked ref scan, and `git diff --check`.
- Remaining active script blockers for deleting the bridge are Responses -> Chat / context-capture users:
  - `sharedmodule/llmswitch-core/scripts/tests/cross-protocol-matrix.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-context-snapshot-no-tool-control.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-local-image-path-autoload.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-overlong-function-name-regression.mjs`
  - `sharedmodule/llmswitch-core/scripts/tests/responses-roundtrip.mjs`

### 2026-07-10 Progress: router hotpath analysis wrapper retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-analysis.ts` is physically deleted after exact source scan showed no active production consumer beyond `native-router-hotpath.ts`.
- The remaining native-call/JSON parse/fail-fast glue for pending tool sync, continue execution injection, chat media analysis/strip, and web-search intent is now local to `native-router-hotpath.ts`; this removes one production TS shell without adding a JS/TS semantic fallback.
- `tests/sharedmodule/helpers/native-shared-conversion-direct-native.ts` now owns its test-only media strip parser locally, and parser observability now verifies invalid native JSON is logged before fail-fast through public native wrapper calls instead of importing the deleted parser directly.
- The residue gate now locks `native-router-hotpath-analysis.ts` absent and distinguishes generic parser observability warnings from forbidden tool-args repair fallback warnings.
- Verification passed: focused Jest `native-semantics-parsers-observability.spec.ts` + `hub-pipeline-stage-residue-audit.spec.ts` 219/219, exact source scan for the retired path, strict shell reference audit (`prodTsShellCount=11`, `shellsWithProdImporters=9`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`), `npm run verify:llmswitch-core-tsc`, `npm run verify:llmswitch-minimal-ts-surface -- --json`, `npm run verify:llmswitch-rustification-audit -- --json` (`prodTsFileCount=11`, `nonNativeFileCount=0`), `npm run verify:function-map-compile-gate`, `npm run verify:architecture-deleted-path`, `npm run verify:architecture-thin-wrapper-only`, `npm run build:base`, and `git diff --check`.
- Remaining work: continue from the strict audit graph. Do not delete `native-hub-pipeline-req-inbound-semantics.ts` solely because it has `prodImportRefs=0`; it still participates in function-map/mainline/test ownership until those references are explicitly moved.

### 2026-07-10 Progress: root public barrel runtime shell exports removed

- `sharedmodule/llmswitch-core/src/index.ts` no longer runtime re-exports `native-virtual-router-bootstrap-config.ts`, `native-provider-runtime-ingress.ts`, or `native-router-hotpath-loader.ts`; the root package entry is now metadata/type-only (`VERSION` plus `export type *` for VR contracts).
- Source scan found no active runtime source consumer importing `bootstrapVirtualRouterConfig` or other native facade runtime values from root `rcc-llmswitch-core`; the only root example in `src/modules/README.md` was updated to the explicit native subpath.
- `verify-llmswitch-minimal-ts-surface.mjs` now forbids those root runtime shell exports from being restored. `llmswitch-rustification-audit.mjs` and the minimal surface gate classify the root entry as non-semantic only when it contains type-only exports plus `VERSION`, avoiding fake native markers while preventing non-native debt growth.
- Verification passed: `npm run verify:llmswitch-minimal-ts-surface -- --json`, `npm run verify:llmswitch-rustification-audit -- --json` (`prodTsFileCount=11`, `nonNativeFileCount=0`), strict shell reference audit (`prodTsShellCount=11`, `shellsWithProdImporters=7`, `shellsWithHostTextRefs=1`, `coreModuleSubpathRefs=3`), focused residue Jest 203/203, `npm run verify:llmswitch-core-tsc`, `npm run verify:function-map-compile-gate`, `npm run verify:architecture-deleted-path`, `npm run verify:architecture-thin-wrapper-only`, `npm run build:base`, and `git diff --check`.
- Remaining work: `native-provider-runtime-ingress.ts` and `native-virtual-router-bootstrap-config.ts` now have `prodImportRefs=0` but still have active root tests/docs and owner roles. Deletion requires exact test/owner migration first, not immediate file removal.

### 2026-07-10 Progress: provider runtime ingress TS wrapper retired

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-provider-runtime-ingress.ts` is physically deleted after strict shell audit and exact source scan showed no production importer.
- Tests now call Rust/NAPI provider runtime ingress through host `src/modules/llmswitch/bridge/native-exports.js::getRouterHotpathJsonBindingSync`; `tests/sharedmodule/routing-state-store-observability.spec.ts` imports only the local host type declaration.
- `error.mainline` edge `err-03` and `error.err_04_router_policy_applied` now point at Rust owner symbols `report_provider_error_to_router_policy_json_bridge -> report_provider_error`; no-fallback allowlist no longer allows the retired TS shell.
- Residue audit locks the deleted wrapper absent, and root public barrel gate already prevents re-exporting it from `sharedmodule/llmswitch-core/src/index.ts`.
- Verification passed so far: focused Jest `provider-runtime-ingress.spec.ts`, `routing-state-store-observability.spec.ts`, `error-pipeline-contract.spec.ts`, and `hub-pipeline-stage-residue-audit.spec.ts` 219/219; exact source scan shows only docs/history/residue references; strict shell reference audit reports `prodTsShellCount=10`; `npm run verify:function-map-compile-gate`; `npm run verify:architecture-mainline-call-map`; scoped `git diff --check`.
- Remaining work: continue the strict audit graph. `native-virtual-router-bootstrap-config.ts` has no production importer but still has root tests/docs and owner roles, so it requires the same exact test/owner migration before deletion.

### 2026-07-10 Progress: Responses store direct continuation NAPI wrappers retired

- Removed required native export surface for `resumeResponsesConversationPayloadJson`, `restoreResponsesContinuationPayloadJson`, and `materializeResponsesContinuationPayloadJson`; production and tests now use `executeResponsesConversationStoreOperationJson` for the host-facing store operation API.
- Added Rust store operation `resume_entry_payload` to keep the old direct resume error-envelope regression covered without exposing a standalone NAPI wrapper.
- Removed the matching test-only helper wrappers from `tests/sharedmodule/helpers/native-shared-conversion-direct-native.ts`.
- Verification passed: exact source scan shows the retired wrapper names only in historical notes and negative assertions; focused Jest `native-required-exports-sse-stream`, `hub-pipeline-stage-residue-audit`, and `responses-continuation-store` passed 263/263; `npm run build:native-hotpath`, `npm run verify:responses-history-protocol-contract`, `npm run verify:function-map-compile-gate`, `npm run verify:architecture-mainline-call-map`, strict shell reference audit, minimal TS surface audit, rustification audit, deleted-path/thin-wrapper/fallback-denylist gates, `npm run build:base`, and `git diff --check` passed.

### 2026-07-10 Progress: Responses store host d.ts mirror deleted

- Exact source-tracked scan found `src/modules/llmswitch/bridge/responses-conversation-store-host.d.ts` had no active runtime/test importers; the only remaining reference is the residue gate negative path.
- Physically deleted the stale `.d.ts` mirror and changed `hub-pipeline-stage-residue-audit` to assert it stays absent; canonical source remains `responses-conversation-store-host.ts`, and the still-active runtime `.js` mirror remains until its runtime importers are migrated.

### 2026-07-10 Progress: zero-ref bridge d.ts leaf mirrors deleted

- Exact source-tracked scan found these bridge declaration mirrors had no active runtime/test importers outside residue coverage:
  - `bridge.d.ts`
  - `bridge/index.d.ts`
  - `module-loader.d.ts`
  - `native-exports.d.ts`
  - `provider-response-converter-host.d.ts`
  - `response-converter.d.ts`
  - `responses-request-bridge.d.ts`
  - `responses-response-bridge.d.ts`
  - `runtime-integrations.d.ts`
  - `snapshot-recorder-runtime.d.ts`
  - `snapshot-recorder-tool-failures.d.ts`
  - `snapshot-recorder-types.d.ts`
  - `snapshot-recorder.d.ts`
  - `state-integrations.d.ts`
- Physically deleted the mirrors and added one residue gate asserting they all stay absent. Canonical `.ts` sources and still-active `.js` runtime mirrors remain in place until their external importers are migrated.

### 2026-07-10 In Progress: virtual router bootstrap TS wrapper deletion

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-bootstrap-config.ts` has been removed in the working tree after exact source scan showed the runtime mainline already uses host `src/modules/llmswitch/bridge/routing-integrations.ts::bootstrapVirtualRouterConfig`.
- Root/servertool/sharedmodule tests that previously imported the production wrapper now use test-only direct native helper `tests/sharedmodule/helpers/virtual-router-bootstrap-direct-native.ts`, which calls Rust/NAPI `bootstrapVirtualRouterConfigJson` through host native binding.
- `src/modules/README.md` now documents the host bridge import path instead of the deleted llmswitch-core native subpath, and residue audit locks the production wrapper absent.
- Verification passed so far: exact source scan shows no active old wrapper import; strict shell reference audit reports `prodTsShellCount=9`; `npm run verify:llmswitch-core-tsc`.
- Not closed: the broad migrated VR/bootstrap Jest slice still fails. Failures include existing metadataCenterSnapshot/sessionId requirements in direct `VirtualRouterEngine.route` tests, missing `config/providers/ali-coding-plan.json` fixture, and bootstrap-result projection assertions that need to be moved to the host bridge contract. Do not commit this slice until those tests are either migrated to the correct host boundary or split into verified focused gates.
