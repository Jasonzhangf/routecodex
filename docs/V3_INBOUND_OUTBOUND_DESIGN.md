## Conversion V3 三阶段拆分设计

> 目标：在不改变协议治理代码的前提下，将 llmswitch-core 的转换链路拆成 `Inbound → Process → Outbound` 三段节点，方便 RouteCodex 在 provider 选定后再继续执行工具治理/输出。

### 1. 节点分层

| Stage | 说明 | 典型节点 |
| --- | --- | --- |
| **Inbound Conversion** | 解析入口协议（SSE→JSON、input codec），输出 canonical `StandardizedRequest` 与 `metadata`；不做治理。 | `sse-input`, `chat-input`, `responses-input`, `anthropic-input` |
| **Process Stage (host)** | RouteCodex workflow 对 canonical JSON 做路由、兼容 patch；写入 `providerId/providerProtocol/processMode/stream`。| 现有虚拟路由器 + `src/modules/pipeline/modules/provider/v2/compatibility/*` |
| **Outbound Conversion** | 在 host 兼容层之后、Provider HTTP 之前，根据 metadata 中的 provider 信息运行 `chat-process`/`response-process`，输出 provider payload/SSE。| `chat-process-node`, `response-process-node`, `openai-output`, `responses-output`, `sse-output` |

### 2. Pipeline 配置

1. `pipeline-config.json` / `DEFAULT_PIPELINE_DOCUMENT` 中增加 `stage` 字段（`inbound` / `outbound`）。  
2. `PipelineFactory` 依据 stage 构建不同链路：  
   - inbound 仅允许 `sse-input` + `input` 节点；  
   - outbound 允许 `process`/`output`/`sse-output` 节点，并按 `providerProtocols + processMode` 精确匹配。
3. NodeFactory/NodeRegistry 复用现有实现，不新增代码路径；只是将 pipeline 拆成两份配置。

### 3. Bridge API

新增三个入口（保留旧 API 的兼容封装）：

```ts
processInbound(request, { entryEndpoint }): Promise<{ standardizedRequest; metadata }>
processOutboundRequest(standardized, { providerMetadata }): Promise<ConversionResponse>
processOutboundResponse(providerPayload, { providerMetadata }): Promise<ConversionResponse>
```

工作流调用顺序：
1. HTTP handler → `processInbound`  
2. Workflow 路由 → metadata 注入（此处仍会跑 Hook）  
3. Host 兼容层（请求侧：工具治理之后；响应侧：治理之前）  
4. `processOutboundRequest` → Provider HTTP  
5. Provider 响应 → host 兼容 → `processOutboundResponse`

### 4. Metadata 约定

Inbound 阶段生成：
```json
{
  "requestId": "...",
  "entryEndpoint": "/v1/responses",
  "direction": "request",
  "originalRequest": { ... },
  "stream": null
}
```

Process 阶段补充：
```json
{
  "providerId": "glm",
  "providerType": "openai",
  "providerProtocol": "openai-responses",
  "processMode": "chat",
  "stream": true/false,
  "routing": { "pipelineId": "...", "keyId": "..." }
}
```

Outbound/SSE 节点完全依赖这些字段，不再自行推断 provider 或 streaming。

### 5. 兼容层与工具治理

- host 兼容层仍在 Process 阶段运行（canonical JSON 上），不嵌入 llmswitch-core。  
- 如确有必要，可在 outbound pipeline 中保留可选的 `compatibility-process-node`，通过 `providerMatch/providerTypeMatch` 精准触发，但默认禁用。  
- `chat-process-node`/`response-process-node` 负责所有工具治理，逻辑不变。

### 6. 流程与错误处理

1. Inbound 失败 → HTTP handler 直接返回 4xx/5xx。  
2. Process 阶段的路由或兼容异常 → Workflow 捕获，沿用现有错误处理路径。  
3. Outbound/Provider 失败 → pipeline trace 中带 `providerId/pipelineId`，便于定位。  
4. SSE 输出：`SSEOutputNode` 根据 metadata 中的 `stream`、`providerProtocol` 决定输出 JSON/SSE；非流式 Responses 请求也携带完整 `required_action` 字段，安装验证器可以直接解析。

### 7. 实施步骤（执行顺序）

1. 调整 `PipelineConfigManager` 支持按 `stage` 装载 pipeline（Inbound 只包含 input 节点，Outbound 只包含 process/output 节点）。  
2. 更新 `bridge.ts`：实现 `processInbound/processOutbound*`，并让旧 API 调用新函数以保持兼容。  
3. Workflow 内串联 `processInbound → route (workflow) → host compatibility → processOutbound → provider HTTP`，并保留 hooks/snapshot 能力。  
4. 修改 `PipelineAggregate` / hook 栈，在 inbound 阶段生成 `requestId` 并贯穿所有阶段。  
5. 同步文档（ARCHITECTURE.md / llmswitch-core docs）说明新架构及兼容层位置。

这样即可保留 llmswitch-core 的协议转换能力，同时让 RouteCodex 在 provider 选定后再继续执行工具治理，避免“未选 provider 就运行完整 pipeline”的问题。工具代码与 SSE 模块无需变动，只是重新组合节点。
