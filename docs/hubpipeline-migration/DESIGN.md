# HubPipeline TS→Rust 迁移 - 设计文档

## 状态：🔄 Phase 0 ✅ Phase 1 Slice 1 ✅

### Phase 1 Slice 1: resolveProtocolToken → Rust ✅
- 文件：`req_inbound_stage1_format_parse/index.ts`
- 变更：`resolveProtocolToken()`（15 行 TS）→ `resolveHubProviderProtocolWithNative()`
- 验证：unified-hub-shadow diff=0, stopless-goal-state 2/2, hub-rust-shadow 3/3, goal-regression 4/5
- 纯 TS 行迁移：15 行

| 阶段 | 状态 | 证据 |
|------|------|------|
| P0-1 apply_patch dist 残留删除 | ✅ | `rm dist/apply-patch-fixer.{js,d.ts}` |
| P0-2 consecutiveNoProgress ledger 修复 | ✅ | `stopless-goal-guard.ts` else 分支重置 counter |
| P0-3 dist/tools/apply-patch/validator.js | ✅ 无需操作 | src 源码存在，dist 引用无断裂 |
| P0-4 readStoplessGoalState | ✅ 无需操作 | 活跃代码，非死代码 |
| build:min | ✅ v0.90.1626 | tsc + cargo check + build:min |
| unified-hub-shadow | ✅ diff=0 | `npm run test:unified-hub-shadow` |
| stopless-goal-state tests | ✅ 2/2 passed | `jest:run tests/sharedmodule/stopless-goal-state.spec.ts` |
| goal regression tests | ✅ 4/5 passed | `jest:run tests/sharedmodule/goal-request-user-input-sample-regression.spec.ts` |
| Phase 1 Slice 0: Rust pipeline shadow | ✅ 3/3 passed | `tests/sharedmodule/hub-rust-pipeline-shadow.spec.ts` |

## Phase 1 量化分析

### pipeline stage blocks 覆盖率（43 个 native 调用 / 25 个文件 / 3043 行 TS）

| Stage | TS 行 | Native 调用 | 纯 TS 量 | 备注 |
|-------|-------|-------------|---------|------|
| resp_outbound client_remap protocol switch | 524 | 4 | ~484 | 最大纯 TS 文件 |
| req_inbound sse_decode | 373 | 2 | ~353 | |
| req_inbound format_parse | 333 | 5 | ~283 | Rust `parseReqInboundFormatEnvelopeWithNative` |
| req_inbound semantic_map | 320 | 2 | ~300 | |
| resp_process stage1 tool governance | 142 | 2 | ~122 | Rust `governResponseWithNative` ✅ 已接入 |
| req_process stage1 tool governance | 93 | 2 | ~73 | Rust `applyReqProcessToolGovernanceWithNative` ✅ 已接入 |
| req_outbound semantic_map | 169 | 0 | ~169 | 无 native 覆盖 ❌ |
| req_outbound stage3 compat | 66 | 4 | ~26 | 部分覆盖 |
| resp_outbound sse_stream | 73 | 2 | ~53 | 部分覆盖 |

### 已接入 Rust 的部分
- **Format adapters**（4 个）：`parseReqInboundFormatEnvelopeWithNative` ✅
- **Tool governance**（req/resp）：`governResponseWithNative` / `applyReqProcessToolGovernanceWithNative` ✅
- **Hub pipeline**：`normalizeHubEndpointWithNative` / `runHubPipelineOrchestrationWithNative` ✅（仅 metadata 增强）
- **Codecs**：OpenAI/Anthropic/Responses ✅

### Phase 1 真实工作：深化 pure-TS heavy hitters

按纯 TS 量排序的实际迁移目标：

| 优先级 | Stage | 纯 TS 估计 | 建议 |
|--------|-------|-----------|------|
| **P1** | `client-remap-protocol-switch.ts` | ~484 行 | 最大纯 TS，protocol remap 逻辑 |
| **P2** | `sse_decode` | ~353 行 | SSE 解析 |
| **P3** | `semantic_map` (req_inbound) | ~300 行 | 语义映射 |
| **P4** | `format_parse` (req_inbound) | ~283 行 | 格式解析（已有部分 native） |

## 下一步（需 Jason 决策）

**建议**：从 `client-remap-protocol-switch.ts` 开始（P1，最大纯 TS 量）

**流程**：
1. 确认该 stage 的 Rust 等价实现是否存在
2. 如果不存在：在 Rust 中实现 `run_resp_outbound_client_remap_pipeline`
3. 添加 NAPI 绑定
4. TS wrapper 调用 Rust → same-shape replay 对比
5. 物理删除对应 TS 代码
