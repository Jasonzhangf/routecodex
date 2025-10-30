# Resource Module

共享资源池与服务实例管理，提供连接池化、实例复用、健康检查与统计能力。

## 主要职责
- 连接池创建与租借/归还
- 基于 TTL 的服务实例缓存
- 健康检查与故障恢复
- 资源使用度量

## 对外接口
- `ResourceManager`（`resource-manager.ts`）
  - `createConnectionPool(...)`
  - `getServiceInstance(name, factory, ttlMs)`
  - `metrics()`

## 用法
```ts
import { ResourceManager } from './resource-manager.js';
const rm = new ResourceManager();
const pool = await rm.createConnectionPool({ name: 'http' });
```

