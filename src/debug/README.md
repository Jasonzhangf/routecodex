# Debug Toolkit

RouteCodex 的调试系统抽象为一个独立模块 (`src/debug/`)，将 dry-run、replay 与快照机制统一为标准 API。该模块遵循“工具层独立、流水线不受影响”的原则，可在不修改核心节点的情况下对任意节点进行捕获、干跑或回放。

## 组件概览

```
src/debug/
├── index.ts                 # 入口，提供 createDebugToolkit()
├── types.ts                 # 类型定义（会话、快照、Harness 等）
├── snapshot-store.ts        # SnapshotStore 接口 + 文件实现
├── session-manager.ts       # 调试会话生命周期管理
├── harness-registry.ts      # Harness 注册与查找
├── default-harnesses.ts     # 默认注册的 harness（当前仅 provider 预处理）
├── harnesses/
│   └── provider-harness.ts  # Provider preprocess/postprocess harness
├── dry-runner.ts            # 干跑控制器
└── replay-runner.ts         # 回放控制器
```

### 核心概念
- **DebugSession**：一次调试会话，记录 mode（capture/replay）、metadata 等。
- **NodeSnapshot**：节点级快照，包含 nodeId、方向（request/response）、payload、timestamp。
- **SnapshotStore**：抽象的快照存储接口，默认实现为 JSONL 文件，可替换为自定义存储。
- **ExecutionHarness**：节点执行器抽象，提供 `executeForward`/`executeBackward`；可针对 provider、compatibility、llmswitch 等实现。
- **DryRunRunner / ReplayRunner**：在通用 Runner 里调用 harness 并与会话/快照系统交互。

## 快速入门

```ts
import { createDebugToolkit } from '../debug/index.js';

const toolkit = createDebugToolkit({
  snapshotDirectory: './logs/debug'
});

const session = toolkit.sessions.startSession({ label: 'responses provider dry-run' });

const result = await toolkit.dryRunner.runProviderPreprocess({
  runtime: {...},       // Provider runtime profile
  request: {...},       // Canonical provider payload
  metadata: {...},      // Provider runtime metadata
  sessionId: session.id // 可选：写入快照
});

console.log(result.processed);
```

### createDebugToolkit(options)
- `snapshotDirectory`: 快照文件存储目录（默认 `logs/debug`）
- `store`: 自定义 SnapshotStore 实现
- `registry`: 自定义 HarnessRegistry
- `providerDependencies`: 可传入 pipeline 的真实依赖，以便复用 logger/error center

## Dry-Run & Replay

- `dryRunner.runProviderPreprocess(options)`：运行 provider 预处理（或 postprocess），并可将结果写入快照。
- `replayRunner.listSnapshots({ sessionId, nodeId })`：查询某会话的快照。
- `replayRunner.replayProvider({ sessionId, direction, runtimeOverride })`：基于快照回放 provider 输入。

## 与现有脚本的关系

- `scripts/tests/responses-provider-dry-run.mjs` 已迁移至该 API 实现。
- 其它 `replay-*.mjs` 脚本可逐步重构为调用统一的 toolkit，而无需直接依赖 provider/llmswitch 源码。

## 扩展指南

1. 实现一个新的 `ExecutionHarness`，例如 `llmswitch.process-node`，把 pipeline 某节点的逻辑封装到独立对象。
2. 在 `default-harnesses.ts` 或调用方自行向 `HarnessRegistry` 注册：
   ```ts
   registry.register(new LlmSwitchProcessHarness());
   ```
3. 在合适的节点调用 `toolkit.sessions.recordSnapshot(...)` 写入快照。

## 注意事项

- 调试模块不应直接耦合 HTTP handler 或 pipeline runtime，只依赖公开的桥接/Provider API。
- `dryRunner/replayRunner` 默认使用 `FileSnapshotStore`，若用于多进程/远程调试，可实现基于 Redis/S3 的 store。
- 确保快照中不包含敏感信息（密钥、用户数据）；可在 Metadata 中覆写/过滤字段。

通过该模块，我们可以在任何节点截取快照、干跑逻辑或回放历史数据，极大提升调试效率，同时保持生产路径单一、确定。欢迎在后续迭代中继续补全更多 harness（如 llmswitch 节点、compatibility 层等）。
