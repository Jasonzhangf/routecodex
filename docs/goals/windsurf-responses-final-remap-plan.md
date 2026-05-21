# Windsurf /v1/responses 最终重建修复计划

## 目标
修复 `/v1/responses` 在 Windsurf/provider chat 链路下仍漏出 `chat.completion` 的问题，保证最终客户端稳定拿到 `object=response` 且 `status=requires_action/completed` 的 Responses surface。

## 验收标准
- `/v1/responses` 真实请求不再返回 `chat.completion`
- tool-call 场景稳定返回 `object=response` + `required_action.submit_tool_outputs`
- `submit_tool_outputs` 二轮可恢复，`response_id` 可继续追踪

## 范围
### In
- `provider-response` 最终重建
- `responses-openai-bridge` 的 `chat -> response` 归一
- `resp_outbound` 最终 client remap
- 相关定向回归测试

### Out
- provider 登录链
- SSE 公共层改造
- fallback / 降级 / 双路径补偿
- 无关协议的兼容层扩面

## 设计原则
- provider 只输出 chat / chat 扩展，chat inbound 保持最薄
- `/v1/responses` 最终 surface 只能由 chat_process/outbound 重建
- 不改无关链路，不引入第二真源
- 任何错误必须显式暴露，不做 fallback

## 技术方案
1. 先用定向测试锁定 `chat.completion -> response` 的唯一重建入口
2. 复核 `buildResponsesPayloadFromChat*` 与 `resp_outbound_stage1_client_remap`
3. 确认最终出口不会把 `response` 盖回 `chat.completion`
4. 若发现旧/重复出口，物理删除错误实现

## 文件清单
- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge/response-payload.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics.rs`
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/*`
- `sharedmodule/llmswitch-core/tests/responses/responses-openai-bridge.spec.ts`
- `sharedmodule/llmswitch-core/tests/hub/responses-followup-client-protocol.test.ts`

## 验证
- 定向 red/green 测试
- `sharedmodule/llmswitch-core` 构建
- 根仓 build / install
- 真实 `/v1/responses` smoke

## 完成定义
- Windsurf 路径真实请求不再漏出 `chat.completion`
- Responses 两轮工具调用链路可闭环
- 相关回归稳定为绿
