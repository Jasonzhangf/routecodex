# 核心模块

## 功能
- 配置管理
- Provider管理
- 请求处理
- 响应处理

## 文件说明
- `config-manager.ts`: 配置管理器，负责加载和管理配置文件，支持ESM模块导入
- `provider-manager.ts`: Provider管理器，管理多个Provider的生命周期，支持负载均衡和故障转移
- `request-handler.ts`: 请求处理器，处理传入的OpenAI请求，支持动态路由分类
- `response-handler.ts`: 响应处理器，处理Provider的响应，支持格式转换和兼容性处理

## 依赖关系
- 依赖 `config/config-loader.ts` 进行配置加载
- 依赖 `providers/base-provider.ts` 进行Provider管理
- 依赖 `utils/load-balancer.ts` 进行负载均衡
- 依赖 `utils/failover.ts` 进行故障转移
- 依赖 `patches/patch-manager.ts` 进行兼容性处理

## 使用示例
```typescript
import { ConfigManager } from './config-manager';
import { ProviderManager } from './provider-manager';

const configManager = new ConfigManager();
const providerManager = new ProviderManager();
await configManager.loadConfig();
```