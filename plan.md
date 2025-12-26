# Plan: Virtual Router 上下文容量管理

## 背景
- 目前 virtual router 只在 classifier 中基于单一 `longContextThreshold` 粗略命中 longcontext 路由，无法根据不同 provider/model 的真实上下文容量挑选候选。
- `estimatedTokens` 虽由 `tiktoken` 计算，但 `selectProvider` 并未利用，导致上下文不足的 provider 也会被选中。
- 需要一个可配置、完全由虚拟路由掌控的上下文管理方案，保证“配置是唯一数据源”的约束。

## 执行步骤
1. **梳理模型上下文配置入口**
   - 解析 `virtualrouter.providers.*.models.*` 中的 `maxContextTokens`（新增字段）。
   - 若未配置，回落到 `modules.json -> contextBudget.defaultMaxContextBytes` 或硬编码默认值 `200_000 tokens`。
   - 在 bootstrap 阶段将该值注入 `ProviderProfile` / `ProviderRuntimeProfile`，并写入 `targetRuntime` 供后续使用。

2. **扩展 ProviderRegistry 元数据**
   - 为每个 providerKey/model 建立 `maxContextTokens` 索引。
   - `TargetMetadata` 携带 `maxContextTokens`，日志/诊断可直接引用。

3. **实现 ContextAdvisor 组件**
   - 输入：`estimatedTokens`、候选 provider 列表、配置阈值（默认 warnRatio=0.9）。
   - 输出：`safeProviders`、`riskyProviders`、`overflowProviders`，并返回 flag（如 `poolExhausted`）。
   - 逻辑：`usage = estimatedTokens / maxContextTokens`，>=1 判定 overflow，>=warnRatio 记为 risky，否则 safe。
   - WarnRatio、hardLimit 通过 `virtualrouter.contextRouting` 配置（可写入 plan 后在实现阶段补充 schema）。

4. **整合到 VirtualRouterEngine.selectProvider**
   - 在 load balancer 挑选前调用 ContextAdvisor。
   - 先尝试 safe，若为空尝试 risky，最后才接受 overflow（若配置允许）；全部拒绝时才降级到下一个优先级池或路由候选。
   - hit log 增加上下文使用率诊断（如 `context:0.87/200k`）。

5. **配置 & 文档更新**
   - `docs/config/virtual-router.md`（或相关文档）增加 `contextRouting`、`maxContextTokens` 字段说明。
   - 强调“默认 200k tokens，需要覆盖时在模型节点显式设置”。

6. **测试 & 回归验证**
   - 新增单元测试：构造含不同 `maxContextTokens` 的虚拟配置，验证 safe/risky/overflow 分类与 fallback 行为。
   - 使用黄金样本回放一条接近上限的请求，确认会切到大上下文模型；再用普通请求确保不会误判。
   - `npm run build:dev` & `npm run install:global` 验证通过。

## 风险 & 缓解
- **缺失模型配置**：默认统一 200k tokens，并允许 CLI/env 覆盖 warnRatio，防止误杀。
- **性能影响**：ContextAdvisor 只做常数次遍历，缓存 `maxContextTokens`，对路由耗时影响可忽略。
- **配置兼容性**：保持向后兼容；老配置不写 `maxContextTokens` 也可运行，只是全部视为 200k。
