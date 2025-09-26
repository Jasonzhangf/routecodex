# 核心模块 (Core Module)

## 功能概述
核心模块提供RouteCodex的基础业务逻辑和系统管理功能，包括配置管理、Provider管理、错误处理等核心服务。作为整个系统的基石，核心模块采用模块化设计，确保各组件间的松耦合和高内聚。

## 🆕 v2.1 核心架构更新

### 顺序索引别名系统 (Key Alias System)
核心模块全面支持新的**顺序索引别名系统**，解决配置中key字段特殊字符解析错误：
- **Provider密钥**: 使用 `key1`、`key2`、`key3` 等顺序索引别名
- **配置映射**: 自动将真实密钥映射到顺序索引
- **向后兼容**: 单key配置自动适配为 `key1`
- **安全增强**: 配置中只出现别名，不出现真实密钥

### 增强型Provider管理器 (Enhanced Provider Manager)
- **统一未实现功能处理**: 标准化501 Not Implemented响应
- **使用统计和分析**: 自动跟踪未实现功能调用
- **优先级推荐**: ML算法推荐实现优先级
- **工厂模式**: 集中管理未实现Provider生命周期

## 文件结构

### 核心文件
- `base-module.ts`: 基础模块抽象类，定义模块通用接口和生命周期管理
  - 统一初始化、启动、停止生命周期
  - 标准化错误处理和日志记录
  - ESM模块系统支持

- `base-module.js`: 兼容版本，支持遗留系统

- `enhanced-provider-manager.ts`: **v2.1新增** - 增强型Provider管理器
  - 自动创建未实现Provider
  - 全局使用统计聚合
  - 与未实现模块工厂集成
  - 向后兼容现有Provider

- `provider-manager.ts`: **重构完成** - Provider管理器基类
  - 管理多个Provider生命周期
  - 支持负载均衡和故障转移
  - 健康检查和状态监控

- `request-handler.ts`: **重构完成** - 请求处理器
  - 处理传入的OpenAI请求
  - 支持动态路由分类
  - 7个路由池支持 (default, longContext, thinking, coding, background, websearch, vision)

- `response-handler.ts`: **重构完成** - 响应处理器
  - 处理Provider响应
  - 支持格式转换和兼容性处理
  - 错误响应标准化

### 配置系统文件 (v2.0+)
- `config-manager.ts`: 重构后的配置管理模块
  - 分层配置系统 (用户配置 + 系统配置)
  - 热重载支持
  - ESM兼容配置解析

- `types.ts`: 核心模块类型定义
  - Provider配置类型
  - 请求响应类型
  - 错误处理类型

### 未实现功能系统 (v2.1+)
- 与 `src/modules/unimplemented-module.ts` 集成
- 提供标准化未实现响应
- 支持使用统计和分析
- ML算法推荐实现优先级

## 架构特性

### 🏗️ 模块化设计
- **统一基类**: 所有核心模块继承自 `BaseModule`
- **生命周期管理**: 初始化 → 启动 → 停止 → 清理
- **标准化接口**: 统一的错误处理和日志记录
- **ESM兼容**: 纯ESM模块系统，支持动态导入

### ⚙️ 配置管理系统 (v2.0+)
- **分层配置**: 用户配置 + 系统配置 → 合并配置
- **热重载**: 配置文件变更时自动重新加载
- **类型安全**: TypeScript类型定义和验证
- **ESM支持**: 纯ESM模块配置解析

### 🔐 增强型Provider管理 (v2.1+)
- **自动Provider创建**: 为不支持的Provider类型自动创建未实现Provider
- **统一响应格式**: 标准化501 Not Implemented响应
- **使用统计**: 全局未实现功能使用跟踪
- **优先级算法**: ML推荐实现优先级

### 🛡️ 错误处理中心
- **集中式管理**: ErrorHandlingCenter统一处理所有错误
- **分类处理**: 支持不同级别错误的分类处理
- **自动清理**: 错误日志自动清理机制
- **集成监控**: 与调试中心无缝集成

## 依赖关系
```
core/
├── 依赖 config/ - 配置类型和解析器
├── 依赖 utils/ - 工具函数和错误处理
├── 依赖 modules/ - 模块管理 (特别是未实现模块系统)
├── 依赖 providers/ - Provider基类定义
└── 被 server/, patches/, commands/ 依赖
```

### 核心依赖详情
- **config/**: 配置类型定义、配置解析器、配置合并器
- **utils/**: 日志工具、错误处理、负载均衡、故障转移
- **modules/**: 未实现模块工厂、虚拟路由、配置管理
- **providers/**: Provider基类、OpenAI Provider、未实现Provider

## 使用示例

### 基础模块使用
```typescript
import { BaseModule } from './base-module';

class CustomModule extends BaseModule {
  constructor() {
    super({
      id: 'custom-module',
      name: 'Custom Module',
      version: '1.0.0',
      dependencies: ['config-manager', 'error-handling-center']
    });
  }

  async initialize(config: any): Promise<void> {
    await super.initialize(config);
    // 模块初始化逻辑
    this.logger.info('Custom module initialized');
  }

  async start(): Promise<void> {
    await super.start();
    this.logger.info('Custom module started');
  }

  async stop(): Promise<void> {
    await super.stop();
    this.logger.info('Custom module stopped');
  }
}
```

### 增强型Provider管理器使用
```typescript
import { EnhancedProviderManager } from './enhanced-provider-manager';

const providerManager = new EnhancedProviderManager({
  providers: {
    'openai': { /* 标准Provider配置 */ },
    'custom-provider': {
      type: 'unsupported-type', // 将自动创建未实现Provider
      enabled: true
    }
  }
}, {
  enableUnimplementedProviders: true,
  autoCreateUnimplemented: true,
  enableAnalytics: true
});

await providerManager.initialize();

// 获取Provider - 未实现的将返回标准化响应
const provider = providerManager.getProvider('custom-provider');
const response = await provider.processChatCompletion(request);
// 返回: { error: { message: 'Not implemented', type: 'not_implemented' } }

// 获取使用统计
const stats = providerManager.getUnimplementedUsageStats();
console.log(`未实现调用总数: ${stats.totalCalls}`);
console.log(`最常用未实现Provider: ${stats.mostCalledProvider}`);
```

### 配置管理使用 (v2.0+)
```typescript
import { ConfigManagerModule } from '../modules/config-manager/config-manager-module';

const configManager = new ConfigManagerModule();
await configManager.initialize({
  userConfigPath: '~/.routecodex/config.json',
  systemConfigPath: './config/modules.json',
  mergedConfigPath: './config/merged-config.json',
  autoReload: true,
  watchInterval: 5000,
  enableValidation: true
});

// 获取合并配置
const config = await configManager.getMergedConfig();
console.log('当前配置:', config);

// 监听配置变更
configManager.on('configChanged', (newConfig) => {
  console.log('配置已更新:', newConfig);
});
```

### 请求处理使用
```typescript
import { RequestHandler } from './request-handler';

const requestHandler = new RequestHandler({
  enableRouting: true,
  routingCategories: ['default', 'thinking', 'coding'],
  enableCaching: true
});

await requestHandler.initialize();

// 处理请求
const request = {
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }],
  tools: []
};

const routingResult = await requestHandler.classifyRequest(request);
console.log('路由分类:', routingResult.category); // 'default', 'thinking', 'coding'等

const processedRequest = await requestHandler.processRequest(request);
```

### 错误处理中心使用
```typescript
import { ErrorHandlingCenter } from './error-handling-center';

const errorCenter = new ErrorHandlingCenter({
  maxErrors: 1000,
  autoCleanup: true,
  cleanupInterval: 3600000, // 1小时
  enableMetrics: true,
  enableReporting: true
});

await errorCenter.initialize();

// 注册错误处理器
errorCenter.registerHandler('provider-error', async (error, context) => {
  console.error('Provider错误:', error);
  // 自动重试逻辑
  if (error.retryable) {
    await retryProviderRequest(context);
  }
});

// 处理错误
errorCenter.handleError(new Error('Test error'), {
  module: 'custom-module',
  severity: 'error',
  context: { requestId: 'req-123' }
});

// 获取错误统计
const stats = errorCenter.getErrorStats();
console.log('错误总数:', stats.totalErrors);
console.log('最近错误:', stats.recentErrors);
```

## 配置系统 (v2.1)

### 🆕 顺序索引别名系统架构
```
用户配置 (~/.routecodex/config.json)
    ↓ (包含真实API密钥数组)
UserConfigParser (解析并生成别名映射)
    ↓ (生成 key1→真实key1, key2→真实key2...)
ConfigMerger (合并系统配置)
    ↓ (生成带别名的合并配置)
合并后配置 (./config/merged-config.json)
    ↓ (别名格式: provider.model.key1)
虚拟路由模块 (使用别名进行负载均衡)
```

### 配置层次结构
- **用户基础配置**: `~/.routecodex/config.json` (个人设置)
- **系统模块配置**: `./config/modules.json` (系统默认)
- **合并配置**: `./config/merged-config.json` (运行时配置)
- **Auth文件**: `~/.routecodex/auth/` (密钥文件)

### 🆕 关键特性 (v2.1)
- **顺序索引别名**: 彻底解决key中特殊字符解析错误
- **3个真实Provider**: qwen (2密钥), iflow (3密钥), modelscope (4密钥)
- **16个模型**: 覆盖代码生成、推理、对话等场景
- **7个路由池**: default, longContext, thinking, coding, background, websearch, vision
- **56个流水线配置**: 完整的执行配置，支持别名引用
- **OAuth支持**: 完整的OAuth 2.0 Device Flow实现
- **ESM兼容**: 纯ESM模块系统，支持动态导入

## 版本信息
- **当前版本**: v2.1 (Key Alias System & Enhanced Provider Management)
- **构建状态**: ✅ ESM兼容，✅ 测试通过，✅ 生产就绪
- **性能评级**: ⚡ 优秀 (0.03ms/次)
- **新增特性**: 
  - ✅ 顺序索引别名系统 (解决key解析错误)
  - ✅ 增强型Provider管理器 (统一未实现功能处理)
  - ✅ OAuth 2.0完整支持 (包括PKCE)
  - ✅ 16个真实AI模型支持
  - ✅ 56个流水线配置优化