# P0 Hub Stage Residue Matrix

## 目的

把 P0 主链当前仍留在 TS 的 stage/process residue 落成文件级证据，作为“先测试矩阵，后 Rust 收口”的起点。

## 审计范围

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage2_finalize.rs`

## 分类标准

- `thin-shell`：只做 native 调用、类型边界、JSON 编解码、recordStage。
- `native-primary with TS residue`：主语义已在 Rust，但 stage/shell 仍保留 TS 业务变换或判定。
- `TS-authoritative residue`：stage/index 仍直接依赖 process 语义模块或直接改写 payload/message/tool_calls。

## 当前矩阵

| 能力块 | 入口文件 | 当前证据 | 判定 | 现有测试 | 缺口 | Rust 收口目标 |
| --- | --- | --- | --- | --- | --- | --- |
| req_process governance + heartbeat + clock inject + sanitize | `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts` | L5 已调 native；但 L6-L8 仍直接引 `chat-process-heartbeat-directives.ts`、`blocks/chat-process-clock-runtime-bridge.ts`、`blocks/chat-process-request-sanitizer-runtime-bridge.ts`，且 L53/L69/L74 在 stage 内继续执行 heartbeat apply、clock runtime bridge、sanitizer runtime bridge。当前 runtime bridge 不只是边界：heartbeat 文件仍写 marker strip / daemon persistence，clock bridge 仍写 clientInjectReady / clear-directive / due inject / metadata build / reminder message build，sanitizer bridge 仍先做 generic marker strip 再补 metadata。按项目 Hard Guard，这一整段仍属 `TS-authoritative residue`。 | `TS-authoritative residue` | `tests/servertool/servertool-clock.spec.ts`、`tests/servertool/servertool-heartbeat.spec.ts`、`tests/servertool/servertool-mixed-tools.spec.ts`、`tests/sharedmodule/apply-patch-chat-process-contract.spec.ts` | 现有行为回归能证明功能可跑，但还不能证明：1) stage 不再命中 runtime bridge；2) 删除旧 TS bridge 后主链仍绿。已新增 residue audit 禁止项来先锁红当前残留。 | 将 heartbeat / reminder / sanitize 串联收口进 Rust `req_process_stage1_tool_governance` 对应 shared functions + blocks；TS stage 最终只保留 envelope 校验 + native 调用 + recordStage。 |
| hub chat-process entry orchestration | `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.ts` | 入口本身主要串联 blocks；L21 只调 `runReqProcessStage1ToolGovernance`。但该入口当前仍因下游 req_process stage residue 而未形成真正 Rust-only 主链。 | `native-primary with TS residue` | `tests/sharedmodule/hub-pipeline-execute-chat-process-entry.spec.ts`、`tests/sharedmodule/hub-pipeline-chat-process-metadata-merge-contract.spec.ts` | 缺少“主链不得再命中 process-level TS 语义”的 audit/red test。 | 待 req_process stage 收口后，入口维持 orchestration shell。 |
| resp_process stage1 tool governance | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs` + `resp_process_stage1_tool_governance_blocks/` | 旧 TS stage wrapper 已删除；当前入口经 Rust HubPipeline total entry 和 native bridge 调用 Rust response governance。旧 wrapper API 不得恢复为测试或 runtime 入口。 | `rust-owned` | `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`、`tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`、`sharedmodule/llmswitch-core/scripts/tests/apply-patch-native-regression-matrix.mjs`、`sharedmodule/llmswitch-core/scripts/tests/apply-patch-freeform-tool-schema-passthrough.mjs` | Rust 文件内部仍需按后续 control/data split 继续拆分，但不再通过 TS stage shell 承载语义。 | 继续在 Rust owner 内拆 control/data；TS 仅保留 native JSON/NAPI bridge 和 provider-response effect dispatch。 |
| resp_process stage2 finalize | `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage2_finalize/index.ts` | finalize 与 servertool strip 均走 native；`buildProcessedRequestFromChatResponse()` 也是 native wrapper。 | `thin-shell` | `tests/sharedmodule/chat-process-roundtrip-integration.spec.ts`、`tests/sharedmodule/responses-conversation-store.real-errorsample.spec.ts`、本目录 `__tests__/resp-process-stage2-finalize-native.test.ts` | 需后续 deletion gate 证明无隐藏 TS finalize residue。 | 维持 thin-shell。 |
| resp_process stage3 servertool orchestration | `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage3_servertool_orchestration/index.ts` | stage index 自身是一层壳，但转入 `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts` 后，仍保留 followup skip/support gating 等 TS 条件判定。 | `native-primary with TS residue` | `tests/servertool/resp-process-stage3-reentry.spec.ts`、相关 servertool stopless tests | 缺少 residue audit，把 shell 里的 stop/followup 判定逐项压到 Rust/native summary。 | 收口到 Rust servertool orchestration block；TS shell 仅做 providerInvoker/reenter dispatch。 |
| servertool clock / auto-hook active `.js` shadow chain | `sharedmodule/llmswitch-core/src/servertool/engine.ts` -> `server-side-tools.js` -> `handlers/clock.js` / `handlers/clock-auto.js` | 当前 `src/servertool/*.js` 在源目录内是**活的运行真源影子**：`engine.ts` 直接 import `./server-side-tools.js`，而 `server-side-tools.js` 又直接 import `./handlers/clock.js`、`./handlers/clock-auto.js`。这会导致同名 `.ts` 修改不一定命中实际运行路径，形成“TS 已改、行为未变”的双实现残留。 | `dual-source active residue` | `tests/servertool/servertool-clock.spec.ts`（行为回归）、`tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts`（新增红门禁） | 当前缺少“critical src entrypoint 不得继续命中同名 `.js` shadow”门禁；若不先锁这层，后续 Rust/TS closeout 会持续误判真实运行真源。 | 在删除/迁移前，先用 audit gate 把 active `.js` shadow 证据化；最终状态必须是不再通过 `src/*.js` sibling shadow 承载 P0 servertool 语义。 |

## 现阶段测试矩阵结论

### 已有覆盖

1. `req_process stage1`：
   - clock / heartbeat / marker strip / mixed tools / apply_patch contract 已有行为回归。
2. `resp_process stage1`：
   - responses/chat canonicalize、tool allowlist、real sample compare 已有行为回归。
3. `resp_process stage2/3`：
   - roundtrip、real sample、servertool reentry 已有行为回归。

### 当前缺口

1. **没有 stage residue red test**
   - 还没有测试直接锁定“stage index 不得继续依赖 process-level TS 语义模块 / 不得在 stage 内直接改 payload sidecar”。
2. **没有 deletion gate**
   - 现有测试证明行为可跑，但不能证明删掉旧 TS helper 后仍全绿。
3. **没有 P0 matrix 驱动的红绿顺序**
   - 现有测试更多是功能回归，不是为了 Rust closeout 设计的迁移门禁。

## 立即执行的第一批红测目标

1. `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
   - 红测一：`req_process_stage1_tool_governance/index.ts` 不得直接 import / call `chat-process-heartbeat-directives.ts`、`chat-process-clock-runtime-bridge.ts`、`chat-process-request-sanitizer-runtime-bridge.ts`
   - 红测二：已删除的 `resp_process_stage1_tool_governance/index.ts` 不得恢复；Rust owner 内禁止把 control sidecar 混入 data payload。

2. 后续 deletion gate（待 Rust 收口后补）
   - 删除 req_process stage 内 heartbeat / clock / sanitizer TS residue 后，原行为回归必须保持全绿。
   - resp_process stage1 当前以“已删除 stage shell 不得复活 + Rust owner control/data split”为后续门禁方向。
3. `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts`
   - 红测：P0 servertool clock path 不得继续通过 `src/servertool/*.js` sibling shadow 运行。
   - 目的：把 “活跃 `.js` 影子覆盖 `.ts` 改动” 正式纳入双实现 residue 审计，而不是只靠口头提醒。

## 为什么这份矩阵是当前唯一正确入口

1. 你的目标要求“先测试矩阵，再 Rust，再删 TS”；所以必须先把 **哪条 stage 还残留 TS 语义** 明文固化。
2. 当前主链最直接的违规点不是“Rust 文件是否存在”，而是 **stage/index 仍在运行哪些 TS 语义**。
3. 没有这张矩阵，后续只会继续做“功能看起来能跑”的测试，而不是 Rust closeout 真正需要的 red/deletion gate。
