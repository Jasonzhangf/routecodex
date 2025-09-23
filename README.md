# RCC4 - RouteCodex Claude Code Router

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![Architecture](https://img.shields.io/badge/Architecture-4--layer-purple.svg)](./ARCHITECTURE_DOCUMENTATION.md)

A sophisticated AI service routing and transformation system that provides seamless integration with multiple AI providers through a clean, modular architecture.

## 🏗️ 4-Layer Architecture

RCC4 implements a sophisticated 4-layer pipeline architecture that provides clean separation of concerns and flexible protocol handling:

```
HTTP Request → LLM Switch → Workflow → Compatibility → Provider → AI Service
     ↓             ↓          ↓            ↓           ↓
  Request      Protocol   Flow       Format     Standard     Response
  Analysis     Routing    Control    Conversion   HTTP Server  Processing
```

### Layer 1: LLM Switch (Dynamic Routing Classification)
- **Request Analysis**: Analyzes incoming requests to determine optimal routing
- **Protocol Routing**: Routes requests to appropriate processing pipelines
- **Dynamic Classification**: Supports 7 routing categories (default, longcontext, thinking, background, websearch, vision, coding)

### Layer 2: Workflow (Flow Control)
- **Streaming Control**: Handles streaming/non-streaming request conversion
- **Request Processing**: Manages request flow and processing state
- **Response Handling**: Processes and transforms responses as needed

### Layer 3: Compatibility (Format Transformation)
- **Protocol Translation**: Converts between different AI service protocols
- **Format Adaptation**: Transforms request/response formats between providers
- **Tool Integration**: Handles tool calling format conversion and execution
- **Configuration-Driven**: Uses JSON configuration for transformation rules

### Layer 4: Provider (Standard HTTP Server)
- **HTTP Communication**: Manages all HTTP communications with AI services
- **Authentication**: Handles provider authentication and authorization
- **Error Handling**: Manages network errors and provider-specific issues

## ✨ Key Features

### 🔧 Tool Calling Support
- Full OpenAI-compatible tool calling implementation
- Supports multiple AI providers (LM Studio, OpenAI, Qwen, iFlow, Anthropic)
- Automatic tool format conversion and execution
- Real-time tool response processing

### 🔐 OAuth 2.0 Authentication
- Secure OAuth 2.0 Device Flow implementation
- Automatic token management and refresh
- PKCE (Proof Key for Code Exchange) security
- Persistent token storage and recovery

### 🌊 Streaming Support
- Native streaming request/response handling
- Automatic streaming/non-streaming conversion
- Chunked response processing
- Backward compatibility with non-streaming clients

### 🔄 Multi-Protocol Support
- OpenAI-compatible API endpoints
- Native provider protocol support
- Automatic protocol translation
- Configuration-driven transformations

### 🎯 Dynamic Routing
- Intelligent request routing based on content analysis
- 7 specialized routing categories
- Performance-optimized pipeline selection
- Custom routing rules support

## 🚀 Quick Start

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/routecodex.git
cd routecodex

# Install dependencies
npm install

# Build the project
npm run build
```

### Basic Usage

#### LM Studio Provider (API Key)

```javascript
import { OpenAIPassthroughLLMSwitch } from './dist/modules/pipeline/modules/llmswitch/openai-passthrough.js';
import { LMStudioCompatibility } from './dist/modules/pipeline/modules/compatibility/lmstudio-compatibility.js';
import { LMStudioProviderSimple } from './dist/modules/pipeline/modules/provider/lmstudio-provider-simple.js';
import { StreamingControlWorkflow } from './dist/modules/pipeline/modules/workflow/streaming-control.js';
import { DebugCenter } from 'rcc-debugcenter';
import { ErrorHandlingCenter } from 'rcc-errorhandling';

// Initialize components
const errorHandlingCenter = new ErrorHandlingCenter();
const debugCenter = new DebugCenter();
await errorHandlingCenter.initialize();

// Create 4-layer pipeline
const llmSwitch = new OpenAIPassthroughLLMSwitch({
  type: 'openai-passthrough',
  config: {
    protocol: 'openai',
    targetFormat: 'lmstudio'
  }
}, { errorHandlingCenter, debugCenter, logger });

const workflow = new StreamingControlWorkflow({
  type: 'streaming-control',
  config: { enableStreaming: true }
}, { errorHandlingCenter, debugCenter, logger });

const compatibility = new LMStudioCompatibility({
  type: 'lmstudio-compatibility',
  config: { toolsEnabled: true }
}, { errorHandlingCenter, debugCenter, logger });

const provider = new LMStudioProviderSimple({
  type: 'lmstudio-http',
  config: {
    baseUrl: 'http://localhost:1234',
    auth: { type: 'apikey', apiKey: 'your-api-key' }
  }
}, { errorHandlingCenter, debugCenter, logger });

// Initialize all modules
await llmSwitch.initialize();
await workflow.initialize();
await compatibility.initialize();
await provider.initialize();

// Process request through 4-layer pipeline
const request = {
  model: 'gpt-oss-20b-mlx',
  messages: [{ role: 'user', content: 'Hello!' }],
  tools: [...] // Optional tools
};

const result = await provider.processIncoming(
  await compatibility.processIncoming(
    await workflow.processIncoming(
      await llmSwitch.processIncoming(request)
    )
  )
);
```

#### Qwen OAuth Provider

```javascript
import { OpenAIPassthroughLLMSwitch } from './dist/modules/pipeline/modules/llmswitch/openai-passthrough.js';
import { QwenCompatibility } from './dist/modules/pipeline/modules/compatibility/qwen-compatibility.js';
import { QwenProvider } from './dist/modules/pipeline/modules/provider/qwen-provider.js';
import { StreamingControlWorkflow } from './dist/modules/pipeline/modules/workflow/streaming-control.js';
import { DebugCenter } from 'rcc-debugcenter';
import { ErrorHandlingCenter } from 'rcc-errorhandling';

// Initialize components
const errorHandlingCenter = new ErrorHandlingCenter();
const debugCenter = new DebugCenter();
await errorHandlingCenter.initialize();

// Create 4-layer pipeline with OAuth
const llmSwitch = new OpenAIPassthroughLLMSwitch({
  type: 'openai-passthrough',
  config: { protocol: 'openai', targetFormat: 'qwen' }
}, { errorHandlingCenter, debugCenter, logger });

const workflow = new StreamingControlWorkflow({
  type: 'streaming-control',
  config: { enableStreaming: true }
}, { errorHandlingCenter, debugCenter, logger });

const compatibility = new QwenCompatibility({
  type: 'qwen-compatibility',
  config: { toolsEnabled: true }
}, { errorHandlingCenter, debugCenter, logger });

const provider = new QwenProvider({
  type: 'qwen-provider',
  config: {
    type: 'qwen',
    baseUrl: 'https://chat.qwen.ai',
    oauth: {
      clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
      deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
      tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
      scopes: ['openid', 'profile', 'email', 'model.completion'],
      tokenFile: './qwen-token.json'
    }
  }
}, { errorHandlingCenter, debugCenter, logger });

// Initialize all modules
await llmSwitch.initialize();
await workflow.initialize();
await compatibility.initialize();
await provider.initialize(); // This will trigger OAuth flow if not authenticated

// Process request - OAuth is handled automatically
const request = {
  model: 'qwen-turbo',
  messages: [{ role: 'user', content: 'Hello! How can you help me?' }]
};

const result = await provider.processIncoming(
  await compatibility.processIncoming(
    await workflow.processIncoming(
      await llmSwitch.processIncoming(request)
    )
  )
);
```

### Tool Calling Example

```javascript
const requestWithTools = {
  model: 'gpt-oss-20b-mlx',
  messages: [
    {
      role: 'system',
      content: 'You are a helpful assistant with access to tools.'
    },
    {
      role: 'user',
      content: 'What is 15 * 25?'
    }
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'calculate',
        description: 'Perform mathematical calculations',
        parameters: {
          type: 'object',
          properties: {
            expression: {
              type: 'string',
              description: 'Mathematical expression to evaluate'
            }
          },
          required: ['expression']
        }
      }
    }
  ]
};

// Process through pipeline - tool calls will be automatically handled
const response = await processRequest(requestWithTools);

// Tool calls will be in response.choices[0].message.tool_calls
console.log('Tool calls:', response.choices[0].message.tool_calls);
```

## 📖 Documentation

- [Architecture Documentation](./ARCHITECTURE_DOCUMENTATION.md) - Detailed 4-layer architecture explanation
- [Configuration Guide](./docs/CONFIG_ARCHITECTURE.md) - Configuration options and examples
- [Pipeline Architecture](./docs/pipeline/ARCHITECTURE.md) - Pipeline system details
- [LM Studio Integration](./docs/lmstudio-tool-calling.md) - LM Studio specific setup

## 🔧 Configuration

### Basic Configuration

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
    "workflow": {
      "type": "streaming-control",
      "config": {
        "enableStreaming": true,
        "bufferSize": 1024,
        "timeout": 30000
      }
    },
    "compatibility": {
      "type": "lmstudio-compatibility",
      "config": {
        "toolsEnabled": true,
        "customRules": [
          {
            "id": "ensure-standard-tools-format",
            "transform": "mapping",
            "sourcePath": "tools",
            "targetPath": "tools",
            "mapping": {
              "type": "type",
              "function": "function"
            }
          }
        ]
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
        },
        "timeout": 60000
      }
    }
  }
}
```

## 🧪 Testing

```bash
# Run all tests
npm test

# Run specific test
npm test -- --testNamePattern="tool calling"

# Run integration test with LM Studio
node test-llmswitch-workflow-integration.mjs

# Run build
npm run build
```

## 🎯 Supported Providers

### ✅ Currently Supported
- **LM Studio**: Local AI model hosting with full tool support
- **OpenAI**: GPT models with function calling
- **Qwen**: Alibaba's language models with OAuth 2.0 authentication
- **iFlow**: AI service provider with OAuth 2.0 + PKCE authentication
- **Anthropic**: Claude model family

### 🔐 OAuth Authentication Details

#### Qwen OAuth Provider
- **Authentication**: OAuth 2.0 Device Flow
- **Token Management**: Automatic refresh with persistent storage
- **Security**: Standard OAuth 2.0 security model
- **Models**: qwen-turbo, qwen-max, qwen-turbo-latest

#### iFlow OAuth Provider
- **Authentication**: OAuth 2.0 Device Flow with PKCE
- **Token Management**: Automatic refresh with persistent storage
- **Security**: Enhanced PKCE (Proof Key for Code Exchange) protection
- **Models**: iflow-turbo, iflow-pro, iflow-turbo-latest

### 🔄 Planned Support
- Google Gemini
- Cohere
- Custom provider framework

## 📊 Performance

- **Request Processing**: < 50ms overhead per layer
- **Tool Calling**: Native provider optimization
- **Streaming**: Real-time chunk processing
- **Memory Usage**: Efficient module loading and caching

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **LM Studio**: For providing excellent local AI model hosting
- **OpenAI**: For the standard API specification
- **TypeScript**: For enabling type-safe development
- **Node.js**: For the robust runtime environment

## 📞 Support

For support, please:
1. Check the [documentation](./docs/)
2. Search existing [issues](https://github.com/your-username/routecodex/issues)
3. Create a new issue with detailed information

---

**Built with ❤️ using the 4-layer architecture pattern**
