# Direct / Relay Responses Continuation 修复计划

## 1. 目标与验收标准

### 目标
修复 5555 路由链路中 direct 首轮 `tool_calls` 后、下一轮切换到 non-responses / relay provider 时的续接失败问题，恢复三天前 TS 版本的既有语义：
- direct 链路只做 minimum override，不做 Hub Pipeline 语义治理；
- relay 链路完整保留工具声明、工具调用、工具结果与 followup 语义；
- `pending tool_call + 下一条 user` 的 materialized continuation 能正确进入 non-responses provider，不再被误判为 dangling tool call；
- 请求/响应 payload 不被额外清洗，不吞响应，不断流，不错误映射 502。

### 验收标准
1. direct 首轮 `/v1/responses` 返回 `finish_reason=tool_calls` 后，下一轮同 session plain followup 能正确 materialize 成 non-responses chat history。
2. materialized chat history 允许保留“未提交 tool result 的 assistant tool_call + 后续 user turn”，且仅在 route-aware continuation 这个受控场景生效。
3. relay 链路工具声明、tool call、tool result 继续完整 remap，不出现 `update_plan` 被误当 shell 命令等问题。
4. direct 链路不进入 relay 专属 followup / stopless / servertool orchestration；relay 链路继续保留该能力。
5. 本机 build / install / restart 后，5555 真实入口 same-shape 请求复测通过，无吞响应、无断续接力失败、无错误 502 映射。

## 2. 范围与边界

### In Scope
- responses continuation store 的 released prefix materialize 语义
- route-aware responses continuation 到 non-responses chat message 的转换
- native bridge conversion 对 pending tool_call continuation 的受控放行
- 相关 direct / relay 续接回归测试
- 构建、全局安装、重启、5555 实机 smoke

### Out of Scope
- 新设计新的 followup 体系
- 改变 direct/relay 基本架构职责
- 新增 fallback/降级/兜底
- 无证据修改 provider 自身业务逻辑
- 与本问题无关的 tool governance 重构

## 3. 设计原则
- 唯一真源：修复点必须落在 Rust native continuation / bridge semantics 真源，不在 handler / SSE / error mapper 表层打补丁。
- 先红测再实现：先用 same-shape case 稳定复现，再做最小修改。
- payload 语义保真：不得通过裁剪/清洗真实请求响应来“修好”问题。
- direct / relay 分层严格：
  - direct：minimum override only；
  - relay：Hub Pipeline request+response 全链治理；
  - followup / stopless / servertool 仅 relay 负责。
- 无 fallback：错误必须显式暴露，不能吞掉 response 或改报 502。

## 4. 技术方案

### 已确认根因 A（已修）
CRS upstream 可能返回：
- `object=response`
- `status=completed`
- `output` 内已有 `function_call`
- 无 `required_action`

旧逻辑错误把它保留为 completed，导致工具回合不进入 submit_tool_outputs。

已修复文件：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/responses_payload.rs`

### 当前唯一剩余根因 B（待完成）
在 direct 首轮 tool call 之后：
1. continuation store 正确保存了 `releasedInputPrefix`；
2. materialize 也正确产出：`user -> assistant function_call -> next user`；
3. 但 route-aware 切去 non-responses provider 时，native `convertBridgeInputToChatMessages` 把这类“pending tool_call continuation”误判成 `dangling_tool_call`；
4. 结果 continuation 没有 materialize 成 chat history，表现为吞响应/续接失败。

### 唯一正确修复点
- Rust native bridge conversion 需要支持“受控 continuation 场景下允许 pending tool_call + 后续 user turn”的语义；
- 该能力只能由 route-aware responses continuation 显式开启；
- 普通 bridge conversion / 普通请求历史校验仍保持 fail-fast，不放宽全局契约。

### 计划改动文件
1. `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/types.rs`
   - 为 `BridgeInputToChatInput` 增加受控 continuation 标志。
2. `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs`
   - 在 pending tool_call 终态校验处分支处理 continuation 场景。
3. `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-bridge-action-semantics-types.ts`
   - 同步 TS native binding 类型。
4. `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-bridge-action-semantics-tools-core.ts`
   - 透传新标志到 native。
5. `sharedmodule/llmswitch-core/src/conversion/bridge-message-utils.ts`
   - 仅增加受控选项，不改变默认校验语义。
6. `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.ts`
   - 只在 route-aware materialize -> non-responses 路径开启该标志。
7. 测试：
   - `tests/sharedmodule/route-aware-responses-continuation.spec.ts`
   - `tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts`
   - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/tests.rs`

## 5. 风险与规避

### 风险 1
把 pending tool call 放宽成全局行为，污染普通历史校验。
- 规避：只增加显式 flag，只由 route-aware continuation 调用点开启。

### 风险 2
误修 handler/SSE 表层，掩盖真实 conversion 问题。
- 规避：以红测中的 `dangling_tool_call` 为门禁，未消失不转下阶段。

### 风险 3
先前多次散改残留，造成测试/运行态分裂。
- 规避：本次修复后清理错误扩散改动，保留唯一真源路径。

## 6. 测试计划

### 红测
1. Rust 定向：
- `convert_bridge_input_allows_pending_tool_call_continuation_when_enabled`
2. TS 定向：
- `tests/sharedmodule/route-aware-responses-continuation.spec.ts`
  - `RED: materialized plain followup without tool result must preserve released pending tool call and append next user turn for non-responses outbound`
3. E2E：
- `tests/server/handlers/handler-request-executor.unified-semantics.e2e.spec.ts`
  - `RED: direct /v1/responses tool_calls turn must materialize same-session plain followup when outbound switches to non-responses provider`

### 绿测
- 上述 3 条全部变绿
- 再跑相关 responses continuation / handler 回归子集

### 构建与安装
- `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
- 项目 build
- global install
- `routecodex restart --port 5555`

### 实机 smoke
- 使用原 same-shape 5555 请求样本复测：
  1. direct 首轮 `finish_reason=tool_calls`
  2. 下一轮 continuation 正常发出
  3. 不吞响应
  4. 不断流
  5. 不乱报 502
  6. tool call / tool result 历史完整保留

## 7. 实施步骤
1. 清理当前错误扩散改动，只保留唯一真源方案。
2. 固化 Rust 定向红测。
3. 在 native bridge conversion 增加 continuation 受控能力。
4. 透传到 TS binding 与 route-aware 调用点。
5. 跑 Rust 定向绿测。
6. 跑 TS route-aware 定向绿测。
7. 跑 handler E2E 绿测。
8. native build。
9. build / install / restart 5555。
10. 用原 same-shape 请求做本机真实入口 smoke。
11. 清理冗余/错误旧改动，保留唯一修改路径。

## 8. 完成定义（DoD）
- direct 首轮 tool_calls -> 下一轮 non-responses/plain followup 能稳定续接；
- route-aware continuation 不再报 dangling tool_call；
- relay 工具声明/调用/结果语义不回归；
- 5555 same-shape 实机 smoke 通过；
- 提交总结中能明确说明：为什么 bridge conversion 是这次唯一正确修改点，为什么 handler/SSE/error mapper/provider 都不是根因修复点。
