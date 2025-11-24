## RouteCodex V2 流水线统一编排改造方案

### 目标综述

- **单一编排器**：由 host 侧 orchestrator 读取 config-core 生成的 `pipeline-config`，在请求入口一次性装配完整节点链。
- **llmswitch 被动化**：llmswitch-core 拆成的 inbound / process / outbound 节点仅实现标准 `PipelineNode` 接口，不再自行推断 provider 或 processMode。
- **配置优先**：所有路由、兼容策略、流控、passthrough 行为都由配置驱动；缺失/冲突配置直接 Fail Fast。
- **双向对称**：请求与响应链完全镜像，确保 SSE / JSON 行为和兼容层顺序一致。

### 阶段划分

1. **Config-Core 集成（已完成部分）**
   - 自动生成 `conversionV3.pipelineConfig`（请求+响应，chat/passthrough 双线路）。
   - npm `rcc-config-core@0.1.13` 发布后由 host 入口调用生成 `config/pipeline-config.generated.json`。
   - 验证：`npm pack`、`node scripts/config-core-run.ts`，确认新文件包含 pipelines/nodes。

2. **Host Orchestrator 拆解**
   - **PipelineConfig 加载层**：`src/modules/config/pipeline-config-generator.ts` 使用新的 config-core，生成仅含 `pipelineConfig` 的文件。
   - **节点注册表**：`src/modules/pipeline/modules/llmswitch-v2-adapters.ts` → 新建 `NodeRegistry`，把 `implementation` 映射为对应的 llmswitch/compatibility/provider 节点类。
   - **Orchestrator**：`src/modules/pipeline/core` 新增 `pipeline-orchestrator.ts`：
     1. 入口根据虚拟路由返回的 `pipelineId` 查缓存 blueprint；
     2. 构造 `PipelineContext`（附带 requestId / route / metadata）；
     3. 顺序执行节点数组；请求与响应分别有一条 blueprint。
   - **虚拟路由**：保持现有 route pool 逻辑，只需将 pipelineId 透传 orchestrator；不再执行任何工具/流程推断。

3. **llmswitch-core Phase 1**
   - 引入 `PipelineContext` & `PipelineNode`（参见 `docs/pipeline/pipeline-node-interface.md`）。
   - 在 sharedmodule/llmswitch-core:
     - 新建 `context-adapter.ts`、`pipeline-node.ts`。
     - 将现有 V3 node context 转换为标准 context。
   - 提供适配器以兼容旧调用，方便分阶段切换。

4. **llmswitch-core Phase 2**
   - Conversion 节点：`sse-input`、`openai-input`、`responses-input`、`anthropic-input`、`chat-process`、`passthrough-process`、`openai-output`、`responses-output`、`anthropic-output`。
   - Endpoints 节点：chat/responses/messages handler 调整为 orchestrator 中的首节点。
   - 工具治理拆分：tool canonicalizer / harvester / governor 集成为 `process` 子节点，确保只有 process 阶段能操作工具。

5. **Phase 3：Workflow / Compatibility / Provider 节点化**
   - Workflow 节点：streaming-control、hooks、monitor（若仍需要）采用标准接口。
   - Compatibility 节点：开箱仅保留 `compatibility-process`，路由由 `options.compatibility` 控制。
   - Provider 节点：OpenAI/Responses/Anthropic HTTP 调用实现标准 `execute`，读取 `ctx.request`，写入 `ctx.response`，并统一快照逻辑。

6. **Phase 4：整合与回归**
   - 替换 BasePipeline / PipelineManager 内对 `llmswitch-responses-passthrough` 等旧模块的注册。
   - 删去 BasePipeline 中 `providerModuleType.includes('responses')` 等兜底逻辑。
   - Host 启动流程：`generatePipelineConfiguration()` → Orchestrator warmup → RouteCodex server health check。
   - 验证脚本：`npm run build:verify`、`scripts/install-verify.mjs` 使用新的样本路径；更新 `~/.routecodex/codex-samples` 黄金样本。

### 关键接口约束

- `PipelineContext.metadata` 必须包含：
  - `requestId`, `entryEndpoint`, `providerProtocol`, `processMode`, `streaming`, `routeName`, `pipelineId`, `providerId`, `modelId`.
- `PipelineNode.execute(ctx)` 只能读取/修改 `ctx`，禁止访问全局状态。
- `compatibility-process` 节点仅透过配置字段触发；llmswitch-core 其它节点不得硬编码 provider 差异。

### 测试与验收

1. **单元测试**
   - config-core pipeline builder：为不同 provider 配置生成快照。
   - llmswitch-core 节点：mock context，验证工具治理/编码转换逻辑。
2. **集成测试**
   - RouteCodex E2E（chat/responses/anthropic, 流式&非流式）→ 确认 snapshots 中 pipelineId/节点链与配置一致。
   - Passthrough 模式：仅在请求&响应 pipeline-config 中标注时才可命中。
3. **性能基准**
   - 对比改造前后 `/v1/responses` 延迟 < +10%；SSE throughput 不下降。

此计划执行完毕后，RouteCodex Host 的流水线走向将完全由 config-core 输出的 blueprint 决定，llmswitch-core 只负责工具治理与协议转换，兼容层和 provider 都在统一的 PipelineNode 体系内运行。
