# Module Implementations

流水线模块的具体实现，包含LLMSwitch、Workflow、Compatibility和Provider的具体实现。

## 目录结构

```
modules/
├── llm-switch/          # LLMSwitch实现
│   └── openai-normalizer.ts
├── workflow/            # Workflow实现
│   └── streaming-control.ts
├── compatibility/       # Compatibility实现
│   └── field-mapping.ts
└── providers/           # Provider实现
    ├── base-provider.ts
    ├── http-provider.ts
    ├── apikey-provider.ts
    └── oauth-provider.ts
```

## 模块说明

### LLMSwitch实现
- **openai-normalizer.ts**: OpenAI协议规范化实现，保持OpenAI→OpenAI格式

### Workflow实现
- **streaming-control.ts**: 流式控制实现，处理流式/非流式转换

### Compatibility实现
- **field-mapping.ts**: 基于JSON配置的字段映射实现

### Provider实现
- **base-provider.ts**: 所有Provider的基础类
- **http-provider.ts**: HTTP请求的通用Provider实现
- **apikey-provider.ts**: APIKey认证的Provider实现
- **oauth-provider.ts**: OAuth认证的Provider实现

## 扩展指南

### 添加新的LLMSwitch
1. 在`llm-switch/`目录下创建新文件
2. 实现`LLMSwitchModule`接口
3. 注册到模块注册表

### 添加新的Provider
1. 继承`BaseProvider`类
2. 实现必要的认证和请求处理方法
3. 在工厂中注册新类型

### 添加新的Workflow
1. 实现`WorkflowModule`接口
2. 在工厂中添加创建逻辑
3. 更新配置类型定义
