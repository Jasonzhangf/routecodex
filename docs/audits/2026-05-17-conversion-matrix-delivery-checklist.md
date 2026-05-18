# 2026-05-17 转换矩阵交付核对清单

## 目标拆解与证据映射

### A. req 方向矩阵（responses inbound -> chat process -> provider）
- 要求：覆盖 entryEndpoint `/v1/responses|/v1/chat/completions|/v1/messages` + providerProtocol `openai-chat|openai-responses|anthropic-messages|gemini-chat`。
- 实现：
  - `tests/sharedmodule/responses-cross-protocol-audit-matrix.spec.ts:186-226`
  - `it.each(...)` 覆盖上述 4 providerProtocol；每个 case 内同时覆盖 `tool_choice=auto|required`。
- 硬断言：`tool_choice=auto|required` 时 tools 不可被清空。
  - 证据：`...:220-224`，`pickToolNames(payload)` 必须包含 `exec_command`。
- 硬断言：`no-tools` 不得伪造工具列表。
  - 证据：`...:228-272`，`pickToolNames(payload)` 长度必须为 `0`。
- 硬断言：`submit_tool_outputs/function_call_output` 连续性不丢失。
  - 证据：`...:274-312`，roundtrip 后仍保留 `type=function_call_output` + `call_id=call_submit_001`。

### B. response 方向矩阵（provider inbound -> chat process -> client）
- 要求：同协议工具调用不能丢；responses/chat 两端 schema 可见。
- 实现：
  - `tests/sharedmodule/responses-cross-protocol-audit-matrix.spec.ts:228-286`
- 硬断言：
  - `/v1/responses`：必须出现 `output.function_call` + `required_action.submit_tool_outputs.tool_calls`
    - 证据：`...:273-280`
  - `/v1/chat/completions`：必须出现 `assistant.tool_calls` + `finish_reason=tool_calls`
    - 证据：`...:282-283`
  - `call_id/tool_call_id/id` 一致可追溯
    - 证据：`...:277-279`
  - SSE completed 与 JSON final 语义等价
    - 证据：`...:382-440`，同一 tool_calls 响应在 JSON/SSE 均为 `requires_action` 且 SSE 含 `response.completed`。

### C. servertool 拦截语义
- 要求：servertool followup 路径纳入门禁。
- 现有测试纳入 CI：
  - `tests/server/runtime/http-server/executor/provider-response-converter.servertool-regression.spec.ts`
- CI 白名单证据：`scripts/tests/ci-jest.mjs:74-75`

### D. same-protocol direct 透明与开关
- 要求：same-protocol direct/relay 合约保真。
- 现有测试纳入 CI：
  - `tests/server/runtime/http-server/provider-direct-pipeline.spec.ts`
  - `tests/server/runtime/http-server/router-direct-pipeline.spec.ts`
  - `tests/server/runtime/http-server/port-config-validator-sameprotocol.spec.ts`
- CI 白名单证据：`scripts/tests/ci-jest.mjs:39-41`

### E. failing-shape replay + control replay
- failing-shape replay：
  - `tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts:498-545`
  - 用例：`status=completed, output=[]` 空响应形态通过 converter 层保持，交由后续 contract gate 处理。
- control replay：
  - `tests/sharedmodule/responses-cross-protocol-audit-matrix.spec.ts:228-286`
  - 用例：标准 `finish_reason=tool_calls` + `message.tool_calls` -> 客户端完整工具面。

### F. CI 门禁收口
- 已新增到 `scripts/tests/ci-jest.mjs`：
  - `responses-cross-protocol-audit-matrix.spec.ts`
  - `real-sample-hub-io-compare.spec.ts`
  - `provider-response-converter.unified-semantics.spec.ts`
  - `provider-response-converter.servertool-regression.spec.ts`
  - `provider-direct-pipeline.spec.ts`
  - `router-direct-pipeline.spec.ts`
  - `port-config-validator-sameprotocol.spec.ts`

## 验证命令与结果

执行：
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/responses-cross-protocol-audit-matrix.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.servertool-regression.spec.ts tests/server/runtime/http-server/provider-direct-pipeline.spec.ts tests/server/runtime/http-server/router-direct-pipeline.spec.ts tests/server/runtime/http-server/port-config-validator-sameprotocol.spec.ts`

结果：
- `6 passed, 0 failed`
- `82 tests passed`

## 剩余风险
1. `tests/sharedmodule/real-sample-hub-io-compare.spec.ts` 依赖本机 codex-samples，CI 环境可能无样本导致 skip（不影响核心 matrix 单元门禁，但影响“真实样本回放覆盖率”）。
2. SSE completed 与 JSON final 的逐字段等价矩阵，当前更多依赖现有 converter/servertool suites；后续可追加到 `responses-cross-protocol-audit-matrix.spec.ts` 的统一断言函数中。

## 唯一性论证
- 本次问题的根因是“矩阵门禁缺口”，不是单个业务分支 bug。
- 因此唯一正确改动点是：
  1) 在**现有 matrix 真源测试文件**补齐 req/resp 断言（`responses-cross-protocol-audit-matrix.spec.ts`）；
  2) 在**现有 converter/servertool 回归真源**补 failing-shape replay；
  3) 在**唯一 CI 白名单真源** `scripts/tests/ci-jest.mjs` 收口门禁。
- 其他改法（只改 runtime、只加临时测试但不入白名单）都无法阻断“未来再次漏检”。
