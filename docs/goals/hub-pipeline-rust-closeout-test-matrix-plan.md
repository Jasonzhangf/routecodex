# Hub Pipeline Rust Closeout Test Matrix Plan

## 1. 目标与验收标准

### 目标
在 `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/`、`/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/` 与 `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/` 范围内，完成 Hub Pipeline Rust closeout：

- 先建立完整测试矩阵；
- 再把现存 TS 语义迁到 Rust；
- 测试通过后物理删除 TS 重复实现；
- 全程禁止 fallback；
- 最终只保留“公共函数库 + blocks + 纯编排壳层”的单一路径实现。

### 验收标准
只有同时满足以下条件才可宣称完成：

1. 每个能力块都有测试矩阵，且包含红测入口、绿测入口、回归入口。
2. Hub/chat-process/req_process/resp_process/servertool followup 的语义真源全部落在 Rust。
3. TS 不再承载 payload/message/tool_calls/history/sanitize/finalize/followup 的业务语义。
4. 不存在双实现：同一能力不再同时由 TS 与 Rust 承担语义职责。
5. 不存在 fallback/降级/补偿/静默修复路径。
6. TS 仅保留：
   - native 调用薄壳
   - 类型边界
   - JSON 编解码
   - 纯编排壳层（只调 blocks，不做语义决策）
7. 定向测试、构建、主链 smoke、残留审计全部通过。
8. `src/**` 下不存在会覆盖同名 `.ts` 的**活跃 `.js` shadow`**；若存在，则必须先进入 residue audit / deletion gate，不能继续作为隐形运行真源。

## 2. 范围与边界

### In Scope
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/process/**`
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/**`
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-*.ts`
- `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/**`
- `/Users/fanzhang/Documents/github/routecodex/tests/sharedmodule/**`
- hub rust residue 审计文档与 gate

### Out of Scope
- 不相关 provider feature
- 与本轮 Rust 收口无关的 UI/CLI 改动
- 纯 cosmetic 重构

## 3. 设计原则

1. **先测试矩阵，后实现**：没有矩阵与红测，不进入 Rust 改写。
2. **单一真源**：Rust 是唯一语义真源；TS 不能与其并存为第二真源。
3. **禁止 fallback**：出现不支持状态时 fail-fast，不许回退 TS、弱化校验或补偿构形。
4. **公共函数库 + blocks + 纯编排**：
   - 公共函数库：稳定纯函数、schema、canonicalize、normalize、parser helper
   - blocks：稳定数据块/语义块/操作块
   - 编排层：只推进流程与调用 blocks，不写业务判定
5. **先证明覆盖，再删除 TS**：必须先通过测试和 smoke，再做物理删除。
6. **删旧不留尸体**：已被 Rust 接管的 TS 语义文件/分支/辅助函数必须删除，不允许“闲置保留”。
7. **活跃 `.js` shadow 也算双实现**：若 `src/**` 下同名 `.js` 与 `.ts` 并存，且主链/测试会实际命中 `.js`，则该 `.js` 不属于“无害构建物”，而属于 active residue，必须纳入测试矩阵并最终移除或迁出运行路径。

## 4. 能力块拆分与测试矩阵

每个能力块都按统一矩阵执行：
- `Contract`：输入/输出 contract、形状与错误契约
- `Red`：当前缺口复现
- `Rust`：Rust 单测/模块测
- `Bridge`：TS native 壳层 contract
- `Flow`：Hub Pipeline 主链集成
- `Deletion Gate`：删除 TS 前的回归门禁

### P0 能力块

#### A. governance / sanitize / finalize / node-result
- TS 目标文件：
  - `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process.ts`
  - `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-governance-orchestration.ts`
  - `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-request-sanitizer.ts`
- Rust 真源：
  - `chat_governed_filter_payload.rs`
  - `chat_node_result_semantics.rs`
- 测试矩阵：
  - TS/Jest contract：governed request shape、sanitize shape、metadata merge、node-result metadata
  - Rust：payload filter、finalize、post-governed normalize、node-result
  - Flow：`execute-chat-process-entry` 与 `chat-process-roundtrip` 主链
  - 删除门禁：删除 TS 语义 helper 后 contract/flow 全绿
  - 2026-06-09 update: `chat_post_governed_normalization_semantics.rs` later proved zero-consumer native control surface and was physically deleted; do not restore `buildImageAttachmentMetadataJson`.

- 目标：
- 当前 TS residue：
  - `blocks/chat-process-request-sanitizer-runtime-bridge.ts`
- 必须固定的 Jest 门禁套件：
  - `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
  - `tests/servertool/chat-request-marker-strip.spec.ts`
    - 作用：覆盖 generic marker strip 与 routing marker 保留
  - `tests/sharedmodule/chat-process-request-sanitizer.spec.ts`
    - 作用：覆盖 assistant/tool history sanitize、generic marker 关联形状、sanitizer metadata
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
    - 作用：覆盖 req_process stage1 经过治理后的 apply_patch contract 不回退、不被 TS bridge 篡改
  - `tests/sharedmodule/hub-pipeline-execute-chat-process-entry.spec.ts`
    - 作用：覆盖主链 req_process 入口在去除 TS bridge 后仍能维持 chat-process entry contract
- 建议执行命令：
  - `npm run jest:run -- --runTestsByPath /Users/fanzhang/Documents/github/routecodex/tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts --runInBand --no-cache`
- 进入 Rust 前置条件：
  - residue audit 已准确红掉当前 stage 残留
  - 以上 green baseline 套件已在当前工作树通过
  - 删除目标已明确指向 Rust req_process shared functions + blocks，而不是 TS bridge 平移

- 当前状态：
  - 已完成从 disabled native export 到 active Rust truth 的接通；
  - 该切片的定向 contract + behavior 测试已通过。
  - 2026-06-08：`chat-process-node-result.ts` 已证明 runtime 函数无 live caller，并在 metadata type shape 内联后物理删除；node-result runtime owner 保持 Rust/native。
- 唯一真源文件：
  - `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
- 边界文件：
- 通过证据：
  - `cargo test -p router-hotpath-napi resolves_latest_hb_directive_with_camelcase_metadata --release`
  - `node /Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
- 注意：
  - 不代表整个 `req_process stage1` 已完成 Rust-only closeout。

#### B. servertool followup orchestration
- TS 目标文件：
  - `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-servertool-orchestration.ts`
- Rust 真源：
  - `chat_servertool_orchestration.rs`
- 测试矩阵：
  - Contract：followup plan、tool injection plan、stop/continue 条件
  - Rust：followup rebuild-from-origin、tool/runtime plan
  - Flow：servertool/stopless/followup re-entry
  - 删除门禁：TS 不再 build ops 语义，只透传 native plan

### P1 能力块

- TS 目标文件：
- Rust 真源：
- 测试矩阵：
  - Contract：directive parse、due reminder inject、time tag、tool schema append
  - Rust：各语义模块单测
  - 删除门禁：directive/reminder/tool schema 语义不再留在 TS

### P2 能力块

#### D. web-search / review / media / marker-strip / readiness
- TS 目标文件：
  - `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-review.ts`
  - `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-media.ts` 已于 2026-06-09 物理删除；media/image placeholder 语义不得通过 TS process helper 恢复。
- Rust 真源：
  - `chat_web_search_intent.rs`
  - `chat_web_search_tool_schema.rs`
  - `chat_process_media_semantics.rs`
  - `req_process_stage1_tool_governance_blocks/request_sanitizer.rs`
  - 其余若仍无 Rust 真源，则先补 Rust 公共函数库/blocks，再迁移
- 测试矩阵：
  - Contract：intent/schema/media normalization/readiness/marker behavior
  - Rust：对应语义单测
  - Flow：tool append、review inject、media shape 主链回归
  - 删除门禁：TS 不再保留文本/内容/工具语义改写

Phase 0 deletion note (2026-06-07): `chat-process-web-search.ts`、`chat-process-web-search-intent.ts`、`chat-process-web-search-tool-schema.ts`、`client-inject-readiness.ts`、`chat-process-governance-finalize.ts` 已证明无 live consumer 并物理删除；仍有 live consumer 的 native capabilities 保留在 Rust/native wrapper 真源中，后续证明无 consumer 的 public bridge 必须继续物理删除。

Phase 0 deletion note (2026-06-09): `chat_governance_context.rs`、`chat_governance_finalize.rs` 与对应 request-governance public bridge (`resolveGovernanceContext*` / `applyGoverned*` / `mergeGovernanceSummary*` / `finalizeGovernedRequest*`) 后续证明无 live consumer 并物理删除；请求治理语义保留在 active Rust Hub mainline / `req_process_stage1_tool_governance*` owners。

Phase 0 deletion note (2026-06-09): response-governance utility public bridges (`buildWebSearchToolAppendOperations*` / `prepareRespProcessToolGovernancePayload*` / `filterOutExecutedServerToolCalls*` / `resolveRequestedToolNames*`) 后续证明无 live TS/runtime consumer 并物理删除，旧 `servertool_skeleton/finalize_strip.rs` Rust bridge module 也已删除；live response path 保留 `governResponseJson` / `finalizeChatResponseJson` / apply_patch wrappers，web_search append operations 只作为 Rust-internal req-process helper。

Phase 0 deletion note (2026-06-09): servertool utility public bridges (`tryPlanChatServerToolBundleWithNative` / `resolveServertoolFollowupFlowProfileWithNative` / `runApplyPatchWithNative` / `webSearchResolveToolNameWithNative` / `webSearchParseToolArgumentsWithNative` / `webSearchFindArrayWithNative`) 和 standalone NAPI surfaces (`planChatServertoolOrchestrationBundleJson` / `resolveServertoolFollowupFlowProfileJson` / `webSearchFindArrayJson` / `runApplyPatchJson`) 后续证明无 live TS/runtime consumer 并物理删除；req-process servertool bundle planning 与 followup profile lookup 改为 Rust-internal helper 直连，apply_patch freeform contract 只保留 `normalizeApplyPatchArgumentsJson` / `validateApplyPatchArgumentsJson` owner。

Phase 0 deletion note (2026-06-09): VR bootstrap/stop-message follow-on public bridges (`bootstrapVirtualRouterRoutingJson` / `bootstrapVirtualRouterConfigMetaJson` / `applyStopMessageInstructionJson`) 证明无 live TS/runtime consumer 后从 required-export / NAPI public surface 删除；routing/meta bootstrap 与 stop-message action application 保留为 Rust-internal helper，由 total `bootstrapVirtualRouterConfigJson` 和 routing-instruction state owner 调用。

Phase 0 deletion note (2026-06-08): `chat-process-generic-marker-strip.ts` 已证明无 live consumer 并物理删除；generic marker strip / routing marker 保留判断由 Rust `request_sanitizer.rs` 主链拥有，并由 `tests/servertool/chat-request-marker-strip.spec.ts` 通过 Rust total HubPipeline 覆盖。

### Cross-cutting Stage Gate
- 审核所有 stage index：
  - `/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/**/index.ts`
- 测试矩阵：
  - stage entry contract
  - stage->native path assertion
  - residue audit：禁止 stage 直调非薄壳 TS 语义函数
  - source-shadow audit：禁止 critical `src/**` entrypoint 继续命中同名 `.js` shadow

## 5. 技术方案（公共函数库 + blocks + 纯编排）

### Rust 侧目录职责
1. **公共函数库（shared/pure）**
   - parser / canonicalizer / schema normalizer / marker extractor / carrier normalizer
   - 只能做纯函数与稳定 helper
2. **blocks**
   - governance block
   - sanitize/finalize block
   - servertool plan block
   - web-search/review/media block
   - 每个 block 有明确输入输出结构，不直接跨层乱改 payload
3. **编排层**
   - Hub Pipeline Rust orchestration 只负责串联 blocks
   - TS orchestration 只负责 native 调用、类型桥和错误外抛

### TS 侧允许的最终形态
- `parse input -> call native -> cast/validate output -> return`
- 禁止：
  - map/filter/rewrite messages
  - 注入/裁剪 tool_calls
  - followup 判定
  - sanitize/finalize 语义修补
  - fallback 分支

## 6. 实施步骤（顺序强制）

### Phase 0：冻结证据矩阵
1. 产出文件级 residue matrix。
2. 为每个能力块补齐：TS 文件、Rust 真源、主链入口、删除条件、验证命令。
3. 补 stage index 审计表，确认当前是否仍直调非薄壳 TS。

### Phase 1：先补测试矩阵
1. 每个能力块先补红测与 contract test。
2. 补 Rust 单测入口与 Jest flow 入口。
3. 补删除门禁测试：验证 TS 删除后主链仍绿。

### Phase 2：Rust 实现收口
1. 按 P0 -> P1 -> P2 顺序迁移。
2. 每个能力块只改唯一 Rust 真源。
3. TS 同步收缩成薄壳，不允许保留第二套语义。

### Phase 3：回归通过后物理删除 TS
1. 删除已被 Rust 接管的 TS helper / 分支 / 重复 schema logic。
2. 删除 dead code 与双实现测试残骸。
3. 更新 residue matrix 状态为 `deleted` 或 `thin-shell`。

### Phase 4：总体验证与 gate
1. 跑能力块定向测试。
2. 跑构建与安装态 smoke。
3. 跑 residue audit gate，禁止新 TS 语义回流。

## 7. 验证计划

### 最低验证集合
1. Jest contract / regression：
   - `/Users/fanzhang/Documents/github/routecodex/tests/sharedmodule/hub-pipeline-execute-chat-process-entry.spec.ts`
   - `/Users/fanzhang/Documents/github/routecodex/tests/sharedmodule/chat-process-roundtrip-integration.spec.ts`
   - `/Users/fanzhang/Documents/github/routecodex/tests/sharedmodule/chat-process-request-sanitizer.spec.ts`
   - `/Users/fanzhang/Documents/github/routecodex/tests/sharedmodule/hub-pipeline-chat-process-metadata-merge-contract.spec.ts`
   - servertool / stopless / followup 相关 tests
2. Rust tests：`cargo test -p router-hotpath-napi ...`
3. Build：至少 `npm run build:min`
4. 安装/真实入口 smoke：命中 Hub Pipeline 主链
5. Residue audit：grep/stage index 审计不得再命中非薄壳 TS 语义主链

### 每个能力块的完成证据
- 红测 -> 绿测
- Rust 单测通过
- TS 薄壳 contract 通过
- 旧 TS 物理删除后回归通过
- stage/index 调用链证据更新

## 8. 风险与规避

1. **风险：先迁移后补测试，导致假完成**
   - 规避：强制先矩阵后实现。
2. **风险：Rust/TS 双真源并存**
   - 规避：每迁一块，立即删旧 TS 语义。
3. **风险：用 fallback 掩盖语义缺口**
   - 规避：任何 unsupported state 直接 fail-fast。
4. **风险：TS 编排层继续偷写业务判定**
   - 规避：stage residue audit + 薄壳 contract gate。

## 9. 完成定义（DoD）

- 全部 in-scope 能力块已有测试矩阵。
- P0/P1/P2 全部完成 Rust 真源收口。
- 所有重复 TS 语义已物理删除。
- stage index 不再直调非薄壳 TS 语义函数。
- 不存在 fallback 路径。
- 代码结构符合“公共函数库 + blocks + 纯编排”。
- 测试、构建、smoke、residue audit 全通过。

## 10. 推荐执行顺序

1. P0 governance/sanitize/finalize/node-result
2. P0 servertool followup orchestration
4. P2 web-search/review/media/marker-strip/readiness
5. stage residue audit 收尾 + 全量删除门禁

## 11. 为什么这套顺序是当前唯一正确的

- 你的硬约束把顺序锁死了：必须先测试矩阵、再 Rust、最后删 TS，所以不能先写实现。
- “公共函数库 + blocks + 纯编排”要求先把语义拆到 Rust blocks，再允许 TS 退成壳；否则只能继续堆混合文件。
- “不能有 fallback”要求我们不能保留 TS 兜底分支作为过渡，因此每块迁移都必须以测试矩阵和删除门禁作为前置条件。
