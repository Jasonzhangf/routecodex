# Provider Module - 统一OpenAI标准实现

## 🎯 设计概述

本模块基于RouteCodex 9大核心架构原则，提供统一的OpenAI标准实现。通过配置驱动的方式支持多种OpenAI兼容服务，包括GLM、Qwen、OpenAI、iFlow和LM Studio等，同时保持与V1版本的完全接口兼容性。

## 🏗️ 核心架构

### 分层架构设计

```
┌─────────────────────────────────────────────────┐
│                  API接口层 (v2/api/)              │
├─────────────────────────────────────────────────┤
│  统一对外接口  │  类型定义  │  配置接口       │
├─────────────────────────────────────────────────┤
│                  核心实现层 (v2/core/)            │
├─────────────────────────────────────────────────┤
│  基础抽象类  │  标准实现  │  实例工厂       │
├─────────────────────────────────────────────────┤
│                  认证模块 (v2/auth/)            │
├─────────────────────────────────────────────────┤
│  认证接口  │  API Key  │    OAuth         │
├─────────────────────────────────────────────────┤
│                  配置管理 (v2/config/)          │
├─────────────────────────────────────────────────┤
│  服务配置  │  配置验证  │  配置转换       │
├─────────────────────────────────────────────────┤
│                  工具模块 (v2/utils/)             │
├─────────────────────────────────────────────────┤
│  HTTP客户端 │  请求标准化 │ 响应标准化      │
└─────────────────────────────────────────────────┘
```

## 📋 模块详细说明

### API接口层 (v2/api/)

#### 📄 index.ts - 统一对外接口
- **作用**: 提供与V1版本完全一致的对外接口
- **职责**: 统一导出、类型定义、兼容性保证
- **关键功能**:
  - 导出 `OpenAIStandard` 主要类
  - 导出所有类型定义和配置接口
  - 提供V1兼容的类型别名
  - 提供便捷的工厂函数

#### 📄 provider-types.ts - 类型定义
- **作用**: 定义与V1完全兼容的类型接口
- **职责**: 类型安全、接口定义、扩展类型
- **关键类型**:
  - `IProviderV2`: 统一Provider接口
  - `ProviderType`: 支持的服务类型
  - `ProviderError`: 错误类型定义
  - `ProviderMetrics`: 性能指标类型

#### 📄 provider-config.ts - 配置接口
- **作用**: 定义统一的配置接口和验证规则
- **职责**: 配置标准化、V1兼容、类型安全
- **关键接口**:
  - `OpenAIStandardConfig`: 统一配置接口
  - `ApiKeyAuth`: API Key认证配置
  - `OAuthAuth`: OAuth认证配置
  - `ServiceOverrides`: 服务覆盖配置

### 核心实现层 (v2/core/)

#### 📄 base-provider.ts - 基础抽象类
- **作用**: 提供Provider的通用实现和抽象方法
- **职责**: 通用逻辑、抽象方法定义、模板模式
- **关键功能**:
  - 生命周期管理 (`initialize`, `cleanup`)
  - 请求处理流程 (`processIncoming`, `processOutgoing`)
  - 健康检查 (`checkHealth`)
  - 错误处理和日志记录
  - 抽象方法定义（供子类实现）

#### 📄 openai-standard.ts - 标准实现
- **作用**: 统一的OpenAI标准Provider实现
- **职责**: 服务处理、配置驱动、请求路由
- **关键功能**:
  - 根据配置选择服务处理逻辑
  - 服务特定的请求预处理和响应后处理
  - 认证头部构建和验证
  - HTTP请求发送和响应处理
  - 支持的服务: OpenAI, GLM, Qwen, iFlow, LM Studio

#### 📄 provider-factory.ts - 实例工厂
- **作用**: Provider实例的创建和管理
- **职责**: 实例创建、生命周期管理、配置验证
- **关键功能**:
  - `createProvider()`: 创建Provider实例
  - `getProvider()`: 获取现有实例
  - `cleanupAll()`: 清理所有实例
  - 配置验证和错误处理
  - 实例缓存和复用

### 认证模块 (v2/auth/)

#### 📄 auth-interface.ts - 认证接口
- **作用**: 定义统一的认证接口和标准
- **职责**: 认证抽象、类型定义、标准协议
- **关键接口**:
  - `IAuthProvider`: 统一认证接口
  - `IOAuthClient`: OAuth客户端接口
  - `TokenStorage`: 令牌存储接口
  - 认证状态和错误类型定义

#### 📄 apikey-auth.ts - API Key认证 (待实现)
- **作用**: API Key认证的具体实现
- **职责**: API Key验证、头部构建、凭证管理
- **关键功能**:
  - API Key格式验证
  - Authorization头部构建
  - 凭证状态检查
  - 可配置的头部名称和前缀

#### 📄 oauth-auth.ts - OAuth认证 (待实现)
- **作用**: OAuth认证的具体实现
- **职责**: OAuth流程处理、令牌管理、刷新机制
- **关键功能**:
  - OAuth 2.0流程处理
  - 访问令牌和刷新令牌管理
  - 令牌自动刷新
  - 支持设备流和授权码流程

### 配置管理 (v2/config/)

#### 📄 service-profiles.ts - 服务配置档案
- **作用**: 定义各服务的预设配置和验证规则
- **职责**: 服务预设、配置验证、扩展支持
- **关键功能**:
  - 5种服务的完整预设配置
  - 配置验证器和类型检查
  - 服务配置注册和扩展机制
  - 认证类型支持验证

### 工具模块 (v2/utils/)

#### 📄 http-client.ts - HTTP客户端 (已实现)
- **作用**: 提供统一的HTTP请求处理功能
- **职责**: HTTP通信、重试机制、错误处理
- **关键功能**:
  - 标准HTTP方法支持 (GET, POST, PUT, DELETE, PATCH)
  - 自动重试机制和指数退避
  - 超时控制和错误处理
  - 请求头构建和响应解析

## 🚀 使用指南

### 基础使用

```typescript
import { OpenAIStandard, type OpenAIStandardConfig } from './api/index.js';

// GLM配置
const glmConfig: OpenAIStandardConfig = {
  type: 'openai-standard',
  config: {
    providerType: 'glm',
    auth: {
      type: 'apikey',
      apiKey: 'your-glm-api-key'
    },
    overrides: {
      defaultModel: 'glm-4'
    }
  }
};

// 创建Provider实例
const glmProvider = new OpenAIStandard(glmConfig, dependencies);
await glmProvider.initialize();

// 使用Provider
const request = {
  model: 'glm-4',
  messages: [{ role: 'user', content: 'Hello!' }]
};
const response = await glmProvider.processIncoming(request);
```

### 工厂创建

```typescript
import { createOpenAIStandard } from './api/index.js';

// 使用工厂创建实例
const provider = createOpenAIStandard(config, dependencies);
```

### 支持的服务类型

| 服务类型 | 认证方式 | 默认端点 | 特殊处理 |
|---------|---------|-----------|---------|
| `openai` | API Key | `/v1/chat/completions` | 组织ID支持 |
| `glm` | API Key | `/chat/completions` | 中文优化 |
| `qwen` | OAuth | `/chat/completions` | 客户端元数据 |
| `iflow` | OAuth | `/v1/chat/completions` | PKCE支持 |
| `lmstudio` | API Key | `/v1/chat/completions` | 本地模型 |

## 🔄 V1兼容性

### 接口完全一致

```typescript
// V1版本用法 (完全不变)
import { GLMHTTPProvider } from '../glm-http-provider.js';
const v1Provider = new GLMHTTPProvider(v1Config, dependencies);

// V2版本用法 (接口一致)
import { OpenAIStandard } from './v2/api/index.js';
const v2Provider = new OpenAIStandard(v2Config, dependencies);

// 两个版本的方法签名完全相同
await v1Provider.initialize();
await v2Provider.initialize();

await v1Provider.processIncoming(request);
await v2Provider.processIncoming(request);
```

### 配置转换支持

```typescript
import { fromV1Config } from './v2/api/index.js';

// 从V1配置创建V2 Provider
const v2Provider = fromV1Config(v1Config, dependencies);
```

## 📈 扩展性

### 添加新服务类型

1. 在 `service-profiles.ts` 中添加服务配置
2. 在 `provider-types.ts` 中添加类型定义
3. 根据需要实现特殊处理逻辑

### 自定义认证方式

1. 在 `auth-interface.ts` 中扩展接口
2. 实现新的认证类
3. 在核心Provider中注册认证工厂

### 服务特定配置扩展

1. 使用 `ServiceOverrides` 覆盖默认配置
2. 通过配置档案注册扩展
3. 实现自定义的请求/响应处理

---

**版本**: 2.0.0 | **兼容性**: 与V1接口完全兼容 | **维护状态**: 活跃开发中 | **目录**: src/modules/pipeline/modules/provider/v2/