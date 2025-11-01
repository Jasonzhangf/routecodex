# Provider重构项目结构设计

## 🎯 设计原则

1. **接口透明**: 重构版本与未重构版本对外接口完全一致
2. **新旧分离**: 新代码与旧代码放在不同文件夹
3. **配置驱动**: 通过配置区分不同的OpenAI兼容服务
4. **认证分离**: API Key和OAuth使用独立的认证模块
5. **从GLM开始**: 第一个实现GLM作为参考模板

## 🏗️ 新的项目结构

```
src/modules/pipeline/modules/provider/
├── legacy/                           # 旧代码 (保持不变)
│   ├── glm-http-provider.ts
│   ├── qwen-provider.ts
│   ├── lmstudio-provider-simple.ts
│   ├── openai-provider.ts
│   ├── iflow-provider.ts
│   └── ...
├── v2/                              # 新重构版本
│   ├── core/                         # 核心抽象
│   │   ├── base-openai-provider.ts   # 基础OpenAI兼容Provider
│   │   ├── provider-interface.ts     # 统一Provider接口
│   │   └── provider-factory.ts       # Provider工厂
│   ├── auth/                         # 认证模块
│   │   ├── auth-interface.ts         # 认证接口
│   │   ├── apikey-auth.ts            # API Key认证
│   │   └── oauth-auth.ts             # OAuth认证
│   ├── providers/                    # 具体Provider实现
│   │   ├── glmv2-provider.ts         # GLM Provider v2 (第一个实现)
│   │   ├── qwen-v2-provider.ts       # Qwen Provider v2
│   │   ├── openai-v2-provider.ts     # OpenAI Provider v2
│   │   └── lmstudio-v2-provider.ts   # LM Studio Provider v2 (使用SDK)
│   ├── config/                       # 配置定义
│   │   ├── provider-config.ts        # Provider配置接口
│   │   └── service-configs.ts        # 各服务特定配置
│   └── utils/                        # 工具类
│       ├── request-normalizer.ts     # 请求标准化
│       ├── response-normalizer.ts    # 响应标准化
│       └── http-client.ts            # 统一HTTP客户端
├── shared/                           # 共享代码 (保持不变)
│   ├── base-http-provider.ts
│   └── provider-helpers.ts
└── README.md                         # Provider模块说明
```

## 📋 核心接口设计

### 1. 统一Provider接口 (确保接口透明)

```typescript
// v2/core/provider-interface.ts
export interface IProviderV2 extends ProviderModule {
  // 与现有ProviderModule接口完全一致
  readonly type: string;
  readonly providerType: string;
  readonly config: ModuleConfig;

  async initialize(): Promise<void>;
  async processIncoming(request: UnknownObject): Promise<ProviderResponse>;
  async processOutgoing(response: UnknownObject): Promise<UnknownObject>;
  async checkHealth(): Promise<boolean>;
  async cleanup(): Promise<void>;
}
```

### 2. 认证接口分离

```typescript
// v2/auth/auth-interface.ts
export interface IAuthProvider {
  readonly type: 'apikey' | 'oauth';

  // 认证生命周期
  initialize(): Promise<void>;
  buildHeaders(): Record<string, string>;
  validateCredentials(): Promise<boolean>;
  refreshCredentials?(): Promise<void>;
  cleanup(): Promise<void>;
}

export interface ApiKeyCredentials {
  type: 'apikey';
  apiKey: string;
  headerName?: string;    // 默认 'Authorization'
  prefix?: string;        // 默认 'Bearer '
}

export interface OAuthCredentials {
  type: 'oauth';
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  tokenFile?: string;
}

export type AuthCredentials = ApiKeyCredentials | OAuthCredentials;
```

### 3. 统一配置接口

```typescript
// v2/config/provider-config.ts
export interface UnifiedProviderConfig {
  // 基础配置 (与现有配置兼容)
  type: string;                    // Provider类型 (如 'glm-v2-provider')
  config: {
    providerType: string;          // 服务类型: 'glm' | 'qwen' | 'openai' | 'lmstudio'
    baseUrl?: string;
    auth: AuthCredentials;
    timeout?: number;
    maxRetries?: number;

    // 服务特定配置
    serviceConfig?: ServiceSpecificConfig;
  };
}

export interface ServiceSpecificConfig {
  // GLM特定配置
  glm?: {
    model?: string;                 // 默认模型
    apiVersion?: string;            // API版本
    compatibilityVersion?: string;  // 兼容版本
  };

  // Qwen特定配置
  qwen?: {
    resourceUrl?: string;
    clientMetadata?: Record<string, string>;
  };

  // OpenAI特定配置
  openai?: {
    organization?: string;
    project?: string;
  };

  // LM Studio特定配置 (使用SDK)
  lmstudio?: {
    useSDK?: boolean;              // 使用LM Studio SDK
    host?: string;                  // LM Studio host
    port?: number;                  // LM Studio port
  };
}
```

## 🚀 GLM v2 Provider实现 (第一个实现)

### 1. 基础OpenAI兼容Provider

```typescript
// v2/core/base-openai-provider.ts
export abstract class BaseOpenAIProvider implements IProviderV2 {
  readonly id: string;
  readonly abstract type: string;
  readonly providerType: string;
  readonly config: UnifiedProviderConfig;

  protected authProvider: IAuthProvider;
  protected httpClient: HttpClient;
  protected logger: PipelineDebugLogger;
  protected isInitialized = false;

  constructor(config: UnifiedProviderConfig, dependencies: ModuleDependencies) {
    this.id = `provider-v2-${Date.now()}`;
    this.config = config;
    this.providerType = config.config.providerType;
    this.logger = dependencies.logger as PipelineDebugLogger;
    this.httpClient = new HttpClient(config.config);

    // 根据认证类型创建认证提供者
    this.authProvider = this.createAuthProvider(config.config.auth);
  }

  // 抽象方法 - 子类实现服务特定逻辑
  protected abstract getServiceBaseUrl(): string;
  protected abstract getServiceEndpoint(): string;
  protected abstract preprocessRequest(request: UnknownObject): UnknownObject;
  protected abstract postprocessResponse(response: ProviderResponse): ProviderResponse;

  // 统一实现的方法
  async initialize(): Promise<void> {
    await this.authProvider.initialize();
    this.isInitialized = true;
    this.logger.logModule(this.id, 'initialized');
  }

  async processIncoming(request: UnknownObject): Promise<ProviderResponse> {
    if (!this.isInitialized) {
      throw new Error('Provider is not initialized');
    }

    // 预处理请求
    const processedRequest = this.preprocessRequest(request);

    // 构建请求配置
    const url = this.buildUrl();
    const headers = this.buildHeaders();
    const payload = JSON.stringify(processedRequest);

    // 发送HTTP请求
    const response = await this.httpClient.post(url, payload, headers);

    // 后处理响应
    return this.postprocessResponse(response);
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const url = `${this.getServiceBaseUrl()}/models`;
      const headers = this.buildHeaders();
      const response = await this.httpClient.get(url, headers);
      return response.status === 200 || response.status === 404;
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<void> {
    await this.authProvider.cleanup();
    this.isInitialized = false;
  }

  // 辅助方法
  private createAuthProvider(credentials: AuthCredentials): IAuthProvider {
    switch (credentials.type) {
      case 'apikey':
        return new ApiKeyAuth(credentials);
      case 'oauth':
        return new OAuthAuth(credentials, this.providerType);
      default:
        throw new Error(`Unsupported auth type: ${(credentials as any).type}`);
    }
  }

  private buildUrl(): string {
    const baseUrl = this.getServiceBaseUrl();
    const endpoint = this.getServiceEndpoint();
    return `${baseUrl}${endpoint}`;
  }

  private buildHeaders(): Record<string, string> {
    const baseHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'RouteCodex/2.0'
    };

    const authHeaders = this.authProvider.buildHeaders();

    return { ...baseHeaders, ...authHeaders };
  }
}
```

### 2. GLM v2 Provider实现

```typescript
// v2/providers/glmv2-provider.ts
export class GLMv2Provider extends BaseOpenAIProvider {
  readonly type = 'glm-v2-provider';
  readonly providerType = 'glm';

  protected getServiceBaseUrl(): string {
    const baseUrl = this.config.config.baseUrl;
    return baseUrl || 'https://open.bigmodel.cn/api/paas/v4';
  }

  protected getServiceEndpoint(): string {
    return '/chat/completions';
  }

  protected preprocessRequest(request: UnknownObject): UnknownObject {
    const serviceConfig = this.config.config.serviceConfig?.glm;

    // GLM特定的请求预处理
    const processedRequest = {
      ...request,
      // 设置默认模型
      model: request.model || serviceConfig?.model || 'glm-4',

      // GLM兼容性处理
      ...(serviceConfig?.compatibilityVersion && {
        compatibility_version: serviceConfig.compatibilityVersion
      })
    };

    return processedRequest;
  }

  protected postprocessResponse(response: ProviderResponse): ProviderResponse {
    // GLM特定的响应后处理
    return {
      ...response,
      data: {
        ...response.data,
        // 添加GLM特定的元数据
        _providerMetadata: {
          provider: 'glm',
          version: 'v2',
          processingTime: response.metadata?.processingTime,
          timestamp: Date.now(),
          model: response.data?.model
        }
      }
    };
  }
}
```

### 3. 认证模块实现

```typescript
// v2/auth/apikey-auth.ts
export class ApiKeyAuth implements IAuthProvider {
  readonly type: 'apikey' = 'apikey';
  private credentials: ApiKeyCredentials;

  constructor(credentials: ApiKeyCredentials) {
    this.credentials = credentials;
  }

  async initialize(): Promise<void> {
    // API Key认证无需特殊初始化
  }

  buildHeaders(): Record<string, string> {
    const headerName = this.credentials.headerName || 'Authorization';
    const prefix = this.credentials.prefix || 'Bearer ';

    return {
      [headerName]: `${prefix}${this.credentials.apiKey}`
    };
  }

  async validateCredentials(): Promise<boolean> {
    // 基础验证：检查API Key是否非空
    return !!this.credentials.apiKey?.trim();
  }

  async cleanup(): Promise<void> {
    // API Key认证无需清理
  }
}

// v2/auth/oauth-auth.ts
export class OAuthAuth implements IAuthProvider {
  readonly type: 'oauth' = 'oauth';
  private credentials: OAuthCredentials;
  private providerType: string;
  private tokenStorage: TokenStorage | null = null;
  private oauthClient: OAuthClient;

  constructor(credentials: OAuthCredentials, providerType: string) {
    this.credentials = credentials;
    this.providerType = providerType;
    this.oauthClient = this.createOAuthClient();
  }

  async initialize(): Promise<void> {
    // 根据Provider类型初始化OAuth客户端
    await this.loadToken();
  }

  buildHeaders(): Record<string, string> {
    if (!this.tokenStorage?.access_token) {
      throw new Error('No valid OAuth token available');
    }

    return {
      'Authorization': `Bearer ${this.tokenStorage.access_token}`
    };
  }

  async validateCredentials(): Promise<boolean> {
    return !!this.tokenStorage?.access_token && !this.tokenStorage.isExpired();
  }

  async refreshCredentials(): Promise<void> {
    if (this.tokenStorage?.refresh_token) {
      const newTokenData = await this.oauthClient.refreshTokens(this.tokenStorage.refresh_token);
      this.updateTokenStorage(newTokenData);
      await this.saveToken();
    }
  }

  async cleanup(): Promise<void> {
    await this.saveToken();
  }

  private createOAuthClient(): OAuthClient {
    // 根据providerType创建对应的OAuth客户端
    switch (this.providerType) {
      case 'qwen':
        return createQwenOAuth(this.credentials);
      case 'iflow':
        return createIflowOAuth(this.credentials);
      default:
        throw new Error(`Unsupported OAuth provider: ${this.providerType}`);
    }
  }

  private async loadToken(): Promise<void> {
    this.tokenStorage = await this.oauthClient.loadToken();
  }

  private updateTokenStorage(tokenData: any): void {
    if (this.tokenStorage) {
      this.oauthClient.updateTokenStorage(this.tokenStorage, tokenData);
    }
  }

  private async saveToken(): Promise<void> {
    if (this.tokenStorage) {
      await this.oauthClient.saveToken();
    }
  }
}
```

## 🔄 兼容性保证

### 1. 接口透明性

```typescript
// 现有用法 (不变化)
const glmProvider = new GLMHTTPProvider(config, dependencies);
await glmProvider.initialize();
const response = await glmProvider.processIncoming(request);

// 新版本用法 (接口完全一致)
const glmProviderV2 = new GLMv2Provider(config, dependencies);
await glmProviderV2.initialize();
const response = await glmProviderV2.processIncoming(request);
```

### 2. 配置兼容性

```typescript
// 现有配置格式 (继续支持)
{
  "type": "glm-http-provider",
  "config": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "auth": {
      "type": "apikey",
      "apiKey": "your-glm-key"
    }
  }
}

// 新配置格式 (扩展功能)
{
  "type": "glm-v2-provider",
  "config": {
    "providerType": "glm",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "auth": {
      "type": "apikey",
      "apiKey": "your-glm-key"
    },
    "serviceConfig": {
      "glm": {
        "model": "glm-4",
        "compatibilityVersion": "1210"
      }
    }
  }
}
```

## 🚀 实施计划

### 第一阶段：GLM v2实现 (1-2天)
1. 创建v2目录结构
2. 实现基础抽象类和接口
3. 实现GLM v2 Provider
4. 实现认证模块
5. 编写测试用例

### 第二阶段：其他Provider迁移 (3-5天)
1. 实现Qwen v2 Provider (OAuth)
2. 实现OpenAI v2 Provider
3. 实现LM Studio v2 Provider (SDK)
4. 实现iFlow v2 Provider (OAuth)

### 第三阶段：集成和优化 (2-3天)
1. Provider工厂实现
2. 配置兼容性处理
3. 性能优化和错误处理
4. 文档更新

### 第四阶段：测试和部署 (2-3天)
1. 全面测试
2. 与旧版本对比测试
3. 部署和监控
4. 清理旧代码 (可选)

---

**这个设计方案是否符合您的预期？我们可以从GLM v2开始实现。**