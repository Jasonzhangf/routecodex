# Pipeline Module Interfaces

流水线模块的接口定义，规范各个模块的行为和交互方式。

## 接口清单

### 核心处理接口
- **llm-switch-module.ts**: LLMSwitch模块接口，定义协议转换行为
- **workflow-module.ts**: Workflow模块接口，定义流式控制行为
- **compatibility-module.ts**: Compatibility模块接口，定义字段转换行为
- **provider-module.ts**: Provider模块接口，定义服务提供商行为

## 设计原则

### 统一接口设计
所有模块都遵循统一的设计模式：
- 异步处理方法
- 配置驱动的初始化
- 统一的错误处理
- Debug日志支持

### 可替换性
基于接口的设计允许：
- 运行时替换模块实现
- A/B测试不同算法
- 条件性模块选择
- 易于单元测试

### 配置标准化
所有模块都使用标准化的配置格式：
- 类型标识
- 配置参数
- 验证规则
- 默认值

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