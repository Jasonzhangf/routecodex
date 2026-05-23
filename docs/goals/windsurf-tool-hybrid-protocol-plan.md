# Windsurf Hybrid Tool Protocol Plan

## 索引概要
- L1-L12 `purpose`：本文目标与关系。
- L14-L42 `acceptance`：验收标准。
- L44-L79 `scope`：范围与边界。
- L81-L143 `design`：native direct translation + unsupported RCC text protocol。
- L145-L203 `harvest`：响应 harvest 区分处理。
- L205-L263 `implementation-files`：实现文件与职责。
- L265-L352 `blackbox-tests`：黑盒/红测路径。
- L354-L399 `steps`：实施顺序。
- L401-L423 `dod`：完成定义。

## Purpose

为 RouteCodex Windsurf provider 定义完整工具支持方案：

1. **支持工具做语义转译**：与 Windsurf Cascade native tools 语义等同的工具，透明转接为 Cascade structured protocol。
2. **不支持工具用 RCC 文本容器支持**：无法 native 等同的工具，仅对这些 unsupported tools 注入 RouteCodex RCC text-tool contract。
3. **harvest 区分处理**：native trajectory tool calls 与 RCC text tool calls 分别解析、分别回灌，禁止互相 fallback 或混淆。

> Windsurf 的 unsupported-tool fence 命名只使用 `RCC`；其他平台的历史协议命名不得写回 Windsurf 事实、测试或实现。

本文是实现计划；协议事实细节仍以 `docs/design/windsurf-cascade-tool-protocol.md` 为设计锚点。

## Acceptance Criteria

### Functional acceptance

- Native-supported tools transparently work through Cascade structured protocol:
  - request: `planner_mode=DEFAULT(1)` + `CascadeToolConfig.field32 tool_allowlist`。
  - response: trajectory structured fields / native step decode -> OpenAI/Codex `tool_calls`。
  - result submit: `SendUserCascadeMessageRequest.field9 additional_steps`。
- Unsupported tools work through a single RCC text-tool contract:
  - request guidance contains **only unsupported tools**。
  - native-supported tools never appear in RCC guidance。
  - assistant RCC output is harvested into standard `tool_calls`。
  - malformed RCC with tool intent fails fast; no loose salvage from prose。
  - unsupported tool results are returned to Cascade as RCC result context, not `additional_steps`。
- Mixed tool requests work:
  - native subset -> native allowlist。
  - unsupported subset -> RCC guidance。
  - response harvest chooses one source per turn with deterministic precedence and explicit conflict errors。

### Safety acceptance

- This is **not fallback**:
  - native tool failure must not downgrade to RCC。
  - unsupported tool RCC is selected at request partition time only。
- No capability routing/gating is introduced.
- No broad tool text harvest from arbitrary prose.
- No second Windsurf transport path is introduced.

## Scope

### In scope

- `exec_command` / `shell_command` / `run_command` / `bash` direct translation to Cascade `run_command` for one-shot blocking shell execution.
- Existing mapped native families remain native-only where already blackbox-proven:
  - `read_file` / `view_file` -> `view_file`
  - `grep*` -> `grep_search_v2`
  - `find` / `glob` -> `find`
  - `list_dir` / `list_directory` -> `list_directory`
- Unsupported tools via RCC:
  - `write_stdin`
  - `apply_patch`
  - `update_plan`, `get_goal`, `create_goal`, `update_goal`, `request_user_input`
  - `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`
  - `view_image`
  - `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, `close_agent`
  - `mcp__*`
- Tests proving both supported and unsupported paths.

### Out of scope

- MCP server registration into Windsurf LS. This remains a future blackbox path.
- Per-request custom tool injection through `SendUserCascadeMessageRequest`; App schema currently shows no input slot.
- Text fallback for native tools.
- Restoring old `tools_preamble` / `<tool_call>` / `function_call` harvest protocols.

## Design

### 1. Tool partitioning

Provider preprocess must split declared tools into two disjoint sets:

```text
input tools[]
  -> nativeTools[]       // maps to Cascade native kind
  -> unsupportedTools[]  // no native semantic equivalence
```

Native examples:

```text
exec_command / shell_command / run_command / bash -> run_command
read_file / view_file                             -> view_file
grep / grep_search / grep_search_v2               -> grep_search_v2
find / glob                                       -> find
list_dir / list_directory                         -> list_directory
```

Unsupported examples:

```text
apply_patch
write_stdin
update_plan
request_user_input
spawn_agent / send_input / wait_agent / close_agent
mcp__*
```

Partition outputs should be explicit runtime metadata, e.g.:

```text
windsurf_native_mode=true|false
windsurf_native_allowlist=[...]
windsurf_declared_native_tools=[...]
windsurf_unsupported_text_tools=[...]
windsurf_text_tool_protocol="rcc"
```

### 2. Native direct translation

Native path remains Cascade structured protocol:

```text
SendUserCascadeMessageRequest.field5 cascade_config
  CascadeConfig.field1 planner_config
    CascadePlannerConfig.field2 conversational.field4 planner_mode=DEFAULT(1)
    CascadePlannerConfig.field13 tool_config.field32 tool_allowlist
```

`exec_command` / `shell_command` equivalence boundary:

```text
cmd | command | command_line -> command_line
workdir | cwd               -> cwd
blocking                    -> true
observation                 -> stdout + full_output + exit_code
```

Not equivalent and must not be represented as `run_command`:

```text
write_stdin
PTY/session continuation
yield_time_ms
interactive stdin
sandbox/approval semantics
```

### 3. Unsupported RCC text-tool contract

Use the RouteCodex RCC structured text protocol, not a weak markdown fence:

```xml
<|RCC|tool_calls>
<|RCC|invoke name="apply_patch">
<|RCC|parameter name="patch"><![CDATA[
*** Begin Patch
...
*** End Patch
]]></|RCC|parameter>
</|RCC|invoke>
</|RCC|tool_calls>
```

Rules:

- RCC guidance lists **only unsupported tool names and their schema summaries**.
- Native tool names must not appear in RCC guidance.
- If an unsupported tool is needed, assistant must output only the RCC block and no prose.
- If no unsupported tool is needed, assistant may answer normally or may emit native structured tool call via Cascade.
- RCC supports multiple unsupported tool invocations in one root, but each invocation must be explicit:

```xml
<|RCC|invoke name="tool_name">
<|RCC|parameter name="arg"><![CDATA[value]]></|RCC|parameter>
</|RCC|invoke>
```

### 4. Where to inject unsupported RCC guidance

Inject into the Cascade prompt text assembled by `buildCascadePromptText(...)`, scoped to the current request, after system/history projection and before the terminal user task.

Guidance must include:

- `Tool-call output contract (STRICT)` marker.
- Allowed unsupported tool names only.
- Schema summary for unsupported tools only.
- RCC example.
- Prohibitions copied from DeepSeek lessons:
  - no markdown fences;
  - no `Calling:` / `Tool:` / narrative tool intent;
  - no MCP pseudo wrappers like `<use_mcp_tool>`;
  - no JSON-only tool payload outside RCC;
  - no invented tool names.

### 5. Unsupported tool result feedback

Native result feedback:

```text
assistant native tool_call + tool output
  -> additional_steps field9
```

Unsupported result feedback:

```text
assistant RCC-harvested tool_call + tool output
  -> RCC result context in prompt text
```

Recommended result block:

```xml
<|RCC|tool_result id="call_x" name="apply_patch">
<![CDATA[
...tool output...
]]>
</|RCC|tool_result>
```

This block is **context**, not a tool call. Harvest must ignore result blocks.

## Harvest Semantics

### 1. Native harvest

Source:

```text
GetCascadeTrajectorySteps / GetCascadeTrajectory
  CortexTrajectoryStep structured fields
  native step kinds
```

Behavior:

- Convert structured trajectory calls to standard OpenAI/Codex `tool_calls`.
- Reverse map native kind to declared native tool name when possible.
- Native harvest has precedence over RCC if structured tool calls exist.

### 2. Unsupported RCC harvest

Source:

```text
assistant accumulated text / modified text / response text
```

Only enabled when `windsurf_unsupported_text_tools.length > 0`.

Behavior:

- Parse only `<|RCC|tool_calls>...</|RCC|tool_calls>`.
- Only accept `<|RCC|invoke name="...">` where name is in unsupported allowlist.
- Convert parameters into JSON object arguments.
- Return standard `tool_calls` with deterministic `call_<hash>` ids if no id is present.
- Strip RCC block from visible assistant text when tool calls are returned.

### 3. Conflict handling

- If native structured tool calls exist and text also contains RCC tool_calls:
  - fail fast with `WINDSURF_TOOL_PROTOCOL_CONFLICT` unless the RCC block is clearly quoted prior context.
- If RCC marker exists but parsing yields zero valid tool calls:
  - fail fast with `WINDSURF_TEXT_TOOL_PARSE_FAILED`.
- If RCC invokes a native-supported tool:
  - fail fast; native tools must use structured protocol.
- If RCC invokes undeclared/unknown tool:
  - fail fast; do not pass through invented tools.
- If no RCC marker exists:
  - normal assistant text is preserved.

### 4. Do not reuse weak harvest modes

Forbidden for Windsurf unsupported tool path:

- harvesting JSON from arbitrary prose;
- legacy `<tool_call>` / `<function_calls>` unless explicitly wrapped by RCC compatibility code and allowlisted;
- repairing malformed tool calls by guessing names/args from text;
- treating `tool_result` blocks as calls.

## Implementation Files

### Provider implementation

- `src/providers/core/runtime/windsurf-chat-provider.ts`
  - partition tools into native vs unsupported;
  - build native allowlist;
  - inject unsupported RCC guidance into Cascade prompt;
  - build native `additional_steps` only for native tool calls;
  - build RCC result context only for unsupported tool calls;
  - apply native/RCC harvest distinction in `pollCascadeTrajectorySteps` / assistant parse path;
  - surface protocol conflict / parse errors.

### Shared RCC parser / guidance reuse

Prefer reusing or extracting from existing DeepSeek/Rust normalizer instead of writing a new weak parser:

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_text_markup_normalizer.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/deepseek_web/request/prompt/tool_guidance.rs`
- TS wrapper references:
  - `sharedmodule/llmswitch-core/src/conversion/compat/actions/harvest-tool-calls-from-text.ts`
  - `sharedmodule/llmswitch-core/src/conversion/compat/actions/tool-text-request-guidance.ts`

If reuse requires a new exported Rust helper, add it in Rust and keep TS as a thin wrapper.

### Docs / skills

- `docs/design/windsurf-cascade-tool-protocol.md`
- `docs/providers/windsurf-chat-provider-design.md`
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `note.md`

## Blackbox Test Plan

All tests should be added before implementation where they currently fail.

### A. Tool partition tests

1. `native only`:
   - tools: `shell_command`, `read_file`。
   - expect native allowlist only; no RCC guidance.

2. `unsupported only`:
   - tools: `apply_patch`, `update_plan`。
   - expect no native allowlist; RCC guidance contains only those names.

3. `mixed`:
   - tools: `shell_command`, `apply_patch`, `update_plan`。
   - expect native allowlist `run_command`。
   - expect RCC guidance names `apply_patch`, `update_plan`。
   - assert RCC guidance does **not** contain `shell_command` / `run_command`.

### B. Native request blackbox

Compare RouteCodex request bytes with WindsurfAPI for native subset:

- `planner_mode=DEFAULT(1)`。
- `tool_config.field32` equals native allowlist。
- no RCC marker in native-only request。

### C. RCC guidance blackbox

Use DeepSeek-style markers:

- prompt contains `Tool-call output contract (STRICT)`。
- prompt contains `<|RCC|tool_calls>` example。
- prompt contains only unsupported tool schema summaries。
- prompt forbids markdown fence / `Calling:` / `Tool:` / `<use_mcp_tool>`.

### D. Native harvest blackbox

- input trajectory emits structured `run_command` / `tool_call_proposal`。
- output OpenAI tool_calls are returned。
- RCC parser is not invoked / ignored when structured native tool call exists.

### E. RCC harvest blackbox

1. valid RCC:

```xml
<|RCC|tool_calls>
<|RCC|invoke name="apply_patch">
<|RCC|parameter name="patch"><![CDATA[*** Begin Patch\n...]]></|RCC|parameter>
</|RCC|invoke>
</|RCC|tool_calls>
```

Expect:

- `finish_reason=tool_calls`。
- tool name `apply_patch`。
- arguments contain exact patch text。
- visible assistant content excludes RCC block.

2. undeclared RCC tool:

- `name="shell_command"` when shell is native or not in unsupported allowlist。
- expect fail-fast.

3. malformed RCC:

- opener with no closing root or invalid invoke.
- expect `WINDSURF_TEXT_TOOL_PARSE_FAILED`.

4. text without RCC:

- preserve assistant text; no harvest.

### F. Tool result feedback blackbox

1. Native result:

- prior assistant `shell_command`/`exec_command` tool_call + tool output。
- expect `additional_steps field9` and no RCC result context.

2. Unsupported result:

- prior assistant `apply_patch` tool_call + tool output。
- expect RCC result context in prompt and no `additional_steps` for that call.

3. Mixed history:

- prior native call + prior unsupported call。
- expect native call becomes `additional_steps`；unsupported call becomes RCC result context。

### G. Live smoke

After build/install/restart:

1. native smoke:
   - `/v1/responses` with only `shell_command`。
   - expect provider emits Cascade native `run_command` tool_call.

2. unsupported smoke:
   - `/v1/responses` with only `update_plan` or harmless local test tool if available。
   - expect RCC-harvested tool_call.

3. mixed smoke:
   - `/v1/responses` with `shell_command` + `update_plan`。
   - expect deterministic partition and no `WINDSURF_UNMAPPED_TOOL`.

## Implementation Steps

1. Update protocol docs with hybrid native + RCC unsupported design.
2. Add tests for partition metadata and RCC guidance; confirm red.
3. Implement partition metadata in `preprocessRequest`.
4. Add tests for RCC guidance injection; confirm red then implement prompt injection.
5. Add RCC harvest tests; confirm red then wire shared/native parser.
6. Add conflict/fail-fast tests; implement errors.
7. Add unsupported result feedback tests; implement RCC result context.
8. Run targeted Jest.
9. Run full Windsurf provider Jest with explicit timeout.
10. Run TypeScript compile.
11. Build/install/restart.
12. Run live `/v1/responses` smoke for native-only, unsupported-only, and mixed.
13. Update `note.md`, `MEMORY.md` only for verified conclusions.

## Risks and Mitigations

- Risk: RCC guidance competes with Cascade native planner.
  - Mitigation: native tools never appear in RCC guidance; structured native harvest has precedence; mixed native+RCC same turn conflicts fail-fast.
- Risk: text harvest swallows normal assistant prose.
  - Mitigation: harvest only RCC root, no arbitrary JSON/prose salvage.
- Risk: tool result feedback confuses model.
  - Mitigation: native results remain `additional_steps`; unsupported results use distinct `tool_result` context ignored by harvest.
- Risk: implementing parser in TS diverges from DeepSeek Rust normalizer.
  - Mitigation: reuse/export shared native parser; TS remains thin.

## Definition of Done

- Docs updated and consistent.
- Native direct tools still pass request/response/history blackboxes.
- Unsupported RCC tools pass guidance/harvest/result blackboxes.
- Mixed native+unsupported tools pass partition and conflict tests.
- `npx tsc --noEmit --pretty false` passes.
- `npx jest tests/providers/core/runtime/windsurf-chat-provider.spec.ts --runInBand --forceExit --testTimeout=30000` passes.
- `npm run build:min` and `npm run install:global` pass.
- Scoped restart succeeds and `/health` reports current version.
- Live `/v1/responses` smoke proves native-only, unsupported-only, mixed tool flows.
