# Windsurf Response Audit（历史审计，已收敛）

## 索引概要
- L1-L8 `status`：本文不再是真实实现事实入口。
- L10-L33 `final-truth`：响应链最终事实。
- L35-L58 `superseded`：旧响应链废弃事实。
- L60-L93 `retained-evidence`：仍有效的响应解析事实。

## Status

本文是 2026-05-22 多轮黑盒过程中的响应链历史审计。当前唯一事实入口已经收敛到：

- `docs/providers/windsurf-chat-provider-design.md`
- `docs/design/windsurf-cascade-tool-protocol.md`

本文不再作为 provider 实现依据；若与上述两份文档冲突，以那两份为准。

## Final Truth

Windsurf response 主链：

```text
GetCascadeTrajectorySteps / GetCascadeTrajectory poll
  -> parse trajectory protobuf
  -> windsurf-chat-provider.ts
  -> OpenAI chat/responses compatible output
  -> Hub Pipeline outbound
```

工具调用只来自 structured trajectory fields：

```text
CortexTrajectoryStep.field45 custom_tool
CortexTrajectoryStep.field47 mcp_tool
CortexTrajectoryStep.field49 tool_call_proposal
CortexTrajectoryStep.field50 tool_call_choice
```

`ChatToolCall` 结构：

```text
field 1 id
field 2 name
field 3 arguments_json
```

Provider 投影：

```json
{
  "id": "<id>",
  "type": "function",
  "function": {
    "name": "<name>",
    "arguments": "<arguments_json>"
  }
}
```

## Superseded / Deprecated

以下旧响应事实已经废弃，不得再作为实现依据：

- `fetchWithTimeout -> parseGetChatMessageResponse` 作为聊天响应主链。
- Connect/JSON delta frame 作为当前 Cascade 工具响应主真源。
- 从 assistant 普通文本中解析 `function_call` JSON。
- 从 assistant 普通文本中解析 `<tool_call>` XML。
- 通过 text salvage 生成 OpenAI `tool_calls`。

## Retained Evidence

仍然有效的响应层事实：

- `parseTrajectorySteps` 必须对齐 WindsurfAPI。
- fields 45/47/49/50 是工具调用相关 structured fields。
- planner text / thinking 来自 planner response field 20。
- usage 可从 step metadata / generator metadata 聚合。
- partial ACTIVE text 不应提前当最终结果。
- 首个 IDLE race 不应提前结束。
- policy blocked / upstream transient 必须分类明确。

## Required Blackbox Anchors

- RouteCodex `parseTrajectorySteps` 对齐 WindsurfAPI `parseTrajectorySteps`。
- trajectory proposal / choice / mcp / custom tool 都可投影为 OpenAI tool call。
- 若 trajectory 已含 structured tool call，不得走文本 harvest。
- submit 后续轮必须通过 `additional_steps field9` 表达工具结果。
