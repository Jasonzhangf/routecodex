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
- custom tools 不进入 Cascade native structured protocol，也不能通过 `SendUserCascadeMessageRequest` 自造 top-level 字段注入。`preprocessRequest` 将它们写入隐藏 `body.windsurf_custom_tools` 并开启 `body.windsurf_mcp_mode`；下游 `buildSendCascadeMessageRequest` 只启用 `CascadeToolConfig.field16 mcp`。不注入任何文本引导标记，不 fallback 到 RCC/text 协议。

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


## Custom Tools Protocol (Cascade MCP)

非 native 工具（未在 `WINDSURF_TOOL_MAP` 中注册的工具）通过 `SendUserCascadeMessageRequest` field 10 编码一次性 JSON 透传，由 LS 端自主解码适配。

Preprocess 分区：

```text
native-equivalent tool -> Cascade native structured protocol
custom tool            -> CascadeToolConfig.field16 mcp
```

编码规则：

```text
field 10: writeProtoMessageField(10, writeProtoStringField(1, stableStringify(entry)))
```

`SendUserCascadeMessageRequest` 无 custom tool / MCP definition top-level slot；禁止再编码 field 10 synthetic payload。MCP 工具定义必须来自 Windsurf LS 的 MCP server state / tool definition 链路。

Provider 不得做的行为：

- 不得在 prompt 中注入任何 RCC 文本引导标记（`<|RCC|tool_calls>` / `<|RCC|tool_result>`）。
- 不得通过 `windsurf_text_tool_protocol` 字段做文本收缩回退。（该字段和代码路径已被移除。）


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

## apply_patch — 当前处理方式

`apply_patch` 对 Windsurf 不是已确认可等价的 native tool。Windsurf.app 只能确认 `write_to_file` / `propose_code` 是 Cascade trajectory/proto step，不能确认它们是可控本地 executor；其字段也不能表达 Codex `apply_patch` 的 multi-file patch、失败/aborted 等完整语义。因此禁止把 `apply_patch` native-map 到 `write_to_file` / `propose_code`。

当前规则：

1. `apply_patch` 作为 custom tool 处理，通过 `windsurf_custom_tools` 开启 Cascade MCP，不得伪装 native。
2. 不完全兼容工具不得伪装 native；否则执行结果不可控，错误会被模型误解。
3. `exec_command` / `shell_command` 仍可 bridge 到 Cascade `run_command`，但只限 one-shot blocking shell 子集；不能外推到 PTY/session/stdin，也不能用 `run_command` 代替 `apply_patch` 文件编辑。

当前测试锚点必须覆盖：`apply_patch` 被分入 `windsurf_custom_tools`；native allowlist 不包含 `write_to_file`；custom tool 开启 `CascadeToolConfig.field16 mcp`，不使用 `SendUserCascadeMessage` field 10，也不在 prompt 中注入文本引导。

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
