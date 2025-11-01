# Provider统一重构最终设计方案

## 🎯 设计原则

1. **保持旧代码不变** - legacy代码路径完全不修改
2. **新增v2路径** - 新代码放在独立目录
3. **接口透明** - 新旧版本对外接口完全一致
4. **配置驱动** - OpenAI兼容服务通过配置区分
5. **认证分离** - API Key和OAuth独立模块

## 🏗️ 最终项目结构

```
src/modules/pipeline/modules/provider/
├── (现有文件保持不变)
├── glm-http-provider.ts              # 旧GLM Provider (不变)
├── qwen-provider.ts                  # 旧Qwen Provider (不变)
├── lmstudio-provider-simple.ts       # 旧LM Studio Provider (不变)
├── openai-provider.ts                # 旧OpenAI Provider (不变)
├── iflow-provider.ts                 # 旧iFlow Provider (不变)
├── generic-http-provider.ts          # 旧Generic Provider (不变)
├── generic-responses.ts              # 旧Generic Responses (不变)
├── qwen-oauth.ts                     # 旧Qwen OAuth (不变)
├── iflow-oauth.ts                    # 旧iFlow OAuth (不变)
├── shared/                           # 旧共享代码 (不变)
│   ├── base-http-provider.ts
│   └── provider-helpers.ts
├── README.md                         # 旧README (不变)
│
├── v2/                              # 新增v2目录 (全新代码)
│   ├── core/                         # 核心实现
│   │   ├── openai-standard.ts         # OpenAI标准实现
│   │   ├── provider-interface.ts     # 统一接口定义
│   │   └── provider-factory.ts       # Provider工厂
│   ├── auth/                         # 认证模块
│   │   ├── auth-interface.ts         # 认证接口
│   │   ├── apikey-auth.ts            # API Key认证实现
│   │   └── oauth-auth.ts             # OAuth认证实现
│   ├── config/                       # 配置管理
│   │   ├── provider-config.ts        # 配置接口定义
│   │   └── service-profiles.ts       # 各服务配置档案
│   ├── utils/                        # 工具类
│   │   ├── http-client.ts            # 统一HTTP客户端
│   │   ├── request-normalizer.ts     # 请求标准化
│   │   └── response-normalizer.ts    # 响应标准化
│   └── README-v2.md                  # v2版本说明
```

## 🔧 统一Provider配置设计

### 核心配置接口

```typescript
// v2/config/provider-config.ts
export interface UnifiedProviderConfig {
  type: 'openai-standard';
  config: {
    // 服务类型标识
    providerType: 'openai' | 'glm' | 'qwen' | 'iflow' | 'lmstudio';

    // 基础配置 (可选，会使用预设值)
    baseUrl?: string;
    timeout?: number;
    maxRetries?: number;

    // 认证配置 (必需)
    auth: ApiKeyAuth | OAuthAuth;

    // 服务特定覆盖配置 (可选)
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
  baseUrl?: string;
  defaultModel?: string;
  headers?: Record<string, string>;
  endpoint?: string;
}
```

### 服务预设配置

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
      'X-Goog-Api-Client': 'gl-node/22.17.0',
      'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI'
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
// v2/core/openai-standard.ts
export class OpenAIStandard implements IProviderV2 {
  readonly id: string;
  readonly type = 'openai-standard';
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

  // 私有方法实现...
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

### GLM配置 (配置驱动，无需代码)

```json
{
  "type": "openai-standard",
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
  "type": "openai-standard",
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

### OpenAI配置

```json
{
  "type": "openai-standard",
  "config": {
    "providerType": "openai",
    "auth": {
      "type": "apikey",
      "apiKey": "sk-your-openai-key"
    }
  }
}
```

## 🔄 接口透明性保证

### 现有用法 (完全不变)

```typescript
// 旧代码路径和用法保持不变
import { GLMHTTPProvider } from './glm-http-provider.js';

const glmProvider = new GLMHTTPProvider(config, dependencies);
await glmProvider.initialize();
const response = await glmProvider.processIncoming(request);
```

### 新版本用法 (接口一致)

```typescript
// 新代码路径，但接口完全一致
import { OpenAIStandard } from './v2/core/openai-standard.js';

const glmProvider = new OpenAIStandard(config, dependencies);
await glmProvider.initialize();
const response = await glmProvider.processIncoming(request);
```

## 🚀 实施计划

### 第一阶段：创建v2基础结构 (1天)
1. 创建v2目录和核心文件
2. 实现统一OpenAI Provider
3. 实现认证模块
4. 创建服务配置档案

### 第二阶段：GLM配置测试 (1天)
1. 创建GLM配置文件
2. 测试GLM服务接入
3. 验证与旧版本功能一致性
4. 性能对比测试

### 第三阶段：扩展其他服务 (2天)
1. 测试Qwen OAuth认证
2. 测试OpenAI API
3. 测试iFlow服务
4. 测试LM Studio本地服务

### 第四阶段：集成和优化 (2天)
1. Provider工厂实现
2. 配置兼容性处理
3. 错误处理和日志完善
4. 文档更新

## 📈 预期收益

- **零风险迁移** - 旧代码完全不变，新代码独立运行
- **代码减少90%** - 多个Provider合并为1个统一实现
- **配置驱动** - GLM等服务只需配置，无需代码
- **维护简化** - 只需维护一个Provider实现
- **接口透明** - 新旧版本接口完全一致

---

**这个最终设计是否满足您的需求？保持旧代码不变，新增v2路径，GLM通过配置即可使用。**