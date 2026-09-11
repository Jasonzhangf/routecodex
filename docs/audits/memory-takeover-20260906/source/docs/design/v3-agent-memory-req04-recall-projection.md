# V3 Agent Memory Req04 Recall Projection

状态：`source_controlled_pending_short_sample_and_live_matrix`

## Owner 与边界

`routecodex-v3-agent-memory` 是 memory 业务唯一真源。它把一个 typed
`MemoryRecallSnapshotV1` 渲染成 deterministic、bounded 的业务文本；文本只包含
记忆条目的标题、摘要、tags 和 entities。它同时提供固定的 schema guidance，要求模型可选
地输出顶层 `memory.entries[]`；缺失或坏 schema 仍由 Host soft-admission，不拒绝 parent。

`routecodex-v3-runtime` 的 Req04 owner 只做协议形状挂载：在现有 stopless、web-search
和 tool-thinking 准备完成后、policy/wire 之前调用一次 projection。Runtime 不读取
generation、content hash、entry id、request id、provider、route、retry、health 或
MetadataCenter，也不从 payload/debug snapshot 反推 memory。

Provider wire、SSE、route policy、retry、health 和 Resp03 不拥有 Req04 memory
业务。Req04 由统一 startup hook plan 调度，Direct 与 Relay 都经过同一个固定
skeleton；Runtime 只挂载 Skill projection，不拥有 memory 业务。操作被禁用时是
exact no-op；production 缺少 startup plan 时 fail-closed；request path 不编译 plan。

## Provider-visible placement

生产位置固定为 current-turn tail：

```text
[stable system/instructions]
[static tools]
[history]
[current user input]
[RouteCodex Memory Schema Guidance v1]
[RouteCodex Memory Recall v1]  <-- one appended user message
```

Responses array input 使用 `type=message`, `role=user`, `content=[{type=input_text,
text=...}]`；Chat array 使用同语义的 `role=user` message。Responses 的 scalar `input`
会被提升为 canonical message array 后再追加；没有 input 的 fresh request 创建只含
recall 的 array。已经存在 recall marker 时视为幂等 no-op。

这个位置满足 memory cache 不变量：system/tools 稳定前缀不变，frozen snapshot
只在 session 创建或成功 compaction 边界改变，普通 recall 仅追加 request tail。它也
保持 routing facts 在 Req04 注入前计算，因此 memory 不改变 route/provider selection。

## Bounds 与 deterministic projection

- 默认最多 16 个条目、最多 8192 Unicode scalar values；超过上限按 snapshot 顺序截断，
  不生成控制字段，也不进行无界 payload 扩张。
- 无条目或全部条目在 bounded projection 中被排除时不注入。
- memory enabled 但无 committed 条目时仍注入 schema guidance；disabled/no runtime 时保持
  provider-bound semantic no-op。
- 每个条目按固定字段顺序输出；tags/entities 已由 Core trim、dedupe、sort。
- marker 是固定业务文本，不携带 generation/hash/source/request id。
- projection 失败只产生 Req04 diagnostic 并继续 parent；不 retry、不重选、不改变
  provider health。只有 payload 形状本身在既有 Req04 owner 不可挂载时才返回显式内部
 错误；该行为先由红测锁定，再决定是否扩展协议形状。

## Test matrix

先用真实 request-record 中已经确认的 stop-only 元数据锁定样本身份：

| 样本 | request id | input tokens | finish/status | 当前证据 |
| --- | --- | ---: | --- | --- |
| short | `openai-responses-router-gpt-5.5-20260903T082306934-36419-1781` | 81,299 | `completed` / `stop` / provider 200 | request record；payload sample 已 rotation，暂不能 replay |
| long | `openai-responses-router-gpt-5.5-20260903T081851856-36354-1716` | 263,884 | `completed` / `stop` / provider 200 | request record；payload sample 已 rotation，暂不能 replay |

当前 `.rcc/codex-samples` 实时目录没有完整的 `completed/stop` 四件套。此前记录的
208,223-token 路径已轮换，不再存在；不得把失效路径当作 fixture，也不得从 metadata
伪造 payload。

归档目录中还保留两份完整的 `request.json`、`provider-request.json`、
`provider-response.json`、`response.json` 四件套。它们都是大 payload，不能标成用户要求的
短样本，但可作为长/中长 terminal 与 provider/client 保真基线：

| archive fixture | input tokens | output tokens | status/finish | provider status | request items/tools |
| --- | ---: | ---: | --- | ---: | --- |
| `/Volumes/extension/.rcc/archive/codex-samples-before-deepseek-400-lock-20260825T134304Z/codex-samples/openai-responses/ports/7777/openai-responses-router-gpt-5.5-20260825T063120690-956709-5249/` | 245,076 | 1,165 | `completed` / `stop` | 200 | 246 / 未记录 |
| `/Volumes/extension/.rcc/archive/codex-samples-before-deepseek-400-lock-20260825T134304Z/codex-samples/openai-responses/ports/7777/openai-responses-router-gpt-5.5-20260825T063929962-956801-5341/` | 212,898 | 1,928 | `completed` / `stop` | 200 | 217 / 14 |

两份归档响应的 provider raw artifact 是 SSE（分别约 235,549 与 394,223 字节），客户端
响应均保留 `response.completed`/`status=completed` 终态。它们可以进入长样本矩阵，但不能替代
缺失的 81k 短样本四件套。

恢复到 canonical four-part artifacts（client request、final provider request、raw
provider response、client response）后，才允许同入口 replay。恢复不到时只能报告
terminal metadata，不能伪造 fixture 或宣称真实 replay。

对每个样本做 A/B/C 位置观察：

- A：stable system/instructions 之后；
- B：frozen snapshot 区域；
- C：current-turn tail（生产候选）。

记录 provider-bound bytes、semantic diff、stable system/tools prefix hash、字符/Token
增量、context ratio、schema adherence、canonical finish reason/status。短样本先通过：

1. empty recall 的 provider-bound semantic identity 不变；
2. 非空 recall 只追加一个允许的 current-turn message；
3. stable prefix hash 不变；
4. control 字段不出现在 provider payload；
5. duplicate prepare 不双注入；
6. route facts/selected target 不变；
7. oversized recall 有界。

短样本通过后再跑长样本。Resp03 只在 canonical terminal 观察 memory：buffered JSON
要求 `completed + finish_reason=stop`，native Responses SSE 使用 typed
`response.completed + response.status=completed`；EOF、`[DONE]`、debug snapshot 或
HTTP 200 单独不能触发观察。
