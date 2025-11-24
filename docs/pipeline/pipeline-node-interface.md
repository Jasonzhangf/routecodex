# RouteCodex V2 Pipeline Node Contract

本文档定义 RouteCodex V2 Host 侧统一的流水线节点接口（Pipeline Node Contract），用于指导 llmswitch-core 拆分后的 inbound/process/outbound 节点、workflow、compatibility、provider 等模块全部纳入同一数据流。目标是消除节点耦合和运行时推断，实现“配置决定一切”的流水线装配。

## 1. PipelineContext 标准结构

所有节点之间仅通过 `PipelineContext` 传递数据。context 由 orchestration 层在请求/响应开始时创建，并在节点链中依次传递/修改。

```ts
export interface PipelineContext {
  request?: CanonicalRequest;
  response?: CanonicalResponse;
  metadata: {
    requestId: string;
    entryEndpoint: string;
    providerProtocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini-chat' | string;
    processMode: 'chat' | 'passthrough';
    streaming: 'always' | 'never' | 'auto';
    routeName: string;
    pipelineId: string;
    providerId?: string;
    modelId?: string;
    providerType?: string;
  };
  debug: {
    traceEnabled: boolean;
    stages: Record<string, unknown>;
  };
  snapshots: SnapshotHandles | null;
  extra: Record<string, unknown>;
}
```

### 1.1 CanonicalRequest / CanonicalResponse

- Request 对象由 llmswitch inbound 节点生产，是 llmswitch-core 目前的 `StandardizedChatRequest`（含 messages、tools、system、metadata 等）。
- Response 对象由 llmswitch response inbound 节点生产，对应 `StandardizedResponse`.
- Provider 层只能读取 `ctx.request` 转换成 provider payload，禁止直接读取 HTTP 原始 body。

### 1.2 Metadata

- `providerProtocol`：配置中声明的协议（openai-chat/openai-responses/anthropic-messages 等），由 orchestration 层写入；节点禁止自行推断。
- `processMode`：`chat` 或 `passthrough`，来自 config-core pipeline 配置。
- `streaming`：`always` / `never` / `auto`，决定 llmswitch outbound / SSE 输出策略。
- `routeName`、`pipelineId`：虚拟路由＋装配器生成，用于日志和快照。

### 1.3 Debug / Snapshots

- `debug.stages`：节点根据 `ctx.debug.traceEnabled` 决定是否写入。每个节点只写入自己的 key，禁止覆盖其它节点数据。
- `snapshots`：统一快照管道的句柄，供 llmswitch/compatibility/provider 写入 provider-request / response 等文件。

## 2. PipelineNode 接口

```ts
export interface PipelineNode {
  readonly id: string;   // pipeline-config 中的节点 id
  readonly kind: 'sse-input' | 'input' | 'process' | 'workflow' | 'compatibility' | 'provider' | 'output' | 'sse-output';
  execute(ctx: PipelineContext): Promise<PipelineContext>;
}
```

- 每个节点实现 `execute`，读取/修改 `ctx` 后返回同一个实例。
- 节点不得依赖链外全局状态（除配置注入外），确保可组合性。
- 请求和响应链路复用同一接口：响应节点通过 `ctx.response` 传递数据。

## 3. Orchestrator（统一编排器）职责

1. **加载配置**：启动时读取 config-core 生成的 `config/llmswitch/pipeline-config.json`，校验 schema（pipelines、nodes、processMode、providerProtocols 等）。
2. **生成 blueprint**：对每条 pipeline 预编译节点链（`PipelineNode[]`），并记录请求/响应镜像链。
3. **构造 context**：收到虚拟路由输出后，创建 `PipelineContext`，填充 metadata（endpoint、providerProtocol、processMode、routeName、pipelineId 等）以及 debug/snapshot 句柄。
4. **执行节点链**：顺序运行节点 `execute()`，直至链尾；响应阶段按镜像节点链执行。
5. **Fail Fast**：缺失配置 / 节点实现未注册时立即抛错，禁止 fallback。

## 4. 节点分工映射

| 流程阶段 | 节点示例 | 说明 |
| --- | --- | --- |
| 请求 Inbound | `llmswitch-sse-input`, `llmswitch-openai-input` | 解析 HTTP/SSE → CanonicalRequest |
| 请求 Process | `llmswitch-chat-process`, `llmswitch-passthrough-process` | 工具治理、MCP、路由决策（配置驱动） |
| 请求 Outbound | `llmswitch-openai-output`, `llmswitch-responses-output` | 转 provider payload + streaming 元数据 |
| Workflow | `workflow-streaming-node` | 可选，负责流控/阶段 hook |
| Compatibility | `compatibility-openai`, `compatibility-glm` | 最小字段修剪，禁止工具治理 |
| Provider | `provider-openai-http`, `provider-anthropic-http` | HTTP 调用，写入快照 |
| 响应 Inbound | `provider-sse-input`, `llmswitch-response-inbound` | Provider 响应 → CanonicalResponse |
| 响应 Process | `llmswitch-response-process` | 工具响应治理、usage 聚合 |
| 响应 Outbound | `llmswitch-response-output`, `sse-output` | 输出到 HTTP SSE/JSON |

## 5. 改造优先级

1. **llmswitch-core 节点化**：首先将 inbound/process/outbound（请求/响应）实现 `PipelineNode` 接口，移除 adapter-side 推断逻辑。
2. **Workflow & Compatibility**：改写为节点实现，直接读取 `ctx` 操作；兼容层固定在 process → provider 之间。
3. **Provider Node**：BasePipeline 调用改成执行 provider node，日志与 snapshots 从 context 读取。
4. **Orchestrator 接入**：PipelineManager/VirtualRouter 调整为“路由池选择 → 根据 pipelineId 获取 blueprint → 执行节点链”的模式。
5. **配置生成**：config-core 确保 pipeline-config 中包含节点列表、processMode、providerProtocols、streaming。系统启动时强制生成并加载。

## 6. 约束与检查

- 所有节点不得访问 `request` / `response` 之外的 host 级对象；若需额外信息通过 `ctx.extra` 显式传递。
- `processMode` 只能来自配置；llmswitch 节点禁止自判。
- `streaming` 行为由 pipeline 配置决定，SSE 旁路节点必须在 nodes 列表中显式声明。
- 响应链必须与请求链镜像（Inbound ↔ Outbound），确保双向一致。

## 7. 下一步

1. 依照本文档定义，在 sharedmodule/llmswitch-core 中创建 `PipelineNode` 适配层。
2. 更新 orchestrator / pipeline manager 设计文档，明确 blueprint 装配流程。
3. 分阶段替换 Workflow、Compatibility、Provider 模块实现。
4. 更新 README/AGENTS.md，告知不要直接改构建产物，统一通过源代码实现。

此文档为后续模块化改造的基础规范，如需调整接口字段，应先更新本文档并同步 config-core / llmswitch-core 的实现。
