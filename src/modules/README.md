# 模块系统 (Module System)

## 职责概述
RouteCodex Host 模块系统只负责调用共享的 `llmswitch-core` Hub Pipeline、加载配置和提供调试辅助。所有工具治理、路由和协议转换都在 `sharedmodule/llmswitch-core` 中实现，本仓库不会再维护自己的 Conversion/Pipeline。

- Host 读取用户配置 (`routecodex-config-loader.ts`)，立即调用 `bootstrapVirtualRouterConfig`。
- 从 `bootstrapVirtualRouterConfig` 得到的 `virtualRouter` 与 `targetRuntime` 被传递给 Hub Pipeline。
- Host 负责 Provider runtime 管理、HTTP 封装、快照与调试辅助。

> 修改任何 sharedmodule 代码后必须在共享模块目录执行 `npm run build`，再回到根目录构建主包，详见根目录 `AGENTS.md`。

## 核心职责（Do / Don't）
**Do**
- 聚焦配置解析、路径解析、运行时元数据注入。
- 提供调试/快照工具 (`src/debug/*`) 和 CLI 辅助能力。
- 负责 HTTP server 入口与 Provider runtime 生命周期管理。
- 通过 `src/modules/llmswitch/bridge.ts` 与 Hub Pipeline 通信。

**Don't**
- 不实现 Host 自己的工具治理或转换流水线。
- 不修补工具参数、路由决策或 provider payload。
- 不在 Host 中维护多条执行路径，所有请求必须经 Hub Pipeline。

## 目录结构
```
src/modules/
├── config/                # pipeline 配置路径解析
├── llmswitch/             # Hub Pipeline bridge/loader
├── pipeline/              # 仅保留类型/接口/桥接逻辑
└── README.md
```

重点文件：
- `llmswitch/bridge.ts`：唯一调用 Hub Pipeline 的入口。
- `llmswitch/core-loader.ts`：负责加载 `@jsonstudio/llms`（symlink 或 npm 版本）。
- `config/pipeline-config-path.ts`：解析 `LLMSWITCH_PIPELINE_CONFIG` 等路径配置。

## Hub Pipeline 接入示例
```ts
import { bootstrapVirtualRouterConfig } from '@jsonstudio/llms';
import { loadRouteCodexConfig } from '../config/routecodex-config-loader';
import { createHubPipeline } from '../modules/llmswitch/bridge';

const config = await loadRouteCodexConfig();
const { virtualRouter, targetRuntime } = bootstrapVirtualRouterConfig(config.virtualrouter);

const hubPipeline = await createHubPipeline({ virtualRouter, targetRuntime });
const response = await hubPipeline.handleChat(request);
```

## 调试与快照
- `src/debug/` 提供统一的 SnapshotStore、DryRunRunner、ReplayRunner。
- CLI 可以通过 `npm run snapshot:inspect -- --rid <RID>` 查看各阶段的快照摘要。
- Provider Harness（`src/debug/harnesses/provider-harness.ts`）允许在不调用上游的情况下检查 runtime payload。

## 相关文档
- 根目录 `AGENTS.md`：架构原则与职责边界。
- `sharedmodule/llmswitch-core/README.md`：Hub Pipeline 细节。
- `src/config/README.md`：配置加载规则。

## 贡献须知
- 遵循“单一执行路径”原则，所有新增模块必须通过 Hub Pipeline。
- 新增对 sharedmodule 的依赖时需更新 build 流程与文档。
- 引入新调试工具或 CLI 时，确保不破坏 Provider runtime 生命周期。
