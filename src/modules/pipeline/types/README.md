# Pipeline Type Definitions

流水线模块的TypeScript类型定义，提供完整的类型安全支持。

## 类型文件

### 核心类型
- **pipeline-types.ts**: 流水线核心类型，包括请求/响应、配置、接口等
- **transformation-types.ts**: 转换相关类型，包括转换规则、引擎类型等
- **provider-types.ts**: Provider相关类型，包括认证、配置、错误等

## 设计原则

### 类型安全
- 严格的接口定义
- 完整的配置验证
- 运行时类型检查
- 编译时错误检测

### 可扩展性
- 基于泛型的灵活设计
- 联合类型支持多种实现
- 可选类型支持向后兼容
- 条件类型支持复杂逻辑

### 文档化
- JSDoc注释说明用途
- 示例代码展示用法
- 相关类型引用
- 版本兼容性说明

## 主要类型

### PipelineRequest/PipelineResponse
标准化的请求响应类型，包含：
- 原始请求数据
- 路由信息
- 元数据
- 调试上下文

### TransformationRule
转换规则定义，支持：
- JSON路径操作
- 多种转换类型
- 条件转换逻辑
- 验证规则

### ProviderConfig
Provider配置类型，包括：
- 认证配置
- 兼容性配置
- 网络配置
- 错误处理配置