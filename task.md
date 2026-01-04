# Task: Virtual Router / HTTP Executor 模块化拆分

## 目标
- 将 `sharedmodule/llmswitch-core/src/router/virtual-router/engine.ts` 和 `src/server/runtime/http-server/request-executor.ts` 拆分为职责清晰的子模块。
- 保持对外行为与日志完全一致，为后续功能迭代和测试铺路。

## 子任务
1. **VirtualRouterEngine 日志与辅助函数拆分**
   - [x] 新增 `engine-logging.ts`，迁移命中日志格式化、sticky scope、provider 标签、context ratio 等纯日志函数。
   - [x] 让 `VirtualRouterEngine.route` 调用 `engine-logging` 模块中的 `buildHitReason` / `formatVirtualRouterHit`，移除类内同名私有方法。
2. **VirtualRouterEngine 选择/健康逻辑拆分**
   - [x] 拆出 `engine-health.ts`（handleProviderFailure/429 冷却映射），`engine.ts` 内仅做薄封装调用。
   - [x] 拆出 `engine-selection.ts`（selectProvider/trySelectFromTier/selectFromStickyPool 等），将路由选择核心逻辑移出 `engine.ts`。
   - [x] 保持现有类型与导出不变，仅通过依赖注入向子模块传递 registry/health/contextAdvisor（已整理 `engine-selection` 内对 providerRegistry 的依赖）。
3. **HubRequestExecutor 拆分**
   - [x] 新建 `http-server/executor-metadata.ts`，迁移 request metadata 构造、clientHeaders 归一化与 per-attempt metadata 装饰逻辑。
   - [x] 新建 `http-server/executor-pipeline.ts`、`executor-provider.ts`，抽出 Hub pipeline 执行与 provider 错误/重试判定逻辑。
   - [ ] 新建 `http-server/executor-response.ts` 等模块，并继续收缩 `HubRequestExecutor` 只做编排。
4. **回归与文档**
   - [x] 每个拆分阶段跑 `npm run build:dev` + 相关 Jest 用例（虚拟路由、request-executor.single-attempt），并保持 CLI 全局安装通过。
   - [ ] 在 `docs/` 或本文件追加简要模块说明，记录各子模块职责与入口函数。
