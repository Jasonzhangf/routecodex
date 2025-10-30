# Dry-Run Engine

干运行引擎，基于现有流水线接口，对请求在“仅路由/仅流水线/全链路”等不同作用域进行离线评估与回放。

## 主要职责
- 路由/流水线的非侵入式模拟执行
- 统计与对比（请求预算、token 估计、工具使用等）
- 可选持久化，用于后续回放

## 对外接口
- `DryRunEngine`（`core/engine.ts`）
  - `runRequest/runResponse/runBidirectional`（按作用域执行）
- `dryRunEngine`（单例）

## 用法
```ts
import { dryRunEngine } from './core/engine.js';
const res = await dryRunEngine.runRequest({ /* opts */ });
```

