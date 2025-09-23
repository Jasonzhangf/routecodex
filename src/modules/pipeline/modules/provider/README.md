# Provider 模块

Provider 模块提供与各种 AI 服务供应商的 HTTP 通信能力，支持 OAuth 认证、错误处理、健康检查和工具调用功能。

## 模块概述

Provider 模块是流水线架构的第 3 层，负责与 AI 服务供应商进行直接的 HTTP 通信。每个 Provider 实现都遵循标准接口，确保一致的行为和错误处理。

## 支持的供应商

### 🔧 Qwen (通义千问)
- **实现文件**: `qwen-provider.ts`, `qwen-oauth.ts`
- **认证方式**: OAuth 2.0 Device Flow + PKCE
- **API 端点**: `https://portal.qwen.ai/v1`
- **特性**:
  - 完整的 OAuth 设备流认证
  - 自动 Token 刷新
  - 与 CLIProxyAPI 100% 兼容的实现
  - 支持工具调用
  - 基于文件系统的 Token 存储

### 🎨 LM Studio
- **实现文件**: `lmstudio-provider-simple.ts`
- **认证方式**: API Key
- **API 端点**: `http://localhost:1234` (可配置)
- **特性**:
  - 简化的 HTTP 客户端实现
  - 零转换设计（转换由 Compatibility 模块处理）
  - 支持工具调用
  - 本地模型托管支持

### 🔗 iFlow
- **实现文件**: `iflow-provider.ts`
- **认证方式**: OAuth 2.0 Device Flow + Auth File解析
- **API 端点**: `https://api.iflow.cn/v1`
- **特性**:
  - 完整的 OAuth 设备流认证
  - PKCE 安全增强
  - 自动 Token 刷新
  - AuthResolver 文件解析支持

### 🌐 通用 HTTP Provider
- **实现文件**: `generic-http-provider.ts`
- **认证方式**: 多种认证方式支持
- **特性**:
  - API Key 认证
  - Bearer Token 认证
  - OAuth 2.0 认证
  - Basic 认证
  - 自定义认证头
  - 可配置的请求/响应转换

## 核心功能

### 🔐 认证管理
```typescript
// OAuth 设备流认证
const oauth = new QwenOAuth({
  tokenFile: '~/.qwen/oauth_creds.json'
});
await oauth.completeOAuthFlow();

// API Key 认证
const provider = new GenericHTTPProvider({
  auth: {
    type: 'apikey',
    apiKey: 'your-api-key',
    headerName: 'Authorization',
    prefix: 'Bearer '
  }
});
```

### 🔄 自动 Token 刷新
```typescript
// Token 过期自动处理
if (this.tokenStorage.isExpired()) {
  await this.oauth.refreshTokensWithRetry(this.tokenStorage.refresh_token);
}
```

### 🛡️ 错误处理
```typescript
// 统一的错误处理
private createProviderError(error: unknown, type: string): ProviderError {
  const providerError: ProviderError = new Error(errorObj.message) as ProviderError;
  providerError.type = type as any;
  providerError.statusCode = (error as any).status || (error as any).statusCode;
  providerError.details = (error as any).details || error;
  providerError.retryable = this.isErrorRetryable(type);
  return providerError;
}
```

### 📊 健康检查
```typescript
// 自动健康检查
async checkHealth(): Promise<boolean> {
  const response = await fetch(`${this.baseUrl}/v1/models`, {
    headers: this.headers
  });
  return response.ok;
}
```

### ⚡ 性能监控
```typescript
// 性能指标收集
const metrics = await provider.getMetrics();
console.log({
  requestCount: metrics.requestCount,
  successCount: metrics.successCount,
  averageResponseTime: metrics.averageResponseTime
});
```

## 文件结构

```
src/modules/pipeline/modules/provider/
├── qwen-provider.ts              # Qwen 主 Provider 实现
├── qwen-oauth.ts                 # Qwen OAuth 认证实现
├── lmstudio-provider-simple.ts   # LM Studio Provider（简化版）
├── iflow-provider.ts            # iFlow Provider 实现
├── generic-http-provider.ts      # 通用 HTTP Provider
└── README.md                     # 本文档
```

## 使用示例

### Qwen Provider 使用
```typescript
import { QwenProvider } from './qwen-provider.js';

const provider = new QwenProvider({
  type: 'qwen-provider',
  config: {
    baseUrl: 'https://portal.qwen.ai/v1',
    auth: {
      type: 'oauth',
      oauth: {
        tokenFile: '~/.qwen/oauth_creds.json'
      }
    }
  }
}, dependencies);

await provider.initialize();

const response = await provider.processIncoming({
  model: 'qwen3-coder-plus',
  messages: [
    { role: 'user', content: 'Hello!' }
  ]
});
```

### LM Studio Provider 使用
```typescript
import { LMStudioProviderSimple } from './lmstudio-provider-simple.js';

const provider = new LMStudioProviderSimple({
  type: 'lmstudio-http',
  config: {
    baseUrl: 'http://localhost:1234',
    auth: {
      type: 'apikey',
      apiKey: '${LMSTUDIO_API_KEY}'
    }
  }
}, dependencies);

await provider.initialize();

const response = await provider.processIncoming({
  model: 'llama2-7b-chat',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  tools: [/* 工具定义 */]
});
```

### 通用 HTTP Provider 使用
```typescript
import { GenericHTTPProvider } from './generic-http-provider.js';

const provider = new GenericHTTPProvider({
  type: 'generic-http',
  config: {
    type: 'custom-provider',
    baseUrl: 'https://api.example.com/v1',
    auth: {
      type: 'bearer',
      token: 'your-bearer-token'
    }
  }
}, dependencies);

await provider.initialize();
const response = await provider.processIncoming(request);
```

## 认证配置

### OAuth 2.0 Device Flow (Qwen)
```typescript
{
  auth: {
    type: 'oauth',
    oauth: {
      clientId: 'f0304373b74a44d2b584a3fb70ca9e56',
      deviceCodeUrl: 'https://chat.qwen.ai/api/v1/oauth2/device/code',
      tokenUrl: 'https://chat.qwen.ai/api/v1/oauth2/token',
      scopes: ['openid', 'profile', 'email', 'model.completion'],
      tokenFile: '~/.qwen/oauth_creds.json'
    }
  }
}
```

### API Key 认证
```typescript
{
  auth: {
    type: 'apikey',
    apiKey: '${API_KEY}',
    headerName: 'Authorization',  // 可选
    prefix: 'Bearer '             // 可选
  }
}
```

### Bearer Token 认证
```typescript
{
  auth: {
    type: 'bearer',
    token: '${BEARER_TOKEN}',
    refreshUrl: 'https://api.example.com/refresh',  // 可选
    refreshBuffer: 300000  // 5分钟提前刷新，可选
  }
}
```

## 错误处理

Provider 模块实现了完整的错误处理机制：

```typescript
// 网络错误
if (error.code === 'ECONNREFUSED') {
  throw this.createProviderError(error, 'network');
}

// API 错误
if (response.status === 401) {
  throw this.createProviderError({
    message: `Authentication failed: ${response.statusText}`,
    status: response.status
  }, 'authentication');
}

// 速率限制
if (response.status === 429) {
  throw this.createProviderError({
    message: 'Rate limit exceeded',
    status: response.status
  }, 'rate_limit');
}
```

## 状态管理

每个 Provider 都维护详细的状态信息：

```typescript
const status = provider.getStatus();
console.log({
  id: status.id,
  type: status.type,
  providerType: status.providerType,
  isInitialized: status.isInitialized,
  authStatus: status.authStatus,
  healthStatus: status.healthStatus
});
```

## 已知限制

### ❌ 当前缺失的功能
1. **SSE 流式响应支持** - Provider 层未实现 Server-Sent Events 处理
2. **WebSocket 支持** - 仅支持 HTTP 请求
3. **多线程请求** - 单线程处理模型
4. **连接池管理** - 每次请求新建连接

### 🔄 计划中的功能
1. **SSE 流式支持** - 添加 `text/event-stream` 处理能力
2. **连接复用** - HTTP 连接池实现
3. **并发控制** - 请求并发度限制
4. **缓存机制** - 响应缓存支持

## 调试支持

Provider 模块集成了完整的调试日志：

```typescript
// 请求开始
logger.logProviderRequest(requestId, 'request-start', {
  endpoint: this.getAPIEndpoint(),
  method: 'POST',
  hasAuth: !!this.tokenStorage
});

// 请求成功
logger.logProviderRequest(requestId, 'request-success', {
  responseTime: response.metadata?.processingTime,
  status: response.status
});

// 错误处理
logger.logProviderRequest(requestId, 'request-error', {
  error: error.message,
  status: error.statusCode
});
```

## 版本兼容性

- **Node.js**: >= 18.0.0
- **TypeScript**: >= 5.0.0
- **依赖**: rcc-basemodule >= 0.2.0
- **流水线**: RouteCodex Pipeline >= 1.0.0

## 最后更新

2025-01-22 - 添加完整的 OAuth 实现和 CLIProxyAPI 兼容性