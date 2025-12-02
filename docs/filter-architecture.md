LLMSwitch V2 Filter Architecture (Draft)

Goals
- Single, composable pipeline for protocol + tool shaping.
- Replace hard-coded transforms with Filter + FieldMap + Filter stages.
- Enforce single-entry/single-exit for tool handling inside llmswitch-core.

Stages（对称，三件套 + 映射 + 三件套）
- request_pre: 三件套（whitelist/blacklist/add_fields）
- request_map: Field mapping（协议形状/字段映射）
- request_post: 三件套（whitelist/blacklist/add_fields）用于收尾修复（例如补齐 finish_reason、content=null when tool_calls、arguments 串化结果落位等）
- response_pre: 三件套（whitelist/blacklist/add_fields）先行清理（例如剥离文本结果包）
- response_map: Field mapping（供应商 → 标准）
- response_post: 三件套（whitelist/blacklist/add_fields）收尾（finish_reason/content 不变量、必要的 header/元字段补齐；SSE 聚合由专用 Filter 处理）

Filter Types
- Built-ins: whitelist, blacklist, add_fields（两侧 pre/post 对称使用）
- Specialized (to be added):
  - tool_text_canonicalize
  - tool_arguments_stringify (lenient JSON/JSON5 → JSON string)
  - sse_aggregate_arguments (streaming)

Field Mapping
- JSONPath-like (subset) source → target with optional type coercion + named transform.
- Minimal, dependency-free; extensible with pluggable transforms.

Responsibilities
- Core (llmswitch-core): all tool handling (text → tool_calls, arguments stringify, schema augment), request/response filters and mapping.
- Compatibility: provider-specific FieldMap + minimal filters (no tool convert/harvest).
- Server/Provider: zero tool logic.

Observability
- Each filter emits a structured event (filter_after_<name>) with stage + metrics (optional).
- Snapshot for before/after can be toggled by the upper layer.

Migration Plan
1) Land engine + types (this change)
2) Migrate openai-openai codec request/response steps into filter configs (behavior parity)
3) Move textual tool canonicalization + arguments repair into filters
4) Move SSE aggregation into a stateful filter
5) Remove legacy hard-coded paths after parity tests

Testing
- Snapshot A/B using captured req_* payloads
- 1210 guard checks for GLM (arguments stringified, tool_choice rules)
- SSE logs assert arguments deltas swallowed; final full arguments appear once

Offline Testing Tool
--------------------

为方便在不启动 RouteCodex 服务器的前提下验证 FilterEngine 与工具治理链路，主仓库提供了一个基于 llmswitch-core 的离线测试脚本：

- 脚本路径：`tools/run-llmswitch-chat.mjs`（位于 RouteCodex 根目录）
- 依赖：`sharedmodule/llmswitch-core/dist/conversion/index.js` 导出的 `runStandardChatRequestFilters`
- 输入：
  - 直接的 OpenAI Chat 请求（`{ model, messages, tools, ... }`）
  - 或 provider-request 快照 JSON（包含 `data.body` 字段），脚本会自动提取 `data.body` 作为 Chat 请求
- 调用示例：

```bash
# 直接重放 Chat 请求
node tools/run-llmswitch-chat.mjs path/to/chat-request.json

# 使用 snapshot provider-request 作为输入
node tools/run-llmswitch-chat.mjs \
  ~/.routecodex/codex-samples/openai-chat/req_1763203765922_xxxxx_provider-request.json

# 指定入口端点（仅影响 FilterContext.endpoint）
node tools/run-llmswitch-chat.mjs path/to/chat-request.json /v1/messages
```

该工具会：
- 构造最小的 `ConversionProfile/ConversionContext`
- 调用 `runStandardChatRequestFilters`，依次执行 `request_pre`/`request_map`/`request_post`/`request_finalize` 阶段的所有 Filter（包括工具治理与后置约束）
- 将最终发送给 Provider 的 Chat 请求以 JSON 形式输出到 stdout

典型用途：
- 对历史错误样本做 A/B 回归（例如校验新加的 ToolPostConstraintsFilter 是否正确剪掉 schema 校验不过的工具）
- 在不影响运行中 RouteCodex 服务器的情况下，快速迭代和验证新的 Filter 组合或治理规则
