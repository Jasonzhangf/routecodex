# Provider Core Runtime Module
## Overview
Provider core runtime module contains the actual HTTP transport implementations for different AI providers. This is where provider- specific request/response handling, error classification, and HTTP communication occur.
## Directory Structure
```src/providers/core/runtime/
├── base-provider. ts           # Base provider class with common functionality
├── http-transport- provider. ts  # Generic HTTP transport implementation
├── chat-http- provider. ts     # OpenAI Chat protocol handler
├── responses-http- provider. ts  # OpenAI Responses protocol handler
├── anthropic-http- provider. ts  # Anthropic Messages protocol handler
├── gemini-http- provider. ts   # Google Gemini API handler
├── gemini-cli-http- provider. ts  # Google Gemini CLI handler
├── openai-http- provider. ts   # OpenAI legacy protocol handler
├── iflow-http- provider. ts    # iFlow protocol handler
├── http-request-executor. ts   # HTTP request execution and retry logic
├── provider-factory. ts        # Factory for creating provider instances
├── provider-error- classifier. ts  # Error classification and mapping
└── vision-debug-utils. ts      # Vision/image debugging utilities```## Key Components### BaseProvider
Base class providing:- Common request/response handling- Error classification
- Snapshot writing- Hook integration### HTTP Transport Providers| Provider | Protocol Type | Handler File |
|----------|---------------|--------------|
| OpenAI Chat | openai-chat | chat-http-provider.ts |
| OpenAI Responses | openai-responses | responses-http-provider. ts |
| Anthropic Messages | anthropic-messages | anthropic-http- provider.ts |
| Google Gemini | google-gemini | gemini-http-provider. ts |
| Google Gemini CLI | google- gemini-cli | gemini-cli-http- provider.ts |
### ProviderFactoryCreates appropriate provider instances based on:- `providerType` from configuration
- `protocol` field for protocol selection- Runtime metadata injection## Usage```typescriptimport { ChatHttpProvider } from './chat-http-provider. js';const provider = new ChatHttpProvider(config, metadata);const response = await provider.execute(request);```## Do / Don't
**Do**
- Handle HTTP communication, retries, and timeouts- Emit errors via `emitProviderError()` with dependencies
- Write snapshots for debugging**Don't**
- Implement tool logic or routing decisions
- Modify user payload semanticsBypass Hub Pipeline## Related Documentation
- `src/client/` - Protocol client implementations
- `docs/v2-architecture/ README. md` - V2 architecture overview
