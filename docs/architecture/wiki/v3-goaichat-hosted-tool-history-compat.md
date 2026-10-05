# Goaichat hosted 工具与调用历史的请求兼容

缺陷 `908e8aa` 必须分别验证 provider 请求接受与客户端错误隔离。
切换成功或最终客户端 200 不能证明首个 provider 请求形状兼容。
所有模型入口的错误隔离合同由项目 AGENTS.md 唯一维护。

2026-10-04 的请求 `743898-45622` 包含380个工具、115条 Anthropic 历史，
历史中的67次调用均为已声明的 `exec_command`。没有重复名称、非法名称字符
或为普通工具添加的 type/function。原始 provider-bound 请求在两把配置 key
上均返回400 `invalid function name`。只删除 Compat 给原生 hosted
`web_search_20250305` 添加的 `function` 字段，保留全部工具、历史、名称与
schema 后，两把 key 均返回200与真实 `exec_command` 调用；恢复原样均再400。

该额外 envelope 来自此前的 Goaichat Compat 修复。早期14条历史样本曾在
标准 hosted 声明上400，添加 envelope 后200；但该早期标准原样请求在本轮
两把 key 的六次回放均200。历史诊断不能证明网关永远需要这个私有字段。
本次删除代理自行添加的混合协议形状，恢复标准 Anthropic 声明。
客户端已提供的扩展字段保持原样，不能用过滤未知字段替代此修复。

唯一 owner 是 `provider-compat-core` 的 request Compat。复用
`../dagpipe/v3.operation_runner.request.graph.json` 中
`adjust_provider_private_request`，不更改拓扑、通用编解码或错误恢复。
`anthropic:goaichat` 的私有变换只处理已复现的网关表示限制。
原生 hosted 声明继续保持标准形状。

```mermaid
flowchart LR
    A[接收客户端请求] --> B[保留全部工具与配对历史]
    B --> C[标准 Anthropic 投影]
    C --> D[Compat 保留原生 hosted 声明]
    D --> E[发送原目标 provider]
    E --> F[验证首次接受与真实工具往返]
```

普通 Anthropic 工具不得由 Compat 添加 OpenAI type/function。
原生 hosted 声明也不得由 Compat 添加 function。工具名称、参数、call ID、
schema、历史和配对结果完整保留。已退役的历史工具不得重新加入当前工具集合。
客户端工具身份不得改变；私有 wire 别名必须可逆。不删除 hosted 工具、
不排序工具来规避错误、不添加新 fallback。

## 2026-10-05：Goaichat 私有长名称表示

GitHub PR #341（`7eee82d2`）修复 OpenAI Chat 的长 namespace 工具名，
PR #343（`eb77dc9b`）补充普通 function/custom 名称的碰撞保护。
两项修复仍在 main。Anthropic `/v1/messages` 未接入该私有长度表示。
这与上述 hosted function envelope 缺陷有不同的因果证据。

4444 请求 `062420249-767310-11196` 的第二次 attempt 包含380个工具、
117条消息与66次历史调用。原始 Goaichat `glm-5.3` 请求返回400
`invalid function name`。只将24个超过64字符的声明名称映射为唯一的
64字符名称，保留其他 body、历史、headers、key、模型，返回200和
`message_stop`，没有 SSE error。简化工具探针曾成功，不能替代这个
完整失败样本的因果对照。该对照只证明本次名称限制，不证明所有400均已修复。

修复边界是显式 `anthropic:goaichat` Provider Compat。复用已有名称分配器，
预留普通工具名，同步声明、历史 `tool_use.name` 与强制 `tool_choice.name`。
反向映射属于 typed attempt context。它不能进入 payload、metadata 或日志，
也不能跨 candidate 复用。JSON 与完整缓冲 SSE 均先还原标准 Anthropic
工具名，再由原有协议投影恢复客户端 function/custom/namespace 身份。
同协议 Messages 入口同样必须还原。其他 Anthropic profile
继续保留原始名称，不把 Goaichat 的64字符限制升级成通用协议限制。

必跑黑盒 `npm run test:v3-goaichat-hosted-tool-history-blackbox`：
公开 Responses JSON/SSE、Chat、Messages -> 外部 TCP Anthropic peer ->
客户端实际执行 `exec_command` 的确定性 consumer -> 匹配输出的下一轮 ->
正常响应。外部 peer 对本次已证实的额外 hosted 空 parameters function 与普通工具
type/function 形状返回400，而非无条件200。每轮只允许一次接受的 provider
请求。用例保留380个工具、长名称、write_stdin 与已退役 update_plan 的配对
历史。标准 `chat:glm` 对照同样保留原生 hosted 声明。

`npm --prefix v3 run test:v3-goaichat-long-tool-names` 通过公开 HTTP 验证
64/65字符边界、普通 function 与 custom 的 hash 别名碰撞、JSON/SSE
原 dispatch 身份与匹配回传。测试不复制名称分配器或 SHA256 实现。
标准 Anthropic 名称 owner 同步点号 MCP 声明的强制选择和历史；
标准 Chat outbound 由声明恢复完整名称，避免丢失 canonical namespace。

真实 provider 验收须覆盖新115条历史与早期14条历史样本，断言首个 provider
200、无失败 attempt、无切换，并验证真实 consumer 输出与匹配 follow-up。
一次 provider 200 只证明该请求被接受；原生搜索执行仍须独立搜索 receipt。
本次对照不证明所有网关后台或所有其他400原因已经解决。
