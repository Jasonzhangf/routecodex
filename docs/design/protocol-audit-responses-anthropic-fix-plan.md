# Responses ↔ Chat Process ↔ Anthropic 协议审计修复计划

## 索引概要
- L1-L8 `purpose`：本设计文档的目标与范围
- L10-L26 `audit-scope`：本轮审计要闭环的问题范围
- L28-L54 `ssot`：唯一真源与禁止误修位置
- L56-L101 `issue-list`：当前已知问题与修复顺序
- L103-L141 `file-owners`：关键文件与责任边界
- L143-L180 `verification`：验证矩阵
- L182-L194 `completion`：完成标准

## 目标
把 `/v1/responses -> chat process -> provider(尤其 anthropic / deepseek-web) -> client remap` 的协议语义闭环修正到单一路径真源，确保：
1. request 侧每个语义字段都完整进入 chat process；
2. response 侧每个语义字段都从 provider 正确回到客户端协议；
3. tool history / continuation / reasoning / output_text / finish_reason / field transparency 不再出现局部阶段漂移；
4. 所有修复都以 same-shape replay + build/install/live 证据闭环。

## 审计范围
### 主链
- `/v1/responses` request codec
- chat process request / response stages
- responses conversation / continuation materialization
- provider outbound compat（重点 anthropic，必要时 deepseek-web / openai-chat 对照）
- client remap（responses / anthropic 双向）
- SSE to JSON / response builder

### 必须覆盖的语义面
- input / messages / system
- tools / tool_choice / tool_calls / tool results
- continuation / previous_response_id / responses resume
- reasoning / thinking / reasoning_content
- output / output_text / message.content
- finish_reason / stop reasons
- metadata / audit fields / field transparency

## 唯一真源与误修禁区
### 真源优先
- Rust request/response 语义 owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/`
- chat process / hub pipeline orchestrator：`sharedmodule/llmswitch-core/src/conversion/hub/`
- SSE builder owner：`sharedmodule/llmswitch-core/src/sse/sse-to-json/`
- responses continuation store owner：`sharedmodule/llmswitch-core/src/conversion/shared/`

### 禁止误修
- 不允许放宽 dangling / orphan / missing id 合约来掩盖历史配对错误
- 不允许靠 fallback / 静默补字段 / 二次猜测 harvest 修复协议问题
- 不允许在 host/provider/server 层另起第二协议语义面
- 不允许通过裁剪真实 payload“修好”问题

## 当前已知问题与修复顺序
### P0：dangling_tool_call 误杀 terminal pending tool call
- 现象：`bridge tool_call ... does not have a matching tool result in history`
- 真源：`hub_pipeline.rs::sync_responses_context_from_canonical_messages(...)`
- 正确修复：context sync 与 request codec 对齐，允许 terminal pending tool call
- 当前状态：代码 + Rust/Jest 回归已做；仍需 build/install/live replay 闭环

### P0：Responses request/response 协议审计闭环
- 目标：逐字段核对 responses 入口语义是否完整进 chat process，并完整回到 responses / anthropic 客户端出口
- 必查：
  - request codec 是否完整 lift 到 `semantics.responses/context/continuation`
  - response remap 是否完整保留 tool / reasoning / output / finish_reason
  - anthropic outbound / inbound 是否存在 lossy / dropped 未审计字段

### P1：SSE top-level `output_text` 丢失
- 证据：`response-builder.ts` 只重建 `output[*].content[*].text`，未稳定回填顶层 `output_text`
- 正确修复点：SSE builder owner，不是脚本/测试层
- 要求：补 converter regression，覆盖 completed / incomplete / failed / salvage done 路径

### P1：continuation / conversation store / route-aware materialize 一致性
- 目标：保证 responses 历史恢复、submit_tool_outputs、non-responses outbound materialize、route-selected model 保持同一语义
- 必查：
  - `shared_responses_conversation_utils.rs`
  - `responses-conversation-store-native.ts`
  - `hub_pipeline_blocks/responses_resume.rs`
  - toolContinuation 在 request / response / store 三处不漂移

### P1：field transparency / protocol mapping audit 完整性
- 目标：所有 responses→anthropic 非等价映射必须显式落 audit；等价字段必须透明保留
- 必查：
  - `responses-field-transparency.spec.ts`
  - `responses-cross-protocol-audit-matrix.spec.ts`
  - `responses-cross-protocol-reasoning-mapping.spec.ts`
  - 旧 `real-sample-hub-io-compare.spec.ts` 已删除；真实样本覆盖必须迁入现存 matrix/fixture gate 后再启用。

### P2：finish_reason / tool_calls / sanitize 一致性
- 目标：只要最终 payload 有非空 tool_calls，finish_reason 必须是 tool_calls；无合法 tool_calls 时不得把 sanitize 变空误报成功
- 必查 owner：
  - `resp_process_stage2_finalize`
  - `shared_responses_response_utils`
  - `sanitize_reasoning_fields_after_tool_harvest`

## 关键文件责任边界
### Rust / native
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs`
- `.../responses_openai_codec.rs`
- `.../shared_responses_conversation_utils.rs`
- `.../hub_bridge_actions/history.rs`
- `.../hub_bridge_actions/bridge_input.rs`

### TS orchestration / store / remap
- `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store-native.ts`
- `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
- 已删除旧 TS owner：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.ts`

### SSE / response builders
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/builders/response-builder.ts`
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/anthropic-sse-to-json-converter.ts`
- `sharedmodule/llmswitch-core/src/sse/sse-to-json/chat-sse-to-json-converter.ts`

### 重点测试/回放
- `tests/sharedmodule/responses-field-transparency.spec.ts`
- `tests/sharedmodule/responses-submit-tool-outputs.spec.ts`
- `tests/sharedmodule/responses-cross-protocol-reasoning-mapping.spec.ts`
- `tests/sharedmodule/responses-cross-protocol-audit-matrix.spec.ts`
- `tests/sharedmodule/chat-process-roundtrip-integration.spec.ts`
- 旧 `tests/sharedmodule/real-sample-hub-io-compare.spec.ts` 已删除；不得作为当前必跑测试引用。
- `sharedmodule/llmswitch-core/tests/responses/responses-openai-bridge.spec.ts`

## 执行顺序
1. 先以审计矩阵逐字段列出“已验证 / 未验证 / 失败样本 / 真源 owner”。
2. 先修 P0：dangling_tool_call live 链闭环。
3. 再修 request/response 语义漂移 owner；每次只改唯一真源。
4. 修完每个问题立刻补最小回归：unit/contract + same-shape replay。
5. 最后统一 build、install、restart、live verify。

## 验证矩阵
### 代码级
- 定向 Rust tests（hub_pipeline / bridge history / responses codec）
- 定向 Jest/spec（responses transparency / continuation / audit / roundtrip）
- 必要时 SSE converter tests

### 回放级
- 原失败样本 same-shape replay：优先 `dangling_tool_call` 相关 requestId
- 至少 1 条 responses → anthropic → responses real sample compare
- 至少 1 条 control replay，确认未回归

### 安装态 / 运行态
- `npm run build:min`
- `npm run install:global`
- 受控重启目标服务
- 在线复测 10000 端口对应原问题
- 核对日志：不再出现 `dangling_tool_call`、`output_text` 缺失、协议字段静默丢失

## 完成标准
1. `/v1/responses` 原失败样本 same-shape replay 通过。
2. responses→chat process→anthropic→client remap 的关键语义面都有测试或 replay 证据。
3. 所有新增修复都落在唯一真源 owner，没有引入 fallback / 第二实现面。
4. build + install + restart + live verify 全部通过。
5. summary 必须逐项说明：问题真源、为什么这是唯一正确修改点、验证证据、剩余未闭环项（若有）。
