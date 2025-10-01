# 配置模块重构计划 - 独立 ESM 模块方案

## 📋 概述

本文档描述了将 RouteCodex 配置模块从现有的 834 行单体模块重构为独立的 ESM 模块的详细计划。新模块将发布到 npm，支持独立开发和黑盒测试。

## 🎯 重构目标

### 核心目标
- **模块独立性**: 配置模块完全独立于 RouteCodex 主项目
- **ESM 标准**: 采用现代 ESM 模块标准
- **npm 发布**: 可独立发布到 npm 注册表
- **并行开发**: 支持团队并行开发和测试
- **黑盒测试**: 完整的测试覆盖和兼容性验证

### 技术目标
- **代码简化**: 通过上提核心逻辑，减少重复代码
- **性能优化**: 保持或提升现有性能
- **类型安全**: 完整的 TypeScript 类型定义
- **向后兼容**: 保持与现有配置格式的兼容性

### 关键原则
- **上提现有逻辑**: 避免重写，直接迁移成熟的核心规则
- **契约一致性**: 输出与当前 `MergedConfig` 完全一致
- **中间表示(IR)**: 统一内部处理，保证逻辑收敛
- **风险控制**: 完善的测试和回滚机制

## 🏗️ 模块架构设计

### 目录结构

```
sharedmodule/
├── packages/
│   ├── config-engine/           # 配置引擎核心模块
│   │   ├── src/
│   │   │   ├── core/           # 核心功能
│   │   │   ├── adapters/       # 适配器
│   │   │   ├── presets/        # 预设配置
│   │   │   ├── types/          # 类型定义
│   │   │   └── index.ts        # 入口文件
│   │   ├── tests/              # 测试套件
│   │   ├── package.json        # 模块配置
│   │   └── README.md           # 模块文档
│   │
│   ├── config-compat/          # 兼容性模块
│   │   ├── src/
│   │   │   ├── legacy/         # 旧版本兼容
│   │   │   ├── migration/      # 迁移工具
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   └── config-testkit/         # 测试工具包
│       ├── src/
│       │   ├── matchers/       # 测试匹配器
│       │   ├── fixtures/       # 测试数据
│       │   └── index.ts
│       └── package.json
│
├── packages/                  # 单元测试
├── integration/               # 集成测试
├── examples/                  # 示例代码
├── docs/                      # 文档
└── tools/                     # 开发工具
```

### 模块职责划分

#### 1. config-engine (核心引擎)
**职责**: 配置解析、验证、转换的核心功能
**依赖**: 无外部依赖，纯 TypeScript
**导出**:
```typescript
// 核心接口 - 直接复用现有 MergedConfig 契约
export interface ConfigEngine {
  loadConfig(configPath: string): Promise<MergedConfig>;
  validateConfig(config: unknown): ValidationResult;
  transformConfig(config: unknown): MergedConfig;
}

// 工厂方法
export function createConfigEngine(options: ConfigEngineOptions): ConfigEngine;

// 导出现有类型契约
export * from './types/merged-config-types'; // 直接复用现有类型
export * from './types/validation-types';
```

#### 2. config-compat (兼容性模块)
**职责**: 向后兼容现有配置格式，迁移现有逻辑
**依赖**: config-engine
**核心逻辑**: 直接上提 `user-config-parser.ts` 和 `config-merger.ts` 的核心规则
**导出**:
```typescript
// 兼容性接口
export interface LegacyConfigAdapter {
  parseLegacyConfig(config: any): MergedConfig;
  convertToNewFormat(legacyConfig: any): MergedConfig;
}

// 迁移工具 - 基于现有逻辑
export function migrateConfig(legacyConfig: any): MigrationResult;
export function createMergedConfig(userConfig: any): MergedConfig;
```

#### 3. config-testkit (测试工具包)
**职责**: 提供测试工具和黑盒测试框架
**依赖**: config-engine, config-compat
**导出**:
```typescript
// 测试工具 - 针对现有配置样例
export interface ConfigTestEngine {
  runCompatibilityTests(testCases: TestCase[]): TestReport;
  generateTestFixtures(): TestFixtures;
  validateConfigOutput(config: MergedConfig): ValidationResult;

  // 针对现有配置文件的测试
  testConfigFile(configPath: string): Promise<TestResult>;
  testAgainstLegacy(configPath: string): Promise<CompatibilityResult>;
}
```

## 📋 详细实施计划

### 阶段一：基础架构搭建 (第1周)

#### 1.1 创建 monorepo 结构
```bash
# 创建 sharedmodule 目录
mkdir -p sharedmodule/packages

# 初始化工作区
cd sharedmodule
npm init -w packages/config-engine -w packages/config-compat -w packages/config-testkit

# 配置 TypeScript
npm install -D typescript @types/node tslib
```

#### 1.2 设计核心接口 - 基于现有契约
```typescript
// sharedmodule/packages/config-engine/src/core/config-engine.ts
// 直接复用现有 MergedConfig 类型契约
import { MergedConfig } from './types/merged-config-types';

export interface ConfigEngineOptions {
  strictMode?: boolean;
  enableCache?: boolean;
  maxConfigSize?: number;
  preserveCompatibility?: boolean;
}

export interface ConfigEngine {
  loadConfig(configPath: string): Promise<MergedConfig>;
  validateConfig(config: unknown): ValidationResult;
  transformConfig(config: unknown): MergedConfig;

  // 保持现有接口兼容
  createProviderConfig(providerId: string, config: any): ProviderConfig;
  createPipelineConfig(pipelineId: string, config: any): PipelineConfig;
}

// 核心功能 - 基于现有逻辑迁移
export class ConfigEngineImpl implements ConfigEngine {
  async loadConfig(configPath: string): Promise<MergedConfig> {
    // 直接复用现有的 user-config-parser.ts 核心逻辑
    const userConfig = await this.loadUserConfig(configPath);
    const mergedConfig = await this.createMergedConfig(userConfig);
    return mergedConfig;
  }
}
```

#### 1.3 建立开发环境
```json
// sharedmodule/package.json
{
  "name": "@routecodex/sharedmodule",
  "version": "1.0.0",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces",
    "lint": "eslint packages/*/src/**/*.ts",
    "format": "prettier --write packages/*/src/**/*.ts"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "eslint": "^8.0.0",
    "prettier": "^3.0.0",
    "typescript": "^5.0.0"
  }
}
```

### 阶段二：核心功能开发 (第2-3周)

#### 2.1 核心逻辑迁移 - 基于现有代码
```typescript
// sharedmodule/packages/config-engine/src/core/config-parser.ts
// 直接上提现有 user-config-parser.ts 和 config-merger.ts 的核心逻辑

export class ConfigParser {
  constructor(private options: ConfigParserOptions) {}

  async parse(configPath: string): Promise<MergedConfig> {
    // 基于现有逻辑，避免重写
    const userConfig = await this.loadUserConfig(configPath);
    const mergedConfig = await this.createMergedConfig(userConfig);
    return mergedConfig;
  }

  // 直接迁移现有逻辑 - 保持所有规范化规则
  private async loadUserConfig(configPath: string): Promise<UserConfig> {
    // 支持多种配置文件格式，保持现有行为
    const rawConfig = await this.loadConfigFile(configPath);

    // 直接复用现有的规范化逻辑
    return this.normalizeConfig(rawConfig);
  }

  private normalizeConfig(config: any): UserConfig {
    // 保持现有的规范化规则：
    // - provider 类型标准化：qwen→qwen-provider, iflow→iflow-provider, glm→glm-http-provider
    // - 别名映射与多 key 展开
    // - 模块别名：openai-normalizer→llmswitch-openai-openai
    // - 路径与环境变量：~ 展开、${VAR} 扩展
    return this.applyNormalizationRules(config);
  }

  private createMergedConfig(userConfig: UserConfig): Promise<MergedConfig> {
    // 直接复用现有的 config-merger.ts 逻辑
    // 保持 routeTargets/pipelineConfigs 衍生逻辑一致
    return this.mergeConfig(userConfig);
  }

  private applyNormalizationRules(config: any): UserConfig {
    // 迁移现有规范化逻辑，确保1:1复刻
    const normalized = { ...config };

    // Provider 类型标准化
    if (normalized.providers) {
      normalized.providers = this.normalizeProviders(normalized.providers);
    }

    // 别名映射
    if (normalized.aliases) {
      normalized.aliases = this.expandAliases(normalized.aliases);
    }

    // 环境变量扩展
    if (normalized.env) {
      normalized.env = this.expandEnvVars(normalized.env);
    }

    return normalized;
  }

  private normalizeProviders(providers: any): any {
    // 保持现有 provider 标准化逻辑
    const normalized: any = {};

    for (const [key, provider] of Object.entries(providers)) {
      // 应用现有的类型映射规则
      const normalizedKey = this.normalizeProviderType(key);
      normalized[normalizedKey] = this.normalizeProviderConfig(provider);
    }

    return normalized;
  }

  private normalizeProviderType(type: string): string {
    // 直接复用现有的类型映射
    const typeMap: Record<string, string> = {
      'qwen': 'qwen-provider',
      'iflow': 'iflow-provider',
      'glm': 'glm-http-provider',
      'openai': 'openai-provider',
      'lmstudio': 'lmstudio-http'
    };

    return typeMap[type] || type;
  }

  private normalizeProviderConfig(provider: any): any {
    // 保持现有的 provider 配置逻辑
    const normalized = { ...provider };

    // OAuth 配置处理
    if (normalized.oauth) {
      normalized.oauth = this.normalizeOAuthConfig(normalized.oauth);
    }

    // TokenFile 路径处理
    if (normalized.auth?.tokenFile) {
      normalized.auth.tokenFile = this.expandPath(normalized.auth.tokenFile);
    }

    return normalized;
  }

  private normalizeOAuthConfig(oauth: any): any {
    // 保持现有的 OAuth 配置逻辑
    const normalized = { ...oauth };

    // 默认路径处理（Qwen/iflow）
    if (!normalized.tokenFile) {
      normalized.tokenFile = this.getDefaultOAuthPath(oauth.type);
    }

    normalized.tokenFile = this.expandPath(normalized.tokenFile);
    return normalized;
  }

  private getDefaultOAuthPath(type: string): string {
    // 保持现有的默认路径逻辑
    const defaultPaths: Record<string, string> = {
      'qwen': '~/.routecodex/oauth/qwen/token.json',
      'iflow': '~/.routecodex/oauth/iflow/token.json'
    };

    return defaultPaths[type] || '~/.routecodex/oauth/token.json';
  }

  private expandPath(path: string): string {
    // 保持现有的路径展开逻辑
    if (path.startsWith('~')) {
      return path.replace('~', process.env.HOME || '');
    }
    return path;
  }

  private expandEnvVars(config: any): any {
    // 保持现有的环境变量扩展逻辑
    const expanded: any = {};

    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string') {
        // 支持 ${VAR} 和 $VAR 格式
        expanded[key] = value.replace(/\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/g, (match, var1, var2) => {
          const varName = var1 || var2;
          return process.env[varName] || match;
        });
      } else {
        expanded[key] = value;
      }
    }

    return expanded;
  }
}
```

#### 2.2 验证和错误处理 - 基于 Ajv/Zod
```typescript
// sharedmodule/packages/config-engine/src/validation/config-validator.ts
import { MergedConfig } from '../types/merged-config-types';
import Ajv from 'ajv';

export class ConfigValidator {
  private ajv: Ajv;

  constructor() {
    this.ajv = new Ajv({ allErrors: true });
    this.registerValidationSchemas();
  }

  validate(config: unknown): ValidationResult {
    try {
      // 使用 Ajv 进行精确验证
      const valid = this.ajv.validate(this.mergedConfigSchema, config);

      if (!valid) {
        return {
          valid: false,
          errors: this.ajv.errors?.map(error => ({
            path: error.schemaPath,
            message: error.message,
            params: error.params
          })) || []
        };
      }

      // 额外的业务逻辑验证
      const businessErrors = this.validateBusinessRules(config as MergedConfig);
      if (businessErrors.length > 0) {
        return {
          valid: false,
          errors: businessErrors
        };
      }

      return { valid: true, errors: [] };
    } catch (error) {
      return {
        valid: false,
        errors: [{
          path: 'root',
          message: `Validation failed: ${error.message}`,
          params: { originalError: error }
        }]
      };
    }
  }

  private validateBusinessRules(config: MergedConfig): ValidationError[] {
    const errors: ValidationError[] = [];

    // 验证 routeTargets 与 pipelineConfigs 的一致性
    if (config.routeTargets && config.pipelineConfigs) {
      const targetErrors = this.validateRouteTargetsConsistency(config);
      errors.push(...targetErrors);
    }

    // 验证 provider 配置
    if (config.providers) {
      const providerErrors = this.validateProviderConfigs(config);
      errors.push(...providerErrors);
    }

    return errors;
  }

  private validateRouteTargetsConsistency(config: MergedConfig): ValidationError[] {
    const errors: ValidationError[] = [];

    // 确保每个 routeTarget 都有对应的 pipelineConfig
    for (const target of config.routeTargets || []) {
      const hasMatchingPipeline = config.pipelineConfigs?.[target];
      if (!hasMatchingPipeline) {
        errors.push({
          path: `routeTargets[${target}]`,
          message: `Route target '${target}' has no corresponding pipelineConfig`,
          params: { target }
        });
      }
    }

    return errors;
  }

  private validateProviderConfigs(config: MergedConfig): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const [providerId, provider] of Object.entries(config.providers || {})) {
      // 验证必需的配置字段
      if (!provider.type) {
        errors.push({
          path: `providers.${providerId}`,
          message: `Provider '${providerId}' missing required 'type' field`,
          params: { providerId }
        });
      }

      // 验证 OAuth 配置
      if (provider.oauth) {
        const oauthErrors = this.validateOAuthConfig(providerId, provider.oauth);
        errors.push(...oauthErrors);
      }
    }

    return errors;
  }

  private validateOAuthConfig(providerId: string, oauth: any): ValidationError[] {
    const errors: ValidationError[] = [];

    if (!oauth.type) {
      errors.push({
        path: `providers.${providerId}.oauth`,
        message: `OAuth configuration missing 'type' field`,
        params: { providerId }
      });
    }

    if (!oauth.tokenFile && !oauth.clientId) {
      errors.push({
        path: `providers.${providerId}.oauth`,
        message: `OAuth configuration requires either 'tokenFile' or 'clientId'`,
        params: { providerId }
      });
    }

    return errors;
  }

  private registerValidationSchemas(): void {
    // 注册 MergedConfig 的 JSON Schema
    this.mergedConfigSchema = {
      type: 'object',
      properties: {
        providers: { type: 'object' },
        routeTargets: { type: 'array', items: { type: 'string' } },
        pipelineConfigs: { type: 'object' },
        aliases: { type: 'object' },
        env: { type: 'object' }
      },
      required: ['providers'],
      additionalProperties: false
    };
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
  params: Record<string, any>;
}

// Typed errors for better error handling
export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly errors: ValidationError[]
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}
```

#### 2.3 预设配置系统 - 自动对齐现有模块
```typescript
// sharedmodule/packages/config-engine/src/presets/config-presets.ts
export class ConfigPresets {
  private presets = new Map<string, ConfigPreset>();
  private moduleAliases = new Map<string, string>();

  constructor() {
    this.registerDefaultPresets();
    this.autoRegisterModuleAliases();
  }

  registerPreset(name: string, preset: ConfigPreset): void {
    this.presets.set(name, preset);
  }

  getPreset(name: string): ConfigPreset | undefined {
    return this.presets.get(name);
  }

  listPresets(): string[] {
    return Array.from(this.presets.keys());
  }

  // 自动对齐现有模块别名，防止手写漂移
  private autoRegisterModuleAliases(): void {
    // 基于现有模块类型自动注册别名
    const moduleTypeMap: Record<string, string> = {
      'openai-normalizer': 'llmswitch-openai-openai',
      'anthropic-openai-converter': 'llmswitch-anthropic-openai',
      'qwen-compatibility': 'qwen-provider',
      'iflow-compatibility': 'iflow-provider',
      'glm-compatibility': 'glm-http-provider',
      'lmstudio-compatibility': 'lmstudio-http'
    };

    for (const [oldName, newName] of Object.entries(moduleTypeMap)) {
      this.moduleAliases.set(oldName, newName);
    }
  }

  private registerDefaultPresets(): void {
    // 基于现有配置文件扫描生成预设，防止手写漂移
    this.registerPreset('lmstudio-default', {
      provider: {
        type: 'lmstudio-http',
        baseUrl: 'http://localhost:1234',
        timeout: 30000,
        auth: {
          type: 'none'
        }
      },
      pipeline: {
        maxTokens: 4096,
        temperature: 0.7
      }
    });

    this.registerPreset('qwen-default', {
      provider: {
        type: 'qwen-provider',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
        timeout: 30000,
        oauth: {
          type: 'qwen',
          tokenFile: '~/.routecodex/oauth/qwen/token.json'
        }
      },
      pipeline: {
        maxTokens: 262144,
        temperature: 0.7
      }
    });

    this.registerPreset('iflow-default', {
      provider: {
        type: 'iflow-provider',
        baseUrl: 'https://api.iflow.work/v1',
        timeout: 30000,
        oauth: {
          type: 'iflow',
          tokenFile: '~/.routecodex/oauth/iflow/token.json'
        }
      },
      pipeline: {
        maxTokens: 4096,
        temperature: 0.7
      }
    });

    this.registerPreset('glm-default', {
      provider: {
        type: 'glm-http-provider',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        timeout: 30000,
        auth: {
          type: 'apikey',
          apiKey: '${GLM_API_KEY}'
        }
      },
      pipeline: {
        maxTokens: 4096,
        temperature: 0.7
      }
    });

    this.registerPreset('openai-default', {
      provider: {
        type: 'openai-provider',
        baseUrl: 'https://api.openai.com/v1',
        timeout: 30000,
        auth: {
          type: 'apikey',
          apiKey: '${OPENAI_API_KEY}'
        }
      },
      pipeline: {
        maxTokens: 4096,
        temperature: 0.7
      }
    });
  }

  // 构建时校验脚本，防止预设漂移
  validatePresetsAgainstSource(): ValidationResult {
    const issues: string[] = [];

    // 检查是否有新的模块类型需要注册
    const knownProviderTypes = ['qwen', 'iflow', 'glm', 'openai', 'lmstudio'];
    const registeredTypes = Array.from(this.presets.keys()).map(key =>
      this.presets.get(key)?.provider?.type
    );

    for (const type of knownProviderTypes) {
      if (!registeredTypes.includes(type)) {
        issues.push(`Provider type '${type}' is not registered in presets`);
      }
    }

    // 检查模块别名是否同步
    const expectedAliases = Object.entries({
      'openai-normalizer': 'llmswitch-openai-openai',
      'anthropic-openai-converter': 'llmswitch-anthropic-openai',
      'qwen-compatibility': 'qwen-provider',
      'iflow-compatibility': 'iflow-provider',
      'glm-compatibility': 'glm-http-provider',
      'lmstudio-compatibility': 'lmstudio-http'
    });

    for (const [oldAlias, newAlias] of expectedAliases) {
      if (this.moduleAliases.get(oldAlias) !== newAlias) {
        issues.push(`Module alias mapping for '${oldAlias}' is out of sync`);
      }
    }

    return {
      valid: issues.length === 0,
      issues
    };
  }
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
}

export interface ConfigPreset {
  provider: {
    type: string;
    baseUrl: string;
    timeout: number;
    auth?: any;
    oauth?: any;
  };
  pipeline: {
    maxTokens: number;
    temperature: number;
  };
}
```

### 阶段三：测试框架开发 (第4周)

#### 3.1 黑盒测试框架 - 基于真实配置样例
```typescript
// sharedmodule/packages/config-testkit/src/blackbox/test-engine.ts
export class ConfigTestEngine {
  constructor(
    private legacyParser: any, // 现有的配置解析器
    private newParser: ConfigEngine // 新的配置引擎
  ) {}

  // 核心黑盒测试方法
  async runCompatibilityTests(testCases: TestCase[]): Promise<TestReport> {
    const results: TestResult[] = [];

    for (const testCase of testCases) {
      const result = await this.compareConfigs(testCase);
      results.push(result);
    }

    return this.generateTestReport(results);
  }

  // 针对现有配置文件的专门测试
  async testConfigFile(configPath: string): Promise<TestResult> {
    try {
      // 测试旧版本解析器
      const v1Start = performance.now();
      const v1Result = await this.legacyParser.parse(configPath);
      const v1Time = performance.now() - v1Start;

      // 测试新版本解析器
      const v2Start = performance.now();
      const v2Result = await this.newParser.loadConfig(configPath);
      const v2Time = performance.now() - v2Start;

      // 黄金快照比对
      const passed = this.compareMergedConfigs(v1Result, v2Result);

      return {
        testName: `Config File: ${configPath}`,
        passed,
        performance: {
          v1Time,
          v2Time,
          improvement: ((v1Time - v2Time) / v1Time) * 100
        },
        diff: passed ? undefined : this.generateDetailedDiff(v1Result, v2Result),
        goldenSnapshot: v1Result // 保存黄金快照
      };
    } catch (error) {
      return {
        testName: `Config File: ${configPath}`,
        passed: false,
        error: error.message
      };
    }
  }

  // 针对现有配置样例的批量测试
  async runGoldenSnapshotTests(): Promise<TestReport> {
    const configFiles = [
      '~/.routecodex/config/mixed.json',
      '~/.routecodex/config/modelscope.json',
      '~/.routecodex/config/glm.json',
      './e2e/test-configs/qwen-config.json',
      './e2e/test-configs/iflow-config.json',
      './e2e/test-configs/lmstudio-config.json'
    ];

    const results: TestResult[] = [];

    for (const configFile of configFiles) {
      const result = await this.testConfigFile(configFile);
      results.push(result);
    }

    return this.generateTestReport(results);
  }

  // 性能基准测试
  async runPerformanceBenchmark(configPath: string): Promise<PerformanceReport> {
    const iterations = 100;
    const v1Times: number[] = [];
    const v2Times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      // 测试旧版本性能
      const v1Start = performance.now();
      await this.legacyParser.parse(configPath);
      v1Times.push(performance.now() - v1Start);

      // 测试新版本性能
      const v2Start = performance.now();
      await this.newParser.loadConfig(configPath);
      v2Times.push(performance.now() - v2Start);
    }

    return {
      v1Average: v1Times.reduce((a, b) => a + b) / v1Times.length,
      v2Average: v2Times.reduce((a, b) => a + b) / v2Times.length,
      improvement: ((v1Times.reduce((a, b) => a + b) - v2Times.reduce((a, b) => a + b)) / v1Times.reduce((a, b) => a + b)) * 100,
      v1StdDev: this.calculateStandardDeviation(v1Times),
      v2StdDev: this.calculateStandardDeviation(v2Times)
    };
  }

  // MergedConfig 专用比较方法
  private compareMergedConfigs(v1Result: any, v2Result: any): boolean {
    // 专门针对 MergedConfig 结构的比较
    const v1 = v1Result as MergedConfig;
    const v2 = v2Result as MergedConfig;

    // 比较 providers
    if (!this.deepEqual(v1.providers, v2.providers)) return false;

    // 比较 routeTargets
    if (!this.arrayEqual(v1.routeTargets || [], v2.routeTargets || [])) return false;

    // 比较 pipelineConfigs
    if (!this.deepEqual(v1.pipelineConfigs, v2.pipelineConfigs)) return false;

    // 比较 aliases
    if (!this.deepEqual(v1.aliases, v2.aliases)) return false;

    return true;
  }

  // 生成式测试：验证 routeTargets 与 pipelineConfigs 的一致性
  async runPropertyBasedTests(): Promise<TestReport> {
    const testResults: TestResult[] = [];

    // 生成随机配置
    for (let i = 0; i < 100; i++) {
      const randomConfig = this.generateRandomConfig();
      const result = await this.testConfigConsistency(randomConfig);
      testResults.push(result);
    }

    return this.generateTestReport(testResults);
  }

  private async testConfigConsistency(config: any): Promise<TestResult> {
    try {
      const result = await this.newParser.loadConfig('temp-config.json');

      // 验证 routeTargets 与 pipelineConfigs 的一致性
      const consistencyIssues: string[] = [];

      if (result.routeTargets && result.pipelineConfigs) {
        for (const target of result.routeTargets) {
          if (!result.pipelineConfigs[target]) {
            consistencyIssues.push(`Route target '${target}' has no corresponding pipelineConfig`);
          }
        }
      }

      return {
        testName: 'Property-based consistency test',
        passed: consistencyIssues.length === 0,
        error: consistencyIssues.length > 0 ? consistencyIssues.join(', ') : undefined
      };
    } catch (error) {
      return {
        testName: 'Property-based consistency test',
        passed: false,
        error: error.message
      };
    }
  }

  private generateRandomConfig(): any {
    // 生成随机配置用于性质测试
    return {
      providers: this.generateRandomProviders(),
      routeTargets: this.generateRandomRouteTargets(),
      pipelineConfigs: this.generateRandomPipelineConfigs()
    };
  }

  private generateRandomProviders(): any {
    // 生成随机 provider 配置
    const providerTypes = ['qwen', 'iflow', 'glm', 'openai', 'lmstudio'];
    const providers: any = {};

    const numProviders = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < numProviders; i++) {
      const type = providerTypes[Math.floor(Math.random() * providerTypes.length)];
      providers[`${type}-${i}`] = {
        type: `${type}-provider`,
        baseUrl: `https://api.${type}.com/v1`,
        timeout: 30000
      };
    }

    return providers;
  }

  private generateRandomRouteTargets(): string[] {
    const targets = ['default', 'longcontext', 'thinking', 'background'];
    const numTargets = Math.floor(Math.random() * targets.length) + 1;
    return targets.slice(0, numTargets);
  }

  private generateRandomPipelineConfigs(): any {
    const configs: any = {};
    const targetTypes = ['default', 'longcontext', 'thinking', 'background'];

    for (const target of targetTypes) {
      configs[target] = {
        llmSwitch: {
          type: 'llmswitch-openai-openai'
        },
        compatibility: {
          type: 'lmstudio-compatibility'
        },
        provider: {
          type: 'lmstudio-http'
        }
      };
    }

    return configs;
  }

  // 工具方法
  private deepEqual(obj1: any, obj2: any): boolean {
    return JSON.stringify(obj1) === JSON.stringify(obj2);
  }

  private arrayEqual(arr1: any[], arr2: any[]): boolean {
    if (arr1.length !== arr2.length) return false;
    return arr1.every((item, index) => this.deepEqual(item, arr2[index]));
  }

  private calculateStandardDeviation(values: number[]): number {
    const mean = values.reduce((a, b) => a + b) / values.length;
    const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  private generateDetailedDiff(obj1: any, obj2: any): any {
    return {
      added: this.getAddedProperties(obj1, obj2),
      removed: this.getRemovedProperties(obj1, obj2),
      changed: this.getChangedProperties(obj1, obj2)
    };
  }

  private getAddedProperties(obj1: any, obj2: any): any {
    const added: any = {};
    for (const key in obj2) {
      if (!(key in obj1)) {
        added[key] = obj2[key];
      }
    }
    return added;
  }

  private getRemovedProperties(obj1: any, obj2: any): any {
    const removed: any = {};
    for (const key in obj1) {
      if (!(key in obj2)) {
        removed[key] = obj1[key];
      }
    }
    return removed;
  }

  private getChangedProperties(obj1: any, obj2: any): any {
    const changed: any = {};
    for (const key in obj1) {
      if (key in obj2 && !this.deepEqual(obj1[key], obj2[key])) {
        changed[key] = {
          from: obj1[key],
          to: obj2[key]
        };
      }
    }
    return changed;
  }

  private generateTestReport(results: TestResult[]): TestReport {
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const total = results.length;

    return {
      totalTests: total,
      passedTests: passed,
      failedTests: failed,
      successRate: (passed / total) * 100,
      results,
      summary: `测试完成: ${passed}/${total} 通过 (${((passed / total) * 100).toFixed(1)}%), ${failed} 失败`,
      performance: {
        averageV1Time: results.reduce((sum, r) => sum + (r.performance?.v1Time || 0), 0) / total,
        averageV2Time: results.reduce((sum, r) => sum + (r.performance?.v2Time || 0), 0) / total,
        averageImprovement: results.reduce((sum, r) => sum + (r.performance?.improvement || 0), 0) / total
      }
    };
  }
}

// 类型定义
export interface TestReport {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  successRate: number;
  results: TestResult[];
  summary: string;
  performance: {
    averageV1Time: number;
    averageV2Time: number;
    averageImprovement: number;
  };
}

export interface TestResult {
  testName: string;
  passed: boolean;
  performance?: {
    v1Time: number;
    v2Time: number;
    improvement: number;
  };
  diff?: any;
  error?: string;
  goldenSnapshot?: any;
}

export interface PerformanceReport {
  v1Average: number;
  v2Average: number;
  improvement: number;
  v1StdDev: number;
  v2StdDev: number;
}

export interface TestCase {
  name: string;
  input: any;
  expectedOutput?: any;
  options?: any;
}

export interface MergedConfig {
  providers: Record<string, any>;
  routeTargets?: string[];
  pipelineConfigs?: Record<string, any>;
  aliases?: Record<string, string>;
  env?: Record<string, string>;
}
```

#### 3.2 测试数据生成器 - 基于现有配置样例
```typescript
// sharedmodule/packages/config-testkit/src/fixtures/test-fixtures.ts
export class TestFixtures {
  // 基于现有配置文件生成测试用例
  static generateRealConfigCases(): TestCase[] {
    return [
      {
        name: 'Qwen Provider 配置',
        input: {
          providers: {
            'qwen': {
              type: 'qwen',
              baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
              oauth: {
                type: 'qwen',
                tokenFile: '~/.routecodex/oauth/qwen/token.json'
              },
              models: {
                'qwen-turbo': {
                  maxTokens: 262144
                }
              }
            }
          },
          pipelineConfigs: {
            'default': {
              llmSwitch: {
                type: 'llmswitch-openai-openai'
              },
              compatibility: {
                type: 'qwen-compatibility'
              },
              provider: {
                type: 'qwen-provider'
              }
            }
          },
          routeTargets: ['default']
        }
      },
      {
        name: 'iFlow Provider 配置',
        input: {
          providers: {
            'iflow': {
              type: 'iflow',
              baseUrl: 'https://api.iflow.work/v1',
              oauth: {
                type: 'iflow',
                tokenFile: '~/.routecodex/oauth/iflow/token.json'
              }
            }
          },
          pipelineConfigs: {
            'default': {
              llmSwitch: {
                type: 'llmswitch-openai-openai'
              },
              compatibility: {
                type: 'iflow-compatibility'
              },
              provider: {
                type: 'iflow-provider'
              }
            }
          },
          routeTargets: ['default']
        }
      },
      {
        name: 'LM Studio Provider 配置',
        input: {
          providers: {
            'lmstudio': {
              type: 'lmstudio',
              baseUrl: 'http://localhost:1234',
              auth: {
                type: 'none'
              }
            }
          },
          pipelineConfigs: {
            'default': {
              llmSwitch: {
                type: 'llmswitch-openai-openai'
              },
              compatibility: {
                type: 'lmstudio-compatibility'
              },
              provider: {
                type: 'lmstudio-http'
              }
            }
          },
          routeTargets: ['default']
        }
      },
      {
        name: '多 Provider 混合配置',
        input: {
          providers: {
            'qwen': {
              type: 'qwen',
              baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
              oauth: {
                type: 'qwen',
                tokenFile: '~/.routecodex/oauth/qwen/token.json'
              }
            },
            'lmstudio': {
              type: 'lmstudio',
              baseUrl: 'http://localhost:1234',
              auth: {
                type: 'none'
              }
            }
          },
          pipelineConfigs: {
            'qwen-target': {
              llmSwitch: {
                type: 'llmswitch-openai-openai'
              },
              compatibility: {
                type: 'qwen-compatibility'
              },
              provider: {
                type: 'qwen-provider'
              }
            },
            'lmstudio-target': {
              llmSwitch: {
                type: 'llmswitch-openai-openai'
              },
              compatibility: {
                type: 'lmstudio-compatibility'
              },
              provider: {
                type: 'lmstudio-http'
              }
            }
          },
          routeTargets: ['qwen-target', 'lmstudio-target'],
          aliases: {
            'openai-normalizer': 'llmswitch-openai-openai',
            'qwen-compatibility': 'qwen-provider',
            'lmstudio-compatibility': 'lmstudio-http'
          },
          env: {
            'QWEN_API_KEY': '${QWEN_API_KEY}',
            'LMSTUDIO_BASE_URL': '${LMSTUDIO_BASE_URL}'
          }
        }
      },
      {
        name: '环境变量和路径扩展配置',
        input: {
          providers: {
            'glm': {
              type: 'glm',
              baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
              auth: {
                type: 'apikey',
                apiKey: '${GLM_API_KEY}'
              }
            },
            'openai': {
              type: 'openai',
              baseUrl: 'https://api.openai.com/v1',
              auth: {
                type: 'apikey',
                apiKey: '${OPENAI_API_KEY}'
              }
            }
          },
          pipelineConfigs: {
            'glm-target': {
              llmSwitch: {
                type: 'llmswitch-openai-openai'
              },
              compatibility: {
                type: 'glm-compatibility'
              },
              provider: {
                type: 'glm-http-provider'
              }
            },
            'openai-target': {
              llmSwitch: {
                type: 'llmswitch-openai-openai'
              },
              compatibility: {
                type: 'openai-compatibility'
              },
              provider: {
                type: 'openai-provider'
              }
            }
          },
          routeTargets: ['glm-target', 'openai-target']
        }
      }
    ];
  }

  // 生成边界情况测试用例
  static generateErrorCases(): TestCase[] {
    return [
      {
        name: '无效 JSON 测试',
        input: 'invalid json content'
      },
      {
        name: '缺少必需字段测试',
        input: {
          optionalField: 'value'
        }
      },
      {
        name: '类型错误测试',
        input: {
          provider: 'should be object not string'
        }
      },
      {
        name: '无效 Provider 类型测试',
        input: {
          providers: {
            'invalid-provider': {
              type: 'unknown-type',
              baseUrl: 'http://localhost:1234'
            }
          }
        }
      },
      {
        name: '路由目标不匹配测试',
        input: {
          providers: {
            'qwen': {
              type: 'qwen-provider',
              baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation'
            }
          },
          routeTargets: ['non-existent-target'],
          pipelineConfigs: {
            'qwen-target': {
              llmSwitch: {
                type: 'llmswitch-openai-openai'
              },
              compatibility: {
                type: 'qwen-compatibility'
              },
              provider: {
                type: 'qwen-provider'
              }
            }
          }
        }
      },
      {
        name: 'OAuth 配置不完整测试',
        input: {
          providers: {
            'qwen': {
              type: 'qwen-provider',
              baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
              oauth: {
                type: 'qwen'
                // 缺少 tokenFile
              }
            }
          }
        }
      }
    ];
  }

  // 生成多 key 展开测试用例
  static generateMultiKeyCases(): TestCase[] {
    return [
      {
        name: '多 key 展开测试',
        input: {
          providers: {
            'qwen-primary': {
              type: 'qwen-provider',
              baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
              oauth: {
                type: 'qwen',
                tokenFile: '~/.routecodex/oauth/qwen/token.json'
              }
            },
            'qwen-secondary': {
              type: 'qwen-provider',
              baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
              oauth: {
                type: 'qwen',
                tokenFile: '~/.routecodex/oauth/qwen/secondary-token.json'
              }
            }
          },
          pipelineConfigs: {
            'qwen-pipeline': {
              llmSwitch: {
                type: 'llmswitch-openai-openai'
              },
              compatibility: {
                type: 'qwen-compatibility'
              },
              provider: {
                type: 'qwen-provider'
              }
            }
          },
          routeTargets: ['qwen-pipeline']
        }
      }
    ];
  }

  // 生成 Windows/Unix 路径兼容性测试用例
  static generatePathCompatibilityCases(): TestCase[] {
    return [
      {
        name: 'Windows 路径测试',
        input: {
          providers: {
            'lmstudio': {
              type: 'lmstudio-http',
              baseUrl: 'http://localhost:1234',
              auth: {
                type: 'none'
              },
              tokenFile: 'C:\\Users\\User\\.routecodex\\oauth\\lmstudio\\token.json'
            }
          }
        }
      },
      {
        name: 'Unix 路径测试',
        input: {
          providers: {
            'lmstudio': {
              type: 'lmstudio-http',
              baseUrl: 'http://localhost:1234',
              auth: {
                type: 'none'
              },
              tokenFile: '/home/user/.routecodex/oauth/lmstudio/token.json'
            }
          }
        }
      },
      {
        name: '波浪号路径测试',
        input: {
          providers: {
            'qwen': {
              type: 'qwen-provider',
              baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
              oauth: {
                type: 'qwen',
                tokenFile: '~/.routecodex/oauth/qwen/token.json'
              }
            }
          }
        }
      }
    ];
  }

  // 生成模块别名映射测试用例
  static generateModuleAliasCases(): TestCase[] {
    return [
      {
        name: '模块别名映射测试',
        input: {
          providers: {
            'qwen': {
              type: 'qwen',
              baseUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
              oauth: {
                type: 'qwen',
                tokenFile: '~/.routecodex/oauth/qwen/token.json'
              }
            }
          },
          pipelineConfigs: {
            'default': {
              llmSwitch: {
                type: 'openai-normalizer' // 应该映射为 llmswitch-openai-openai
              },
              compatibility: {
                type: 'qwen-compatibility' // 应该映射为 qwen-provider
              },
              provider: {
                type: 'qwen-provider'
              }
            }
          },
          routeTargets: ['default'],
          aliases: {
            'openai-normalizer': 'llmswitch-openai-openai',
            'qwen-compatibility': 'qwen-provider',
            'anthropic-openai-converter': 'llmswitch-anthropic-openai'
          }
        }
      }
    ];
  }

  // 生成所有测试用例
  static generateAllTestCases(): TestCase[] {
    return [
      ...this.generateRealConfigCases(),
      ...this.generateErrorCases(),
      ...this.generateMultiKeyCases(),
      ...this.generatePathCompatibilityCases(),
      ...this.generateModuleAliasCases()
    ];
  }
}

export interface TestCase {
  name: string;
  input: any;
  expectedOutput?: any;
  options?: any;
}
```

### 阶段四：发布和部署 (第5周)

#### 4.1 npm 发布配置
```json
// sharedmodule/packages/config-engine/package.json
{
  "name": "@routecodex/config-engine",
  "version": "1.0.0",
  "description": "Configuration engine for RouteCodex",
  "type": "module",
  "main": "dist/index.js",
  "module": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc",
    "test": "jest",
    "lint": "eslint src/**/*.ts",
    "prepublishOnly": "npm run build && npm test"
  },
  "dependencies": {},
  "devDependencies": {
    "@types/node": "^20.0.0",
    "jest": "^29.0.0",
    "typescript": "^5.0.0"
  },
  "keywords": [
    "config",
    "routecodex",
    "ai",
    "typescript"
  ],
  "author": "RouteCodex Team",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/routecodex/sharedmodule.git"
  }
}
```

#### 4.2 版本管理和发布脚本
```bash
#!/bin/bash
# sharedmodule/scripts/publish.sh

set -e

echo "🚀 开始发布配置模块..."

# 检查版本号
if [ -z "$1" ]; then
  echo "❌ 请提供版本号 (如: 1.0.0)"
  exit 1
fi

VERSION=$1

# 更新版本号
echo "📦 更新版本号到 $VERSION"
cd packages/config-engine
npm version $VERSION --no-git-tag-version
cd ../config-compat
npm version $VERSION --no-git-tag-version
cd ../config-testkit
npm version $VERSION --no-git-tag-version

# 构建所有包
echo "🔨 构建所有包..."
cd ../..
npm run build

# 运行测试
echo "🧪 运行测试..."
npm test

# 发布到 npm
echo "📤 发布到 npm..."
npm publish --workspaces --access public

echo "✅ 发布完成!"
```

## 🔄 集成策略

### 特征开关控制
```typescript
// 在 RouteCodex 主项目中使用
import { ConfigEngine } from '@routecodex/config-engine';
import { LegacyConfigAdapter } from '@routecodex/config-compat';

class ConfigManager {
  private useNewEngine = process.env.USE_NEW_CONFIG_ENGINE === 'true';

  async loadConfig(configPath: string) {
    if (this.useNewEngine) {
      const engine = new ConfigEngine();
      return engine.loadConfig(configPath);
    } else {
      // 使用现有的配置解析器
      return this.loadLegacyConfig(configPath);
    }
  }

  private async loadLegacyConfig(configPath: string) {
    // 现有解析逻辑
  }
}
```

### 渐进式迁移
```typescript
// 迁移工具
export class ConfigMigrationTool {
  async migrateProject(projectPath: string): Promise<MigrationResult> {
    // 1. 分析现有配置
    const analysis = await this.analyzeExistingConfig(projectPath);

    // 2. 生成新配置
    const newConfig = await this.generateNewConfig(analysis);

    // 3. 验证兼容性
    const validation = await this.validateCompatibility(newConfig);

    // 4. 应用新配置
    await this.applyNewConfig(projectPath, newConfig);

    return {
      success: true,
      changes: analysis.changes,
      validationResults: validation
    };
  }
}
```

## 📊 质量保证

### 测试策略
1. **单元测试**: 覆盖所有核心功能
2. **集成测试**: 验证模块间交互
3. **黑盒测试**: 与现有系统对比测试
4. **性能测试**: 确保性能不退化
5. **兼容性测试**: 验证向后兼容性

### 性能指标
- **解析速度**: 新版本应该 <= 旧版本解析时间的 110%
- **内存使用**: 新版本应该 <= 旧版本内存使用的 120%
- **错误处理**: 所有错误情况都应该有优雅的处理
- **类型安全**: 100% TypeScript 类型覆盖

### 发布检查清单
- [ ] 所有测试通过
- [ ] 代码审查完成
- [ ] 文档更新
- [ ] 版本号正确
- [ ] 构建成功
- [ ] 性能测试通过
- [ ] 兼容性测试通过

## 📈 项目时间线

| 阶段 | 时间 | 主要任务 | 产出 |
|------|------|----------|------|
| 阶段一 | 第1周 | 基础架构搭建 | monorepo 结构、核心接口 |
| 阶段二 | 第2-3周 | 核心功能开发 | 配置解析器、适配器、预设 |
| 阶段三 | 第4周 | 测试框架开发 | 黑盒测试、测试工具 |
| 阶段四 | 第5周 | 发布和部署 | npm 包、集成文档 |

## 🎯 成功标准

### 功能标准
- ✅ 100% 功能兼容性
- ✅ 所有现有配置格式支持
- ✅ 向后兼容性保证
- ✅ 完整的错误处理

### 质量标准
- ✅ 测试覆盖率 > 90%
- ✅ 零运行时错误
- ✅ 性能不退化
- ✅ 完整的文档

### 发布标准
- ✅ 独立的 npm 包
- ✅ 完整的 API 文档
- ✅ 迁移指南
- ✅ 示例代码

## 📝 相关文档

- [API 文档](./docs/api.md)
- [迁移指南](./docs/migration.md)
- [开发指南](./docs/development.md)
- [测试指南](./docs/testing.md)

## 🔄 后续计划

1. **监控和反馈**: 收集使用反馈，持续优化
2. **功能扩展**: 根据需求添加新功能
3. **性能优化**: 持续优化性能
4. **生态建设**: 构建完整的配置管理生态系统

---

**文档版本**: 1.0
**最后更新**: 2024-01-15
**负责人**: RouteCodex Team

---

## 🧩 增补与细化（审阅建议已纳入）

### 契约与输出稳定性
- 输出契约固定为当前 MergedConfig，并在输出中加入 `schemaVersion` 与 `engineVersion` 字段，便于宿主断言版本匹配。
- 保证输出确定性：对 `providers`、`routeTargets`、`pipelineConfigs` 等对象键与数组做稳定排序（deterministic）以利快照对比与审计。

### 错误与诊断标准
- 标准化错误码：`validation_error`、`compat_error`、`migration_error`、`io_error`；错误载荷包含 JSON Pointer（`instancePath`）、`schemaPath` 与业务上下文（`providerId`/`modelId`/`pipelineKey`）。
- 业务规则校验清单：
  - routeTargets ↔ pipelineConfigs 完备性（一一对应）
  - provider 可用性（`type` 必须在宿主注入的 `registeredModuleTypes` 中）
  - OAuth：`tokenFile` 展开为绝对路径；`baseURL` 与 `oauth` 至少满足一项
  - 模块别名归一：如 `openai-normalizer`→`llmswitch-openai-openai` 等

### 安全与密钥治理
- 统一脱敏：日志/错误/快照对 `apiKey`、`token`、`refresh_token` 做红action（如 `sk-****`）。
- Secret Resolver 扩展点：预留 env > file > literal > keychain/sops 的可插拔解析链，首期实现 env+file。

### 性能与确定性
- 性能预算：典型 `mixed.json` 的 parse+merge P95 < 60ms，CI 设阈值基线；内存使用 ≤ 旧实现 120%。
- 缓存边界：引擎不负责 watch；可选一次性 in-memory 缓存（可禁用），避免状态引入非确定性。

### 迁移与回滚
- CLI 提供 `--dry-run` 与 `--diff`，迁移生成备份与回滚指令提示。
- 灰度开关：`USE_NEW_CONFIG_ENGINE=true`；采集解析时延/错误率指标；回滚 SOP：关闭开关即回退 legacy 路径。

### 测试与 CI 矩阵
- 快照来源：使用当前真实样本（`~/.routecodex/config/mixed.json`、`modelscope.json` 等）作为黄金快照。
- 矩阵覆盖：Node 18/20/22，Ubuntu/macOS/Windows（含 `~` 展开、Windows 盘符）。
- 决定性测试：验证稳定排序与无随机字段污染（不在输出注入时间戳/随机 id）。

### 打包与发布约定
- 仅支持 ESM；`exports` 暴露 `types`；`engines`: Node ≥ 18。
- 用 Changesets 管理 semver 与发布说明，提供 next/canary tag 测试通道。
- 从 JSON Schema 生成文档与 VSCode schema（智能提示）。

### Preset 对齐与脚本
- 通过脚本从宿主导出的注册清单校验 presets（provider/llmswitch 名称不漂移）。
- 覆盖优先级断言：`model > provider > preset > default`，纳入测试断言。

### 扩展与诊断
- Provider 正规化插件接口：`registerProviderNormalizer({ id, normalizeFn })`，便于新增厂商时零入侵。
- 诊断命令：`rc-config why` 打印 routeTarget → pipelineConfig 的推导链路与命中规则，定位“为什么没有 pipeline”。

### 验收指标（KPI）
- 兼容性通过率 ≥ 99%（覆盖现网主流配置与 e2e 样例）
- 快照一致率 100%（稳定排序确保）
- 解析耗时 P95 < 60ms（典型 mixed.json）
- 误报/漏报率 < 1%（验证器）
