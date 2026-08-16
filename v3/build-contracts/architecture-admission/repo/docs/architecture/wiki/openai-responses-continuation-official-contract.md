# OpenAI Responses Continuation Official Contract

## Purpose

这页只记录两个真源：

1. OpenAI 官方 `/v1/responses` continuation / conversation-state 契约
2. 我们从官方契约推导出的 RouteCodex 约束

它不是第二份实现设计文档。它的作用是防止我们继续从当前错误行为反推正确架构。

Official sources:

- `https://platform.openai.com/docs/guides/conversation-state`
- `https://platform.openai.com/docs/guides/reasoning`
- `https://platform.openai.com/docs/api-reference/responses/create`

Direct reference sample:

- `~/.rcc/codex-samples/openai-responses/port-52525/req_1782141103548_1973d9d4/provider-request.json`

## Official Rules

### 1. `previous_response_id` is an explicit continuation anchor

官方 continuation 不是“同 session 自动续接”，而是显式请求字段续接。

合法 continuation 证据来自请求本身，例如：

- `previous_response_id`
- tool-call 续接时显式提交的新增 items
- API 自身规定的 continuation entry

没有这些显式证据，不能因为同 session / 同 scope / 同 conversation 就自动恢复。

### 2. If you manage conversation state yourself, the next request must carry explicit incremental items

官方 `conversation-state` 明确区分两种模式：

- provider-owned state：通过 `previous_response_id` 续接
- client-managed/manual state：下一轮请求必须显式带入要继续使用的历史/增量 items

这意味着“响应回来以后本地猜测下轮上下文”不是标准做法。
如果不是依赖 provider 远端 state，那么当前轮新增语义必须在下一轮请求里显式表达。

### 3. Tool continuation is request-visible, not implicit response memory

官方 reasoning / tool-calling 续接要求：

- 模型发出 `function_call`
- 客户端/调用方执行工具
- 下一轮请求显式带回 `function_call_output`
- `function_call_output` 通过 `call_id` 与之前的 `function_call` 配对

也就是说，工具结果不是“响应端存一下，恢复时自己猜回去”。
它必须作为下一轮请求的一部分显式进入模型可见输入。

### 4. `store=false` removes remote continuation rights

如果请求不依赖远端保存状态，那么不能把响应当成“隐式下一轮上下文真源”。
此时 continuation 所需历史只能由调用方显式带回请求，或者由本地唯一 owner 在请求前 materialize 成标准请求。

结论：

- `store=false` 不能因为本地有历史就自动 remote resume
- `store=false` 也不能在 response side 猜测并补造 request truth

## Direct Sample Evidence

Direct 样本 `req_1782141103548_1973d9d4/provider-request.json` 给了当前最直接的官方行为参照：

- request body `tools` 含 `exec_command`
- `input` 长度为 7
- `input` 中显式包含：
  - user message
  - `function_call`
  - `function_call_output`
  - 下一轮 user message
  - 新一轮 `function_call`
  - 新一轮 `function_call_output`
  - `continue`

这说明 direct 正确行为是：

- 下一轮 provider request 自己就带着显式增量
- 工具调用链作为 request items 可见存在
- 不是依赖“响应已经被远端记住，所以本地不用处理”

## RouteCodex Derived Contract

基于官方契约，RouteCodex 必须满足：

### A. continuation owner must decide before request enters governed processing

唯一 owner 必须在请求侧完成：

- 当前请求是否具备 continuation 证据
- 这是 `direct` 还是 `relay`
- 该轮是否要 remote resume 还是 local materialize

hook / stopless / tool governance 不能重新判 continuation owner。

### B. restore happens on request truth, not on response guess

如果要恢复 continuation：

1. 先恢复 canonical current-turn request truth
2. 再跑 request-side tool restore / hook rewrite
3. 再进入 stopless / tool governance

禁止：

- response side 猜下轮 request truth
- handler/bridge 在 response side 临时拼装一个新的 `responsesRequestContext`
- 用 stale saved shell shape 覆盖当前轮真实请求形状

### C. save must persist finalized canonical truth

response side 如果发生了：

- tool projection
- hook-side response rewrite
- stopless schema feedback injection
- terminal/non-terminal 改写

那么 continuation owner 保存的必须是这些动作完成后的 canonical truth，而不是 pre-hook shell shape。

否则下一轮 restore 会丢掉这些 modification context。

### D. stopless is not a continuation owner

stopless 只是普通工具/stop 语义的一种治理场景。
它必须遵守与其他工具相同的 request/response paired rewrite contract。

禁止：

- stopless 自己决定 continuation 恢复权
- stopless 在 continuation store 外另存一份 session truth
- stopless 把 response-side shell projection 当成 continuation owner

## Audit Checklist

- 当前实现是否仍把同 session / same scope 当 continuation 恢复权。
- 当前实现是否在 response side 猜/补 request truth。
- 当前实现是否把 `function_call_output` 当作隐式响应记忆，而不是下一轮 request item。
- `store=false` 时是否仍会自动 remote resume 或 response-side fallback。
- direct 与 relay 是否都以请求显式增量或显式 remote anchor 为 continuation 真源。
