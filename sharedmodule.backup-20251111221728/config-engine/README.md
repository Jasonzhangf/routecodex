# routecodex-config-engine

RouteCodex 配置引擎（共享模块）。提供配置解析、校验、环境变量展开、敏感信息脱敏，以及统一的配置路径解析工具。

## 功能概览
- 配置解析与校验（Zod/Ajv 形状，版本管理与兼容性检查）
- 环境变量展开与安全脱敏（支持 `***REDACTED***` 输出）
- 统一配置路径解析（家目录与工作区路径兼容）
- JSON Pointer 工具与错误定位（`utils/json-pointer.ts`）

## 主要导出
- `ConfigParser`（`src/core/config-parser.ts`）
- `createConfigParser()`（`src/index.ts`）
- `SharedModuleConfigResolver`（统一配置路径，`src/utils/shared-config-paths.ts`）
- `sanitizeObject/sanitizeError`（敏感信息脱敏，`src/utils/secret-sanitization.ts`）

## 用法示例
```ts
import { createConfigParser } from 'routecodex-config-engine';

const parser = createConfigParser('~/.routecodex/config');
const { config, errors, warnings } = await parser.loadAndValidate();
```

## 构建顺序（重要）
本模块位于 `sharedmodule/` 下，修改后请先在本模块目录构建，再构建根包：
- `npm --prefix sharedmodule/config-engine run build`（如配置有 build 脚本）
- 然后在根目录执行 `npm run build`

> 参见仓库根 `AGENTS.md`：先模块、后整包。

