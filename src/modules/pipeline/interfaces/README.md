# Pipeline Module Interfaces

基于RouteCodex 9大核心架构原则的流水线模块接口定义，规范各个模块的行为和交互方式。

## 🚨 9大架构原则接口约束

### **原则1-3: 技术架构基础接口约束**

基于RouteCodex核心架构原则，各模块接口严格遵循以下职责分离：

#### **LLMSwitch模块接口约束 (原则1: 统一工具处理)**
```typescript
interface LLMSwitchModule {
  // ✅ 允许的职责 (原则1合规)
  processIncoming(request: any): Promise<any>;  // 委托给llmswitch-core
  processOutgoing(response: any): Promise<any>; // 委托给llmswitch-core

  // ❌ 禁止的职责 (违反原则1)
  // 不直接处理工具调用转换，全部委托给llmswitch-core
  // 不进行provider特定的字段适配
  // 不重复实现工具文本收割逻辑
}
```

#### **Compatibility模块接口约束 (原则2: 最小兼容层)**
```typescript
interface CompatibilityModule {
  // ✅ 允许的职责 (原则2合规)
  processIncoming(request: any): Promise<any>;  // provider特定配置注入
  processOutgoing(response: any): Promise<any>; // 字段标准化

  // ❌ 禁止的职责 (违反原则2)
  // 不处理工具调用格式转换 (原则1)
  // 不进行文本工具收割 (原则1)
  // 不重复llmswitch-core的功能
  // 不实现fallback逻辑 (原则6)
}
```

#### **Provider模块接口约束 (原则4-6: 质量保证)**
```typescript
interface ProviderModule {
  // ✅ 允许的职责 (原则4-6合规)
  processIncoming(request: any): Promise<any>;  // HTTP请求准备
  processOutgoing(response: any): Promise<any>; // HTTP响应处理

  // ❌ 禁止的职责 (违反原则4-6)
  // 不修改数据格式（由Compatibility层处理）
  // 不处理工具调用逻辑
  // 不隐藏错误 (原则4)
  // 不实现silent failures (原则5)
}
```

### **原则7-9: 可维护性设计接口约束**

#### **功能分离原则接口设计 (原则7)**
```typescript
// 每个模块接口只负责单一职责
interface ModuleInterface {
  // 单一职责方法
  process(request: any): Promise<any>;

  // 不包含多重职责
  // 避免功能重叠
}

// 模块间依赖明确
interface ModuleDependencies {
  llmSwitch: LLMSwitchModule;    // 协议转换
  workflow: WorkflowModule;      // 流式控制
  compatibility: CompatibilityModule; // 字段适配
  provider: ProviderModule;      // HTTP通信
}
```

#### **配置驱动原则接口设计 (原则8)**
```typescript
interface ConfigurableModule {
  // 配置驱动初始化
  initialize(config: ModuleConfig): Promise<void>;

  // 配置验证
  validateConfig(config: any): boolean;

  // 热更新支持
  updateConfig(config: Partial<ModuleConfig>): Promise<void>;
}

interface ModuleConfig {
  type: string;           // 模块类型标识
  config: any;           // 模块特定配置
  validation?: ConfigValidation; // 配置验证规则
}
```

#### **模块化原则接口设计 (原则9)**
```typescript
// 文件大小控制：每个接口文件不超过200行
// 功能分拆：按职责定义不同的接口文件

// llm-switch-module.ts (单一职责：协议转换)
interface LLMSwitchModule { /* 50行 */ }

// workflow-module.ts (单一职责：流式控制)
interface WorkflowModule { /* 40行 */ }

// compatibility-module.ts (单一职责：字段适配)
interface CompatibilityModule { /* 60行 */ }

// provider-module.ts (单一职责：HTTP通信)
interface ProviderModule { /* 50行 */ }
```

## 接口清单

### 核心处理接口
- **llm-switch-module.ts**: LLMSwitch模块接口，定义协议转换行为
- **workflow-module.ts**: Workflow模块接口，定义流式控制行为
- **compatibility-module.ts**: Compatibility模块接口，定义字段转换行为
- **provider-module.ts**: Provider模块接口，定义服务提供商行为

## 基于架构原则的设计

### 原则7: 功能分离的统一接口设计
所有模块都遵循统一的设计模式，确保职责单一：
- 异步处理方法
- 配置驱动的初始化
- 统一的错误处理 (原则4-5)
- 结构化日志支持 (原则5)

### 原则7: 职责边界清晰
基于接口设计强制执行模块职责边界：
- **LLMSwitch**: 协议透传，委托工具处理给llmswitch-core (原则1)
- **Compatibility**: 仅做provider特定字段适配 (原则2)
- **Provider**: 纯HTTP通信，错误立即暴露 (原则4)

### 原则6: 清晰解决方案的可替换性
基于接口的设计允许：
- 运行时替换模块实现
- A/B测试不同算法
- 条件性模块选择
- 易于单元测试
- **无fallback逻辑**: 单一明确的实现路径

### 原则8: 配置驱动标准化
所有模块都使用标准化的配置格式：
- 类型标识
- 配置参数
- 验证规则
- 默认值
- **无硬编码**: 所有参数可配置

### 原则9: 模块化文件组织
- **文件大小控制**: 每个接口文件不超过200行
- **功能分拆**: 按职责定义不同的接口文件
- **依赖管理**: 明确模块间依赖关系
- **可维护性**: 单一文件单一职责

## 接口使用示例

```typescript
// 实现LLMSwitch接口
class CustomLLMSwitch implements LLMSwitchModule {
  async transformRequest(request: any): Promise<any> {
    // 实现协议转换逻辑
  }

  getSupportedProtocols(): { source: string[]; target: string[] } {
    return { source: ['openai'], target: ['custom'] };
  }
}

// 实现Provider接口
class CustomProvider implements ProviderModule {
  async sendRequest(request: any): Promise<any> {
    // 实现请求处理逻辑
  }

  async authenticate(): Promise<AuthResult> {
    // 实现认证逻辑
  }
}
```