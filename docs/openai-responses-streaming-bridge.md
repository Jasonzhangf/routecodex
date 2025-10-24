# OpenAI Responses 真流式桥接（OpenAI Chat → Responses SSE）

## 目标
- 客户端：OpenAI /v1/responses（SSE）
- 上游：OpenAI Chat /chat/completions（stream=true）
- 实时等价映射，语义与非流式合成保持一致；Provider 只 IO；特性在 llmswitch/compatibility。

## 事件映射
- 起始：response.created（包含 id/object/model/created_at/status='in_progress'）
- 文本：response.output_text.delta → response.output_text.done（仅文本，不混入 reasoning）
- 工具：
  - 新形态 delta.tool_calls[*].function.{name|arguments}
  - 旧形态 delta.function_call.{name|arguments}
  - 映射：
    - response.output_item.added（function_call 开始，含 id/call_id/name）
    - response.function_call_arguments.delta（字符串增量，逐段）
    - response.function_call_arguments.done（完整字符串）
    - response.output_item.done（status='completed'）
- 结束/用量：response.completed（附 usage: prompt/completion→input/output/total）；finish_reason 映射 length→max_tokens，tool_calls→tool_calls

## 一致性与复用
- 文本清理：仅对文本做必要清理（不混入 reasoning）。
- 工具/参数：严格字符串增量，不猜测，不分词。
- 与非流式合成字段、语义一致，仅差异在增量节奏。

## 架构与接入
- 新增（llmswitch-core）
  - streaming/openai-to-responses-transformer.ts：消费 OpenAI SSE，增量发出 Responses 事件，带 sequence_number
  - 复用 openai-sse-parser.ts
- 接入（RouteCodex）
  - src/server/handlers/responses.ts：当请求 stream=true 且上游返回 Readable 时，默认走真流式桥接；否则回退为合成流

## 配置
- RCC_R2C_STREAM：默认开启（未设置即启用）；设为 0/false 关闭
- RCC_R2C_COALESCE_MS：文本/参数聚合窗口（默认 1000ms）

## 容错
- 上游流错误 → response.error + 结束
- 缺失 id/name 时生成临时 id；顺序号自增

## 测试
- 纯文本、纯工具（新/旧形态）、混合、多工具、仅工具无文本、finish_reason/usage 尾帧
- 对比现有合成流，确认事件名与字段一致（节奏可更细）

