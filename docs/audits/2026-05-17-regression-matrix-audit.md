# 2026-05-17 回归矩阵完整性审计（关键缺陷漏检）

## 结论
当前回归矩阵**不完整**，存在“测试写了但不在 CI 门禁内”的真空区，导致关键缺陷（`tool_calls` 在 `/v1/responses` 映射丢失）未被拦截。

## 证据链

1. 根 Jest 根目录不包含 `sharedmodule/llmswitch-core/test`
   - 文件：`jest.config.js`
   - 配置：`roots = ['<rootDir>/src', '<rootDir>/tests', '<rootDir>/webui/src']`
   - 影响：`sharedmodule/llmswitch-core/test/hub/provider-response.spec.ts` 默认不运行。

2. CI 白名单测试清单此前未包含该关键用例
   - 文件：`scripts/tests/ci-jest.mjs`
   - 机制：`--runTestsByPath` 固定白名单执行
   - 影响：即使 `tests/` 下已有很多回归，若未入白名单也不会跑。

3. 漏检缺陷的真实形态
   - 现网样本：`/Volumes/extension/.rcc/codex-samples/openai-responses/mini27.key1.MiniMax-M2.7/req_1778999506986_89eecd9c/provider-response.json`
   - 上游返回：`finish_reason=tool_calls` + `message.tool_calls` 存在
   - 客户端异常：`/v1/responses` 最终缺少可见 `function_call`，进入无工具可执行循环

## 本次补齐动作（已执行）

### A. 增加矩阵回归（进入 roots 且可进入 CI）
- 新文件：`tests/sharedmodule/provider-response-remap-toolcall-matrix.spec.ts`
- 覆盖维度：
  1) `providerProtocol=openai-chat` + `entryEndpoint=/v1/responses`
     - 断言必须有：
       - `output[].type=function_call`
       - `required_action.submit_tool_outputs.tool_calls[]`
  2) `providerProtocol=openai-chat` + `entryEndpoint=/v1/chat/completions`
     - 断言必须保留：`assistant.tool_calls`

### B. 纳入 CI 门禁
- 修改：`scripts/tests/ci-jest.mjs`
- 新增白名单：`tests/sharedmodule/provider-response-remap-toolcall-matrix.spec.ts`

## 验证结果
- 命令：
  - `npm run jest:run -- --runTestsByPath tests/sharedmodule/provider-response-remap-toolcall-matrix.spec.ts tests/server/runtime/http-server/router-direct-pipeline.spec.ts tests/server/runtime/http-server/port-config-validator-sameprotocol.spec.ts tests/server/runtime/http-server/provider-direct-pipeline.spec.ts`
- 结果：`4 suites, 31 tests, 0 failures`

## 当前矩阵缺口（仍需补齐）

1. **协议 × 入口 × 响应形态** 还未系统穷举
   - 目前只补了 `openai-chat -> /v1/responses` 的关键缺陷路径。
   - 还需最小必测格：
     - `openai-responses -> /v1/responses`（function_call id 保真）
     - `anthropic-messages -> /v1/responses`（tool_use -> function_call）
     - `gemini-chat -> /v1/responses`（functionCall -> function_call）

2. **JSON 与 SSE 双通道一致性** 未形成统一矩阵门禁
   - 当前用例主要验证 JSON body。
   - 还需确保同一语义在 SSE chunk 与 final completed 事件一致可见。

3. **样本回放门禁与契约门禁未绑定**
   - 真实 codex-samples 能复现问题，但尚未形成“新样本入库 -> 强制回归”的统一钩子。

## 标准回归矩阵建议（最小可落地）

维度：
- `providerProtocol`: `openai-chat | openai-responses | anthropic-messages | gemini-chat`
- `entryEndpoint`: `/v1/chat/completions | /v1/responses | /v1/messages`
- `shape`: `plain_text | tool_calls | requires_action`
- `transport`: `json | sse`

关键断言（tool_calls 相关）：
- 有工具调用语义时：
  - Chat 面必须可见 `assistant.tool_calls`
  - Responses 面必须可见 `output.function_call` + `required_action.submit_tool_outputs.tool_calls`
- 无工具调用语义时：不得虚构 function_call
- `call_id/tool_call_id/id` 必须可追溯一致
