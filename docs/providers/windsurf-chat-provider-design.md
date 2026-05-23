# Windsurf Chat Provider 设计（唯一事实）

## 索引概要
- L1-L9 `status`：本文是 Windsurf provider 当前唯一事实入口。
- L11-L23 `truth`：唯一主链与参考真源。
- L25-L62 `protocol`：Cascade 工具协议事实。
- L64-L102 `boundaries`：禁止路径与失败边界。
- L104-L119 `implementation-contract`：RouteCodex provider 实现契约。
- L121-L136 `multi-account-quota`：多账号、多 runtime、probe、quota 回收事实。
- L138-L159 `verification`：黑盒与实机验证顺序。
- L161-L182 `fact-hygiene`：事实清理与旧路径处置规则。

## Status

本文是 RouteCodex Windsurf provider 当前唯一设计事实入口。

被本文覆盖的旧材料：

- `docs/audit/windsurf-request-shape-audit.md`：历史审计，只保留取证价值。
- `docs/audit/windsurf-response-audit.md`：历史审计，只保留取证价值。
- `docs/goals/windsurf-cascade-single-path-rebuild-plan.md`：历史计划，执行事实以本文为准。

工具协议细节唯一展开文档：

- `docs/design/windsurf-cascade-tool-protocol.md`

## Truth

唯一聊天主链：

```text
HTTP server
  -> llmswitch-core Hub Pipeline
  -> Provider V2
  -> windsurf-chat-provider.ts
  -> local managed Windsurf LS gRPC
  -> Cascade
```

唯一 Cascade 时序：

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

唯一参考真源：

- `/Volumes/extension/code/WindsurfAPI`
- `/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js` protobuf schema evidence
- LS binary strings for schema/getter evidence

运行数据、日志、samples 真源路径：

- `~/.rcc`
- 禁止写成 `~/.routecodex`

## Protocol

标准工具调用不是文本协议，而是 Cascade structured protocol。

请求侧：

```text
SendUserCascadeMessageRequest.field5 cascade_config
  CascadeConfig.field1 planner_config
    CascadePlannerConfig.field2 conversational
      CascadeConversationalPlannerConfig.field4 planner_mode = DEFAULT(1)
    CascadePlannerConfig.field13 tool_config
      CascadeToolConfig.field32 repeated string tool_allowlist
```

响应侧：

```text
GetCascadeTrajectorySteps response
  CortexTrajectoryStep.field45 custom_tool
  CortexTrajectoryStep.field47 mcp_tool
  CortexTrajectoryStep.field49 tool_call_proposal
  CortexTrajectoryStep.field50 tool_call_choice
```

工具结果回灌：

```text
SendUserCascadeMessageRequest.field9 additional_steps
  repeated DONE CortexTrajectoryStep with native observation/result body
```

`ChatToolCall` 结构：

```text
field 1 id
field 2 name
field 3 arguments_json
```

## Boundaries

禁止路径：

- `GetChatCompletions` / `GetChatMessage` 作为聊天主链。
- cloud JSON chat baseurl 作为聊天真源。
- prompt 注入 `{"function_call": ...}`。
- prompt 注入 `<tool_call>...</tool_call>`。
- 从 assistant 普通文本 harvest / salvage JSON/XML tool call。
- 对 unmapped arbitrary OpenAI function 做 fallback。

当前支持边界：

- 已确认可走标准 native path 的工具必须映射到 Cascade native kind。
- `exec_command` / `shell_command` / `run_command` / `bash` 与 Cascade `run_command` 仅在**单次 blocking shell 执行**子集上语义等同：`cmd|command|command_line -> command_line`，`workdir|cwd -> cwd`，`blocking=true`。不得把 `write_stdin`、PTY、session 续写、yield 中间返回、sandbox/approval 语义冒充为已等同。
- App schema 中存在 `CustomToolSpec` / `McpServerState` / `ChatToolDefinition`，但 `SendUserCascadeMessageRequest` 已确认只有 fields 1-9：`cascade_id/items/metadata/experiment_config/cascade_config/images/recipe_ids/blocking/additional_steps`，没有 per-request arbitrary tool definitions 输入槽位。
- WindsurfAPI 对 unmapped tools 走旧 `toolPreamble` emulation，不是 structured custom-tool request；RouteCodex 不得静默恢复该路径。
- custom/MCP/unmapped tool 不进入 Cascade native structured protocol；当前按 hybrid 设计进入显式 RCC text-tool protocol（`windsurf_text_tool_protocol="rcc"`），不是 fallback，也不做能力路由 gating。

## Implementation Contract

唯一实现文件：

- `src/providers/core/runtime/windsurf-chat-provider.ts`

Provider 必须负责：

1. OpenAI chat / responses 输入到 Cascade 语义转换。
2. 本地 managed LS gRPC warmup/start/send/poll。
3. 工具列表映射为 `windsurf_native_mode` + `windsurf_native_allowlist`。
4. `SendUserCascadeMessage` 中编码 `planner_mode=DEFAULT(1)` + `tool_config.field32`。
5. 从 trajectory structured fields 投影 OpenAI `tool_calls`。
6. 从 prior assistant tool_calls + tool output 构造 `additional_steps field9`。
7. 明确错误分类并 fail-fast。

Provider 不得负责：

- 重建 Hub Pipeline 工具治理。
- 保留第二条 Windsurf provider 实现。
- 保留旧 cloud JSON chat 主链。


## Hybrid Tool Protocol Implementation Plan

Detailed implementation and blackbox test plan:

- `docs/goals/windsurf-tool-hybrid-protocol-plan.md`

Provider behavior target:

- native-equivalent tools: transparent Cascade structured translation;
- unsupported tools: explicit RCC text-tool contract only for unsupported subset;
- Windsurf text-tool fence names are RCC-only (`<|RCC|tool_calls>` / `<|RCC|tool_result>`); do not import other provider protocol names into Windsurf facts.
- harvest: native trajectory and RCC text are parsed by separate paths with conflict fail-fast.


## Multi-account / quota / stopMessage

当前多账号事实：

- 一个 Windsurf 账号 alias 必须对应一个 runtime：`windsurf.ws-pro-N`。
- 一个 model target 必须写成：`windsurf.ws-pro-N.<model>`。
- runtime auth 如果没有显式 `accountAlias`，必须从 runtime key 的第二段派生，例如 `windsurf.ws-pro-4` -> `ws-pro-4`，避免所有账号共享 `windsurf-default` token/session。
- 服务器启动时，每个 Windsurf runtime 默认自动 `checkHealth()` probe 一次（auth + `GetCascadeModelConfigs`）；probe 抛错或返回 `false` 都是启动失败，该 runtime 不注册 handle、不入池，不允许伪装可用。
- 多账号同时工作要求 route pool 使用 `mode = "round-robin"` 或明确 weighted；`mode = "priority"` 只表示首个可用 target 优先，会锁定单账号，不能作为 5520 多账号池配置。
- 单 runtime 仍保持 `maxInFlight = 1`，通过多个 alias runtime 横向并行；不要把单账号并发调大来模拟多账号。
- auth entries 必须 alias 去重；重复 `ws-pro-N` 会造成认证/session/quota 状态混淆。
- `WINDSURF_WEEKLY_QUOTA_EXHAUSTED` 是 account alias family 级别，不是单 model：命中一个 target 后，同 alias 下所有 `windsurf.ws-pro-N.*` 与 root alias 都从池里回收。
- weekly quota 默认冷却到本地 00:00 自动恢复；上游显式 `cooldownOverrideMs` 仍可覆盖；本地 00:00 后 quota maintenance/reload 清理 expired weekly blacklist，下一次启动 probe 再确认账号可用后入池。
- 端口级 `[[httpserver.ports]].stopMessage.enabled=false` 是 5520 smoke 的 stopMessage 关闭真源；关闭后不得触发 tmux/client followup。

## Verification

执行顺序固定：

1. 更新本文和 `docs/design/windsurf-cascade-tool-protocol.md`。
2. 补黑盒锚点测试，必须先红。
3. 对照黑盒修改 provider。
4. 定向 Jest 转绿。
5. TypeScript 编译通过。
6. `build:min`。
7. `install:global`。
8. `routecodex restart --port 5520`。
9. 自己执行 installed `/v1/responses` smoke，再让 Jason 测。

必要黑盒：

- auth 黑盒：CheckUserLoginMethod / password login / WindsurfPostAuth / GetCascadeModelConfigs。
- startup 黑盒：warmup 四步 + StartCascade。
- request 黑盒：SendUserCascadeMessage native tool mode shape。
- response 黑盒：trajectory fields 45/47/49/50。
- submit/history 黑盒：additional_steps field9。
- error 黑盒：panel missing / trajectory not found / untrusted workspace / policy blocked / transient。

## Fact Hygiene

Windsurf 相关文档只允许两类事实：

1. **当前事实**：只能写入本文和 `docs/design/windsurf-cascade-tool-protocol.md`。
2. **历史取证**：只能写入 audit/goal 文档，并必须标注“历史/废弃/不得作为实现依据”。

清理规则：

- 发现旧主链或文本工具协议被写成当前事实时，必须改为废弃事实或删除。
- 发现 `~/.routecodex`、cloud JSON chat baseurl、`GetChatCompletions` 主链等错误路径时，必须改成当前真源：`~/.rcc` 与 local managed LS gRPC + Cascade。
- skipped 测试、未调用代码、旧 helper 只要承载废弃语义，必须后续物理删除，不能作为“参考”留在仓库。
- 每次 provider 行为变更后，agent 必须自己跑测试/构建/安装/重启/smoke，再交给 Jason 复测。
