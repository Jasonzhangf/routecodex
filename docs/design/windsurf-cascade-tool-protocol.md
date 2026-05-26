# Windsurf Cascade Tool Protocol Design Anchor

## 索引概要
- L1-L11 `scope`：本文用途与禁止路径。
- L13-L25 `truth-sources`：WindsurfAPI / Windsurf App / LS binary 真源锚点。
- L27-L65 `request-shape`：标准工具请求形状。
- L67-L131 `response-shape`：trajectory 工具调用返回形状。
- L133-L190 `tool-result-submit`：工具执行结果回灌形状。
- L192-L230 `mapping-boundary`：OpenAI tools 到 Cascade native tools 的边界。
- L232-L265 `routecodex-requirements`：RouteCodex provider 必须满足的行为。
- L267-L294 `test-plan`：先红黑盒锚点清单。
- L296-L318 `doc-hygiene`：协议事实写入边界。

## Scope

本文固定 RouteCodex Windsurf provider 的工具调用协议目标：**对齐 Windsurf Cascade 标准协议**。

禁止把以下路径作为最终工具调用方案：

- prompt 文本里注入 `{"function_call": ...}`。
- prompt 文本里注入 `<tool_call>...</tool_call>`。
- 从 assistant 普通文本中 harvest / salvage JSON 或 XML 工具调用。
- 对 unmapped arbitrary OpenAI function 做文本 fallback。

如果某工具无法映射到已确认的 Cascade 标准入口，必须 fail-fast；不能降级到文本协议。

## Truth Sources

### WindsurfAPI reference

固定参考：

- `/Volumes/extension/code/WindsurfAPI/src/windsurf.js`
  - `buildSendCascadeMessageRequest(...)`
  - `buildCascadeConfig(...)`
  - `buildNativeCascadeToolConfig(...)`
  - `parseTrajectorySteps(...)`
- `/Volumes/extension/code/WindsurfAPI/src/cascade-native-bridge.js`
  - `TOOL_MAP`
  - `buildAdditionalStepsFromHistory(...)`
  - `buildAdditionalStep(...)`
  - `decodeCascadeStepToToolCall(...)`
- `/Volumes/extension/code/WindsurfAPI/src/handlers/chat.js`
  - native bridge partition / allowlist / `additionalSteps` call site

### Windsurf App / LS evidence

Windsurf App bundle exposes the protobuf schema family in:

- `/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js`

Confirmed schema anchors:

- `exa.cortex_pb.CascadeConfig`
- `exa.cortex_pb.CascadePlannerConfig`
- `exa.cortex_pb.CascadeConversationalPlannerConfig`
- `exa.cortex_pb.CascadeToolConfig`
- `exa.cortex_pb.CortexStepToolCallProposal`
- `exa.cortex_pb.CortexStepToolCallChoice`
- `exa.cortex_pb.CortexStepCustomTool`
- `exa.cortex_pb.CortexStepMcpTool`
- `exa.chat_pb.ChatToolDefinition`
- `exa.cortex_pb.CustomToolSpec`

LS binary strings additionally confirm `CascadeToolConfig.GetToolAllowlist` and CustomTool getters exist.

## Request Shape: Standard Cascade Native Tool Mode

工具调用请求走本地 LS gRPC：

```text
/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage
```

Top-level `SendUserCascadeMessageRequest` relevant fields:

```text
field 1 cascade_id: string
field 2 items: repeated TextOrScopeItem
  field 1 text: string
field 3 metadata: Metadata
field 5 cascade_config: CascadeConfig
field 9 additional_steps: repeated CortexTrajectoryStep  // tool result submit path
```

`cascade_config` shape:

```text
CascadeConfig
  field 1 planner_config: CascadePlannerConfig
  field 7 brain_config: BrainConfig
```

`planner_config` shape for standard native tools:

```text
CascadePlannerConfig
  field 2 conversational: CascadeConversationalPlannerConfig
    field 4 planner_mode = 1  // DEFAULT
  field 13 tool_config: CascadeToolConfig
  field 34 plan_model_uid: string
  field 35 requested_model_uid: string
  field 15 requested_model_deprecated: ModelOrAlias  // when model enum exists
  field 1 plan_model_deprecated: enum              // when model enum exists
  field 6 max_output_tokens = 32768
```

`CascadeToolConfig` native allowlist shape:

```text
CascadeToolConfig
  field 8  run_command: empty message        // enabled when allowlist contains run_command
  field 10 view_file: empty message          // enabled when allowlist contains view_file
  field 19 list_dir: empty message           // enabled when allowlist contains list_dir/list_directory
  field 33 grep_v2: empty message            // enabled when allowlist contains grep_search_v2/grep_search
  field 5  find: empty message               // enabled when allowlist contains find
  field 32 tool_allowlist: repeated string
```

Important protobuf encoding rule:

- Empty embedded messages must be omitted by the generic `writeMessageField` helper if body is empty.
- WindsurfAPI currently calls `writeMessageField(field, Buffer.alloc(0))` for per-tool sub-configs; because its helper omits empty messages, **field 32 `tool_allowlist` is the authoritative enabled-tool gate** in the RouteCodex-compatible blackbox.

Native tool request must not contain textual tool protocol markers:

```text
function_call
<tool_call>
You have access to the following functions.
```

## Response Shape: Trajectory Tool Calls

Tool calls come from `GetCascadeTrajectorySteps`, not assistant text.

Response parser reads repeated `CortexTrajectoryStep` from field 1.

Relevant `CortexTrajectoryStep` fields:

```text
field 20 planner_response: CortexStepPlannerResponse
  field 1 response_text: string
  field 3 thinking: string
  field 8 modified_text: string

field 45 custom_tool: CortexStepCustomTool
field 47 mcp_tool: CortexStepMcpTool
field 49 tool_call_proposal: CortexStepToolCallProposal
field 50 tool_call_choice: CortexStepToolCallChoice
```

`ChatToolCall` shape:

```text
field 1 id: string
field 2 name: string
field 3 arguments_json: string
```

`tool_call_proposal` shape:

```text
CortexStepToolCallProposal
  field 1 tool_call: ChatToolCall
```

`tool_call_choice` shape:

```text
CortexStepToolCallChoice
  field 1 proposal_tool_calls: repeated ChatToolCall
  field 2 choice: uint32
  field 3 reason: string
```

Provider projection to OpenAI-compatible tool call:

```json
{
  "id": "<ChatToolCall.field1 or deterministic id>",
  "type": "function",
  "function": {
    "name": "<caller-visible tool name>",
    "arguments": "<arguments_json>"
  }
}
```

If a trajectory has real tool calls, RouteCodex must use those structured fields. It must not parse assistant text for JSON/XML fallback.

## Tool Result Submit: additional_steps field 9

Tool results are injected back through `SendUserCascadeMessageRequest.field9 additional_steps`.

Each additional step is a completed `CortexTrajectoryStep`:

```text
CortexTrajectoryStep
  field 1 type: CortexStepType enum
  field 4 status = 3  // DONE
  field <oneofField> native step body with arguments + observation/result
```

Known native step mapping:

```text
view_file       -> type 14,  oneof field 14
list_directory  -> type 15,  oneof field 15
write_to_file   -> type 23,  oneof field 23
run_command     -> type 28,  oneof field 28
find            -> type 34,  oneof field 34
read_url_content-> type 40,  oneof field 40
search_web      -> type 42,  oneof field 42
grep_search_v2  -> type 105, oneof field 105
```

Observation overlay examples:

```text
view_file       result -> body.content field 4
run_command     result -> stdout field 4 + exit_code field 6 + combined_output field 21.full field 1
grep_search_v2  result -> raw_output field 15
find            result -> raw_output field 11
list_directory  result -> repeated children field 2
search_web      result -> summary field 5
read_url_content result -> summary field 4
```

RouteCodex submit/history path must build `additional_steps` from prior assistant structured tool calls plus matching tool outputs. It must not inject `<tool_result>` text as the final protocol.

## Mapping Boundary

The confirmed standard path is **not arbitrary OpenAI function passthrough**.

Current supported model:

```text
OpenAI/Responses tool name -> RouteCodex/WindsurfAPI TOOL_MAP -> Cascade native tool kind -> tool_allowlist
```

Known mapped families and semantic status:

| Caller tool family | Cascade native kind | Semantic status | Implementation rule |
| --- | --- | --- | --- |
| `exec_command` / `shell_command` / `run_command` / `bash` | `run_command` | **direct equivalent for one-shot blocking shell execution** | Translate `cmd`/`command`/`command_line` -> `command_line`, `workdir`/`cwd` -> `cwd`, force `blocking=true`; reverse trajectory back to caller tool name. Do not claim PTY/session/stdin/yield semantics. |
| `Read` / `read` / `read_file` / `view_file` | `view_file` | direct equivalent for file read | Translate file path/offset/limit to `absolute_path_uri`/offset/limit. |
| `Glob` / `glob` / `find` | `find` | partial/direct for filename discovery | Translate only matching directory/pattern semantics proven by tests. |
| `Grep` / `grep` / `grep_search` / `grep_search_v2` | `grep_search_v2` | partial/direct for text search | Translate only pattern/path/glob/context flags. |
| `list_dir` / `list_directory` | `list_directory` | direct equivalent for directory listing | Translate directory path. |
| `Write` / `write` / `write_to_file` | `write_to_file` | partial; single-file only | Do not map multi-file patch semantics here. |
| `WebSearch` / `ToolSearch` / `web_search` | `search_web` | partial; provider-dependent result shape | Only enable when request allowlist and result projection are tested. |
| `WebFetch` / `read_url_content` | `read_url_content` | partial/direct URL fetch | Only enable when result projection is tested. |
| `apply_patch` | none | custom tool via gRPC field 10 mcpCompat | Windsurf.app exposes `write_to_file` / `propose_code` as Cascade trajectory/proto steps, not as a controllable executor equivalent to Codex `apply_patch`. Do not native-map `apply_patch` to `write_to_file` / `propose_code`. Instead, pass through `windsurf_custom_tools` → gRPC field 10 JSON strip for LS-side decoding. |
| `write_stdin` / PTY/session continuation | none | unsupported by `run_command` equivalence | Must fail-fast; `run_command` is one-shot blocking, not an interactive session. |
| `update_plan` / `request_user_input` / `spawn_agent` / `send_input` / `wait_agent` / `close_agent` | none | unsupported by current native map | Candidate only for future MCP registration blackbox, not direct translation. |
| `mcp__*` caller tools | no per-request input slot proven | MCP candidate, not supported yet | Requires separate MCP registration/request blackbox; cannot be injected through `SendUserCascadeMessageRequest`. |

However, request-side `CascadeToolConfig` allowlist is currently confirmed for these native kinds only:

```text
run_command
view_file
list_dir / list_directory
grep_search_v2 / grep_search
find
```

Fields for `CustomToolSpec`, `ChatToolDefinition`, `McpServerState`, `CortexStepCustomTool`, and `CortexStepMcpTool` exist in the App schema, but the request-side input slot for arbitrary OpenAI function schemas is **not present** in the confirmed `SendUserCascadeMessageRequest` shape:

```text
SendUserCascadeMessageRequest fields confirmed from Windsurf App bundle:
1 cascade_id
2 items
3 metadata
4 experiment_config
5 cascade_config
6 images
7 recipe_ids
8 blocking
9 additional_steps
```

Additional evidence:

- WindsurfAPI `src/handlers/tool-emulation.js` explicitly records the same conclusion: `SendUserCascadeMessageRequest` fields 1-9 do not accept tool definitions; `CustomToolSpec` exists as a trajectory event type, not as request input.
- WindsurfAPI native bridge maps known tools via `TOOL_MAP`; unmapped tools are sent through its old `toolPreamble` emulation path, not structured custom-tool injection.
- App `ChatToolDefinition` appears in `GetSystemPromptAndToolsResponse.tool_definitions`, which is LS-produced tool metadata, not a per-request user tool-definition input.

Therefore RouteCodex must treat arbitrary Codex/MCP/custom tools as **unsupported by Cascade native structured protocol**. They must not be encoded into `SendUserCascadeMessageRequest` as native tool definitions, because that request has no such input slot.

Current RouteCodex decision: custom tools (unmapped from `WINDSURF_TOOL_MAP`) are sent as JSON strips via gRPC field 10. No text-tool markers are injected into the prompt. This is a request-time partition, not fallback after native failure:

```text
native-equivalent tool -> Cascade native structured protocol
custom tool            -> gRPC field 10 mcpCompat JSON strip
```

`apply_patch` is a custom tool for Windsurf. It passes through `windsurf_custom_tools` → gRPC field 10; it must not be translated to Cascade `write_to_file` / `propose_code` native steps.

## RouteCodex Provider Requirements

1. `preprocessRequest`:
   - detect `tools[]`.
   - partition declared tools into `windsurf_declared_native_tools` and `windsurf_custom_tools`.
   - native tools set `windsurf_native_mode=true` and `windsurf_native_allowlist=[...]`.
   - custom tools are written to `body.windsurf_custom_tools`.
   - remove original `tools` and legacy `tools_preamble` from outbound body.
   - do not perform provider capability routing/gating.
   - do NOT set `windsurf_text_tool_protocol` — that path is removed.

2. `buildSendCascadeMessageRequest`:
   - when `windsurf_native_mode=true`, encode planner mode `DEFAULT(1)`.
   - encode `CascadePlannerConfig.field13 tool_config` with `field32 tool_allowlist`.
   - do not write textual tool protocol into native tool fields.

3. `buildCascadePromptText`:
   - do NOT inject RCC guidance or any text-tool protocol markers.
   - custom tools are not represented in prompt text — they pass through gRPC field 10 only.
   - do not restore legacy `tools_preamble`, `<tool_call>`, or `function_call` protocols.

4. `pollCascadeTrajectorySteps` / harvest:
   - collect native tool calls from structured trajectory fields 45/47/49/50 and known native step decode.
   - custom tool calls are returned by Cascade as trajectory steps (field 45 custom_tool / field 47 mcp_tool) — decode them directly.
   - if `windsurf_custom_tools` were declared and the response contains `<|RCC|tool_calls>` text, fail fast with `WINDSURF_TOOL_PROTOCOL_CONFLICT` (RCC protocol is removed).

5. submit/history:
   - native assistant tool calls + outputs become `additional_steps field9`.
   - custom tool results are returned as trajectory step fields 45/47 in the next poll — they are not injected as prompt context.
   - native additional_steps and custom tool trajectory results coexist in the same poll loop.

## Test Plan

Blackbox anchors must be added and run in this order:

1. Request blackbox:
   - Compare RouteCodex `buildSendCascadeMessageRequest(... nativeMode ...)` with WindsurfAPI `buildSendCascadeMessageRequest(... {nativeMode:true,nativeAllowlist:[...]})`.
   - Assert planner mode is `DEFAULT(1)`.
   - Assert `planner_config.field13.tool_config.field32` equals allowlist.
   - Assert request bytes do not contain textual tool protocol markers.

2. Preprocess / partition blackbox:
   - mapped tools become `windsurf_declared_native_tools` + `windsurf_native_mode=true` + allowlist.
   - custom tools become `windsurf_custom_tools`.
   - `windsurf_text_tool_protocol` must be undefined.
   - App request schema no tool-definition input slot remains a blackbox anchor.

3. Response blackbox:
   - RouteCodex `parseTrajectorySteps` matches WindsurfAPI `parseTrajectorySteps` for fields 45/47/49/50.
   - `pollCascadeTrajectorySteps` emits OpenAI `tool_calls` from structured trajectory for native calls.
   - Custom tools decode from trajectory fields 45/47; RCC text-tool harvest is removed (detected as conflict and fails fast).

4. Submit/history blackbox:
   - RouteCodex `buildCascadeAdditionalStep` matches WindsurfAPI `buildAdditionalStep` for native calls.
   - `SendUserCascadeMessage.field9 additional_steps` matches WindsurfAPI reference.
   - Custom tool trajectory results are decoded from poll response — not injected as text.

5. Installed smoke after implementation:
   - build + install + restart RouteCodex.
## Custom Tools Protocol (gRPC field 10 mcpCompat)

Non-native tools (unregistered in `WINDSURF_TOOL_MAP`) are encoded as JSON strips via `SendUserCascadeMessageRequest` gRPC field 10. The LS runtime decodes and adapts them.

Protocol decision:

- Native-equivalent tools must use Cascade structured protocol only.
- Custom tools pass through `windsurf_custom_tools` → gRPC field 10 mcpCompat JSON strips.
- RCC text-tool protocol (`<|RCC|tool_calls>` / `<|RCC|tool_result>`) is **removed**. If detected in responses, `WINDSURF_TOOL_PROTOCOL_CONFLICT` (400) is thrown.
- Harvest decodes custom tool trajectory steps from fields 45/47 directly.

## Documentation Hygiene

本文是工具协议唯一细节文档。写入新结论前必须满足：

1. 能指向 WindsurfAPI、Windsurf App protobuf schema、LS binary strings、或 `~/.rcc` runtime sample/log 中至少一个证据源。
2. 不能把文本引导、文本收割、旧 cloud JSON path 写成可选实现。
3. 若只是历史踩坑，写到 audit/note，并标注 superseded；不要混入本文的当前协议。
4. 每个协议字段必须说明方向：request、trajectory response、或 submit/history additional_steps。
