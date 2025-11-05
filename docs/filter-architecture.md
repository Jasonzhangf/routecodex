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
