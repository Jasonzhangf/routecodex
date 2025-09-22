# 配置模块

## 功能
- 配置文件定义
- 配置类型定义
- 配置加载和验证

## 文件说明
- `default-config.json`: 默认配置文件模板，包含所有可配置项的示例
- `config-types.ts`: 配置相关的TypeScript类型定义，支持ESM类型导入
- `config-loader.ts`: 配置文件加载器，支持多配置源和环境变量，ESM兼容
- `config-validator.ts`: 配置验证器，确保配置的正确性和完整性

## 依赖关系
- 被 `core/config-manager.ts` 调用
- 被 `core/provider-manager.ts` 调用
- 依赖 `utils/logger.ts` 进行配置加载日志
- 支持 `config/routecodex.json` 用户配置文件

## 使用示例
```typescript
import { ConfigLoader } from './config-loader';
import { ConfigValidator } from './config-validator';

const loader = new ConfigLoader();
const validator = new ConfigValidator();
const config = await loader.loadConfig('./config/routecodex.json');
const isValid = await validator.validate(config);
```