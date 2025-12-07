# Debug Toolkit

调试模块 (`src/debug/`) 只提供快照、dry-run、replay 等辅助工具，不参与主线工具治理。

## 组件
```
src/debug/
├── index.ts                 # createDebugToolkit() 入口
├── types.ts                 # 快照/会话类型
├── snapshot-store.ts        # JSONL 快照存储
├── session-manager.ts       # 调试会话生命周期
├── harness-registry.ts      # Harness 注册
├── harnesses/
│   └── provider-harness.ts  # provider 层干跑
├── dry-runner.ts            # dry-run 控制器
└── replay-runner.ts         # 快照回放
```

## 核心概念
- **DebugSession**：一次调试会话。
- **NodeSnapshot**：节点级快照（request/response payload）。
- **ExecutionHarness**：面向 provider/compat 等节点的运行器。

## 使用
```ts
const toolkit = createDebugToolkit({ snapshotDirectory: './logs/debug' });
const session = toolkit.sessions.startSession({ label: 'glm provider dry-run' });
await toolkit.dryRunner.runProviderPreprocess({
  runtime,
  request,
  metadata,
  sessionId: session.id,
});
```

## 快照排查
- `npm run snapshot:inspect -- --rid <RID>` 查看 RID 在各阶段的顶层键与 messages 摘要。
- 快照目录：`~/.routecodex/codex-samples/{openai-chat|openai-responses|anthropic-messages}`。

## 注意
- 调试工具不得修改 Hub Pipeline 行为，只能读取或模拟节点输入/输出。
- 记录的快照包含敏感信息，使用时注意安全。
