# Chat Process 协议与流水线契约（processMode=chat）

> 目的：把“请求/响应都必须进入 chat process（且只走 chat 扩展协议）”写成可执行、可 fail-fast 的契约，并给出**命名统一**与**修改点清单**，供审阅后再落地。

## 1) 术语（统一口径）

- **Chat 扩展协议（Chat Extension Protocol）**：llmswitch-core 内部的统一载体。
  - 请求载体：`ChatEnvelope` / `StandardizedRequest`
  - 响应载体：`ChatCompletionLike`（必须是 *OpenAI-chat-like*：`choices[0].message` 存在）
- **Chat Process**：对 chat 载体执行的“必经处理段”，包括但不限于：
  - 工具治理/收割/规范化（tool governance + response tool harvesting）
  - 路由选择（VirtualRouter）
  - 兼容动作（compat actions）只能通过 Hub Pipeline 阶段触发
- **metadata**：仅允许承载**不可映射**的运行时提示/诊断信息；任何“可映射语义（mappable semantics）”严禁滞留在 metadata。

## 2) 刚性不变量（processMode=chat）

### 2.1 请求侧

在 `processMode=chat` 下，请求必须满足：

1. **inbound 必须产出 chat 扩展协议语义**（语义映射完成后才允许进入 chat process）。
2. **必须进入 chat process**（除非明确 `processMode=passthrough`）。
3. **outbound 仅使用白名单语义重建客户端协议**（clientRemap），不允许把“可映射语义”回塞到 metadata/透传到客户端。

代码事实（当前实现骨架）：
- 正常入口：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts`（`executeRequestStagePipeline` 内部）
- servertool followup 重入入口：`sharedmodule/llmswitch-core/src/servertool/engine.ts:468`（`__hubEntry = 'chat_process'`，进入 `executeChatProcessEntryPipeline`）

### 2.2 响应侧

在 `processMode=chat` 下，响应必须满足：

1. **provider → compat → inbound → 语义映射（chat 形态）**是必经步骤。
2. **进入响应侧 chat process 前，必须是 canonical chat completion**（`choices[0].message` 存在）。
3. **outbound 仅产出客户端协议白名单字段**；内部 metadata 只用于转换过程，不可泄露到客户端 payload。

代码事实（当前实现骨架）：
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts:343`（resp inbound SSE decode）
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts:401`（resp inbound semantic map → `chatResponse`）
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts:426`（servertool orchestration）
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts:464`（resp process tool governance）
- canonical chat completion 强制归一（hard gate）：`sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`（servertool orchestration 后、resp process 前）
- canonical chat completion 兜底归一（best-effort bridge）：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.ts`

## 3) “强制语义映射”规则（进入 chat process 前）

### 3.1 原则

- **同一语义在不同协议出现 → 必须映射到同一 chat 字段**（而不是塞进 metadata）。
- **chat 本身已有字段**（如 `messages/tools/toolOutputs/parameters`）→ 直接落入这些字段。
- **chat 没有但属于“跨协议可复用语义”** → 进入 `ChatSemantics` 的稳定字段（优先 `semantics.session/system/tools`，其次协议命名空间 `semantics.responses/anthropic/gemini`）。
- **仅“暂时无法映射/无语义对齐”的残余**，才允许进入 `semantics.providerExtras`（并要求逐步清空）。

### 3.2 禁入字段（fail-fast）

进入 chat process 的最后一刻，必须 fail-fast 校验：任何**可映射语义**不得存在于 metadata。

代码事实：当前请求侧在 chat_process entry 有 strict gate：
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts:1714`（`assertNoMappableSemanticsInMetadata`）
- 当前禁入键（含 snake_case 同义键）：`responsesResume`, `clientToolsRaw`, `anthropicToolNameMap`, `responsesContext`, `responseFormat`, `systemInstructions`, `toolsFieldPresent`, `extraFields`

你拍板（A1）：禁入采用“已知具体键枚举”，并持续把同义字段/旧字段补全进黑名单；不禁掉 legacy catch-all 容器本身。

> 落地要求：把 legacy `extraFields/*Context/*Format` 这种“同义字段/旧字段”逐条枚举到禁入表（而不是靠一个大范围禁掉容器）。

#### A1 协议扫描结果（第一版：哪些键属于“可映射语义”，因此应被纳入禁入枚举/或迁移出 metadata）

> 说明：这里把“可映射语义”按**来源协议**归类，并标出当前代码的落点（metadata vs semantics）。
> 目标是：最终 chat process 只读 chat 字段与 `chat.semantics`，而不是靠 metadata 透传语义。

**OpenAI Chat（openai-chat）**
- legacy `metadata.systemInstructions`：可映射 → `chat.semantics.system.textBlocks`（当前主路径不再依赖 metadata；若仍出现应视为 legacy 注入并被 fail-fast gate 拦截）。
- legacy `metadata.toolsFieldPresent`：可映射 → `chat.semantics.tools.explicitEmpty`（当前主路径不再依赖 metadata；若仍出现应视为 legacy 注入并被 fail-fast gate 拦截）。
- legacy `metadata.extraFields`：可映射 → `chat.semantics.providerExtras.openaiChat.extraFields`（当前主路径以 semantics 为准；若仍出现应视为 legacy 注入并被 fail-fast gate 拦截）。

**Gemini（gemini-chat）**
- legacy `metadata.toolsFieldPresent`：可映射 → `chat.semantics.tools.explicitEmpty`（当前主路径不再依赖 metadata；若仍出现应视为 legacy 注入并被 fail-fast gate 拦截）。

**Anthropic（anthropic-messages）**
- legacy `anthropicToolNameMap`：可映射 → `chat.semantics.tools.toolNameAliasMap`（当前主路径已写入 semantics，见 `.../anthropic-mapper.ts:176`；禁入枚举保留是为了阻止旧路径把它塞回 metadata）。

**Responses（openai-responses）**
- legacy `responsesContext` / `responseFormat`：可映射 → `chat.semantics.responses.context` / `chat.semantics.responses.responseFormat`（当前主路径已走 semantics；禁入枚举用于阻止旧路径回流到 metadata）。
- `responsesResume`（submit_tool_outputs resume）：可映射 → `chat.semantics.responses.resume`（已落地到 inbound semantic gate，见 `.../req_inbound_stage2_semantic_map/index.ts:57`）。

### 3.3 已落地的语义映射（作为基线）

（当前代码已做，符合“可映射语义不得滞留 metadata”的方向）

- `/v1/responses` tool-loop 恢复语义：
  - `responsesResume`（host side 临时注入）→ **必须**在 inbound semantic map 前提升为 `chat.semantics.responses.resume`
  - 并在需要时提升为 `chat.toolOutputs`（统一工具输出面）
  - 位置：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage2_semantic_map/index.ts:57`

- 客户端 tools raw schema：
  - `tools` 原始数组 → `chat.semantics.tools.clientToolsRaw`
  - 位置：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_inbound/req_inbound_stage2_semantic_map/index.ts:51`

- Anthropic tool alias：
  - `payload.tools` → `chat.semantics.tools.toolNameAliasMap`
  - 位置：`sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/anthropic-mapper.ts:176`

## 4) ServerTool followup 契约（你选的方案：override → canonical chat）

目标：servertool followup **不允许破坏“响应进入 chat process 必须 canonical chat completion”** 的不变量。

### 4.1 请求重入（followup request）

代码事实：目前 followup 通过设置 `__hubEntry='chat_process'` 直接从 chat_process 入口重入：
- `sharedmodule/llmswitch-core/src/servertool/engine.ts:468`

你拍板（B）：followup 重入入口仍为 `__hubEntry='chat_process'`，并明确 hop 编号：

- **H1**：第一次请求命中（例如图像 meta / web_search 关键词等）。
- **H2**：模型调用工具被截获后进入工具执行：
  - web_search：发起工具请求；
  - vision：直接路由到第二跳进行 vision 工具调用；
  - 这里发生一次路由与一次 reenter（进 chat process）。
- **H3**：第二次请求的响应回来后拦截并注入结果，再次 reenter 到 chat process 继续请求。

### 4.2 响应 override（followup response）

你拍板（C）：followup 对 provider 来说就是正常请求；响应回来后与正常响应一致：
- 成功/失败都按正常响应返回给客户端；
- 429 等错误按正常策略截获重发（reenter 处）/VirtualRouter 重试；不引入“followup 特判”的异常路径。

因此，这里所谓“响应 override”不是“在 Host/Provider 绕开响应流水线”，而是强调**响应侧统一约束**：
- 无论该响应来自 H1/H2/H3 中的哪一跳，只要进入响应侧 chat process（response tool harvesting/governance），就必须先完成 “provider→compat→inbound→semantic_map_to_chat→(必要时 canonicalize_chat_completion)” 的统一处理；
- canonicalize 失败时，按正常错误流返回（fail-fast / bubble up），而不是在 Host/Provider 做 payload 语义修补或旁路输出。

代码事实（当前实现的 canonicalize 约束点）：
- servertool orchestration 后、进入 resp process 前：hard gate（必须 canonical，否则抛错）：
  - `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- resp process 内部保留 best-effort bridge（仅作为安全网；原则上不应再依赖它）：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.ts`

## 5) StageId 命名规范（你要求的点分风格）

### 5.1 新命名（提案）

> 你要求：`chat_process.req.stage1_*`（点分）——下面给出 request/response 的对齐命名。

**请求侧（direction=request）**
- `chat_process.req.stage1.format_parse`
- `chat_process.req.stage2.semantic_map`
- `chat_process.req.stage3.context_capture`
- `chat_process.req.stage4.tool_governance`
- `chat_process.req.stage5.route_select`
- `chat_process.req.stage6.outbound.semantic_map`
- `chat_process.req.stage7.outbound.format_build`
- `chat_process.req.stage8.outbound.compat`

**响应侧（direction=response）**
- `chat_process.resp.stage1.sse_decode`
- `chat_process.resp.stage2.format_parse`
- `chat_process.resp.stage3.compat`
- `chat_process.resp.stage4.semantic_map_to_chat`
- `chat_process.resp.stage5.servertool_orchestration`
- `chat_process.resp.stage6.canonicalize_chat_completion`
- `chat_process.resp.stage7.tool_governance`
- `chat_process.resp.stage8.finalize`
- `chat_process.resp.stage9.client_remap`
- `chat_process.resp.stage10.sse_stream`

### 5.2 现有命名 → 新命名（已落地）

你补充的约束：目前只有 **chat process 相关**命名会混淆，所以只改 chat process 范围内的 stageId/keys，不扩大到全链路。

下面这些已统一改名（stageId 仅用于 stageRecorder/snapshot，不更改目录结构）：

- 请求 inbound：
  - `req_inbound_stage1_format_parse` → `chat_process.req.stage1.format_parse`
  - `req_inbound_stage2_semantic_map` → `chat_process.req.stage2.semantic_map`
  - `req_inbound_stage3_context_capture` → `chat_process.req.stage3.context_capture`
- 请求 process/outbound：
  - `req_process_stage1_tool_governance` → `chat_process.req.stage4.tool_governance`
  - `req_process_stage2_route_select` → `chat_process.req.stage5.route_select`
  - `req_outbound_stage1_semantic_map` → `chat_process.req.stage6.outbound.semantic_map`
  - `req_outbound_stage2_format_build` → `chat_process.req.stage7.outbound.format_build`
  - `req_outbound_stage3_compat` → `chat_process.req.stage8.outbound.compat`
- 响应 inbound/process/outbound：
  - `resp_inbound_stage1_sse_decode` → `chat_process.resp.stage1.sse_decode`
  - `resp_inbound_stage2_format_parse` → `chat_process.resp.stage2.format_parse`
  - `resp_inbound_stage_compat` → `chat_process.resp.stage3.compat`
  - `resp_inbound_stage3_semantic_map` → `chat_process.resp.stage4.semantic_map_to_chat`
  - `resp_process_stage0_chat_normalize` → `chat_process.resp.stage6.canonicalize_chat_completion`
  - `resp_process_stage1_tool_governance` → `chat_process.resp.stage7.tool_governance`
  - `resp_process_stage2_finalize` → `chat_process.resp.stage8.finalize`
  - `resp_outbound_stage1_client_remap` → `chat_process.resp.stage9.client_remap`
  - `resp_outbound_stage2_sse_stream` → `chat_process.resp.stage10.sse_stream`

## 6) 待你审阅确认的“修改点清单”

已拍板项（A/B/C/D/E 的决议已合入上文）之外，剩余需要你继续拍板的只有两类“落地细节”：

1. **禁入字段清单的扩展范围**：以 A1 为原则，把哪些 legacy 同义字段逐条加入黑名单（给一个首批 list 即可）。
2. **环境相关 metadata 的清扫实现策略**：你不想维护名单，所以我建议采用“内部注入字段统一使用 `__*` 前缀，并在 provider/client 边界统一剥离 `__*`”的约束；你确认是否接受这个前缀约束（否则只能回到枚举清扫）。

metadata 生命周期决议（E，需落地到清扫点）：
- protocol 相关的“可映射语义”：必须进入 chat 字段/`chat.semantics`，不得出现在 outbound 后（请求/响应都一样）。
- 环境相关的内部注入变量：到 provider 前与 client 前都必须清理掉，不允许出现在 provider request / client response。

你拍板（E1）：环境相关内部注入变量采用 `__*` 前缀约束，并在 provider/client 边界统一剥离所有 `__*`。

实现约束（落地口径）：所有内部 runtime/env 注入变量统一放入 `metadata.__rt`（`__rt` 作为唯一 runtime carrier，天然满足 `__*` 前缀规则），严禁散落为 `metadata.serverToolFollowup/webSearch/clock/...` 这类顶层键。

E1 落地点（已实现）：
- client→provider（上游请求体）：各协议 `*ProtocolClient.buildRequestBody(...)` 在返回 body 前统一执行 `__*` 剥离（同时这些 client 本身也会移除 `metadata` 字段）。
  - `src/client/openai/chat-protocol-client.ts`
  - `src/client/responses/responses-protocol-client.ts`
  - `src/client/gemini/gemini-protocol-client.ts`
  - `src/client/gemini-cli/gemini-cli-protocol-client.ts`
- server→client（JSON 响应体）：HTTP handler 在 `res.json(...)` 前统一剥离 `__*`（SSE carrier `__sse_responses` 走专用分支，不会 JSON 编码）。
  - `src/server/handlers/handler-utils.ts`

---

关联文档（现有）：
- `docs/chat-semantic-expansion-plan.md`（语义扩展分阶段计划，和本契约的 3.x 规则一致）
- `docs/V3_INBOUND_OUTBOUND_DESIGN.md`（inbound/outbound 设计背景）
