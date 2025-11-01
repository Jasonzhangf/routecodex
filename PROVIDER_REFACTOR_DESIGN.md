# Provider模块重构设计方案

## 🎯 设计目标

基于RouteCodex 9大架构原则，重构Provider模块以实现：
- **统一抽象**: 所有Provider继承统一基类
- **认证分离**: API Key和OAuth认证分别抽象
- **配置驱动**: 完全基于配置的Provider实现
- **代码复用**: 消除重复的HTTP处理逻辑

## 🏗️ 新的架构层次

```
AbstractProvider (抽象基类)
├── ApiKeyProvider (API Key认证基类)
│   ├── LMStudioProvider (本地模型)
│   ├── OpenAIProvider (OpenAI官方)
│   ├── GLMProvider (智谱GLM)
│   └── GenericApiKeyProvider (通用API Key)
└── OAuthProvider (OAuth认证基类)
    ├── QwenProvider (通义千问)
    ├── IflowProvider (iFlow平台)
    └── GenericOAuthProvider (通用OAuth)
```

## 📋 核心接口设计

### 1. 统一Provider配置接口

```typescript
interface BaseProviderConfig {
  type: string;                    // Provider类型标识
  baseUrl: string;                 // API基础URL
  timeout?: number;                 // 请求超时(ms)
  maxRetries?: number;              // 最大重试次数
  headers?: Record<string, string>; // 额外请求头
}

interface ApiKeyConfig extends BaseProviderConfig {
  auth: {
    type: 'apikey';
    apiKey: string;
    headerName?: string;            // 默认 'Authorization'
    prefix?: string;                // 默认 'Bearer '
  };
}

interface OAuthConfig extends BaseProviderConfig {
  auth: {
    type: 'oauth';
    clientId: string;
    clientSecret?: string;
    tokenUrl: string;
    scopes?: string[];
    tokenFile?: string;
    deviceCodeUrl?: string;         // 设备流OAuth
  };
}

type ProviderConfig = ApiKeyConfig | OAuthConfig;
```

### 2. 抽象Provider基类

```typescript
abstract class AbstractProvider implements ProviderModule {
  readonly id: string;
  readonly abstract type: string;
  readonly abstract providerType: string;
  readonly config: ProviderConfig;

  protected logger: PipelineDebugLogger;
  protected httpClient: HttpClient;
  protected isInitialized = false;

  constructor(config: ProviderConfig, dependencies: ModuleDependencies);

  // 抽象方法 - 子类必须实现
  protected abstract getDefaultBaseUrl(): string;
  protected abstract buildEndpointUrl(path?: string): string;
  protected abstract buildAuthHeaders(): Record<string, string>;

  // 通用方法 - 基类实现
  async initialize(): Promise<void>;
  async processIncoming(request: UnknownObject): Promise<ProviderResponse>;
  async processOutgoing(response: UnknownObject): Promise<UnknownObject>;
  async checkHealth(): Promise<boolean>;
  async cleanup(): Promise<void>;

  // HTTP请求处理 - 统一实现
  protected async sendRequest(request: UnknownObject, endpoint?: string): Promise<ProviderResponse>;
  protected buildRequestHeaders(): Record<string, string>;
  protected handleRetryableError(error: unknown, attempt: number): Promise<void>;
}
```

### 3. API Key认证基类

```typescript
abstract class ApiKeyProvider extends AbstractProvider {
  readonly config: ApiKeyConfig;

  constructor(config: ApiKeyConfig, dependencies: ModuleDependencies);

  protected buildAuthHeaders(): Record<string, string> {
    const auth = this.config.auth;
    const headerName = auth.headerName || 'Authorization';
    const prefix = auth.prefix || 'Bearer ';

    return {
      [headerName]: `${prefix}${auth.apiKey}`
    };
  }

  // API Key Provider的通用实现
  protected async sendRequest(request: UnknownObject): Promise<ProviderResponse> {
    // 统一的HTTP请求逻辑，子类只需配置baseUrl和endpoint
    return super.sendRequest(request);
  }
}
```

### 4. OAuth认证基类

```typescript
abstract class OAuthProvider extends AbstractProvider {
  readonly config: OAuthConfig;
  protected tokenStorage: TokenStorage | null = null;
  protected oauthClient: OAuthClient;

  constructor(config: OAuthConfig, dependencies: ModuleDependencies);

  async initialize(): Promise<void> {
    await super.initialize();
    await this.initializeOAuth();
  }

  protected buildAuthHeaders(): Record<string, string> {
    if (!this.tokenStorage?.access_token) {
      throw new Error('No valid OAuth token available');
    }

    return {
      'Authorization': `Bearer ${this.tokenStorage.access_token}`
    };
  }

  // OAuth通用逻辑
  protected async ensureValidToken(): Promise<void>;
  protected async refreshToken(): Promise<void>;
  protected abstract createOAuthClient(): OAuthClient;
  protected abstract initializeOAuth(): Promise<void>;
}
```

## 🚀 具体Provider实现示例

### 1. LM Studio Provider (API Key)

```typescript
export class LMStudioProvider extends ApiKeyProvider {
  readonly type = 'lmstudio-http';
  readonly providerType = 'lmstudio';

  protected getDefaultBaseUrl(): string {
    return this.config.baseUrl || 'http://localhost:1234';
  }

  protected buildEndpointUrl(path?: string): string {
    const baseUrl = this.getDefaultBaseUrl();
    return path ? `${baseUrl}${path}` : `${baseUrl}/v1/chat/completions`;
  }
}
```

### 2. Qwen Provider (OAuth)

```typescript
export class QwenProvider extends OAuthProvider {
  readonly type = 'qwen-provider';
  readonly providerType = 'qwen';

  protected getDefaultBaseUrl(): string {
    return this.config.baseUrl || 'https://portal.qwen.ai/v1';
  }

  protected buildEndpointUrl(path?: string): string {
    const baseUrl = this.tokenStorage?.resource_url
      ? `https://${this.tokenStorage.resource_url}/v1`
      : this.getDefaultBaseUrl();
    return path ? `${baseUrl}${path}` : `${baseUrl}/chat/completions`;
  }

  protected createOAuthClient(): OAuthClient {
    return createQwenOAuth({
      tokenFile: this.config.auth.tokenFile,
      clientId: this.config.auth.clientId,
      clientSecret: this.config.auth.clientSecret
    });
  }

  protected async initializeOAuth(): Promise<void> {
    this.oauthClient = this.createOAuthClient();
    this.tokenStorage = await this.oauthClient.loadToken();
  }
}
```

## 📝 配置示例

### API Key Provider配置

```json
{
  "type": "lmstudio-http",
  "baseUrl": "http://localhost:1234",
  "auth": {
    "type": "apikey",
    "apiKey": "your-api-key",
    "headerName": "Authorization",
    "prefix": "Bearer "
  },
  "timeout": 60000,
  "maxRetries": 3
}
```

### OAuth Provider配置

```json
{
  "type": "qwen-provider",
  "baseUrl": "https://portal.qwen.ai/v1",
  "auth": {
    "type": "oauth",
    "clientId": "your-client-id",
    "clientSecret": "your-client-secret",
    "tokenUrl": "https://chat.qwen.ai/api/v1/oauth2/token",
    "deviceCodeUrl": "https://chat.qwen.ai/api/v1/oauth2/device/code",
    "scopes": ["openid", "profile", "model.completion"],
    "tokenFile": "./qwen-token.json"
  },
  "timeout": 300000,
  "maxRetries": 2
}
```

## 🔄 迁移策略

### 第一阶段：创建新基类
1. 实现`AbstractProvider`基类
2. 实现`ApiKeyProvider`和`OAuthProvider`基类
3. 创建统一的HTTP客户端

### 第二阶段：重构现有Provider
1. 将LM Studio Provider迁移到ApiKeyProvider
2. 将Qwen Provider重构为OAuthProvider
3. 统一配置格式和验证逻辑

### 第三阶段：清理和优化
1. 删除重复代码
2. 更新配置文件
3. 更新文档和示例

## 📈 预期收益

1. **代码减少**: 预计减少60%的重复代码
2. **维护性提升**: 统一的接口和行为
3. **扩展性增强**: 新增Provider只需实现少量方法
4. **配置统一**: 标准化的配置格式
5. **错误处理**: 统一的错误处理和重试机制

## 🎯 架构原则遵循

- ✅ **原则7: 功能分离** - 认证逻辑与HTTP逻辑分离
- ✅ **原则8: 配置驱动** - 完全基于配置的Provider实现
- ✅ **原则9: 模块化** - 按认证类型分模块，职责清晰
- ✅ **原则4: 快速死亡** - 统一的错误处理，立即失败
- ✅ **原则5: 暴露问题** - 标准化的错误信息和调试支持

---

**下一步**: 请审核此设计方案，我将根据您的反馈实现具体的重构代码。