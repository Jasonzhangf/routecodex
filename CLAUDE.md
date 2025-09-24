# RouteCodex 4-Layer Pipeline Architecture Documentation

## Overview

The RouteCodex system implements a sophisticated 4-layer pipeline architecture that provides clean separation of concerns, modular design, and flexible protocol handling. This architecture enables seamless integration with multiple AI providers while maintaining consistent interfaces and proper workflow management.

## Architecture Diagram

```
HTTP Request → LLM Switch → Compatibility → Provider → AI Service
     ↓             ↓             ↓            ↓           ↓
  Request      Protocol      Format       Standard     Response
  Analysis     Routing     Conversion     HTTP Server  Processing
```

## Layer 1: LLM Switch (Dynamic Routing Classification)

### Core Functionality
- **Request Analysis**: Analyzes incoming requests to determine optimal routing
- **Protocol Routing**: Routes requests to appropriate processing pipelines
- **Dynamic Classification**: Supports 7 routing categories:
  - `default`: Standard request routing
  - `longcontext`: Long text processing requests
  - `thinking`: Complex reasoning requests
  - `background`: Background processing requests
  - `websearch`: Web search requests
  - `vision`: Image processing requests
  - `coding`: Code generation requests

### Key Responsibilities
1. **Request Validation**: Validates incoming request format and parameters
2. **Protocol Detection**: Determines source and target protocols
3. **Route Selection**: Selects appropriate processing pipeline based on request characteristics
4. **Metadata Enrichment**: Adds routing and processing metadata

### Implementation Example
```typescript
export class OpenAIPassthroughLLMSwitch implements LLM SwitchModule {
  async processIncoming(request: any): Promise<any> {
    // Analyze request and determine routing
    const routing = this.analyzeRequest(request);

    // Add routing metadata
    return {
      ...request,
      _metadata: {
        switchType: 'openai-passthrough',
        timestamp: Date.now(),
        originalProtocol: 'openai',
        targetProtocol: 'openai',
        routingCategory: routing.category
      }
    };
  }
}
```

## Layer 2: Compatibility (Format Transformation)

### Core Functionality
- **Protocol Translation**: Converts between different AI service protocols
- **Format Adaptation**: Transforms request/response formats between providers
- **Tool Integration**: Handles tool calling format conversion and execution
- **Configuration-Driven**: Uses JSON configuration for transformation rules

### Key Responsibilities
1. **Request Transformation**: Converts requests to target provider format
2. **Response Processing**: Transforms provider responses back to expected format
3. **Tool Format Conversion**: Handles tool calling format differences
4. **Error Handling**: Manages transformation errors and fallbacks

### Transformation Engine
```typescript
// Example transformation rules
const transformationRules = [
  {
    id: 'openai-to-lmstudio-tools',
    transform: 'mapping',
    sourcePath: 'tools',
    targetPath: 'tools',
    mapping: {
      'type': 'type',
      'function': 'function'
    }
  }
];
```

### Implementation Example
```typescript
export class LMStudioCompatibility implements CompatibilityModule {
  async processIncoming(request: any): Promise<any> {
    // Apply transformation rules
    const transformed = await this.transformationEngine.transform(
      request,
      this.config.transformationRules
    );

    return transformed.data || transformed;
  }
}
```

## Layer 3: Provider (Standard HTTP Server)

### Core Functionality
- **HTTP Communication**: Manages all HTTP communications with AI services
- **Authentication**: Handles provider authentication and authorization
- **Error Handling**: Manages network errors and provider-specific issues
- **Health Monitoring**: Monitors provider health and connectivity

### Key Responsibilities
1. **Request Execution**: Sends HTTP requests to AI providers
2. **Response Handling**: Processes HTTP responses from providers
3. **Authentication Management**: Handles API keys, tokens, and auth contexts
4. **Connection Management**: Manages HTTP connections and timeouts

### Architecture Principle
**CRITICAL**: Provider modules do NOT perform any format transformations. They are standard HTTP servers that only send and receive raw HTTP requests/responses. All transformations are handled by the Compatibility layer.

### Implementation Example
```typescript
export class LMStudioProviderSimple implements ProviderModule {
  async processIncoming(request: any): Promise<any> {
    // Compatibility模块已经处理了所有转换，直接发送请求
    const response = await this.sendChatRequest(request);
    return response;
  }

  private async sendChatRequest(request: any): Promise<ProviderResponse> {
    // Standard HTTP request to AI provider
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(request)
    });

    return {
      data: await response.json(),
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      metadata: { /* processing metadata */ }
    };
  }
}
```

## Layer 4: AI Service (External Provider)

### Core Functionality
- **Model Processing**: Executes AI models and generates responses
- **Tool Execution**: Handles tool calling and function execution
- **Response Generation**: Produces AI-generated content and tool calls

### Supported Providers
- **LM Studio**: Local AI model hosting with tool support
- **OpenAI**: GPT models with function calling
- **Qwen**: Alibaba's language models
- **Anthropic**: Claude model family
- **Custom Providers**: Extensible architecture for additional providers

## Data Flow Example

### Request Flow
```
1. User Request: {
  "model": "qwen3-4b-thinking-2507-mlx",
  "messages": [...],
  "tools": [...]
}

2. LLM Switch Output: {
  "model": "qwen3-4b-thinking-2507-mlx",
  "messages": [...],
  "tools": [...],
  "_metadata": {
    "switchType": "openai-passthrough",
    "timestamp": 1758554010322,
    "originalProtocol": "openai",
    "targetProtocol": "openai"
  }
}

3. Compatibility Output: {
  "model": "qwen3-4b-thinking-2507-mlx",
  "messages": [...],
  "tools": [...],
  "_metadata": { ... }
}

4. Provider HTTP Request: {
  "model": "qwen3-4b-thinking-2507-mlx",
  "messages": [...],
  "tools": [...]
}
```

### Response Flow
```
1. AI Service Response: {
  "id": "chat-xxx",
  "object": "chat.completion",
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "content": "\n\n",
      "tool_calls": [...]
    }
  }]
}

2. Provider Response: {
  "data": { /* AI service response */ },
  "status": 200,
  "headers": { ... },
  "metadata": { ... }
}

3. Compatibility Processing: {
  "id": "chat-xxx",
  "object": "chat.completion",
  "choices": [...],
  "_transformed": true
}

4. Final User Response: {
  "id": "chat-xxx",
  "object": "chat.completion",
  "choices": [...],
  "usage": { ... }
}
```

## Configuration Structure

### Module Configuration
```json
{
  "pipeline": {
    "llmSwitch": {
      "type": "openai-passthrough",
      "config": {
        "protocol": "openai",
        "targetFormat": "lmstudio"
      }
    },
    "compatibility": {
      "type": "lmstudio-compatibility",
      "config": {
        "toolsEnabled": true,
        "customRules": [...]
      }
    },
    "provider": {
      "type": "lmstudio-http",
      "config": {
        "type": "lmstudio",
        "baseUrl": "http://localhost:1234",
        "auth": {
          "type": "apikey",
          "apiKey": "your-api-key"
        }
      }
    }
  }
}
```

## Key Design Principles

### 1. Separation of Concerns
- **LLM Switch**: Routing and classification
- **Compatibility**: Format transformation
- **Provider**: HTTP communication
- **AI Service**: Model processing

### 2. Configuration-Driven
- JSON configuration for all transformations
- Dynamic rule application
- Hot reload capabilities

### 3. Modular Design
- Each layer can be independently replaced
- Plugin architecture for extensibility
- Interface-based contracts

### 4. Error Handling
- Comprehensive error handling at each layer
- Graceful degradation
- Detailed error reporting

### 5. Performance Optimization
- Minimal overhead between layers
- Efficient transformation algorithms
- Connection pooling and caching

## Benefits

1. **Flexibility**: Easy to add new providers and protocols
2. **Maintainability**: Clear separation of responsibilities
3. **Testability**: Each layer can be tested independently
4. **Extensibility**: Plugin architecture for custom functionality
5. **Performance**: Optimized for high-throughput scenarios
6. **Reliability**: Robust error handling and recovery

## Best Practices

1. **Always use Compatibility layer** for transformations
2. **Keep Provider layer simple** - HTTP communication only
3. **Configure proper routing** in LLM Switch for optimal performance
4. **Implement comprehensive logging** for debugging
5. **Use appropriate timeouts** and retry mechanisms
6. **Validate all configurations** before deployment
7. **Monitor system health** and performance metrics

## Testing Strategy

### Unit Tests
- Test each layer independently
- Mock external dependencies
- Verify transformation rules
- Validate error handling

### Integration Tests
- Test complete request/response flow
- Verify provider integration
- Test tool calling functionality
- Performance benchmarking

### End-to-End Tests
- Real AI model testing
- Tool execution validation
- Error scenario testing
- Load testing

This architecture provides a solid foundation for building scalable, maintainable AI service integrations with proper separation of concerns and flexible configuration options.