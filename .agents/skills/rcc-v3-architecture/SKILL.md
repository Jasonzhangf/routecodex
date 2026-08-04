---
name: rcc-v3-architecture
description: Use before any RouteCodex V3 architecture/debug/development work; agents must read maps before coding, keep control semantics out of payload, preserve Direct same-protocol and Relay per-stage shapes, avoid silent strip/fallback/script bulk edits, and verify owner/gates before review.
---

# RCC V3 Architecture

## Summary Hard Rules

- Use this skill before any V3 work involving Hub Pipeline, Direct/Relay, Virtual Router, provider/runtime boundaries, continuation, Stopless/servertool, protocol projection, response projection, routing, or Error resources.
- Before code, bind the task to `v3-resource-operation-map.yml`, `v3-function-map.yml`, `v3-mainline-call-map.yml`, module registry, and `v3-verification-map.yml`; if the unique owner or adjacent edge is not clear, update the contract first instead of editing implementation.
- Control semantics must stay in typed side-channels / MetadataCenter control resources / Error chain. They must never enter provider/client normal payload, protocol `metadata`, request/response reconstruction, SSE frames, handler cleanup, outbound strip, or provider transport patches.
- Direct preserves the entry protocol end-to-end. Relay normalizes inbound to Chat/OpenAI Chat semantics and projects outbound to the selected target protocol only through adjacent codecs. Chat Process governs semantics but must not carry source wire, target wire, or provider-specific payload patches.
- Protocol conversion is static and registered: exact mapping or named compatible mapping with tests; otherwise explicit unmapped/unsupported at the adjacent codec. No dynamic probing, silent drop, approximate marker, MetadataCenter rebuild, or provider switch to hide bad projection.
- No semantic bulk replacement scripts. Read each target file, verify context, and patch manually with reviewable hunks.

## P0 架构阻断（先于任何路由）

- 禁止脚本批量替换：严禁用 Python / Node / Perl / `sed` / `awk`、临时脚本、shell loop、正则替换命令、编辑器宏或生成式 transformation script，对跨文件或同一文件多位置做语义批量替换。必须逐文件读取并核实上下文，再用明确、可审查的 `apply_patch` hunk 手工修改。既有 formatter / canonical generator 仅可生成其声明的机械或生成产物，绝不能用于语义改写。
- RouteCodex 控制语义只能走 typed carrier / MetadataCenter 控制资源 / Error 链，绝不能进入、镜像到或借协议 `metadata` 混入 provider/client 正常 payload。
- normal payload 也不得重建 routing、switching、continuation、retry、provider selection、health、debug、snapshot、error、scope、stopless/servertool 状态。
- 命中泄漏必须在 owning boundary fail-fast；禁止 silent strip，禁止请求侧 cleanup，禁止 handler/SSE/outbound 补偿。先执行本块，再看图、查 map 或修改代码。
- 强制顺序：读取涉及模块精确定义 -> 方案越界审查 -> 实现 -> diff 越界自检 -> 功能验证 -> live 闭环 -> code review。审查必须核对 module id/owner、owned/allowed/forbidden paths、相邻调用边和资源关系；任何阶段不得跳过或倒序。

## Module Boundary Review Gate

1. Before code, bind every planned edit and new call/resource edge to `v3-resource-operation-map.yml`, `v3-function-map.yml`, `v3-mainline-call-map.yml`, module registry, and `v3-verification-map.yml`.
2. Reject the design before implementation if any file has no unique module owner, any call skips an adjacent node, any resource relation is undeclared, or any allowed/forbidden path is violated.
3. After code, inspect the actual diff against the same bindings, including imports, helpers, payload fields, builders/projectors, and tests. This architecture self-review precedes functional verification.
4. Run code review only after functional and required live verification. The reviewer must independently report module-boundary violations as blocking findings.

## Trigger
- Any V3 debug/development/architecture task.
- Any request to audit, draw, or change V3 pipeline/caller/resource/function maps.
- Any issue involving Direct vs Relay, Hub Pipeline, Stopless/servertool, continuation, provider wire, response projection, routing, error resources, or `/v1/responses`.

## First look
1. Project `AGENTS.md`.
2. This skill.
3. `.agents/skills/rcc-dev-skills/SKILL.md` for debug/restart/live rules.
4. Edge-generated review surface:
   - Generate: `npm run render:v3-mainline-caller-flow`
   - Open: `docs/architecture/wiki/html/v3-mainline-caller-flow.html`
   - Edge source: `docs/architecture/v3-mainline-call-map.yml`
   - Resource source: `docs/architecture/v3-resource-operation-map.yml`

## Core architecture skeleton

### Request graph must stay separate
```text
V3HubReqInbound01ClientRaw
  -> V3HubReqInbound02Normalized
  -> V3HubReqContinuation03Classified
  -> V3HubReqChatProcess04Governed
  -> V3HubReqExecution05Planned
  -> V3HubReqTarget06Resolved
  -> V3HubReqOutbound07ProviderSemantic
  -> ProviderReqCompat06ProviderCompat
  -> V3ProviderReqOutbound08WirePayload
  -> V3ProviderReqOutbound09TransportRequest
```

### Response graph must stay separate
```text
V3ProviderRespInbound01Raw
  -> ProviderRespCompat02ProviderCompat
  -> V3HubRespInbound02Normalized
  -> V3HubRespChatProcess03Governed
  -> V3HubRespContinuation04Committed
  -> V3HubRespOutbound05ClientSemantic
  -> V3ServerRespOutbound06ClientFrame
```

### Error resources graph is mandatory
```text
V3Error01SourceRaised
  -> V3Error02Classified
  -> V3Error03TargetLocalAction
  -> V3Error04TargetExhaustionDecision
  -> V3Error05ExecutionDecision
  -> V3Error06ClientProjected

V3Error03TargetLocalAction -> V3ProviderHealthStateMutated -> V3ProviderAvailabilityProjected
```

Hard locks:
- Main path is edge truth, not memory or grep.
- Request and response diagrams are separate; do not merge them into one synthetic request/response loop.
- Request shape is `inbound -> continuation classify -> Chat Process -> execution/target -> outbound -> compat -> wire/transport`.
- Response shape is `provider raw -> compat -> inbound -> Chat Process -> continuation save -> outbound -> server frame`.
- VR/Target belongs to request execution/target nodes; it is not a replacement for request mainline.
- Error handler, provider health, provider availability, debug ledger/capture are resources with owners. `side-channel` is only the carrier mechanism, not the resource.
- Request/response normal payload and metadata/debug/error resources stay separated.
- MetadataCenter is the only semantic control carrier. If a change affects routing, continuation, stopless, servertool, retry, or observation state, write it into MetadataCenter or another declared side-channel resource. Do not rewrite normal request/response payloads for control reasons outside the adjacent codec/projection boundary.
- Direct may have its own lifecycle, but must declare Direct-only internal nodes; no provider/raw/Resp04 direct jump to client payload.
- Stopless/servertool response governance lives only in Rust Resp03 Chat Process. Req04 may restore request-side continuation/control; Resp04 may only save/commit the governed continuation. Continuation must be documented as save + restore together; never mention only one side.

## Debug/SOP workflow
1. Open `docs/architecture/wiki/v3-mainline-skeleton-sop.md` first for the audited big skeleton.
2. Open the generated HTML review surface.
3. If a relevant chain is already locked in `docs/architecture/v3-architecture-audit-locks.yml`, check its SOP/locked review before normal debug.
4. If no SOP exists or SOP checks pass, open the relevant branch diagram/table in the HTML.
5. Locate `chain_id`, `step_id`, `from_node`, `to_node`, `caller_symbol`, `callee_symbol`, source file, owner feature, and resource_flow.
6. Cross-check:
   - `docs/architecture/v3-function-map.yml`
   - `docs/architecture/v3-mainline-call-map.yml`
   - `docs/architecture/v3-resource-operation-map.yml`
   - `docs/architecture/v3-verification-map.yml`
   - relevant manifest under `docs/architecture/manifests/`
7. Only then inspect source and patch the unique owner.
8. After a new debug pattern is proven, update the owning SOP/skill; do not leave it only in chat or note.
9. If the HTML graph is semantically unclear, update renderer annotations/gates instead of hand-explaining in chat.
10. Locked V3 SOP pages, small-skeleton review pages, controlled-runtime review pages, and protocol/entry-boundary review pages must use generated annotated HTML, not generic Markdown-to-HTML. The required shape is: hero/meta, separated request and response diagrams, node logic cards, resource/error/side-channel section, review checklist or lock table, canonical sources, and machine-verifiable markers.
11. Main skeleton SOP HTML and controlled-runtime/protocol-boundary HTML must be generated by dedicated renderers and must match the visual/semantic review quality of small-skeleton pages such as Req04/Resp03 tool governance. `verify:architecture-wiki-html-sync` must fail if these V3 review surfaces fall back to the generic Markdown renderer.
12. Request-side small skeletons start at the client request surface when Jason asks for request lifecycle review. For SSE entries, include client SSE request, server accept, ReqInbound normalization, tool-output pair normalization, continuation owner check, Req04 restore, current-turn merge/governance, and handoff. Do not start the review at Req04 unless the requested scope is explicitly Req04-only.
13. Do not invent request-side cleanup / artifact-removal paths in review diagrams. If a removal path is not a confirmed architecture requirement, omit the node, omit the resource, and do not lock red fixtures for it.
14. Protocol conversion audits must start from a downloaded source field inventory, not coarse semantic buckets. For each protocol, record official/source schema URLs and field paths first, then map every field family to one of: canonical Chat Process semantic, protocol-specific Chat Process extension owner, edge-only transport state, or explicit unsupported/lossy audit. Runtime conversion edits may start only after the inventory, semantic matrix, unique owner, and required gate/red-fixture coverage are updated.
15. Protocol semantic field matrices need a dedicated generated HTML review surface, not a chat summary or generic Markdown table. Use `docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml` as source, render `docs/architecture/wiki/html/v3-protocol-semantic-field-matrix.html` with `npm run render:v3-protocol-semantic-field-matrix`, and keep `verify:v3-protocol-conversion-field-parity` as the HTML/YAML sync gate.
16. Protocol semantic field matrices use **OpenAI Chat itself** as the Chat Process base protocol, not a newly named parallel protocol. Every OpenAI Chat native request/response field must appear with the exact same field path, including `[]` item notation, and must be `mapped`/native rather than `extension_added`. Only semantics absent from OpenAI Chat get added top-level `request.*` / `response.*` / `edge.*` extension fields; those extension fields must be protocol-neutral, uniquely owned, associated back to source protocol fields, and red-locked against native renames, fake `chat.extensions.openai_chat` ownership, and collapsing distinct extension semantics such as `previous_response_id` into native `store`.
17. Protocol semantic field matrices must be manually semantic-first, not source-field dump-first. Primary review surface is `chat_semantic_translation_groups`: each row starts from an OpenAI Chat native field or protocol-neutral Chat extension, explains the standard Chat meaning, then groups Responses / Anthropic / Gemini fields by meaning with explicit value/shape transform rules. Many-to-one and one-to-many mappings are expected. Red-lock against collapsing tool call id/name/arguments, tool result call_id/output/name/error, image URL/file id/inline bytes/MIME, and terminal/usage semantics into one field merely because a source protocol nests them together.
17a. Protocol conversion runtime rule: Inbound normalization must preserve all source semantics as canonical or protocol-extension data and must not discard because a target lacks an equivalent. Outbound must obey the target protocol wire spec exactly. Project only exact semantic equivalents directly; if no exact equivalent exists, use an explicit compatible target mapping with red/green tests; if no compatible target slot exists, fail-fast or list the field for Jason decision before any discard. Red-lock against request cap vs response usage, request reasoning config vs response reasoning content, boolean logprob enable vs top-logprobs count, and tool-choice policy vs parallel-tool-call boolean collapses.
18. Protocol field-matrix review must also have a gated textual truth section in `docs/architecture/reviews/v3-protocol-semantic-matrix-review.md`: exact audit status legend/counts, gap categories, closeout owner/rule, and follow-up goal doc. Generic `pending_audit` is forbidden. `source_inventory_only` must stay at zero after semantic-owner closeout; new source fields first become `semantic_declared`, `edge_only`, `covered`, `partial`, or explicit unsupported/lossy with owner evidence. Labels like `extension_declared` and `semantic_declared` are audit states, not runtime completion claims. `verify:v3-protocol-conversion-field-parity` and red fixtures must fail stale counts, missing truth text, missing gap audit, source-inventory-only reintroduction, or silent relabeling.
19. `shape_branch_gap` rows in the protocol matrix require explicit `shape_branch_cases.positive[]` and `shape_branch_cases.negative[]` before runtime closeout: source condition or forbidden source, target Chat semantic, adjacent Rust codec owner file, and required Rust test symbol. Branch cases must be rendered in the HTML review surface and red-locked; do not relabel shape gaps to `covered` until those named runtime tests and owner implementation prove URL vs file id vs inline bytes vs MIME vs file URI are not collapsed.
20. Closing a `shape_branch_gap` protocol subset must bind the matrix `required_test` to the adjacent codec source and test symbol, then red-lock source-field-near-target-semantic mapping. Token presence alone is insufficient: a gate must fail if `fileData.fileUri` maps near `ChatImageUrlUrl`, `inlineData.data` maps near file data/url, or MIME maps near bytes/image URL. Keep the matrix row open until every protocol branch for that row has equivalent owner evidence.
21. One source subtree can contain multiple Chat semantics; split by meaning before runtime edits. Example: Gemini `toolConfig.functionCallingConfig.mode` maps to Chat `request.tool_choice` policy, while `allowedFunctionNames` maps to the protocol-neutral extension `request.tool_choice.allowed_function_names`; it must not collapse into tool declarations or `parallel_tool_calls`. Gate the adjacent codec helper/tests and map edge, then update counts from actual `current_impl` evidence.
22. After the protocol field matrix has been realigned to OpenAI Chat native fields plus registered protocol-neutral extensions, long-tail closeout is not one broad runtime objective, but V2-supported long-tail behavior is a required V3 inbound/outbound audit baseline. Promote one V2-backed or current-client field family at a time with adjacent Rust codec owner, red/green tests, and target-valid projection/fail-fast behavior. Leave edge-only or target-incompatible rows explicit; do not use raw payload, MetadataCenter, server/SSE/provider transport, or fallback to "support" them.

## Flow rendering contract
- Render from edges/resources only:
  - `docs/architecture/v3-mainline-call-map.yml`
  - `docs/architecture/v3-resource-operation-map.yml`
- Human graph format:
  - Node = human title + one-line responsibility + raw contract node id.
  - Edge = `step_id` + semantic action.
  - Table = raw caller/callee/source/resource evidence.
- Page shape:
  1. Large top-down Request skeleton from `v3.hub_pipeline.v1.request`.
  2. Large top-down Response skeleton from `v3.hub_pipeline.v1.response`.
  3. Mandatory Error resources graph/table.
  4. Auto audit/gap section.
  5. Manual audit lock table.
  6. Branch index.
  7. Expandable standalone branch diagrams.

## Required gates after graph/map changes
- `node --check scripts/architecture/v3-mainline-caller-flow-lib.mjs`
- `node --check scripts/architecture/verify-v3-mainline-caller-flow.mjs`
- `node --check scripts/tests/v3-mainline-caller-flow-red-fixtures.mjs`
- `npm run render:v3-mainline-caller-flow`
- `npm run verify:v3-mainline-caller-flow`
- `npm run test:v3-mainline-caller-flow-red-fixtures`
- `npm run verify:v3-architecture-docs`
- `npm run verify:architecture-wiki-html-sync`
- `node scripts/architecture/verify-architecture-wiki-browser-smoke.mjs`
- `git diff --check -- <changed files>`

## Red flags
- Request and response are merged into one confusing main graph.
- Request graph omits `ProviderReqCompat06ProviderCompat` between outbound semantic and provider wire.
- Response graph omits `ProviderRespCompat02ProviderCompat` before RespInbound.
- Error resources / provider health / provider availability are missing from the review surface.
- A graph generated from caller functions is too horizontal/tiny to audit.
- A summary in chat is used instead of the HTML review surface.
- A provider response jumps to client/server projection without Resp chain or declared Direct-only nodes.
- A fix edits handler/SSE/outbound/error projection before proving the owning contract edge.
- A provider error is “fixed” by wrapping/projecting the error instead of preventing the bad provider-bound request field.
