# Anthropic 真流式桥接（OpenAI → Anthropic）

## 目标
- 客户端：Anthropic /v1/messages（SSE）
- 上游：OpenAI Chat /chat/completions（stream=true）
- 实时等价映射，语义与非流式一致；Provider 只 IO；特性在 Compatibility/LLMSwitch。

## 事件映射
- 起始：OpenAI delta.role='assistant' → Anthropic message_start
- 文本：delta.content → content_block_start(text) → content_block_delta(text_delta) → content_block_stop
- 工具：
  - 新形态 delta.tool_calls[*].function.{name|arguments}
  - 旧形态 delta.function_call.{name|arguments}
  - 映射：content_block_start(tool_use,id,name,input={}) → content_block_delta(input_json_delta, partial_json) → content_block_stop
- 结束/用量：finish_reason → stop_reason（tool_calls→tool_use，length→max_tokens）；usage → message_delta(usage) → message_stop

## 一致性与复用
- 文本清理：仅对文本 stripThinkingTags；不处理工具结构/参数。
- 工具/参数：复用 llmswitch-core args-mapping；id 缺失时生成 `call_<rand>`。
- 与非流式字段完全一致，同名同义。

## 架构与接入
- 新增（llmswitch-core）
  - streaming/openai-sse-parser.ts：行级解析
  - streaming/anthropic-sse-emitter.ts：事件输出
  - streaming/openai-to-anthropic-transformer.ts：状态机 + 小窗口聚合
- 集成（RouteCodex）
  - protocol-handler：/v1/messages 流路径检测上游流 → 调用 transformer.consume() 输出 Anthropic SSE
  - Provider 只 IO（glm-http/generic-openai）

## 配置
- 默认开启：未设置即启用；如需关闭将 RCC_O2A_STREAM=0（或 'false'）
  - 仍可显式设置 RCC_O2A_STREAM=1 强制开启
- RCC_O2A_COALESCE_MS=1000（默认 1s）微窗口聚合文本/arguments 片段

## 容错与回压
- 帧解析失败跳过并记录；finalize 时补 stop_reason 与 message_stop
- 遵循 res.write backpressure；客户端关闭时中止上游

## 测试
- 纯文本、纯工具（新/旧）、混合、多工具、仅工具无文本、finish_reason/usage 末帧
- 验证换行与字段名完全一致

## 实施步骤
1) 在 llmswitch-core 增加 streaming 转换器与导出
2) protocol-handler /v1/messages 接入 consume()
3) 复用非流工具/思考/结束/用量映射函数
4) 单元/集成/实网验证与灰度
