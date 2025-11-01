# Provider统一简化设计方案

## 🎯 设计理念

基于RouteCodex配置驱动原则，创建一个统一的OpenAI兼容Provider，通过配置区分不同的服务，无需为每个服务创建单独的Provider类。

## 🏗️ 极简架构

```
UnifiedOpenAIProvider (单一实现)
├── 支持所有OpenAI兼容服务
├── 通过配置区分服务类型
├── API Key和OAuth认证模块
└── 配置驱动，无需代码变更
```

## 📁 项目结构

```
src/modules/pipeline/modules/provider/
├── legacy/                           # 旧代码 (保持不变)
│   ├── glm-http-provider.ts
│   ├── qwen-provider.ts
│   ├── lmstudio-provider-simple.ts
│   ├── openai-provider.ts
│   └── iflow-provider.ts
├── v2/                              # 新重构版本
│   ├── core/                         # 核心实现
│   │   ├── unified-openai-provider.ts # 统一OpenAI Provider
│   │   ├── provider-interface.ts     # 接口定义
│   │   └── provider-factory.ts       # Provider工厂
│   ├── auth/                         # 认证模块
│   │   ├── auth-interface.ts         # 认证接口
│   │   ├── apikey-auth.ts            # API Key认证
│   │   └── oauth-auth.ts             # OAuth认证
│   ├── config/                       # 配置管理
│   │   ├── provider-config.ts        # 配置接口
│   │   └── service-profiles.ts       # 各服务配置档案
│   └── utils/                        # 工具类
│       ├── http-client.ts            # HTTP客户端
│       └── request-normalizer.ts     # 请求标准化
└── shared/                           # 共享代码 (保持不变)
    ├── base-http-provider.ts
    └── provider-helpers.ts
```

## 🔧 统一配置设计

### 核心配置接口

```typescript
// v2/config/provider-config.ts
export interface UnifiedProviderConfig {
  type: 'unified-openai-provider';
  config: {
    // 服务标识 (关键配置)
    providerType: 'openai' | 'glm' | 'qwen' | 'iflow' | 'lmstudio';

    // 基础配置
    baseUrl?: string;
    timeout?: number;
    maxRetries?: number;

    // 认证配置 (二选一)
    auth: ApiKeyAuth | OAuthAuth;

    // 可选的服务特定配置
    overrides?: ServiceOverrides;
  };
}

export interface ApiKeyAuth {
  type: 'apikey';
  apiKey: string;
  headerName?: string;    // 默认 'Authorization'
  prefix?: string;        // 默认 'Bearer '
}

export interface OAuthAuth {
  type: 'oauth';
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  scopes?: string[];
  tokenFile?: string;
}

export interface ServiceOverrides {
  // 覆盖默认配置的选项
  baseUrl?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  endpoint?: string;      // 覆盖默认端点
}
```

### 服务配置档案

```typescript
// v2/config/service-profiles.ts
export const SERVICE_PROFILES = {
  openai: {
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultEndpoint: '/chat/completions',
    defaultModel: 'gpt-4',
    requiredAuth: ['apikey'],
    optionalAuth: []
  },

  glm: {
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultEndpoint: '/chat/completions',
    defaultModel: 'glm-4',
    requiredAuth: ['apikey'],
    optionalAuth: [],
    headers: {
      'Content-Type': 'application/json'
    }
  },

  qwen: {
    defaultBaseUrl: 'https://portal.qwen.ai/v1',
    defaultEndpoint: '/chat/completions',
    defaultModel: 'qwen-plus',
    requiredAuth: ['oauth'],
    optionalAuth: ['apikey'],
    headers: {
      'User-Agent': 'google-api-nodejs-client/9.15.1',
      'X-Goog-Api-Client': 'gl-node/22.17.0'
    }
  },

  iflow: {
    defaultBaseUrl: 'https://api.iflow.ai/v1',
    defaultEndpoint: '/v1/chat/completions',
    defaultModel: 'kimi',
    requiredAuth: ['oauth'],
    optionalAuth: []
  },

  lmstudio: {
    defaultBaseUrl: 'http://localhost:1234',
    defaultEndpoint: '/v1/chat/completions',
    defaultModel: 'local-model',
    requiredAuth: ['apikey'],
    optionalAuth: [],
    headers: {
      'Content-Type': 'application/json'
    }
  }
};
```

## 🚀 统一Provider实现

### 核心Provider类

```typescript
// v2/core/unified-openai-provider.ts
export class UnifiedOpenAIProvider implements IProviderV2 {
  readonly id: string;
  readonly type = 'unified-openai-provider';
  readonly providerType: string;
  readonly config: UnifiedProviderConfig;

  private authProvider: IAuthProvider;
  private httpClient: HttpClient;
  private logger: PipelineDebugLogger;
  private serviceProfile: ServiceProfile;
  private isInitialized = false;

  constructor(config: UnifiedProviderConfig, dependencies: ModuleDependencies) {
    this.id = `unified-provider-${Date.now()}`;
    this.config = config;
    this.providerType = config.config.providerType;
    this.logger = dependencies.logger as PipelineDebugLogger;
    this.serviceProfile = this.getServiceProfile();

    // 验证配置
    this.validateConfig();

    // 创建HTTP客户端
    this.httpClient = new HttpClient({
      baseUrl: this.getEffectiveBaseUrl(),
      timeout: config.config.timeout || 60000,
      maxRetries: config.config.maxRetries || 3
    });

    // 创建认证提供者
    this.authProvider = this.createAuthProvider(config.config.auth);
  }

  async initialize(): Promise<void> {
    await this.authProvider.initialize();
    this.isInitialized = true;
    this.logger.logModule(this.id, 'initialized', {
      providerType: this.providerType,
      baseUrl: this.getEffectiveBaseUrl()
    });
  }

  async processIncoming(request: UnknownObject): Promise<ProviderResponse> {
    if (!this.isInitialized) {
      throw new Error('Provider is not initialized');
    }

    const startTime = Date.now();

    try {
      // 标准化请求
      const normalizedRequest = this.normalizeRequest(request);

      // 构建请求配置
      const url = this.buildRequestUrl();
      const headers = this.buildRequestHeaders();
      const payload = JSON.stringify(normalizedRequest);

      this.logger.logProviderRequest(this.id, 'request-start', {
        url,
        providerType: this.providerType,
        model: normalizedRequest.model
      });

      // 发送HTTP请求
      const httpResponse = await this.httpClient.post(url, payload, headers);

      // 标准化响应
      const providerResponse = this.normalizeResponse(httpResponse, startTime);

      this.logger.logProviderRequest(this.id, 'request-success', {
        status: providerResponse.status,
        responseTime: providerResponse.metadata.processingTime
      });

      return providerResponse;

    } catch (error) {
      const processingTime = Date.now() - startTime;
      this.logger.logModule(this.id, 'request-error', {
        error: error instanceof Error ? error.message : String(error),
        processingTime
      });
      throw error;
    }
  }

  async processOutgoing(response: UnknownObject): Promise<UnknownObject> {
    return response;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const url = `${this.getEffectiveBaseUrl()}/models`;
      const headers = this.buildRequestHeaders();
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

  // 私有方法
  private getServiceProfile(): ServiceProfile {
    const profile = SERVICE_PROFILES[this.providerType];
    if (!profile) {
      throw new Error(`Unsupported provider type: ${this.providerType}`);
    }
    return profile;
  }

  private validateConfig(): void {
    const profile = this.serviceProfile;
    const auth = this.config.config.auth;

    // 验证认证类型
    const supportedAuthTypes = [...profile.requiredAuth, ...profile.optionalAuth];
    if (!supportedAuthTypes.includes(auth.type)) {
      throw new Error(
        `Auth type '${auth.type}' not supported for provider '${this.providerType}'. ` +
        `Supported types: ${supportedAuthTypes.join(', ')}`
      );
    }

    // 验证必需认证
    if (profile.requiredAuth.length > 0 && !profile.requiredAuth.includes(auth.type)) {
      throw new Error(
        `Provider '${this.providerType}' requires auth type: ${profile.requiredAuth.join(' or ')}`
      );
    }
  }

  private getEffectiveBaseUrl(): string {
    return (
      this.config.config.overrides?.baseUrl ||
      this.config.config.baseUrl ||
      this.serviceProfile.defaultBaseUrl
    );
  }

  private buildRequestUrl(): string {
    const baseUrl = this.getEffectiveBaseUrl();
    const endpoint = (
      this.config.config.overrides?.endpoint ||
      this.serviceProfile.defaultEndpoint
    );
    return `${baseUrl}${endpoint}`;
  }

  private buildRequestHeaders(): Record<string, string> {
    const baseHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'RouteCodex/2.0'
    };

    // 服务特定头部
    const serviceHeaders = this.serviceProfile.headers || {};

    // 配置覆盖头部
    const overrideHeaders = this.config.config.overrides?.headers || {};

    // 认证头部
    const authHeaders = this.authProvider.buildHeaders();

    return {
      ...baseHeaders,
      ...serviceHeaders,
      ...overrideHeaders,
      ...authHeaders
    };
  }

  private normalizeRequest(request: UnknownObject): UnknownObject {
    const normalized = {
      // 设置默认模型
      model: request.model ||
             this.config.config.overrides?.defaultModel ||
             this.serviceProfile.defaultModel,

      // 复制其他字段
      ...request
    };

    // 服务特定的请求标准化
    if (this.providerType === 'qwen') {
      return this.normalizeQwenRequest(normalized);
    }

    return normalized;
  }

  private normalizeQwenRequest(request: UnknownObject): UnknownObject {
    // Qwen特定的请求标准化
    const allowedKeys = [
      'model', 'messages', 'input', 'parameters',
      'tools', 'stream', 'response_format', 'user', 'metadata'
    ];

    const filtered: UnknownObject = {};
    for (const key of allowedKeys) {
      if (key in request) {
        filtered[key] = request[key];
      }
    }

    return filtered;
  }

  private normalizeResponse(httpResponse: any, startTime: number): ProviderResponse {
    const processingTime = Date.now() - startTime;

    return {
      data: httpResponse.data,
      status: httpResponse.status,
      headers: httpResponse.headers,
      metadata: {
        requestId: this.id,
        processingTime,
        providerType: this.providerType,
        model: httpResponse.data?.model,
        usage: httpResponse.data?.usage
      }
    };
  }

  private createAuthProvider(credentials: ApiKeyAuth | OAuthAuth): IAuthProvider {
    switch (credentials.type) {
      case 'apikey':
        return new ApiKeyAuth(credentials);
      case 'oauth':
        return new OAuthAuth(credentials, this.providerType);
      default:
        throw new Error(`Unsupported auth type: ${(credentials as any).type}`);
    }
  }
}
```

## 🔧 配置示例

### GLM配置 (纯配置驱动)

```json
{
  "type": "unified-openai-provider",
  "config": {
    "providerType": "glm",
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "auth": {
      "type": "apikey",
      "apiKey": "your-glm-api-key"
    },
    "overrides": {
      "defaultModel": "glm-4"
    }
  }
}
```

### Qwen配置 (OAuth认证)

```json
{
  "type": "unified-openai-provider",
  "config": {
    "providerType": "qwen",
    "auth": {
      "type": "oauth",
      "clientId": "your-client-id",
      "tokenUrl": "https://chat.qwen.ai/api/v1/oauth2/token",
      "deviceCodeUrl": "https://chat.qwen.ai/api/v1/oauth2/device/code",
      "tokenFile": "./qwen-token.json"
    }
  }
}
```

### LM Studio配置

```json
{
  "type": "unified-openai-provider",
  "config": {
    "providerType": "lmstudio",
    "baseUrl": "http://localhost:1234",
    "auth": {
      "type": "apikey",
      "apiKey": "not-required-for-local"
    }
  }
}
```

## 🚀 实施计划

### 第一阶段：创建基础结构 (1天)
1. 创建v2目录结构
2. 实现统一Provider核心类
3. 实现认证模块
4. 创建服务配置档案

### 第二阶段：GLM配置测试 (1天)
1. 创建GLM配置文件
2. 测试GLM服务接入
3. 验证API Key认证
4. 对比legacy版本功能

### 第三阶段：扩展其他服务 (2-3天)
1. 测试Qwen OAuth认证
2. 测试OpenAI API
3. 测试iFlow服务
4. 测试LM Studio本地服务

### 第四阶段：集成和优化 (2天)
1. 性能优化
2. 错误处理完善
3. 日志和监控集成
4. 文档更新

## 📈 预期收益

- **代码减少90%** - 从多个Provider类合并为1个
- **配置驱动** - 新增服务只需配置，无需代码
- **维护简化** - 只需维护一个Provider实现
- **接口透明** - 与现有代码完全兼容
- **认证统一** - API Key和OAuth认证标准化

---

**这个简化方案是否符合您的想法？GLM确实只需要配置即可，基于统一的OpenAI Provider。**