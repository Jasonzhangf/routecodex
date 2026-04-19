# Protocol Compatibility Matrix（Chat Process 真源版）

## 索引概要
- L1-L8 `purpose`：定义当前协议兼容矩阵与验收口径。
- L10-L26 `legend`：兼容等级定义与边界。
- L28-L47 `chat-ssot`：chat process 字段落盘真源。
- L49-L88 `responses-outbound`：Responses 到其他协议的请求侧映射矩阵。
- L90-L129 `to-responses`：其他协议到 Responses 的请求/响应侧映射矩阵。
- L106-L114 `response-path`：provider response → client protocol 的兼容结论。
- L116-L137 `known-gaps`：当前确认缺口、非目标与真实样本覆盖边界。

## 目标

按 Jason 当前要求，把“Responses ↔ 其他协议”的兼容性结论、chat process 字段真源、以及 `full/lossy/dropped/unsupported/internal-only` 口径统一到一个文档中。

本文件是**矩阵真源**；具体流水线契约见：
- `docs/CHAT_PROCESS_PROTOCOL_AND_PIPELINE.md`
- `docs/chat-process-continuation-state-contract.md`

## 兼容等级定义

- `full`
  - 能进入 chat canonical，并能从 chat canonical 恢复目标协议字段，语义等价。
- `lossy`
  - 可以映射，但目标协议缺少完全等价表达；必须写入 `semantics.audit.protocolMapping`。
- `dropped`
  - chat canonical 可识别，但目标协议无承载位；字段显式丢弃并记录 audit。
- `unsupported`
  - 当前链路明确不支持该语义；不得伪装为 preserved。
- `internal-only`
  - 当前仅用于 provider/internal protocol，不是完整 public client contract。

## Chat Process 字段落盘真源

| 语义 | chat canonical 真源 | 说明 |
|---|---|---|
| continuation / tool loop / previous_response_id | `semantics.continuation` | 跨协议 continuation 唯一真源 |
| 协议映射 audit | `semantics.audit.protocolMapping` | preserved/lossy/dropped/unsupported 统一真源 |
| 客户端原始 tool schema | `semantics.tools.clientToolsRaw` | client-facing tool 名称恢复、args schema 归一 |
| Anthropic tool alias | `semantics.tools.toolNameAliasMap` + `semantics.anthropic.toolNameAliasMap` | 用于 `Bash/Glob/...` ↔ canonical tool name 恢复 |
| 显式空 tools | `semantics.tools.explicitEmpty` | 不能留在 metadata |
| Responses context / resume | `semantics.responses.context` / `semantics.responses.resume` | submit_tool_outputs / previous_response_id / include/store 等恢复基座 |
| Anthropic system blocks | `semantics.system.blocks` + `semantics.anthropic.systemBlocks` | system block 既保留跨协议公共层，也保留协议命名空间 |
| Anthropic content shape / provider metadata | `semantics.anthropic.messageContentShape` / `semantics.anthropic.providerMetadata` | 替代旧 `providerExtras.anthropicMirror/providerMetadata` |
| Gemini systemInstruction / generationConfig / toolConfig / safetySettings / providerMetadata | `semantics.gemini.*` | Gemini 命名空间真源 |

> 规则：可映射语义必须进入 `messages/tools/toolOutputs/parameters/semantics`；不得继续滞留 metadata。

## Responses → 其他协议（请求侧）

### 总结
- `Responses -> Chat canonical`：主链最完整，作为统一语义入口。
- `Responses -> Anthropic`：不是完全兼容；存在明确 `lossy/dropped/unsupported`。
- `Responses -> Gemini`：不是完全兼容；且 Gemini 当前主要是 provider/internal protocol。

### 字段矩阵

| 字段/能力 | Responses -> Chat canonical | Chat canonical -> Anthropic | Chat canonical -> Gemini | 说明 |
|---|---|---|---|---|
| input/messages | `full` | `full` | `full` | 主消息面可稳定映射 |
| system / instructions | `full` | `full` | `full` | Responses `instructions` 先入 canonical system，再分别重建 |
| tools schema | `full` | `full` | `full` | 原始 schema 需同时落盘到 `semantics.tools.clientToolsRaw` |
| tool_choice | `full` | `full` | `full` | Anthropic 顶层保留；Gemini 通过 metadata passthrough 保留 |
| parallel_tool_calls | `full` | `dropped` | `dropped` | 目标协议无完全等价表达，必须 audit |
| include | `full` | `dropped` | `dropped` | Responses 专属恢复语义 |
| store | `full` | `dropped` | `dropped` | Responses 专属持久化语义 |
| prompt_cache_key | `full` | `dropped` | `dropped` | 目标协议无等价字段 |
| response_format / structured output | `full` | `unsupported` | `unsupported` | 当前 Anthropic/Gemini 路径不承诺等价 structured output |
| reasoning | `full` | `lossy` | `lossy` | Anthropic 映射到 `thinking/output_config`；Gemini 映射到 `generationConfig.thinkingConfig` |
| previous_response_id / submit_tool_outputs continuity | `full` | `lossy` | `lossy` | 统一由 `semantics.continuation` / `semantics.responses.resume` 承接 |
| required_action / tool outputs | `full` | `lossy` | `lossy` | 目标协议表面不同，但统一语义可恢复到 chat process |
| stream | `full` | `full` | `full` | 传输层支持，但事件表面仍随协议不同 |

## 其他协议 → Responses（请求侧 / 语义侧）

### OpenAI Chat -> Responses

| 字段/能力 | OpenAI Chat -> Chat canonical | Chat canonical -> Responses | 说明 |
|---|---|---|---|
| messages/system/tools/tool calls | `full` | `full` | Responses bridge 最成熟的兼容方向之一 |
| structured output (`response_format`) | `full` | `full` | Responses 原生支持 |
| continuation | `session/lossy` | `lossy` | OpenAI Chat 自身没有 Responses 原生 response-chain；统一由 `semantics.continuation` 补位 |
| reasoning | `full` | `full` | 可还原为 Responses `reasoning` |

### Anthropic -> Responses

| 字段/能力 | Anthropic -> Chat canonical | Chat canonical -> Responses | 说明 |
|---|---|---|---|
| messages/system blocks | `full` | `full` | system block 进入 `semantics.system.blocks` + `semantics.anthropic.systemBlocks` |
| tool schema | `full` | `full` | 需保留 raw client tools + alias map |
| tool alias fidelity (`Bash/Glob/...`) | `full` | `lossy -> target fix path` | canonical 工具名会归一；客户端恢复依赖 `toolNameAliasMap/clientToolsRaw` |
| provider metadata | `full` | `lossy` | 仅保留与协议重建相关的稳定字段 |
| thinking / reasoning | `lossy` | `lossy` | Anthropics 的 thinking 与 Responses reasoning 不完全同构 |
| continuation | `lossy` | `lossy` | Anthropic 无 Responses 原生 response-chain；靠统一 continuation 语义承接 |

### Gemini -> Responses

| 字段/能力 | Gemini -> Chat canonical | Chat canonical -> Responses | 说明 |
|---|---|---|---|
| contents/systemInstruction/tools | `full` | `full` | Gemini inbound/outbound 主要依赖 `semantics.gemini.*` |
| generationConfig/toolConfig | `full` | `lossy` | 部分字段可转入 Responses parameters，部分仅留 audit/命名空间 |
| safetySettings | `full` | `dropped` | Responses 无等价安全设置字段 |
| reasoning/thinking | `lossy` | `lossy` | 可转换，但并非一一对应 |
| Gemini client protocol | `internal-only` | `internal-only` | 当前仓内是 provider/internal protocol，不是完整 public client surface |

## Response Path（provider response -> client protocol）

| 方向 | 结论 | 说明 |
|---|---|---|
| provider -> Chat canonical | `full` | 响应进入 chat process 前必须先 canonicalize 为 chat completion |
| Chat canonical -> OpenAI Chat client | `full` | 默认 client protocol 之一 |
| Chat canonical -> Responses client | `full` | 支持 response object / required_action / usage / continuation 恢复 |
| Chat canonical -> Anthropic client | `full with alias-semantics dependency` | 需要 `semantics.tools.toolNameAliasMap` / `clientToolsRaw` / `semantics.anthropic.*` 参与恢复 |
| Chat canonical -> Gemini client | `internal-only` | 当前未作为 public client protocol 暴露 |

## 当前确认缺口 / 非目标

### 真实兼容缺口（需要修）
1. **Anthropic tool alias fidelity**
   - 必须依赖 chat semantics 落盘后的 alias map / raw tools 才能恢复原始 `Bash/Glob/...`。
   - 若 alias map 丢失，只能回退到 canonical tool name，属于真实兼容缺口，不得伪装为 full。

### 设计性非完全兼容（必须 audit，不算 bug）
1. `Responses -> Anthropic/Gemini` 的 `parallel_tool_calls/include/store/prompt_cache_key`。
2. `Responses -> Anthropic/Gemini` 的 `response_format`。
3. `Responses <-> Anthropic/Gemini` 的 reasoning/thinking 双向映射。
4. Gemini 作为 public client protocol 暂未开放。

### 真实样本覆盖边界（当前仅覆盖三大主协议）
1. `openai-chat`
   - 已有真实样本 request/response 双向 compare。
2. `openai-responses`
   - 已有真实样本 request replay compare。
   - 已有真实样本 response replay compare（经 Anthropic provider upstream 回放后再回到 Responses client payload）。
3. `anthropic-messages`
   - 已有真实样本 provider-side request/response compare 证据。
   - 目前仓内没有独立的 anthropic client-entry 真实样本目录，不能把它当成已覆盖的 client-entry 证据。

## 实施要求

1. 任何新字段先对齐本矩阵，再决定落入：
   - `messages/tools/toolOutputs/parameters`
   - `semantics.continuation`
   - `semantics.audit.protocolMapping`
   - 协议命名空间 `semantics.responses/anthropic/gemini`
2. 如果目标协议无法等价承载，必须显式写 audit。
3. 不允许再把可映射语义塞回 metadata。
