# Windsurf Cascade Single Path Rebuild Plan（历史计划，已收敛）

## 索引概要
- L1-L8 `status`：本文只保留历史计划名，不再承载实现事实。
- L10-L17 `current-truth`：当前唯一事实入口与唯一主链。
- L19-L54 `current-work-order`：后续执行顺序。
- L56-L68 `cleanup-rule`：旧事实清理规则。
- L70-L82 `done-definition`：当前验收定义。

## Status

本文原本用于规划 Windsurf provider 从旧链路收敛到 Cascade 单一路径。2026-05-22 后，事实已经统一到：

- `docs/providers/windsurf-chat-provider-design.md`
- `docs/design/windsurf-cascade-tool-protocol.md`

本文不再作为设计或实现依据；如果与上述两份文档冲突，必须以它们为准，并删除本文中的旧叙事。

## Current Truth

Windsurf provider 唯一聊天主链：

```text
HTTP server
  -> llmswitch-core Hub Pipeline
  -> Provider V2
  -> windsurf-chat-provider.ts
  -> local managed Windsurf LS gRPC
  -> Cascade
```

Cascade 请求时序：

```text
warmup:
  InitializeCascadePanelState
  AddTrackedWorkspace
  UpdateWorkspaceTrust
  Heartbeat

request:
  StartCascade
  SendUserCascadeMessage
  GetCascadeTrajectorySteps / GetCascadeTrajectory poll
```

工具调用唯一目标是 Cascade structured protocol：

```text
planner_mode=DEFAULT(1)
+ CascadeToolConfig.tool_allowlist(field32)
+ trajectory fields 45/47/49/50
+ tool result additional_steps(field9)
```

## Current Work Order

后续所有 Windsurf provider 改造必须按以下顺序执行：

1. 先更新 `docs/providers/windsurf-chat-provider-design.md` 与 `docs/design/windsurf-cascade-tool-protocol.md`。
2. 再补黑盒锚点测试，并确认测试先红。
3. 再改 `src/providers/core/runtime/windsurf-chat-provider.ts`。
4. 定向运行 `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`。
5. 运行 TypeScript 编译。
6. `npm run build:min`。
7. `npm run install:global`。
8. `routecodex restart --port 5520`。
9. 自己执行 installed `/v1/responses` smoke，再让 Jason 测。

## Cleanup Rule

以下旧事实不得在文档、测试、实现中继续作为有效路径保留：

- `GetChatCompletions` / `GetChatMessage` 作为聊天主链。
- cloud JSON chat baseurl 作为聊天真源。
- `tools_preamble` / `toolPreamble` 文本工具协议。
- prompt 注入 `function_call` JSON。
- prompt 注入 `<tool_call>` / `<tool_result>` XML。
- 从 assistant 普通文本 harvest / salvage JSON/XML tool call。
- unmapped arbitrary OpenAI function 的文本模拟或降级。

如果历史说明中必须提到这些词，只能放在 `Deprecated / 禁止路径` 小节，并明确“不得作为实现依据”。

## Done Definition

1. 文档事实入口唯一：provider design + cascade tool protocol。
2. 历史审计/计划文档只保留取证或索引价值，不再承载实现事实。
3. provider 只剩 local managed LS gRPC + Cascade 单一路径。
4. 工具请求、响应、submit/history 均由 structured protocol 黑盒覆盖。
5. 旧文本工具协议残留被物理删除，而不是 skip、注释或闲置。
6. 修改后必须由 agent 自己完成测试、构建、安装、重启、smoke。
