# HubPipeline Rust 化剩余 Phase 1/2 执行计划

**日期**: 2026-07-05
**状态**: closeout-auditing
**基于**: Jason 给定的目标 (pasted-text-1.txt), 初始审计 (57 nonNative files, 8481 LOC)
**目标**: Rust 化 Hub Pipeline 剩余的 TypeScript 语义变换模块

---

## 当前基线

| 维度 | 值 |
|------|-----|
| 非 Native TS 文件 | 57 |
| 非 Native LOC | 8,481 |
| 主线边 total | 86 |
| 主线边 anchored | 85 (98.8%) |
| 主线边 partial | 1 (1.2%, 非 Hub 域) |
| 主线边 pending | 0 |
| servertool | 完全 Rust-only |

## 2026-07-06 当前收口基线

| 维度 | 值 |
|------|-----|
| 最新 source/doc-only L1 | `prodTsFileCount=160`, `prodTsLocTotal=28969`, `nonNativeFileCount=36`, `nonNativeLocTotal=4747` |
| 当前 Hub/VR semantic watchlist | `0` open `ts_semantic_debt` |
| `conversion.responses.store` | `ts_io_shell_ok/native_plan_io_shell_ok` |
| Phase 1-C / 2-D / 2-E / 2-F | 已各自完成 L2 owner slice，降为 `native_shell_ok` / `type_shell_ok` |
| closeout-level code gates | `cargo test -p router-hotpath-napi --lib`, `verify:llmswitch-rustification-audit`, `verify:function-map-compile-gate`, `verify:architecture-mainline-call-map`, `verify:responses-history-protocol-contract`, `build:base`, `verify:architecture-ci` 全部 PASS |
| live/runtime closeout | `routecodex restart --port 5555` 后 `5555/5520 /health.version = 0.90.3596`；same-entry `/v1/responses` live replay 见 `/tmp/p0-rust-live-5555-after-restart.json` |

---

## Phase 1 (P0) — Anthropic 已闭合；剩余 2 个 P0 feature

### Phase 1-A: conversion.shared.anthropic (closed as native shells)

| 文件 | LOC | 语义命中 | 现有 Rust owner |
|------|-----|---------|---------------|
| `conversion/shared/anthropic-message-utils.ts` | thin barrel | 0 | `anthropic_openai_codec.rs` |
| `conversion/shared/anthropic-message-utils-core.ts` | thin export | 0 | 同上 |
| `conversion/shared/anthropic-message-utils-tool-schema.ts` | native shell | 0 | 同上 |

**闭合状态**:
- TS 三个 shared util 不再拥有 Anthropic protocol/tool schema 语义；只保留 re-export / native wrapper。
- Rust `anthropic_openai_codec.rs` 拥有 stable tool schema sanitize、image block ordering、OpenAI function `tool_choice` 到 Anthropic tool choice 映射，以及 malformed image fail-fast。
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` 已加 residue gate，阻止 `buildAnthropicToolAliasMap`、TS tool schema sanitizer、tool name normalization、text flattening 等语义复活。

**已跑验证栈**:
- `cargo test -p router-hotpath-napi anthropic_openai_codec --lib -- --nocapture`
- `cargo test -p router-hotpath-napi hub_protocol_spec_semantics --lib -- --nocapture`
- `npm run verify:anthropic-roundtrip`
- `npm run verify:hub-response-anthropic-native`
- `npm run verify:function-map-compile-gate`
- `npm run verify:llmswitch-core-tsc`
- `npm run verify:llmswitch-rustification-audit`
- `npm run build:base`

**剩余风险**:
- 本 slice 没有 live replay；`verify:anthropic-roundtrip` 当前提示 codex samples 缺失并跳过样本重放。

---

### Phase 1-B: conversion.responses.store (1,216 LOC)

| 文件 | LOC | 语义命中 | 现有 Rust owner |
|------|-----|---------|---------------|
| `conversion/shared/responses-conversation-store.ts` | 1,125 | 32 | `shared_responses_conversation_utils.rs` |
| `conversion/shared/responses-conversation-store-types.ts` | 91 | 0 (type only) | 可保持 TS |

**现有 Rust 覆盖**:
- `shared_responses_conversation_utils.rs` 已有完整 store 语义
- 48 个 Rust 单元测试
- `responses-continuation-store.spec.ts` 39 test cases

**剩余 TS 语义需迁移**:
- `responses-conversation-store.ts` — store/resume/continuation IO 逻辑。已有 `responses-conversation-store-native.ts` 薄壳

**验证栈**:
- `npm run verify:responses-history-protocol-contract`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `tests/sharedmodule/responses-continuation-store.spec.ts`

---

### Phase 1-C: conversion.bridge.action_parsing (689 LOC)

| 文件 | LOC | 语义命中 | 目标 Rust 文件 |
|------|-----|---------|---------------|
| `native/router-hotpath/native-hub-bridge-action-semantics-parsers.ts` | 411 | 32 | 新建 `hub_bridge_action_semantics.rs` |
| `native/router-hotpath/native-hub-bridge-action-semantics-types.ts` | 278 | 0 (type only) | 可保持 TS |

**说明**: `native-hub-bridge-action-semantics-parsers.ts` 包含 Anthropic/GLM/Gemini 等协议的 bridge action pipeline 解析 — 这是 `buildOpenAIChatFromAnthropic` 在 TS 调用链中的编排层。需新建 Rust 文件迁移后删除 TS。

**验证栈**: 复用 Phase 1-A 验证栈 + `npm run verify:function-map-compile-gate`

---

## Phase 2 (P1) — 3 个 feature_id, 7 文件, 1,060 LOC

### Phase 2-D: conversion.openai.control_text + tool_history (458 LOC)

| 文件 | LOC | 语义命中 | 目标 Rust 文件 |
|------|-----|---------|---------------|
| `conversion/shared/openai-message-normalize-control-text.ts` | 185 | 18 | 新建 `hub_openai_message_normalize.rs` |
| `conversion/shared/openai-message-normalize-tool-history.ts` | 238 | 7 | 同上 (合并) |
| `conversion/shared/openai-message-normalize-contract.ts` | 35 | 3 | 同上 (类型) |

### Phase 2-E: conversion.marker_lifecycle (220 LOC)

| 文件 | LOC | 语义命中 | 目标 Rust 文件 |
|------|-----|---------|---------------|
| `conversion/shared/marker-lifecycle.ts` | 220 | 23 | 新建 `hub_marker_lifecycle.rs` |

### Phase 2-F: conversion.responses.bridge + reasoning (382 LOC)

| 文件 | LOC | 语义命中 | 目标 Rust 文件 |
|------|-----|---------|---------------|
| `conversion/responses/responses-openai-bridge/utils.ts` | 244 | 14 | `shared_responses_conversation_utils.rs` |
| `conversion/shared/responses-reasoning-registry.ts` | 104 | 8 | 同上 |
| `conversion/responses/responses-openai-bridge/types.ts` | 34 | 0 (type only) | 可保持 TS |

---

## 完成标准

| 指标 | Phase 1 目标 | Phase 2 目标 |
|------|-------------|-------------|
| `verify:llmswitch-rustification-audit` | <=53 files / <=7,600 LOC | <=50 files / <=7,000 LOC |
| `verify:function-map-compile-gate` | PASS | PASS |
| `verify:architecture-mainline-call-map` | PASS | PASS |
| `npx tsc --noEmit` | PASS | PASS |
| `cargo test -p router-hotpath-napi --lib` | PASS | PASS |
| `node scripts/build-native-hotpath.mjs` | PASS | PASS |
| 旧 TS 语义文件 | 物理删除 | 物理删除 |
| 无 fallback 补偿 | 强制 | 强制 |

---

## 执行顺序

1. Phase 1-A (conversion.shared.anthropic) → closed; next commit records native-shell collapse
2. Phase 1-B (conversion.responses.store) → next target, commit: `feat(rustify): conversion.responses.store owned by rust`
3. Phase 1-C (conversion.bridge.action_parsing) → commit: `feat(rustify): conversion.bridge.action_parsing owned by rust`
4. Phase 2-D (conversion.openai.control_text + tool_history) → commit
5. Phase 2-E (conversion.marker_lifecycle) → commit
6. Phase 2-F (conversion.responses.bridge + reasoning) → commit

每步验证栈:
```
cargo test -p router-hotpath-napi
npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit
npm run verify:llmswitch-rustification-audit
npm run verify:function-map-compile-gate
npm run verify:architecture-mainline-call-map
node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs
cargo test -p router-hotpath-napi --lib
```

---

## 2026-07-05 追加：最终 closeout 执行补充

### 当前已闭合切片

`conversion.responses.store` 已经有以下 Rust-owned action plans，并已通过对应 Rust 白盒、native build、focused Jest、responses history contract、rustification audit、function-map 和 mainline gates：

- scope continuation match: `planResponsesScopeContinuationMatchJson`
- submit resume entry match: `planResponsesConversationResumeEntryMatchJson`
- lookup by response id projection: `planResponsesContinuationLookupByResponseIdJson`
- persistence eligibility: `planResponsesConversationPersistenceEligibilityJson`
- capture-time pending cleanup: `planResponsesCapturePendingCleanupJson`
- record-time completed cleanup: `planResponsesRecordScopeCleanupJson`
- record-time fallback scope entry match: `planResponsesRecordScopeEntryMatchJson`
- lifecycle sweep: `planResponsesStoreSweepJson`
- release request payload: `planResponsesReleaseRequestPayloadJson`
- attach-scope collision: `planResponsesAttachEntryScopesJson`

### Final Target

把 Hub Pipeline / Chat Process / Responses continuation / servertool followup 相关的剩余 TypeScript 语义全部收口为 Rust-owned plans。TS 只能保留以下角色：

- native binding facade
- unavoidable filesystem / Map / HTTP / process IO shell
- type-only declarations
- diagnostics and test-only harness

不得保留：

- continuation/session/scope/owner policy
- payload transformation or repair
- provider/client semantic projection
- fallback / compatibility branch / silent cleanup
- duplicated helper or old generic facade

### Scope

In scope:

- Continue `conversion.responses.store` until every remaining TS branch is classified as IO-only or moved to Rust.
- Then move to `conversion.bridge.action_parsing`, `conversion.openai.control_text + tool_history`, `conversion.marker_lifecycle`, and `conversion.responses.bridge + reasoning` in this order unless gate evidence shows a different P0 blocker.
- Keep `docs/architecture/function-map.yml`, `docs/architecture/verification-map.yml`, and mainline call map aligned whenever feature ownership changes.
- Physically delete dead TS semantics and stale native exports after repository search proves zero production consumers.

Out of scope without explicit Jason approval:

- Provider-specific behavior in Hub Pipeline or Virtual Router.
- Direct passthrough remap/fallback/shape repair.
- Live release/install/restart claims without managed `routecodex restart --port <port>` and real replay evidence.
- Broad cleanup of unrelated dirty files.

### Required Verification Matrix

Minimum per slice:

- Rust focused unit for the exact native plan.
- `npm run build:native-hotpath`
- `npm --prefix sharedmodule/llmswitch-core run build`
- focused Jest for affected TS shell.
- `npm run verify:responses-history-protocol-contract` when touching Responses continuation/store.
- `npm run verify:llmswitch-rustification-audit`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- touched-file `git diff --check`

Closeout-level verification:

- `cargo test -p router-hotpath-napi --lib -- --nocapture`
- `npm run build:base`
- `npm run verify:architecture-ci` if architecture docs/gates changed broadly.
- managed live install/restart/replay only when claiming runtime closure.

Known current blocker:

- Root `npx tsc --noEmit --pretty false` can fail on unrelated dirty files `src/server/runtime/http-server/http-server-runtime-setup.ts` and `src/server/runtime/http-server/index.ts` syntax breakage. Do not claim global TS closure until those are fixed or isolated. For `llmswitch-core` slices, `npm --prefix sharedmodule/llmswitch-core run build` is the local TS gate.

### Completion Definition

The final goal is complete only when:

- `conversion.responses.store` is either Rust-owned or explicitly documented as IO-only TS shell.
- Phase 1-C and Phase 2-D/E/F semantic residues are moved to Rust or deleted as dead code.
- `verify:llmswitch-rustification-audit` meets the active threshold in this plan or a newer recorded threshold.
- function-map, verification-map, mainline map, MEMORY, note, and relevant local skill lessons are updated.
- Required gates pass with exact command evidence.
- If runtime closure is claimed, managed live restart and real sample replay evidence are included.

## 2026-07-06 closeout audit update

The conditions above are now evidenced on the current worktree:

- `conversion.responses.store` is closed as `ts_io_shell_ok/native_plan_io_shell_ok` with residue gate evidence and no remaining continuation semantics in TS.
- Phase 1-C (`conversion.bridge.action_parsing`) and Phase 2-D/E/F semantic residues were moved to Rust/native shells and are recorded in `docs/loops/rustification/loop-run-log.md`.
- Fresh source/doc-only L1 records no open `ts_semantic_debt` in the Hub Pipeline / Virtual Router semantic watchlist.
- Closeout-level gates passed on the current state:
  - `cargo test -p router-hotpath-napi --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml --lib -- --nocapture`
  - `npm run verify:llmswitch-rustification-audit`
  - `npm run verify:function-map-compile-gate`
  - `npm run verify:architecture-mainline-call-map`
  - `npm run verify:responses-history-protocol-contract`
  - `npm run build:base`
  - `npm run verify:architecture-ci`
- Managed runtime closure was re-verified on the current installed runtime:
  - `routecodex restart --port 5555`
  - `http://127.0.0.1:5555/health` => `version=0.90.3596`
  - `http://127.0.0.1:5520/health` => `version=0.90.3596`
  - same-entry live `/v1/responses` replay via `scripts/tests/stopless-5555-live-probe.mjs` wrote `/tmp/p0-rust-live-5555-after-restart.json` with first-turn stopless `exec_command`, no leaked stop schema, and continuation completion.

Non-goal boundary still open:

- MemoryPalace re-mine/search closure is still blocked by an external palace lock and is not part of the Hub Pipeline rustification completion proof.

## 2026-07-05 correction: threshold is not completion

Current state is **not complete**. `verify:llmswitch-rustification-audit` reaching `47 files / 6999 LOC` is only a Phase 2 numeric gate and an L1 audit baseline. It does not prove complete Rustification.

The total goal remains open until every remaining non-native TypeScript file in the Hub Pipeline / Virtual Router / Chat Process / servertool followup scope is explicitly classified and evidenced as one of:

- `rust_ssot`: semantics are owned by Rust, with tests/gates proving the owner.
- `native_shell_ok`: TypeScript is only a fail-fast native binding facade or type shell, with residue gates blocking semantic revival.
- `ts_io_shell_ok`: TypeScript owns only unavoidable filesystem / Map / HTTP / process / diagnostics IO, with no semantic decisions.

Any remaining `ts_semantic_debt` means the overall rustification goal is still incomplete, regardless of LOC threshold.

Additional closeout requirements before any completion claim:

- Run a fresh L1 classification over the current `verify:llmswitch-rustification-audit` file list and record every remaining file classification in `docs/loops/rustification/loop-run-log.md`.
- Promote each `ts_semantic_debt` item through one owner-scoped L2 slice using `docs/loops/rustification/gate-matrix.md`.
- Keep server HTTP/IO in TypeScript only where it is IO shell. Server Rustification is required only if server code owns Hub/VR/Chat Process semantics.
- Closeout-level gates must pass after the final L2 slice, including full Rust `router-hotpath-napi --lib`, llmswitch-core build, function-map/mainline gates, rustification audit, and relevant protocol/history/servertool gates.
- Runtime completion requires managed install/restart plus same-entry real replay evidence. Without that evidence, only code/gate closure may be claimed.

## 2026-07-05 correction: source/doc-only search boundary

Rustification audit evidence must exclude generated artifacts and local indexes.
The current L1 process must:

- build candidate paths from `git ls-files`;
- include only source code, tests-as-code, scripts, architecture maps, loop docs,
  goal/design docs, and project skill docs;
- exclude `dist/`, `target/`, `coverage/`, `node_modules/`, `.mempalace/`,
  `.local-index/`, `mempalace/`, generated HTML, backups, snapshots, and
  generated reports even if they are tracked;
- not use MemoryPalace or generated audit output as evidence for current code
  state.

Fresh source/doc-only L1 evidence:

- `node scripts/ci/llmswitch-rustification-audit.mjs --json` PASS:
  `prodTsFileCount=165`, `prodTsLocTotal=29818`,
  `nonNativeFileCount=44`, `nonNativeLocTotal=5956`.
- `npm run verify:llmswitch-core-tsc` PASS.
- `git ls-files` plus generated denylist produced zero generated/local-index
  matches after filtering.

Current remaining closeout classes:

- `ts_semantic_debt`: compat profile registry
  (`header-policies.ts`, `policy-overrides.ts`, `provider-resolver.ts`,
  `registry.ts`, `types.ts`), `tools/exec-command/normalize.ts`,
  `native/router-hotpath/virtual-router-contracts.ts`,
  `runtime/virtual-router-hit-log.ts`.
- `native_plan_io_shell_candidate_needs_L2_closeout_evidence`:
  `conversion/shared/responses-conversation-store.ts`.
- `native_shell_ok` / `type_shell_ok` / `ts_io_shell_ok`: remaining type
  declarations, native parser facades, timing/diagnostic IO, user-data paths,
  progress-file IO, telemetry stats, servertool orchestration/types, and shared
  common utilities.

This means the overall goal is still open: every `ts_semantic_debt` item above
must be migrated to Rust/native truth or proven to be a pure IO/type/native shell
with gates before completion can be claimed.
