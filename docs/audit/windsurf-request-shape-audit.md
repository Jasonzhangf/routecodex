# Windsurf Request Shape Audit（历史审计，已收敛）

## 索引概要
- L1-L8 `status`：本文不再是真实实现事实入口。
- L10-L32 `final-truth`：请求链最终事实。
- L34-L56 `superseded`：旧审计中已废弃的结论。
- L58-L90 `retained-evidence`：仍保留的取证价值。

## Status

本文是 2026-05-22 多轮黑盒过程中的请求形状历史审计。当前唯一事实入口已经收敛到：

- `docs/providers/windsurf-chat-provider-design.md`
- `docs/design/windsurf-cascade-tool-protocol.md`

本文不再作为 provider 实现依据；若与上述两份文档冲突，以那两份为准。

## Final Truth

Windsurf provider 请求唯一主链：

```text
OpenAI/Responses input
  -> llmswitch-core Hub Pipeline
  -> windsurf-chat-provider.ts
  -> local managed Windsurf LS gRPC
  -> StartCascade
  -> SendUserCascadeMessage
  -> GetCascadeTrajectorySteps / GetCascadeTrajectory poll
```

工具请求标准形状：

```text
SendUserCascadeMessageRequest.field5 cascade_config
  CascadeConfig.field1 planner_config
    CascadePlannerConfig.field2 conversational
      CascadeConversationalPlannerConfig.field4 planner_mode = DEFAULT(1)
    CascadePlannerConfig.field13 tool_config
      CascadeToolConfig.field32 tool_allowlist
```

工具结果回灌：

```text
SendUserCascadeMessageRequest.field9 additional_steps
```

## Superseded / Deprecated

以下旧审计事实已经废弃，不得再作为实现依据：

- `GetChatCompletions` / `GetChatMessage` cloud JSON 主链。
- `metadata/chatMessagePrompts/systemPrompt/completionsRequest` 作为最终发送契约。
- `tools_preamble` / `toolPreamble` 文本工具协议作为最终工具调用方案。
- `buildToolPreambleForProto` / `normalizeMessagesForCascade` 的文本 emulation 路径作为 RouteCodex 目标实现。
- 通过 prompt 要求模型输出 `function_call` JSON。
- 通过 prompt 要求模型输出 `<tool_call>` XML。

旧链路中的 `maxTokens=32768` 等发现只保留历史取证价值；当前正确字段是 Cascade planner config：

```text
CascadePlannerConfig.field6 max_output_tokens = 32768
```

## Retained Evidence

仍然有效的请求层事实：

- WindsurfAPI 参考目录：`/Volumes/extension/code/WindsurfAPI`。
- Windsurf App / LS 证明了 Cascade protobuf schema 存在。
- local LS gRPC 是聊天主链，不是 cloud chat API。
- warmup 必须包含：
  - `InitializeCascadePanelState`
  - `AddTrackedWorkspace`
  - `UpdateWorkspaceTrust`
  - `Heartbeat`
- `SendUserCascadeMessage` 是真实用户消息入口。
- `additional_steps field9` 是工具结果回灌入口。

## Required Blackbox Anchors

- `buildSendCascadeMessageRequest(... nativeMode:true ...)` 对齐 WindsurfAPI。
- `planner_mode=DEFAULT(1)`。
- `tool_config.field32 tool_allowlist`。
- 请求 bytes 不包含文本工具协议 marker：
  - `function_call`
  - `<tool_call>`
  - `You have access to the following functions.`
- unmapped tool fail-fast：`WINDSURF_UNMAPPED_TOOL`。
