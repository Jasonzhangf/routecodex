# Pipeline Error Handling Framework

## Goals
- 单一错误回调接口，所有节点（llmswitch / compatibility / provider / host 自有节点）统一上报。
- Fail Fast：任何节点错误必须立即被 Error Center 记录并中止流水线，禁止 silent fallback。
- 上报信息包含 pipelineId / nodeId / implementation / phase / requestId，方便定位。
- llmswitch-core 与 RouteCodex host 共用同一错误契约。

## Standard Types
```ts
export interface PipelineNodeError extends Error {
  nodeId: string;
  implementation: string;
  pipelineId: string;
  requestId: string;
  phase: 'request' | 'response';
  stage: string;
  metadata?: Record<string, unknown>;
  cause?: unknown;
}

export type PipelineErrorCallback = (error: PipelineNodeError) => Promise<void>;
export type PipelineWarningCallback = (warning: {
  nodeId: string;
  implementation: string;
  pipelineId: string;
  requestId: string;
  phase: 'request' | 'response';
  message: string;
  detail?: unknown;
}) => Promise<void>;
```

## Host Responsibilities
1. BasePipeline 构造全局回调（内部调用现有 ErrorHandlingCenter，将错误写日志/快照/metrics）。
2. NodeExecutor 捕获所有节点异常，并确保：
   - 若异常类型不是 `PipelineNodeError`，包装成标准错误再调用回调；
   - 调用 `errorCallback` 后 rethrow，让 HTTP 层返回 4xx/5xx。
3. Snapshot/hook 等 warning 通过 `warningCallback` 上报，仍由 Error Center 决定记录级别。
4. HTTP 响应携带节点信息：`pipelineId`、`nodeId`、`stage`、`requestId`，方便排查。

## llmswitch-core Responsibilities
1. 每个节点（inbound/input/process/output/SSE）在执行时如有异常，构造 `PipelineNodeError`（含 nodeId、implementation、pipelineId、requestId、phase、stage）。
2. 若 bridge 传入 `errorCallback`，先 `await errorCallback(err)` 再 `throw err`。没有回调时直接抛出。
3. 非致命问题（snapshot/hook/compat warning）调用 `warningCallback` 上报。
4. ContextAdapter 必须保证 node/pipeline metadata 正确填充，以便错误对象完整。
5. Blueprint/NodeRegistry 校验失败时也要抛 `PipelineNodeError`，确保 config 问题在启动阶段失败。

## Bridge 接口扩展
`BridgeProcessOptions` 新增：
```ts
type BridgeProcessOptions = {
  processMode: 'chat' | 'passthrough';
  providerProtocol?: string;
  entryEndpoint?: string;
  errorCallback?: PipelineErrorCallback;
  warningCallback?: PipelineWarningCallback;
  // ...existing fields
};
```

## Data Flow
```
Node (llmswitch/provider/compat) → throw PipelineNodeError
    ↓
errorCallback → ErrorHandlingCenter → snapshot/log/metrics
    ↓
NodeExecutor rethrow → BasePipeline catch → HTTP 4xx/5xx 包含 nodeId 等信息
```

## TODO
- [ ] Host 端定义 `PipelineErrorCallback` 实现并在 BasePipeline/NodeExecutor 中调用。
- [ ] llmswitch-core 在 ContextAdapter / 节点执行时接收回调并抛 `PipelineNodeError`。
- [ ] Provider/Compatibility 节点迁移至统一处理路径。
- [ ] 集成测试：制造 llmswitch/compat/provider 错误，验证错误链路完整。
