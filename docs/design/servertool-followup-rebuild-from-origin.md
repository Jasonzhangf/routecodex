# Servertool Followup 重构计划（Origin Rebuild 模式）

## 索引概要
- L1-L9 `objective`：重构目标与非目标。
- L11-L28 `remove-keep`：要去除与要保留项。
- L30-L52 `design`：新设计与失败策略。
- L54-L66 `phases`：分阶段实施。
- L68-L116 `test-plan`：详细测试计划（单测/集成/回归/灰度）。
- L118-L161 `cleanup-plan`：详细清理计划（文件级删除与验收）。
- L163-L169 `done-criteria`：迁移完成判定。

## 目标 / 非目标
- 目标：将 servertool followup 从“chat-process followup payload 注入模式”迁移为“origin request 重建 + 正常请求重入模式”。
- 目标：followup 请求必须与正常请求同构，不再依赖 `capturedChatSeed` / `followupInjectionOps` / `message-trimmer`。
- 非目标：本次不改 provider transport 协议；不引入 fallback 双路径长期共存。
- 非目标：不改变 servertool handler 业务语义（仅改变 followup 触发与重入方式）。

## 目标
- followup 不再基于 `capturedChatSeed` / chat-process 注入 payload。
- followup 必须是“一个正常请求”：从上一次请求来源（origin request）重建，并重新进入完整 hub pipeline。

## 要去除
1. Rust: `chat_servertool_orchestration.rs` 中 `build_servertool_generic_followup_payload*` 能力与注入 op 构造。
2. TS: `servertool/handlers/followup-request-builder/*`（seed/chat-block/op-block/message-block/native-block）以及 `followup-message-trimmer.ts`。
3. TS: `reenter-followup-block.ts` 中依赖 followup payload 注入策略的分支。
4. TS/Rust: `resp_process stage3 servertool orchestration` 中 followup payload 计划字段（`followupInjectionOps*`、generic followup 路径）。

## 要保留
- Rust `planServertoolFollowupRuntimeWithNative` 的“是否需要 followup”决策。
- servertool handler 的执行结果协议（成功/失败/client inject only）。

## 新设计
### A. Origin Request Snapshot（新增）
在 `req_inbound` 结束后保存 origin request snapshot（session scope 维度）：
- model/messages/tools/parameters/entryEndpoint
- providerProtocol
- requestId/sessionScope

建议落点：
- Rust 真源：`hub_req_inbound_context_capture.rs` 新增 snapshot 输出字段
- TS runtime store：新增 `servertool/origin-request-store.ts` 持久化文件（tmux scope）

### B. Followup 触发协议（修改）
servertool orchestration 只返回：
- `needsFollowup: boolean`
- `followupReason: string`
- `flowId`
不再返回 followup payload。

### C. Followup 执行入口（新增）
新增 `servertool/origin-followup-reenter.ts`：
1) load origin snapshot by session scope
2) 组装 metadata（标记 `serverToolFollowup=true`、`followupFlowId`）
3) 直接调用 `reenterPipeline({ body: originSnapshotPayload })`

### D. 失败策略
- origin snapshot 缺失：显式 `SERVERTOOL_FOLLOWUP_ORIGIN_MISSING`（fail-fast）
- followup 重入失败：沿用现有 `SERVERTOOL_FOLLOWUP_FAILED`，但移除 payload-injection/trimmer 相关 reason

## 分阶段实施
1. Phase-1（安全切换）
   - 保留旧路径，新增 origin 路径 behind flag: `ROUTECODEX_SERVERTOOL_FOLLOWUP_ORIGIN_ONLY=1`
2. Phase-2（双跑对比）
   - 比对 old/new followup 是否同样触发工具执行；记录差异
3. Phase-3（删旧）
   - 删除 followup-request-builder 全家桶与 trimmer
   - 删除 Rust generic followup payload 构造

## 详细测试计划

### A. 单元测试（必须新增）

1) Origin Snapshot Store
- 文件建议：`sharedmodule/llmswitch-core/tests/servertool/origin-request-store.spec.ts`
- 用例：
  - `saveOriginSnapshot()` 正常写入（含 model/messages/tools/parameters/entryEndpoint/sessionScope）
  - `loadOriginSnapshot()` 正常读取
  - snapshot 过期策略（若设计 TTL）
  - 非 tmux scope 拒绝保存（fail-fast）

2) Followup 触发协议
- 文件建议：`sharedmodule/llmswitch-core/tests/servertool/followup-trigger-policy.spec.ts`
- 用例：
  - servertool orchestration 输出仅包含 `needsFollowup/followupReason/flowId`
  - 不再输出 `followupInjectionOps/followupPayload` 相关字段
  - `needsFollowup=false` 时不触发重入

3) Origin Reenter 执行器
- 文件建议：`sharedmodule/llmswitch-core/tests/servertool/origin-followup-reenter.spec.ts`
- 用例：
  - snapshot 存在时，重入 body 与原始请求语义等价
  - snapshot 缺失返回 `SERVERTOOL_FOLLOWUP_ORIGIN_MISSING`
  - 重入超时/4xx/5xx 错误封装符合新错误码约束

4) Rust 能力层
- 文件建议：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/*_tests.rs`
- 用例：
  - Rust orchestration 输出中不再包含 generic followup payload 构造字段
  - 仍保留 followup 是否需要的决策语义

### B. 集成测试（必须新增）

1) Stop Message Flow
- 场景：stop_message 工具触发 followup
- 断言：
  - followup 请求来源为 origin snapshot
  - 不走 message-trimmer
  - followup 请求可被当作正常请求完整处理

2) Web Search Flow
- 场景：web_search handler 触发 followup
- 断言：
  - followup body 结构与 origin 请求同构
  - 工具列表不出现历史污染/重复注入

3) Apply Patch Guard Flow
- 场景：apply_patch 前置 guard 触发 followup
- 断言：
  - 不再依赖 `followup-request-builder`
  - 重入请求工具选择与原请求一致

### C. 回归测试（必须跑）
- 命令层（示意）：
  - `pnpm -C sharedmodule/llmswitch-core test -- servertool`
  - `pnpm -C sharedmodule/llmswitch-core test -- followup`
  - `pnpm -C sharedmodule/llmswitch-core test -- stop-message`
- 重点回归项：
  - `SERVERTOOL_FOLLOWUP_FAILED` 仍可观测
  - `reasoning.stop` 生命周期不受影响
  - tool_call id 归一与清理逻辑无回归

### D. 灰度与观测计划
- Phase-1 打开 `ROUTECODEX_SERVERTOOL_FOLLOWUP_ORIGIN_ONLY=1` 进行灰度。
- 打点指标：
  - followup 触发总数
  - followup 成功率
  - origin snapshot 缺失率
  - 4xx/5xx 分布
- 验收阈值（建议）：
  - 成功率不低于旧路径
  - snapshot 缺失率 <= 0.1%

## 详细清理计划

### Phase-3 清理清单（文件级）

1) 删除 TS 构造链
- `sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder/chat-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder/message-blocks.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder/native-block.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder/op-blocks.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder/seed.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/followup-message-trimmer.ts`

2) 收缩 TS 重入块
- `sharedmodule/llmswitch-core/src/servertool/reenter-followup-block.ts`
  - 删除 `followupPayloadRaw` / `followupInjectionOps` 相关分支
  - 保留 timeout/retry/error 分类能力

3) 删除 Rust generic payload 构造
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
  - 删除 `build_servertool_generic_followup_payload*`
  - 删除 `followupInjectionOps*` 输出字段

4) 更新导出清单
- `native-router-hotpath-required-exports.ts` / Rust napi export
  - 删除 `buildServertoolGenericFollowupPayloadJson` 相关导出

### 清理验收步骤
1. `rg "followup-request-builder|followup-message-trimmer|followupInjectionOps|buildServertoolGenericFollowupPayload"` 返回空（允许文档引用）。
2. `reenter-followup-block.ts` 不再接收/处理 followup payload 注入字段。
3. Rust 导出表不再包含 generic followup payload 构造能力。
4. 全量 servertool 回归通过。

## 验证清单
- 单测：
  - origin snapshot 存取
  - followup 触发后从 origin 重入
  - snapshot 缺失 fail-fast
- 回归：
  - stop_message flow
  - web_search flow
  - apply_patch guard flow
- 禁止项验证：
  - 不再出现 `followupInjectionOps` 字段
  - 不再调用 `followup-message-trimmer`

## 迁移完成判定
- 代码库中不存在 `followup-request-builder` 目录引用。
- `reenter-followup-block.ts` 不再接收 `followupPayloadRaw`。
- Rust 不再导出 `buildServertoolGenericFollowupPayloadJson`。
