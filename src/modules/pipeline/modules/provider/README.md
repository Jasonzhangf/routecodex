# Provider 模块

Provider 模块是流水线架构的第 4 层（最终层），负责与 AI 服务提供商进行 HTTP 通信。它接收来自 Compatibility 层的标准化请求，发送给对应的 AI 服务，并将原始响应返回给上层处理。

## 🎯 模块概述

Provider 模块作为流水线的最终执行层，专注于：
- **HTTP 通信**: 标准的 HTTP 请求/响应处理
- **认证管理**: 多种认证方式支持（API Key、OAuth 2.0 等）
- **错误处理**: 统一的错误处理和重试机制
- **性能监控**: 请求性能统计和健康检查

## 📁 支持的 Provider

### 🏠 LM Studio Provider
- **实现文件**: `lmstudio-provider-simple.ts`
- **协议**: OpenAI Compatible API
- **认证**: API Key
- **特性**:
  - 本地 AI 模型支持
  - 完整的工具调用功能
  - 流式响应支持
  - 健康检查和重试机制

### 🔍 Qwen Provider
- **实现文件**: `qwen-provider.ts`, `qwen-oauth.ts`
- **协议**: OpenAI Compatible API
- **认证**: OAuth 2.0 + API Key
- **特性**:
  - 阿里云通义千问模型支持
  - 自动 OAuth 认证和令牌刷新
  - 多模型支持（qwen-turbo、qwen-max、qwen-plus）
  - 工具调用和流式响应

### 🌊 iFlow Provider
- **实现文件**: `iflow-provider.ts`, `iflow-oauth.ts`
- **协议**: OpenAI Compatible API
- **认证**: OAuth 2.0 + PKCE
- **特性**:
  - iFlow AI 服务支持
  - Kimi 模型支持
  - 增强的安全认证（PKCE）
  - 多种认证模式支持

### 🤖 OpenAI Provider
- **实现文件**: `openai-provider.ts`
- **协议**: OpenAI API
- **认证**: API Key
- **特性**:
  - 官方 OpenAI API 支持
  - GPT 模型系列支持
  - 完整的 API 功能支持
  - 高可靠性和性能

### 🔧 Generic HTTP Provider
- **实现文件**: `generic-http-provider.ts`
- **协议**: 可配置
- **认证**: 可配置
- **特性**:
  - 通用 HTTP Provider 框架
  - 可配置的协议支持
  - 灵活的认证机制
  - 自定义请求/响应处理

### 🟢 GLM HTTP Provider
- **实现文件**: `glm-http-provider.ts`
- **协议**: OpenAI Compatible API
- **认证**: API Key
- **特性**:
  - 智谱 GLM Coding API 支持
  - 工具调用优化
  - 1210 兼容性处理
  - 诊断和调试支持

## 🏗️ 模块架构

### 核心接口
```typescript
interface ProviderModule extends BaseModule {
  readonly type: string;
  readonly protocol: string;

  async processIncoming(request: any): Promise<ProviderResponse>;
  async processOutgoing?(response: any): Promise<any>;
}
```

### 标准响应格式
```typescript
interface ProviderResponse {
  data: any;                    // AI 服务响应数据
  status: number;               // HTTP 状态码
  headers: Record<string, string>; // 响应头
  metadata: {                   // 响应元数据
    requestId: string;
    providerId: string;
    modelId: string;
    responseTime: number;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  };
}
```

## 🔄 请求处理流程

### 标准请求流程
```typescript
async processIncoming(request: any): Promise<ProviderResponse> {
  // 1. 请求验证
  this.validateRequest(request);

  // 2. 构建 HTTP 请求
  const httpConfig = this.buildHttpConfig(request);

  // 3. 发送请求
  const response = await this.sendHttpRequest(httpConfig);

  // 4. 处理响应
  return this.processResponse(response);
}
```

### 错误处理和重试
```typescript
async sendHttpRequest(config: HttpConfig): Promise<Response> {
  const maxRetries = this.config.maxRetries || 3;
  const timeout = this.getTimeout();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(config.url, {
        ...config.options,
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      return response;

    } catch (error) {
      if (attempt === maxRetries) {
        throw this.handleFatalError(error, attempt);
      }

      await this.delay(this.getRetryDelay(attempt));
    }
  }
}
```

## 🛡️ 认证机制

### API Key 认证
```typescript
interface ApiKeyAuth {
  type: 'apikey';
  apiKey: string | string[];
  headerPrefix?: string; // 默认 "Bearer"
}

// 使用示例
const provider = new OpenAIProvider({
  type: 'openai-provider',
  config: {
    auth: {
      type: 'apikey',
      apiKey: 'sk-...',
      headerPrefix: 'Bearer'
    },
    baseUrl: 'https://api.openai.com/v1'
  }
}, dependencies);
```

### OAuth 2.0 认证
```typescript
interface OAuthConfig {
  type: 'oauth';
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  scopes: string[];
  tokenFile?: string;
}

// Qwen OAuth 示例
const qwenProvider = new QwenProvider({
  type: 'qwen-provider',
  config: {
    auth: {
      type: 'oauth',
      clientId: 'your-client-id',
      tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
      deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
      scopes: ['openid', 'profile', 'model.completion'],
      tokenFile: './qwen-token.json'
    },
    baseUrl: 'https://chat.qwen.ai'
  }
}, dependencies);
```

## ⚙️ 配置选项

### 通用配置
```typescript
interface ProviderConfig {
  type: string;                    // Provider 类型
  protocol: string;                // 协议类型
  baseUrl: string;                 // API 基础 URL
  auth: AuthConfig;                // 认证配置
  timeout?: number;                // 请求超时（毫秒）
  maxRetries?: number;             // 最大重试次数
  retryDelay?: number;             // 重试延迟（毫秒）
  enableHealthCheck?: boolean;     // 启用健康检查
  enableMetrics?: boolean;         // 启用性能指标
}
```

### 特定 Provider 配置

#### LM Studio 配置
```json
{
  "type": "lmstudio-http",
  "config": {
    "baseUrl": "http://localhost:1234",
    "auth": {
      "type": "apikey",
      "apiKey": "your-api-key"
    },
    "timeout": 60000,
    "maxRetries": 3,
    "enableHealthCheck": true
  }
}
```

#### Qwen 配置
```json
{
  "type": "qwen-provider",
  "config": {
    "baseUrl": "https://chat.qwen.ai",
    "auth": {
      "type": "oauth",
      "clientId": "your-client-id",
      "tokenUrl": "https://chat.qwen.ai/api/v1/oauth2/token",
      "scopes": ["openid", "profile", "model.completion"]
    },
    "timeout": 300000,
    "maxRetries": 2
  }
}
```

## 🚀 使用示例

### 基本 Provider 使用
```typescript
import { LMStudioProviderSimple } from './lmstudio-provider-simple.js';

const provider = new LMStudioProviderSimple({
  type: 'lmstudio-http',
  config: {
    baseUrl: 'http://localhost:1234',
    auth: {
      type: 'apikey',
      apiKey: 'your-api-key'
    },
    timeout: 60000,
    enableMetrics: true
  }
}, {
  errorHandlingCenter,
  debugCenter,
  logger
});

await provider.initialize();

// 处理请求
const response = await provider.processIncoming({
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  stream: false
});

console.log(response.data);
console.log(response.metadata.usage);
```

### 在流水线中使用
```typescript
// 流水线配置
const pipelineConfig = {
  modules: {
    provider: {
      type: 'lmstudio-http',
      config: {
        baseUrl: 'http://localhost:1234',
        auth: {
          type: 'apikey',
          apiKey: 'your-api-key'
        }
      }
    }
  }
};

// 请求处理流程
const response = await provider.processIncoming(chatRequest);
// {
//   data: { id: 'chat-xxx', choices: [...], usage: {...} },
//   status: 200,
//   headers: { 'content-type': 'application/json' },
//   metadata: {
//     requestId: 'req_123',
//     providerId: 'lmstudio',
//     modelId: 'gpt-4',
//     responseTime: 1250,
//     usage: { promptTokens: 20, completionTokens: 15, totalTokens: 35 }
//   }
// }
```

## 📊 性能监控

### 性能指标收集
```typescript
private collectMetrics(request: any, response: any, startTime: number): ProviderMetrics {
  const endTime = Date.now();
  const responseTime = endTime - startTime;

  return {
    requestId: request._metadata?.requestId,
    providerId: this.config.type,
    modelId: request.model,
    responseTime,
    status: response.status,
    success: response.ok,
    usage: response.data?.usage,
    hasTools: !!request.tools,
    messageCount: request.messages?.length || 0,
    timestamp: endTime
  };
}
```

### 健康检查
```typescript
async healthCheck(): Promise<HealthStatus> {
  try {
    const response = await fetch(`${this.config.baseUrl}/health`, {
      method: 'GET',
      timeout: 5000
    });

    return {
      status: response.ok ? 'healthy' : 'unhealthy',
      timestamp: Date.now(),
      providerId: this.config.type,
      responseTime: response.ok ? undefined : 'timeout'
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      timestamp: Date.now(),
      providerId: this.config.type,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
```

## 🌐 API 协议支持

### OpenAI 协议
- **端点**: `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`
- **认证**: Bearer Token
- **支持**: 流式响应、工具调用、函数调用

### OpenAI 兼容协议
- **Provider**: LM Studio, Qwen, iFlow, GLM
- **端点**: `/v1/chat/completions`
- **认证**: Bearer Token / OAuth 2.0
- **支持**: 流式响应、工具调用（兼容性处理）

### Responses 协议
- **端点**: `/v1/responses`
- **认证**: Bearer Token
- **支持**: 通过 LLM Switch 转换为 Chat 格式

## 🛠️ 调试和诊断

### 请求/响应快照
```typescript
// 保存请求快照（调试模式）
if (this.isDebugEnhanced) {
  await this.saveRequestSnapshot(request, 'provider-in');
}

// 保存响应快照（调试模式）
if (this.isDebugEnhanced) {
  await this.saveResponseSnapshot(response, 'provider-out');
}
```

### 错误诊断
```typescript
// 详细错误信息
const errorInfo = {
  requestId: request._metadata?.requestId,
  providerId: this.config.type,
  error: error.message,
  statusCode: error.status,
  url: error.config?.url,
  method: error.config?.method,
  headers: error.config?.headers,
  timestamp: Date.now()
};

this.logger.logModule(this.id, 'provider-error', errorInfo);
```

## 📝 环境变量

### 通用环境变量
- `ROUTECODEX_UPSTREAM_TIMEOUT_MS`: 上游请求超时时间（默认 300000ms）
- `ROUTECODEX_MAX_RETRIES`: 最大重试次数（默认 3）
- `ROUTECODEX_RETRY_DELAY`: 重试延迟时间（默认 1000ms）

### Provider 特定环境变量
- `GLM_HTTP_TIMEOUT_MS`: GLM Provider 超时时间
- `Qwen_OAUTH_TIMEOUT`: Qwen OAuth 超时时间
- `IFLOW_OAUTH_TIMEOUT`: iFlow OAuth 超时时间

## 🔧 扩展性

### 创建新的 Provider
```typescript
class CustomProvider implements ProviderModule {
  readonly type = 'custom-provider';
  readonly protocol = 'custom-api';

  async processIncoming(request: any): Promise<ProviderResponse> {
    // 1. 验证请求
    this.validateRequest(request);

    // 2. 构建请求配置
    const config = this.buildConfig(request);

    // 3. 发送 HTTP 请求
    const response = await this.sendRequest(config);

    // 4. 处理响应
    return this.processResponse(response);
  }

  private validateRequest(request: any): void {
    // 自定义验证逻辑
  }

  private buildConfig(request: any): HttpRequestConfig {
    // 自定义请求构建逻辑
  }

  private async sendRequest(config: HttpRequestConfig): Promise<Response> {
    // 自定义 HTTP 请求逻辑
  }

  private processResponse(response: Response): ProviderResponse {
    // 自定义响应处理逻辑
  }
}
```

### 自定义认证机制
```typescript
class CustomAuthHandler implements AuthHandler {
  async authenticate(config: AuthConfig): Promise<AuthResult> {
    switch (config.type) {
      case 'custom':
        return this.handleCustomAuth(config);
      case 'oauth':
        return this.handleOAuth(config);
      default:
        throw new Error(`Unsupported auth type: ${config.type}`);
    }
  }

  private async handleCustomAuth(config: CustomAuthConfig): Promise<AuthResult> {
    // 自定义认证逻辑
  }
}
```

## 📈 版本信息

- **当前版本**: 2.0.0
- **新增特性**: 增强的认证支持、性能监控、错误处理
- **兼容性**: RouteCodex Pipeline >= 2.0.0
- **TypeScript**: >= 5.0.0
- **Node.js**: >= 18.0.0

## 🔗 依赖关系

- **rcc-debugcenter**: 调试中心集成
- **PipelineDebugLogger**: 模块日志记录
- **ErrorHandlingCenter**: 错误处理集成
- **BaseModule**: 基础模块接口

## 🚨 已知限制

### 当前限制
1. **协议版本支持**: 主要支持 API v1 版本
2. **并发控制**: 单个 Provider 实例的并发限制
3. **连接池**: 简单的连接管理，无高级连接池
4. **缓存机制**: 无响应缓存功能

### 未来计划
1. **连接池管理**: 实现高级连接池和连接复用
2. **响应缓存**: 智能缓存机制
3. **负载均衡**: 多实例负载均衡
4. **协议版本管理**: 支持多版本 API

## 📞 技术支持

如有问题或建议，请：
1. 检查 Provider 配置是否正确
2. 验证认证信息是否有效
3. 查看调试日志了解详细信息
4. 检查网络连接和防火墙设置

## 🔄 更新日志

### v2.0.0 (2025-10-17)
- ✨ 新增完整的 Provider 框架文档
- 🔄 统一的 Provider 接口和响应格式
- 🛡️ 增强的错误处理和重试机制
- 📊 完善的性能监控和健康检查
- 🔧 支持多种认证机制（API Key、OAuth 2.0）
- 🌐 扩展的协议支持

### v1.5.0 (2025-01-22)
- 🔧 GLM Provider 1210 兼容性改进
- 📊 性能监控功能增强
- 🛡️ 错误处理机制优化

---

**最后更新**: 2025-10-17 - 全面更新 Provider 模块文档