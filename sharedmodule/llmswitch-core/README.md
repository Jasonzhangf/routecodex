# @routecodex/llmswitch-core（内置）

提供 LLMSwitch 的核心实现与编解码器（codecs）：

- openai-openai：OpenAI Chat 规范化
- anthropic-openai：Anthropic Messages ↔ OpenAI Chat 转换
- responses-openai：OpenAI Responses ↔ Chat 转换
- conversion-router：按端点选择合适的 codec

## 导入

```ts
import { normalizeChatRequest, normalizeChatResponse } from 'rcc-llmswitch-core/conversion';
import { OpenAIOpenAIConversionCodec } from 'rcc-llmswitch-core/conversion/codecs/openai-openai-codec';
```

## 约定

- assistant.tool_calls[].function.arguments 为单一 JSON 字符串；对象会被 JSON.stringify。
- 工具定义采用 OpenAI function 形状：`{ type:'function', function:{ name, description?, parameters } }`。
- 名称规范化仅允许 `[a-zA-Z0-9_-]`，长度≤64。

## 环境变量（部分）

- `RCC_ALLOWED_TOOLS`：额外允许的函数工具（逗号分隔）。
- `RCC_TOOL_LIMIT`：工具最大保留数量（默认 32）。
