# Initialization Module

并行初始化器与依赖拓扑工具，负责在启动期解析模块依赖关系并以最优并行度完成初始化、健康检查与清理。

## 主要职责
- 依赖图构建与循环检测
- 并行度控制与失败重试（指数退避）
- 初始化统计与健康检查
- 统一的清理阶段

## 对外接口
- `ParallelInitializer`（`parallel-initializer.ts`）
  - `run(tasks, config)`：执行初始化
  - `cleanup()`：按反向依赖顺序清理

## 用法
```ts
import { ParallelInitializer } from './parallel-initializer.js';

const init = new ParallelInitializer();
const result = await init.run(tasks, { maxConcurrency: 4 });
```

