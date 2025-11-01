# Provider统一化重构设计方案

## 🎯 设计理念

基于RouteCodex 9大核心架构原则，特别是**配置驱动原则**，将所有OpenAI兼容的Provider合并为一个统一的Provider，通过配置区分不同的服务。

## 🏗️ 统一Provider架构

```
UnifiedOpenAIProvider (单一Provider实现)
├── 支持 API Key 认证 (LM Studio, OpenAI, GLM等)
├── 支持 OAuth 认证 (Qwen, iFlow等)
├── 通过配置区分不同服务
└── 自动处理服务特定差异
```

## 📋 核心设计

### 1. 统一配置接口

```typescript
interface UnifiedProviderConfig {
  // 基础配置
  type: 'unified-openai-provider';
  providerType: string;              // 'lmstudio' | 'openai' | 'qwen' | 'glm' | 'iflow'
  baseUrl: string;

  // 通用配置
  timeout?: number;
  maxRetries?: number;
  headers?: Record<string, string>;

  // 认证配置 (二选一)
  auth: ApiKeyAuth | OAuthAuth;

  // 服务特定配置
  serviceConfig?: ServiceSpecificConfig;
}

interface ApiKeyAuth {
  type: 'apikey';
  apiKey: string;
  headerName?: string;              // 默认 'Authorization'
  prefix?: string;                  // 默认 'Bearer '
}

interface OAuthAuth {
  type: 'oauth';
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  tokenFile?: string;
}

interface ServiceSpecificConfig {
  // Qwen特定配置
  qwen?: {
    resourceUrl?: string;
    clientMetadata?: Record<string, string>;
  };

  // iFlow特定配置
  iflow?: {
    pkce?: boolean;
  };

  // GLM特定配置
  glm?: {
    compatibilityVersion?: string;
  };

  // LM Studio特定配置
  lmstudio?: {
    localPort?: number;
  };
}
```

### 2. 统一Provider实现

```typescript
export class UnifiedOpenAIProvider extends AbstractProvider {
  readonly type = 'unified-openai-provider';
  readonly providerType: string;
  readonly config: UnifiedProviderConfig;

  private authHandler: ApiKeyAuthHandler | OAuthAuthHandler;

  constructor(config: UnifiedProviderConfig, dependencies: ModuleDependencies) {
    super(config, dependencies);
    this.providerType = config.providerType;
    this.config = config;

    // 根据认证类型选择处理器
    if (config.auth.type === 'apikey') {
      this.authHandler = new ApiKeyAuthHandler(config.auth);
    } else {
      this.authHandler = new OAuthAuthHandler(config.auth, config.providerType);
    }
  }

  protected getDefaultBaseUrl(): string {
    // 服务特定的默认baseUrl
    const defaults = {
      'lmstudio': 'http://localhost:1234',
      'openai': 'https://api.openai.com/v1',
      'qwen': 'https://portal.qwen.ai/v1',
      'glm': 'https://open.bigmodel.cn/api/paas/v4',
      'iflow': 'https://api.iflow.ai/v1'
    };

    return this.config.baseUrl || defaults[this.providerType] || '';
  }

  protected buildEndpointUrl(path?: string): string {
    const baseUrl = this.getEffectiveBaseUrl();
    const defaultPath = this.getDefaultPath();
    return path ? `${baseUrl}${path}` : `${baseUrl}${defaultPath}`;
  }

  protected buildAuthHeaders(): Record<string, string> {
    return this.authHandler.buildHeaders();
  }

  protected async preprocessRequest(request: UnknownObject): Promise<UnknownObject> {
    // 服务特定的请求预处理
    switch (this.providerType) {
      case 'qwen':
        return this.preprocessQwenRequest(request);
      case 'glm':
        return this.preprocessGLMRequest(request);
      default:
        return request;
    }
  }

  protected async postprocessResponse(response: ProviderResponse): Promise<ProviderResponse> {
    // 服务特定的响应后处理
    switch (this.providerType) {
      case 'qwen':
        return this.postprocessQwenResponse(response);
      case 'glm':
        return this.postprocessGLMResponse(response);
      default:
        return response;
    }
  }

  // 服务特定的处理方法
  private getEffectiveBaseUrl(): string {
    // OAuth服务可能有动态baseUrl (如Qwen的resource_url)
    if (this.authHandler instanceof OAuthAuthHandler) {
      const dynamicUrl = this.authHandler.getDynamicBaseUrl();
      if (dynamicUrl) return dynamicUrl;
    }
    return this.getDefaultBaseUrl();
  }

  private getDefaultPath(): string {
    // 不同服务的默认端点
    const paths = {
      'lmstudio': '/v1/chat/completions',
      'openai': '/v1/chat/completions',
      'qwen': '/chat/completions',
      'glm': '/chat/completions',
      'iflow': '/v1/chat/completions'
    };

    return paths[this.providerType] || '/v1/chat/completions';
  }

  private preprocessQwenRequest(request: UnknownObject): UnknownObject {
    // Qwen特定的请求处理
    const allowedKeys = ['model', 'messages', 'input', 'parameters', 'tools', 'stream', 'response_format', 'user', 'metadata'];
    const filtered: UnknownObject = {};

    for (const key of allowedKeys) {
      if (key in request) {
        filtered[key] = request[key];
      }
    }

    return filtered;
  }

  private preprocessGLMRequest(request: UnknownObject): UnknownObject {
    // GLM特定的请求处理
    return {
      ...request,
      model: request.model || 'glm-4'
    };
  }

  private postprocessQwenResponse(response: ProviderResponse): ProviderResponse {
    // Qwen特定的响应处理
    return {
      ...response,
      data: {
        ...response.data,
        _providerMetadata: {
          provider: 'qwen',
          processingTime: response.metadata?.processingTime,
          timestamp: Date.now()
        }
      }
    };
  }

  private postprocessGLMResponse(response: ProviderResponse): ProviderResponse {
    // GLM特定的响应处理
    return {
      ...response,
      data: {
        ...response.data,
        _providerMetadata: {
          provider: 'glm',
          processingTime: response.metadata?.processingTime,
          timestamp: Date.now()
        }
      }
    };
  }
}
```

### 3. 认证处理器抽象

```typescript
// API Key认证处理器
class ApiKeyAuthHandler {
  constructor(private config: ApiKeyAuth) {}

  buildHeaders(): Record<string, string> {
    const headerName = this.config.headerName || 'Authorization';
    const prefix = this.config.prefix || 'Bearer ';

    return {
      [headerName]: `${prefix}${this.config.apiKey}`
    };
  }
}

// OAuth认证处理器
class OAuthAuthHandler {
  private tokenStorage: TokenStorage | null = null;
  private oauthClient: OAuthClient;

  constructor(
    private config: OAuthAuth,
    private providerType: string
  ) {
    this.oauthClient = this.createOAuthClient();
  }

  async initialize(): Promise<void> {
    this.tokenStorage = await this.oauthClient.loadToken();
  }

  buildHeaders(): Record<string, string> {
    if (!this.tokenStorage?.access_token) {
      throw new Error('No valid OAuth token available');
    }

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.tokenStorage.access_token}`
    };

    // 服务特定的额外头部
    if (this.providerType === 'qwen') {
      headers['User-Agent'] = 'google-api-nodejs-client/9.15.1';
      headers['X-Goog-Api-Client'] = 'gl-node/22.17.0';
      headers['Client-Metadata'] = this.getClientMetadata();
    }

    return headers;
  }

  getDynamicBaseUrl(): string | null {
    // Qwen的动态baseUrl
    if (this.providerType === 'qwen' && this.tokenStorage?.resource_url) {
      return `https://${this.tokenStorage.resource_url}/v1`;
    }
    return null;
  }

  private createOAuthClient(): OAuthClient {
    // 根据providerType创建对应的OAuth客户端
    switch (this.providerType) {
      case 'qwen':
        return createQwenOAuth(this.config);
      case 'iflow':
        return createIflowOAuth(this.config);
      default:
        throw new Error(`Unsupported OAuth provider: ${this.providerType}`);
    }
  }

  private getClientMetadata(): string {
    const metadata = [
      'ideType=IDE_UNSPECIFIED',
      'platform=PLATFORM_UNSPECIFIED',
      'pluginType=GEMINI'
    ];
    return metadata.join(',');
  }
}
```

## 🔧 配置示例

### LM Studio配置
```json
{
  "type": "unified-openai-provider",
  "providerType": "lmstudio",
  "baseUrl": "http://localhost:1234",
  "auth": {
    "type": "apikey",
    "apiKey": "lm-studio-key"
  },
  "serviceConfig": {
    "lmstudio": {
      "localPort": 1234
    }
  }
}
```

### Qwen配置
```json
{
  "type": "unified-openai-provider",
  "providerType": "qwen",
  "baseUrl": "https://portal.qwen.ai/v1",
  "auth": {
    "type": "oauth",
    "clientId": "your-client-id",
    "tokenUrl": "https://chat.qwen.ai/api/v1/oauth2/token",
    "deviceCodeUrl": "https://chat.qwen.ai/api/v1/oauth2/device/code",
    "tokenFile": "./qwen-token.json"
  },
  "serviceConfig": {
    "qwen": {
      "resourceUrl": "chat.qwen.ai"
    }
  }
}
```

### OpenAI配置
```json
{
  "type": "unified-openai-provider",
  "providerType": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "auth": {
    "type": "apikey",
    "apiKey": "sk-..."
  }
}
```

### GLM配置
```json
{
  "type": "unified-openai-provider",
  "providerType": "glm",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
  "auth": {
    "type": "apikey",
    "apiKey": "your-glm-key"
  },
  "serviceConfig": {
    "glm": {
      "compatibilityVersion": "1210"
    }
  }
}
```

## 🚀 实现优势

### 1. 极简架构
- **单一实现**: 只有一个Provider类
- **配置驱动**: 通过`providerType`区分服务
- **代码复用**: HTTP逻辑完全统一

### 2. 易于维护
- **集中管理**: 所有OpenAI兼容服务在一个地方
- **统一接口**: 相同的方法签名和行为
- **简化调试**: 统一的日志和错误处理

### 3. 高扩展性
- **新增服务**: 只需添加配置选项和少量处理逻辑
- **服务特性**: 通过`serviceConfig`支持服务特定功能
- **向后兼容**: 现有配置可以平滑迁移

### 4. 符合架构原则
- ✅ **原则8: 配置驱动** - 完全通过配置区分服务
- ✅ **原则7: 功能分离** - 认证逻辑与HTTP逻辑分离
- ✅ **原则9: 模块化** - 单一职责，易于理解
- ✅ **原则4: 快速死亡** - 统一错误处理

## 🔄 迁移策略

### 第一步：创建统一Provider
1. 实现`UnifiedOpenAIProvider`
2. 实现认证处理器
3. 支持基本的API Key和OAuth认证

### 第二步：迁移现有Provider
1. 将配置转换为统一格式
2. 逐步替换现有Provider
3. 测试所有服务类型

### 第三步：清理和优化
1. 删除旧的Provider实现
2. 更新文档和示例
3. 优化性能和错误处理

## 📈 预期收益

- **代码减少80%** - 从10个Provider类减少到1个
- **配置简化** - 统一的配置格式
- **维护成本降低** - 只需维护一个Provider
- **扩展性提升** - 新增服务只需配置

---

**这个方案是否符合您的预期？我可以开始实现具体的代码。**