# Provider模块

## 功能
- Provider基类定义
- OpenAI兼容Provider实现
- Provider工厂模式

## 文件说明
- `base-provider.ts`: Provider基类，定义Provider的通用接口，支持ESM模块导入
- `openai-provider.ts`: OpenAI兼容Provider的具体实现，支持多种OpenAI兼容API
- `provider-factory.ts`: Provider工厂，负责创建和管理Provider实例，支持动态Provider注册

## 依赖关系
- 依赖 `utils/logger.ts` 进行日志记录
- 依赖 `utils/error-handler.ts` 进行错误处理
- 依赖 `config/config-types.ts` 进行配置类型验证
- 被 `core/provider-manager.ts` 调用

## 使用示例
```typescript
import { BaseProvider } from './base-provider';
import { OpenAIProvider } from './openai-provider';
import { ProviderFactory } from './provider-factory';

const provider = new OpenAIProvider({
  endpoint: 'https://api.example.com/v1',
  apiKey: 'your-api-key'
});

const factory = new ProviderFactory();
const instance = await factory.createProvider('openai', config);
```