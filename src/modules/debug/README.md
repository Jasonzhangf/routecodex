# Debug Module

统一调试增强与日志记录。集中管理跨模块的性能度量、请求日志与错误追踪，支持文件落盘。

## 主要职责
- 注册模块级调试增强（启用/禁用、性能追踪、历史保留）
- 统一事件总线对接（DebugEventBus）
- 文件日志记录（可供线下排障）

## 对外接口
- `DebugEnhancementManager`（`debug-enhancement-manager.ts`）
- `DebugFileLogger`（`debug-file-logger.ts`）

## 用法
```ts
import { DebugEnhancementManager } from './debug-enhancement-manager.js';
const mgr = DebugEnhancementManager.getInstance();
const enh = mgr.registerEnhancement('pipeline', { enabled: true });
```

