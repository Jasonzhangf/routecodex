# routecodex-config-compat

RouteCodex 配置兼容层（共享模块）。为历史/外部配置提供规范化、导出与兼容支持，便于与流水线组装器对接。

## 功能概览
- 兼容性处理引擎：`CompatibilityEngine`
- 配置导出器：`buildPipelineAssemblerConfig()`
- 预置选项：`DEFAULT_COMPATIBILITY_OPTIONS`、`LEGACY_COMPATIBILITY_OPTIONS`、`STRICT_COMPATIBILITY_OPTIONS`
- 常用处理：环境变量展开、有序稳定输出（stable sort）等

## 主要导出
- `createCompatibilityEngine(options?)`
- `processConfigWithDefaults(configString)`、`processConfigFile(configName?)`
- `buildPipelineAssemblerConfig(compatConfig)`（导出给流水线装配器）

## 用法示例
```ts
import { createCompatibilityEngine, buildPipelineAssemblerConfig } from 'routecodex-config-compat';

const compat = createCompatibilityEngine();
const result = await compat.processConfigFile();
const assembler = buildPipelineAssemblerConfig(result.config);
```

## 构建顺序（重要）
本模块位于 `sharedmodule/` 下，修改后请先在本模块目录构建，再构建根包：
- `npm --prefix sharedmodule/config-compat run build`（如配置有 build 脚本）
- 然后在根目录执行 `npm run build`

> 参见仓库根 `AGENTS.md`：先模块、后整包。

