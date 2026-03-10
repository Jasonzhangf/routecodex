# JSON转SSE模块

## 概述
JSON转SSE模块负责将规范化的JSON格式转换为Server-Sent Events（SSE）流，支持OpenAI Chat、OpenAI Responses和Anthropic Messages三种协议。

## 目录结构
```
src/sse/json-to-sse/
├── index.ts                          # 模块入口和导出
├── chat-json-to-sse-converter.ts     # OpenAI Chat协议SSE转换器
├── responses-json-to-sse-converter.ts  # OpenAI Responses协议SSE转换器
├── anthropic-json-to-sse-converter.ts  # Anthropic Messages协议SSE转换器
└── sequencers/                        # 事件序列生成器
    ├── chat-sequencer.ts             # Chat事件序列生成
    ├── responses-sequencer.ts        # Responses事件序列生成
    └── anthropic-sequencer.ts        # Anthropic事件序列生成
```

## 核心组件

### 转换器实现
| 协议 | 转换器文件 | 说明 |
|------|-----------|------|
| OpenAI Chat | `chat-json-to-sse-converter.ts` | 生成标准Chat completion事件流 |
| OpenAI Responses | `responses-json-to-sse-converter.ts` | 生成带required_action的响应事件 |
| Anthropic Messages | `anthropic-json-to-sse-converter.ts` | 生成content blocks事件流 |

### 序列器
- **ChatSequencer**：生成chat completion delta事件，支持tool call chunk
- **ResponsesSequencer**：生成response.*类型事件，包括output和required_action
- **AnthropicSequencer**：生成text、thinking、tool_use、tool_result等content block事件

## 使用示例
```typescript
import { ChatJsonToSseConverter } from './chat-json-to-sse-converter.js';

const converter = new ChatJsonToSseConverter();
await converter.convert(chatResponse, stream);
```

## 相关文档
- `src/sse/README.md` - SSE模块整体概述
- `src/conversion/` - 协议转换层文档
