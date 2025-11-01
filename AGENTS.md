# AGENTS 指南

基于RouteCodex 9大核心架构原则的实施指导文档，确保各模块严格按照架构原则进行开发。

## 🚨 构建顺序规范

- **涉及 `sharedmodule/` 下的修改，需要遵循"先模块、后整包"的顺序完成构建**
  - 先编译共享模块（例如：`sharedmodule/llmswitch-core`），再编译根包并进行安装或发布
  - 违反此顺序将导致运行时使用旧版本代码

## 🚨 9大核心架构原则实施指导

### 🧭 精准定位与根因导向（新增强制规则）
- 每次分析问题必须先精准定位问题来源与具体触发条件，不做“兜底性”宽松容错。
- 目标是“避免问题出现”，而不是“等问题出现后再容错”。
- 准备实施代码修改前，务必自问：
  - 这是否真正的 root cause？
  - 我的方案是否直击要害、不会引入副作用与重复处理？
- 修改应尽量发生在“唯一入口/唯一责任层”，避免在多处添加护栏造成行为分散与不可预测。
- 修改完成后，用最小可复现实验与真实样本交叉验证；验证不过不得合入。


### **原则映射表**
| 架构原则 | 实施章节 | 关键检查点 |
|---------|---------|-----------|
| 原则1: 统一工具处理 | llmswitch-core职责 | 工具调用是否全部通过llmswitch-core |
| 原则2: 最小兼容层 | 兼容层职责 | 是否只处理provider特定功能 |
| 原则3: 统一工具引导 | llmswitch-core职责 | 工具指引是否统一管理 |
| 原则4: 快速死亡 | 错误处理指南 | 是否有隐藏的fallback |
| 原则5: 暴露问题 | 日志监控指南 | 错误信息是否充分 |
| 原则6: 清晰解决 | 代码设计指南 | 是否有复杂分支逻辑 |
| 原则7: 功能分离 | 模块职责定义 | 模块功能是否重叠 |
| 原则8: 配置驱动 | 配置管理指南 | 是否存在硬编码 |
| 原则9: 模块化 | 文件结构指南 | 是否有巨型文件 |

## 🚨 模块职责边界定义

### **llmswitch-core (核心工具处理层)**
**职责范围**:
- ✅ **工具调用统一处理**: 所有端点的工具请求和响应处理
- ✅ **文本工具意图收割**: rcc.tool.v1, XML blocks, Execute blocks提取
- ✅ **工具调用标准化**: arguments字符串化, ID生成, 重复去重
- ✅ **工具结果包剥离**: 清理executed/result文本包
- ✅ **系统工具指引**: 统一工具schema增强和指引注入
- ✅ **格式转换**: Anthropic↔OpenAI工具格式转换

**禁止职责**:
- ❌ **Provider特定处理**: 不处理特定provider的字段适配
- ❌ **HTTP通信**: 不直接与外部服务通信
- ❌ **配置管理**: 不处理系统级配置

### **兼容层 (Compatibility Layer)**
**职责范围**:
- ✅ **Provider字段标准化**: 非标准OpenAI格式转换为标准格式
- ✅ **Reasoning内容处理**: provider特定的reasoning_content字段处理
- ✅ **字段映射**: usage, created_at等字段标准化
- ✅ **最小清理**: 避免provider错误的必要清理

**禁止职责**:
- ❌ **工具调用转换**: 不处理工具调用格式转换
- ❌ **文本工具收割**: 不从文本中提取工具意图
- ❌ **重复处理**: 避免与llmswitch-core功能重复

### **服务器端点 (Server Endpoints)**
**职责范围**:
- ✅ **HTTP协议处理**: 请求解析, 响应格式化
- ✅ **认证授权**: API key验证, 权限检查
- ✅ **流式处理**: SSE事件管理, 流控制
- ✅ **错误处理**: HTTP错误码, 异常响应

**禁止职责**:
- ❌ **工具处理逻辑**: 不实现工具转换或收割
- ❌ **格式转换**: 不处理数据格式转换
- ❌ **业务逻辑**: 不处理具体的AI业务逻辑

### **Provider层**
**职责范围**:
- ✅ **HTTP通信**: 与外部AI服务的HTTP请求/响应
- ✅ **认证管理**: API key, token管理
- ✅ **连接管理**: 连接池, 超时, 重试

## 🚨 新系统规则实施指导

### **规则1: 快速死亡原则 (Fail Fast) 实施指南**

**❌ 错误实践**:
```typescript
// 不要这样做 - 尝试fallback
try {
  const result = await riskyOperation();
  return result;
} catch (error) {
  // 不要fallback到默认值
  return defaultValue; // ❌ 隐藏了真正的问题
}
```

**✅ 正确实践**:
```typescript
// 正确做法 - 快速死亡
async function processRequest(request: Request): Promise<Response> {
  // 验证输入，有问题立即抛出
  if (!request.model) {
    throw new ValidationError('Model is required');
  }

  // 不try-catch，让错误冒泡
  const result = await externalServiceCall(request);

  // 简单验证，有问题立即抛出
  if (!result.data) {
    throw new ProcessingError('Invalid response from service');
  }

  return result;
}
```

**实施要点**:
- 移除不必要的try-catch块
- 使用严格的类型验证
- 错误信息要包含足够的上下文
- 避免复杂的错误恢复逻辑

### **规则2: 暴露问题原则 (No Silent Failures) 实施指南**

**❌ 错误实践**:
```typescript
// 不要这样做 - 沉默失败
function processData(data: any): Result {
  try {
    // 处理逻辑
    return processDataInternal(data);
  } catch (error) {
    console.log('Processing failed'); // ❌ 不够详细
    return null; // ❌ 隐藏了错误原因
  }
}
```

**✅ 正确实践**:
```typescript
// 正确做法 - 暴露问题
import { logger } from './utils/logger';

interface ProcessingContext {
  requestId: string;
  step: string;
  data?: any;
}

async function processData(data: any, context: ProcessingContext): Promise<Result> {
  logger.info('Starting data processing', {
    requestId: context.requestId,
    step: context.step,
    dataType: typeof data
  });

  try {
    const result = await processDataInternal(data);

    logger.info('Processing completed successfully', {
      requestId: context.requestId,
      resultSize: JSON.stringify(result).length
    });

    return result;
  } catch (error) {
    logger.error('Processing failed', {
      requestId: context.requestId,
      step: context.step,
      error: error.message,
      stack: error.stack,
      inputPreview: JSON.stringify(data).substring(0, 200)
    });

    // 重新抛出，让上层处理
    throw new ProcessingError(`Failed to process data in step ${context.step}: ${error.message}`, {
      cause: error,
      context
    });
  }
}
```

**实施要点**:
- 使用结构化日志记录所有关键操作
- 错误信息要包含完整的上下文
- 监控关键路径的性能和错误率
- 提供调试友好的错误信息

### **规则3: 清晰解决原则 (No Fallback Logic) 实施指南**

**❌ 错误实践**:
```typescript
// 不要这样做 - 复杂的fallback逻辑
function getProvider(config: Config) {
  if (config.primaryProvider && isProviderAvailable(config.primaryProvider)) {
    return createProvider(config.primaryProvider);
  } else if (config.secondaryProvider && isProviderAvailable(config.secondaryProvider)) {
    return createProvider(config.secondaryProvider);
  } else if (config.fallbackProvider) {
    return createProvider(config.fallbackProvider);
  } else {
    throw new Error('No provider available'); // ❌ 复杂且不可预测
  }
}
```

**✅ 正确实践**:
```typescript
// 正确做法 - 明确的解决方案
interface ProviderConfig {
  provider: string;
  endpoint: string;
  timeout: number;
}

function validateProviderConfig(config: ProviderConfig): void {
  if (!config.provider) {
    throw new ValidationError('Provider is required');
  }
  if (!config.endpoint) {
    throw new ValidationError('Endpoint is required');
  }
  if (config.timeout <= 0) {
    throw new ValidationError('Timeout must be positive');
  }
}

function createProvider(config: ProviderConfig): Provider {
  validateProviderConfig(config);

  // 单一、明确的创建逻辑
  switch (config.provider) {
    case 'openai':
      return new OpenAIProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    default:
      throw new ValidationError(`Unsupported provider: ${config.provider}`);
  }
}
```

**实施要点**:
- 消除多层fallback逻辑
- 使用明确的验证和错误处理
- 每个功能都有单一的处理路径
- 避免复杂的条件分支

### **规则4: 功能分离原则 (No Functional Overlap) 实施指南**

**❌ 错误实践**:
```typescript
// 不要这样做 - 功能重叠
class RequestHandler {
  async handleRequest(request: Request) {
    // ❌ HTTP处理 + 业务逻辑 + 数据验证混合
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      throw new Error('Unauthorized');
    }

    // ❌ 数据验证逻辑
    if (!request.body.model) {
      throw new Error('Model required');
    }

    // ❌ 业务逻辑
    const result = await this.processModel(request.body.model);

    // ❌ HTTP响应格式化
    return new Response(JSON.stringify(result), {
      headers: { 'content-type': 'application/json' }
    });
  }
}
```

**✅ 正确实践**:
```typescript
// 正确做法 - 功能分离
// HTTP处理层
class HTTPHandler {
  constructor(
    private authMiddleware: AuthMiddleware,
    private requestValidator: RequestValidator,
    private businessService: BusinessService,
    private responseFormatter: ResponseFormatter
  ) {}

  async handleRequest(request: Request): Promise<Response> {
    // 1. 认证 (单一职责)
    await this.authMiddleware.authenticate(request);

    // 2. 验证 (单一职责)
    const validatedData = await this.requestValidator.validate(request);

    // 3. 业务逻辑 (单一职责)
    const result = await this.businessService.process(validatedData);

    // 4. 响应格式化 (单一职责)
    return this.responseFormatter.format(result);
  }
}

// 认证中间件 (单一职责)
class AuthMiddleware {
  async authenticate(request: Request): Promise<void> {
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      throw new UnauthorizedError('Missing authorization header');
    }

    // 认证逻辑...
  }
}

// 请求验证器 (单一职责)
class RequestValidator {
  async validate(request: Request): Promise<ValidatedRequest> {
    const body = await request.json();

    if (!body.model) {
      throw new ValidationError('Model is required');
    }

    return new ValidatedRequest(body);
  }
}
```

**实施要点**:
- 每个类/模块只负责一个明确的功能
- 明确定义模块间的接口和职责
- 避免功能重叠和职责混乱
- 使用依赖注入管理模块间关系

### **规则5: 配置驱动原则 (No Hardcoding) 实施指南**

**❌ 错误实践**:
```typescript
// 不要这样做 - 硬编码
class ServiceClient {
  private baseUrl = 'https://api.openai.com'; // ❌ 硬编码
  private timeout = 30000; // ❌ 硬编码
  private maxRetries = 3; // ❌ 硬编码

  async callAPI(endpoint: string, data: any) {
    const url = `${this.baseUrl}/v1/${endpoint}`; // ❌ 硬编码路径
    // ...
  }
}
```

**✅ 正确实践**:
```typescript
// 正确做法 - 配置驱动
interface ServiceConfig {
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  apiVersion: string;
  retryDelay: number;
}

class ConfigValidator {
  static validate(config: ServiceConfig): void {
    if (!config.baseUrl || !isValidUrl(config.baseUrl)) {
      throw new ConfigError('Invalid baseUrl');
    }
    if (config.timeout <= 0) {
      throw new ConfigError('Timeout must be positive');
    }
    if (config.maxRetries < 0) {
      throw new ConfigError('MaxRetries must be non-negative');
    }
  }
}

class ServiceClient {
  private config: ServiceConfig;

  constructor(config: ServiceConfig) {
    ConfigValidator.validate(config);
    this.config = config;
  }

  async callAPI(endpoint: string, data: any): Promise<any> {
    const url = `${this.config.baseUrl}/${this.config.apiVersion}/${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new APIError(`API call failed: ${response.status}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// 配置文件 (service-config.json)
{
  "services": {
    "openai": {
      "baseUrl": "https://api.openai.com",
      "timeout": 30000,
      "maxRetries": 3,
      "apiVersion": "v1",
      "retryDelay": 1000
    }
  }
}
```

**实施要点**:
- 所有可变参数都通过配置文件管理
- 实施严格的配置验证
- 提供类型安全的配置接口
- 支持配置热更新

### **规则6: 模块化原则 (No Giant Files) 实施指南**

**❌ 错误实践**:
```typescript
// 不要这样做 - 巨型文件 (600+ 行)
// file: request-processor.ts
export class RequestProcessor {
  // 认证逻辑 (100 行)
  async authenticate(request: Request): Promise<boolean> {
    // ... 100 lines of authentication code
  }

  // 验证逻辑 (150 行)
  async validateRequest(request: Request): Promise<ValidatedRequest> {
    // ... 150 lines of validation code
  }

  // 业务逻辑 (200 行)
  async processBusiness(data: ValidatedRequest): Promise<BusinessResult> {
    // ... 200 lines of business logic
  }

  // 响应处理 (150 行)
  formatResponse(result: BusinessResult): Response {
    // ... 150 lines of response formatting
  }
}
```

**✅ 正确实践**:
```typescript
// 正确做法 - 模块化拆分
// file: auth/authenticator.ts (80 行)
export class Authenticator {
  async authenticate(request: Request): Promise<AuthContext> {
    // 专注于认证逻辑
  }
}

// file: validation/request-validator.ts (120 行)
export class RequestValidator {
  async validate(request: Request): Promise<ValidatedRequest> {
    // 专注于验证逻辑
  }
}

// file: business/business-processor.ts (150 行)
export class BusinessProcessor {
  async process(data: ValidatedRequest): Promise<BusinessResult> {
    // 专注于业务逻辑
  }
}

// file: response/response-formatter.ts (100 行)
export class ResponseFormatter {
  format(result: BusinessResult): Response {
    // 专注于响应格式化
  }
}

// file: request-processor.ts (50 行) - 协调器
export class RequestProcessor {
  constructor(
    private authenticator: Authenticator,
    private validator: RequestValidator,
    private processor: BusinessProcessor,
    private formatter: ResponseFormatter
  ) {}

  async process(request: Request): Promise<Response> {
    const authContext = await this.authenticator.authenticate(request);
    const validatedData = await this.validator.validate(request);
    const result = await this.processor.process(validatedData);
    return this.formatter.format(result);
  }
}
```

**实施要点**:
- 定期检查文件大小，超过500行就要考虑拆分
- 按功能职责拆分代码，每个文件只有一个明确职责
- 使用依赖注入管理模块间关系
- 保持模块的独立性和可测试性

## 📋 系统规则检查清单

### 开发时自查清单
- [ ] 是否有任何硬编码值需要配置化？
- [ ] 是否有不必要的try-catch块隐藏了错误？
- [ ] 是否有复杂的fallback逻辑需要简化？
- [ ] 每个模块的职责是否明确且不重叠？
- [ ] 文件大小是否超过500行？
- [ ] 错误信息是否包含足够的调试信息？
- [ ] 关键操作是否都有日志记录？

### 代码审查检查清单
- [ ] 错误处理是否遵循快速死亡原则？
- [ ] 日志记录是否完整且结构化？
- [ ] 配置是否外部化并经过验证？
- [ ] 模块职责是否单一且明确？
- [ ] 代码结构是否模块化且可维护？
- [ ] 是否有功能重叠或重复代码？
- [ ] 异常处理是否暴露了问题根源？
- ✅ **健康检查**: 服务可用性监控

**禁止职责**:
- ❌ **数据转换**: 不修改请求/响应数据格式
- ❌ **工具处理**: 不处理工具调用相关逻辑
- ❌ **业务逻辑**: 不处理AI相关的业务逻辑

---

## 🚨 9大架构原则详细实施指南

### **原则1-3: 技术架构基础**

#### **统一工具处理实施要点**
- **唯一入口确认**: 所有工具调用必须通过 `sharedmodule/llmswitch-core/src/conversion/shared/tool-canonicalizer.ts`
- **三端一致性**: Chat、Responses、Messages端点使用相同的工具处理逻辑
- **禁止重复**: 服务器端点、兼容层、Provider层不得重复实现工具处理
- **检查清单**:
  - [ ] 工具调用是否全部通过llmswitch-core处理？
  - [ ] 兼容层是否避免了工具转换逻辑？
  - [ ] 服务器端点是否直接委托给llmswitch-core？

#### **最小兼容层实施要点**
- **专注特殊扩展**: 只处理provider特有的非OpenAI标准功能
- **字段标准化**: reasoning_content、usage等字段转换
- **禁止兜底**: 不实现fallback或工具转换逻辑
- **检查清单**:
  - [ ] 兼容层是否只处理provider特定字段？
  - [ ] 是否避免了与llmswitch-core功能重复？
  - [ ] 是否没有工具调用转换逻辑？

### **原则4-6: 系统质量保证**

#### **快速死亡原则实施要点**
- **立即失败**: 遇到错误立即抛出，不尝试降级
- **移除过度包装**: 避免不必要的try-catch块
- **明确错误信息**: 提供完整上下文的错误描述
- **实施策略**:
  ```typescript
  // ❌ 错误：隐藏错误
  try {
    return await riskyOperation();
  } catch (error) {
    return defaultValue; // 隐藏了真正问题
  }

  // ✅ 正确：快速死亡
  if (!isValidInput(input)) {
    throw new ValidationError(`Invalid input: ${JSON.stringify(input)}`);
  }
  return await riskyOperation(); // 让错误直接冒泡
  ```

#### **暴露问题原则实施要点**
- **结构化日志**: 记录所有关键操作和异常
- **完整上下文**: 错误信息包含足够的调试信息
- **监控覆盖**: 对关键路径添加监控和告警
- **实施策略**:
  ```typescript
  // ✅ 正确：暴露问题
  try {
    const result = await processRequest(data);
    logger.info('Processing completed', { requestId, resultSize: result.length });
    return result;
  } catch (error) {
    logger.error('Processing failed', {
      requestId,
      error: error.message,
      stack: error.stack,
      inputPreview: JSON.stringify(data).substring(0, 200)
    });
    throw error; // 重新抛出，不隐藏
  }
  ```

#### **清晰解决原则实施要点**
- **单一解决方案**: 每个问题都有明确的处理方式
- **确定性行为**: 系统行为可预测和可重复
- **简化分支**: 减少复杂的条件逻辑
- **实施策略**:
  ```typescript
  // ❌ 错误：复杂fallback
  if (primaryProvider.available) {
    return usePrimary();
  } else if (secondaryProvider.available) {
    return useSecondary();
  } else {
    return useFallback(); // 复杂且不可预测
  }

  // ✅ 正确：明确解决方案
  validateProviderConfig(config);
  return createProvider(config.provider); // 单一明确路径
  ```

### **原则7-9: 可维护性设计**

#### **功能分离原则实施要点**
- **单一职责**: 每个模块只负责一个明确功能
- **明确接口**: 模块间接口明确定义
- **避免重叠**: 严格防止功能重复
- **实施策略**:
  ```typescript
  // ❌ 错误：功能混合
  class RequestHandler {
    async handle(request) {
      this.authenticate(request);    // 认证逻辑
      this.validate(request);       // 验证逻辑
      this.processBusiness(request); // 业务逻辑
      this.formatResponse(result);   // 响应逻辑
    }
  }

  // ✅ 正确：功能分离
  class RequestHandler {
    constructor(
      private auth: AuthService,
      private validator: Validator,
      private business: BusinessService,
      private formatter: ResponseFormatter
    ) {}

    async handle(request) {
      await this.auth.authenticate(request);
      const validated = await this.validator.validate(request);
      const result = await this.business.process(validated);
      return this.formatter.format(result);
    }
  }
  ```

#### **配置驱动原则实施要点**
- **外部化配置**: 所有可变参数通过配置管理
- **配置验证**: 实施严格的配置验证机制
- **类型安全**: 使用TypeScript确保配置类型安全
- **实施策略**:
  ```typescript
  // ❌ 错误：硬编码
  class ServiceClient {
    private baseUrl = 'https://api.openai.com'; // 硬编码
    private timeout = 30000; // 硬编码
  }

  // ✅ 正确：配置驱动
  interface ServiceConfig {
    baseUrl: string;
    timeout: number;
  }

  class ServiceClient {
    constructor(private config: ServiceConfig) {
      this.validateConfig(config);
    }
  }
  ```

#### **模块化原则实施要点**
- **文件大小控制**: 超过500行必须拆分
- **功能导向**: 按功能职责拆分模块
- **依赖管理**: 明确模块间依赖关系
- **实施策略**:
  ```typescript
  // ❌ 错误：巨型文件 (600+ 行)
  export class RequestProcessor {
    // 认证逻辑 (100 行)
    // 验证逻辑 (150 行)
    // 业务逻辑 (200 行)
    // 响应处理 (150 行)
  }

  // ✅ 正确：模块化拆分
  export class Authenticator { /* 80 行 */ }
  export class RequestValidator { /* 120 行 */ }
  export class BusinessProcessor { /* 150 行 */ }
  export class ResponseFormatter { /* 100 行 */ }

  export class RequestProcessor { /* 50 行协调器 */ }
  ```

## 🚨 架构合规性检查清单

### **开发阶段自查**
- [ ] **工具处理**: 是否全部通过llmswitch-core？
- [ ] **兼容层**: 是否只处理provider特定功能？
- [ ] **错误处理**: 是否遵循快速死亡原则？
- [ ] **日志记录**: 是否暴露了问题根源？
- [ ] **解决方案**: 是否有清晰的单一处理路径？
- [ ] **功能分离**: 模块职责是否明确且不重叠？
- [ ] **配置管理**: 是否存在硬编码？
- [ ] **文件结构**: 是否有超过500行的巨型文件？

### **代码审查检查**
- [ ] **原则1合规**: 工具调用是否集中在llmswitch-core？
- [ ] **原则2合规**: 兼容层是否避免了工具处理？
- [ ] **原则3合规**: 工具指引是否统一管理？
- [ ] **原则4合规**: 是否有隐藏的fallback逻辑？
- [ ] **原则5合规**: 错误信息是否完整且结构化？
- [ ] **原则6合规**: 代码路径是否确定且可预测？
- [ ] **原则7合规**: 模块功能是否单一且边界清晰？
- [ ] **原则8合规**: 配置是否外部化且经过验证？
- [ ] **原则9合规**: 代码结构是否模块化且可维护？

### **违反架构原则的后果**
- **原则1-3违反**: 工具调用混乱、响应不一致、功能重复
- **原则4-6违反**: 系统不稳定、问题难定位、行为不可预测
- **原则7-9违反**: 维护困难、扩展性差、代码质量下降

## 工具处理（唯一入口）

- 工具请求、引导、归一化与响应的“唯一入口”在 `sharedmodule/llmswitch-core`，不要在服务器各端点分支单独处理。
  - 统一的规范化入口：`sharedmodule/llmswitch-core/src/conversion/shared/tool-canonicalizer.ts`
    - 请求侧：将 assistant 文本中的工具意图（rcc.tool.v1 / <tool_call> / 统一 diff / <function=execute>）转为结构化 `tool_calls`，并清理对应文本；相邻重复去重；arguments 串化。
    - 响应侧：同样规范化 `choices[0].message`，并在生成了 `tool_calls` 时补齐 `finish_reason = tool_calls`（如未提供）。
  - 文本结果包剥离：`sharedmodule/llmswitch-core/src/conversion/shared/text-markup-normalizer.ts: stripRccResultEnvelopesText`
    - 一律剥离包含 `executed/result` 的 `rcc.tool.v1` “结果包”，避免被误当文本显示或再次转为 `tool_calls`。
  - Responses 形状（`object=response`）的输出也要在桥接层做同样的文本剥离：
    - 文件：`sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`

- 系统工具指引与工具 schema 增强统一在 llmswitch-core：
  - 注入/精炼系统工具指引（默认开启，幂等）：
    - `buildSystemToolGuidance` 与 `refineSystemToolGuidance`（模块：`sharedmodule/llmswitch-core/src/guidance`）
  - 工具 schema 增强：`augmentOpenAITools`（例如：`shell`、`apply_patch`、`update_plan`、`view_image` 等严格化）

- 服务器层禁止重复实现以下逻辑：
  - Chat/Responses/Messages 端点、`streaming-manager`、`response-normalizer` 不应再做“文本→工具”的二次收割或“工具结果 JSON 文本回灌”的处理。
  - 若发现工具处理需求，请在 llmswitch-core 对应模块扩展，不要在服务器端点加分支，避免逻辑分散与冲突。

- GLM 兼容层仅做供应商专用最小处理：
  - 仅对 `reasoning_content` 执行“工具意图收割 + strip 思考文本”的标准化（Chat strip、Responses preserve 按策略）。
  - 不再处理 `assistant.content` 文本工具（避免与 llmswitch-core 重复），避免历史污染和 500 错误。

- 构建顺序与验证：
  - 修改 llmswitch-core 后务必先编译共享模块，再编译根包并安装/发布；否则运行时看不到变更。
  - 采样日志位于：`~/.routecodex/codex-samples/{openai-chat|openai-responses}`。调试时优先检查 provider-in / provider-response 与最末端 responses-final 是否仍有文本工具或结果包残留。

- 约定与默认：
  - "工具唯一入口"的规范默认开启，无需通过环境变量开关。若需灰度，可在 llmswitch-core 中提供明确、集中且短期的调试开关，并尽快移除。

## 📋 实现指导与最佳实践

### **新增Provider时的实现步骤**

#### **1. 确定需求范围**
```typescript
// 评估Provider特性
interface ProviderAnalysis {
  hasSpecialFields?: boolean;     // 是否有特殊字段需要标准化
  hasReasoningContent?: boolean;  // 是否有reasoning_content类似字段
  requiresSpecialMapping?: boolean; // 是否需要特殊字段映射
  isStandardOpenAI?: boolean;     // 是否完全兼容OpenAI格式
}
```

#### **2. 选择实现策略**
- **标准OpenAI兼容**: 直接使用OpenAI Provider，无需兼容层
- **字段标准化需求**: 创建专用Compatibility模块
- **特殊协议需求**: 在llmswitch-core添加格式转换器

#### **3. 兼容层实现模板**
```typescript
export class NewProviderCompatibility implements CompatibilityModule {
  async processIncoming(request: any): Promise<SharedPipelineRequest> {
    // ✅ 仅处理provider特定字段
    if (request.thinking_enabled) {
      request.thinking = this.buildThinkingPayload();
    }

    // ❌ 禁止工具处理逻辑
    // if (request.assistant_content_includes_tools) {
    //   // 不在此处处理工具转换
    // }

    return request;
  }

  async processOutgoing(response: any): Promise<unknown> {
    // ✅ 字段标准化
    if (response.custom_usage_field) {
      response.usage.completion_tokens = response.custom_usage_field;
    }

    // ✅ Reasoning内容处理 (如果provider特有)
    if (response.provider_reasoning) {
      const { blocks } = harvestRccBlocksFromText(response.provider_reasoning);
      response.reasoning_content = blocks.join('\n');
    }

    return response;
  }
}
```

### **代码审查检查清单**

#### **兼容层审查要点**
- [ ] 是否包含工具调用转换逻辑？(应移至llmswitch-core)
- [ ] 是否重复实现文本收割逻辑？(应使用llmswitch-core)
- [ ] 是否只处理provider特定字段？(正确)
- [ ] 是否避免与现有功能重复？(必须)

#### **服务器端点审查要点**
- [ ] 是否包含工具处理分支逻辑？(应移至llmswitch-core)
- [ ] 是否直接修改请求/响应数据格式？(应使用Compatibility)
- [ ] 是否只处理HTTP协议相关逻辑？(正确)

#### **llmswitch-core扩展要点**
- [ ] 新功能是否适用于所有端点？(应该)
- [ ] 是否考虑了所有provider的兼容性？(必须)
- [ ] 是否添加了相应的测试用例？(必须)

### **常见反模式与正确做法**

#### **❌ 反模式1: 兼容层处理工具调用**
```typescript
// 错误：在兼容层处理工具转换
export class BadCompatibility {
  processResponse(response: any) {
    // 不要这样做！
    if (response.content.includes('tool_call')) {
      response.tool_calls = this.parseToolCalls(response.content);
      response.content = '';
    }
  }
}
```

#### **✅ 正确做法1: 仅做字段标准化**
```typescript
// 正确：只做必要的字段标准化
export class GoodCompatibility {
  processResponse(response: any) {
    // 仅做字段映射
    if (response.provider_specific_usage) {
      response.usage = {
        prompt_tokens: response.provider_specific_usage.input,
        completion_tokens: response.provider_specific_usage.output,
        total_tokens: response.provider_specific_usage.total
      };
    }

    // 处理provider特有的reasoning字段
    if (response.provider_reasoning) {
      response.reasoning_content = response.provider_reasoning;
    }

    return response;
  }
}
```

#### **❌ 反模式2: 服务器端点工具处理**
```typescript
// 错误：在端点处理器中添加工具逻辑
app.post('/v1/chat/completions', (req, res) => {
  // 不要这样做！
  if (req.messages.some(m => m.content.includes('function_call'))) {
    req.tool_calls = extractToolCalls(req.messages);
  }

  // 应该直接传递给llmswitch-core处理
  const processed = llmswitchCore.process(req);
});
```

#### **✅ 正确做法2: 直接委托**
```typescript
// 正确：端点只做协议处理
app.post('/v1/chat/completions', async (req, res) => {
  try {
    // 端点只负责HTTP协议处理
    const authResult = await authenticateRequest(req);
    if (!authResult.success) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    // 直接委托给llmswitch-core
    const result = await llmswitchCore.processRequest(req.body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

## 调试与采样日志路径

- 采样根目录：`~/.routecodex/codex-samples`

- Chat 端点（OpenAI Chat，`/v1/chat/completions`）
  - 目录：`~/.routecodex/codex-samples/openai-chat`
  - 文件：
    - `req_<id>_raw-request.json`：进入 Chat 处理器的原始 HTTP 请求（未变更）
    - `req_<id>_pre-llmswitch.json` / `post-llmswitch.json`：Chat 处理器调用 llmswitch 前后快照（消息计数与角色统计）
    - `req_<id>_provider-in.json`：发往 Provider 的最终请求摘要（模型、消息数、工具数）
    - `req_<id>_provider-request.json`：发往上游的完整请求载荷（OpenAI Chat 形状）
    - `req_<id>_provider-response.json`：上游原始 JSON 响应（未经过兼容与清洗）
    - `req_<id>_sse-events.log`：SSE 事件流（chunk、chunk.final、done）

- Responses 端点（OpenAI Responses，`/v1/responses`）
  - 目录：`~/.routecodex/codex-samples/openai-responses`
  - 文件：
    - `req_<id>_pre-pipeline.json`：进入 pipeline 前的原始请求快照（可选）
    - `req_<id>_responses-initial.json` / `responses-final.json`：Responses 形状的起始与终态（包含 output/output_text 等）
    - `req_<id>_provider-response.json`：上游原始 JSON 响应（未经过桥接）
    - `req_<id>_sse-events.log` / `sse-audit.log`：SSE 事件与审计日志

- Anthropic 端点（`/v1/messages`）
  - 目录：`~/.routecodex/codex-samples/anthropic-messages`
  - 文件：
    - `req_<id>_provider-request.json` / `provider-response.json`：上游请求/响应（Anthropic 形状）
    - `req_<id>_sse-events.log`：SSE 事件（若使用 SSE）

- 常用排查手册
  - 查询最近一次请求：`ls -1t ~/.routecodex/codex-samples/openai-chat/*_raw-request.json | head -n 1`
  - 关联同 ID 的其它文件：把 `_raw-request.json` 替换为 `_provider-request.json`/`_provider-response.json`/`_sse-events.log`
  - 判断是否上游 500：存在 `_provider-request.json` 但缺 `_provider-response.json`，一般为上游错误/超时
  - 判断是否文本化工具泄漏：
    - Chat：看 `_provider-response.json` 的 `choices[0].message.{tool_calls,content}`
    - Responses：看 `responses-final.json` 的 `output_text`/`output[..].message.content` 是否出现 rcc.tool.v1 结果包或 `<tool_call>` 文本
