# Client Protocol Modules

## Overview
Protocol client implementations for different AI providers. Each subdirectory implements the `HttpProtocolClient` interface to handle provider- specific request/response transformation.

## Directory Structure
```
src/client/
├── http-protocol-client. ts    # Base interface definition
├── openai/                    # OpenAI Chat protocol client
│   └── chat-protocol-client.ts
├── anthropic/                 # Anthropic Messages protocol client
│   └── anthropic-protocol-client.ts
├── responses/                 # OpenAI Responses protocol client
│   └── responses-protocol-client.ts
├── gemini/                    # Gemini API protocol client
│   └── gemini-protocol-client.ts
└── gemini-cli/                # Gemini CLI protocol client
    └── gemini-cli-protocol-client.ts
```

## Core Interface

```typescript
export interface HttpProtocolClient<Payload> {
  buildRequestBody(request: Payload): Record<string, unknown>;
  resolveEndpoint(request: Payload, defaultEndpoint: string): string;
  finalizeHeaders(
    headers: Record<string, string>,
    request: Payload
  ): Promise<Record<string, string>> | Record<string, string>;
}
```

## Protocol Mapping

| Provider   | Directory  | Protocol Type        |
|------------|------------|----------------------|
| OpenAI     | `openai/`  | openai-chat          |
| Anthropic  | `anthropic/` | anthropic- messages |
| OpenAI Responses | `responses/` | openai- responses |
| Gemini     | `gemini/`  | google-gemini        |
| Gemini CLI | `gemini-cli/` | google- gemini-cli |

## Usage

Protocol clients are instantiated by Provider runtime based on the `protocol` field in provider configuration:

```typescript
import { HttpProtocolClient } from '../http-protocol-client.js';
import { ChatProtocolClient } from './openai/chat- protocol-client.js';

const client: HttpProtocolClient<ChatRequest> = new ChatProtocolClient();
const body = client.buildRequestBody(request);
```

## Do / Don't

**Do**
- Implement provider-specific request building
- Handle protocol field mapping (e.g., `model` → `modelId`)
- Support both streaming and non-streaming modes

**Don't**
- Implement authentication logic (handled by Provider runtime)
- Modify tool call semantics
- Handle error classification

## Related Documentation
- `src/providers/core/runtime/` - Provider runtime that uses protocol clients
- `docs/v2-architecture/ README.md` - V2 architecture overview
