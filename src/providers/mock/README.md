# Mock Provider Module
## Overview
Mock provider module provides a testing/development provider that simulates AI responses without making actual HTTP calls to upstream providers. Useful for development, testing, and CI environments.
## Directory Structure
```src/providers/mock/
├── index. ts                  # Module entry point and exports
├── mock- provider.ts          # Main mock provider implementation
├── mock-provider- factory. ts  # Factory for creating mock providers
└── mock-config. json          # Default mock configuration template```## Key Components### MockProviderImplements the same interface as real providers but:- Returns predefined responses- Simulates tool calls
- Generates mock tokens and usage data### MockProviderFactoryCreates mock provider instances based on configuration, supporting different response modes (success/error/streaming).## Usage```typescript
import { MockProviderFactory } from './mock-provider-factory. js';const factory = new MockProviderFactory();const provider = await factory.create(config);```## Use Cases- Development without API keys
- Unit testing- CI/CD pipelines- Response format validation## Related Documentation
- `samples/mock-provider/` - Mock provider samples and examples
- `scripts/mock-provider/` - Mock provider testing scripts
