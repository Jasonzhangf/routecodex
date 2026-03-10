# SSE to JSON Conversion Module

## Overview
SSE to JSON module handles conversion from Server-Sent Events (SSE) stream to canonical JSON format for different AI provider protocols.

## Directory Structure
```
src/sse/sse-to-json/
├── index.ts                          # Module entry point and exports
├── chat-sse-to-json-converter.ts     # OpenAI Chat protocol SSE parser
├── responses-sse-to-json-converter.ts  # OpenAI Responses protocol SSE parser
├── anthropic-sse-to-json-converter.ts  # Anthropic Messages protocol SSE parser
└── parsers/                            # Core SSE parser
    └── sse-parser.ts                  # Universal SSE event parsing
```

## Key Components

### SseParser
Recognizes all protocol event types:
- OpenAI Chat: `chunk`, `done` events
- OpenAI Responses: `response.*`, `input.*` event types
- Anthropic Messages: `content_block_*`, `message_start` events

### Converters
| Protocol | Converter File |
|----------|----------------|
| OpenAI Chat | `chat-sse-to-json-converter.ts` |
| OpenAI Responses | `responses-sse-to-json-converter.ts` |
| Anthropic Messages | `anthropic-sse-to-json-converter.ts` |

## Usage
```typescript
import { ChatSseToJsonConverter } from './chat-sse-to-json-converter.js';
const converter = new ChatSseToJsonConverter();
await converter.convert(sseStream);
```

## Related Documentation
- `src/sse/README.md` - SSE module overview
