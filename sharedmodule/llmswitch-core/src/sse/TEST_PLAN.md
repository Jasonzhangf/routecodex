# SSE 模块回环测试计划（独立于主流水线）

范围
- 协议覆盖：openai-chat、openai-responses（后续可扩展 anthropic/gemini）。
- 不启动主服务器；所有测试脚本走直连第三方端点或纯内存回环。

基础设施
- 黄金样例捕获（第三方端点）：
  - Chat：~/.routecodex/codex-samples/openai-chat/<provider>/*.events.ndjson
  - Responses：~/.routecodex/codex-samples/openai-responses/<provider>/*.events.ndjson
  - 同步保存请求与最终 JSON：*.request.json、*.final.json
- 工具脚本（待实现）：
  - scripts/capture-chat-sse.mjs（与 capture-responses-sse.mjs 对称）
  - scripts/tests/chat-rt.mjs（Chat 回环）
  - scripts/tests/responses-rt.mjs（Responses 回环）

环境变量
- BASEURL（默认 http://127.0.0.1:1234/v1）
- API_KEY（默认 lm-studio）
- MODEL（默认 gpt-oss-20b-mlx）
- TIMEOUT_MS（默认 60000）

回环用例矩阵
1) Chat 协议
   - JSON→SSE→JSON：
     - 纯文本（messages: user→assistant.content）
     - 工具调用（assistant.tool_calls；arguments 增量）
     断言：还原 JSON 在语义等价（role/content/tool_calls/function_call/finish_reason），允许 id/created/usage 差异。
   - Golden SSE→JSON→SSE：
     - 输入黄金 events.ndjson，解析为 JSON，再序列化为 SSE；
     - 比较事件序列“弱等价”：类型与关键字段一致（choices[0].delta.*、finish_reason、[DONE]）。

2) Responses 协议
   - JSON→SSE→JSON：
     - 纯文本 output（message/output_text）
     - required_action（tool_calls + submit_tool_outputs）
     - reasoning（reasoning_text.delta/done）
     断言：状态机合法（created→in_progress→…→completed→done）；output_items 顺序与字段等价；tool id/arguments 配对正确。
   - Golden SSE→JSON→SSE：
     - 输入黄金 response.* 事件序列，聚合为 JSON，再序列化回 SSE；
     - 比较事件序列“弱等价”：type、sequence_number 单调、output_index 连贯、必需字段存在。

等价性定义
- 事件序列弱等价：忽略时间戳/随机 id，只比类型与关键字段（Chat 的 role/content/tool_calls；Responses 的 type/indices）。
- JSON 语义等价：核心字段一致（role/content/tool_calls/function_call/finish_reason/status/output），允许 id/created/usage 差异。

边界用例
- 空内容/空 arguments；
- 多工具并行（索引与 id 对齐）；
- 心跳帧（ping）不影响完成判定；
- 超时/早停；
- 错误帧：error 事件转为结构化错误，序列化为 { name, message, stack, code, details }。

命令草案（示例）
```bash
# 捕获 Chat 黄金
MODEL=gpt-oss-20b-mlx \
BASEURL=http://127.0.0.1:1234/v1 \
API_KEY=lm-studio \
node scripts/capture-chat-sse.mjs --file scripts/payloads/chat.tool.json --out lmstudio-chat-$(date +%s)

# Chat 回环（JSON→SSE→JSON）
node scripts/tests/chat-rt.mjs --case tool

# Chat 回环（Golden SSE→JSON→SSE 对拍）
node scripts/tests/chat-rt.mjs --gold ~/.routecodex/codex-samples/openai-chat/lmstudio-golden/<stamp>.events.ndjson

# Responses 回环同理
node scripts/tests/responses-rt.mjs --case required_action
node scripts/tests/responses-rt.mjs --gold ~/.routecodex/codex-samples/openai-responses/lmstudio-golden/<stamp>.events.ndjson
```

验收标准（per 协议）
- 所有回环用例通过（弱等价/语义等价）；
- 超时/错误处理符合预期；
- 支持可调粒度与心跳，不影响对拍；
- 事件计数/时序统计稳定，性能在预设阈值内（可选）。

备注
- 本测试计划独立于主流水线，不引入 provider/compatibility/node 管道；
- 后续接入主链路后，黄金对拍继续作为二道关（install verify）。

