# Goaichat hosted 工具与调用历史的请求兼容

缺陷 `908e8aa`：Codex Responses 进入标准 Anthropic Messages 投影后，
Goaichat AI / GLM-5.3 网关在 hosted `web_search_20250305` 与已有普通
`tool_use`/`tool_result` 历史同时出现时返回 400 `invalid function name`。
首个真实请求增加 hosted `function: {name: "web_search", parameters: {}}`
后可接受。上线审计发现包含 `exec_command` 与 `write_stdin` 的完整长历史仍失败。
该原始 wire 保留全部声明与历史，并为普通工具补充同名 function envelope 后
返回 200；恢复原 wire 再次返回 400。降低输出预算仍失败，移除 hosted 声明
仅作为诊断对照。名称长度 64/65/77 与 namespace 均不是触发原因。

历史提交 `c3946aeb` 修复的是另一个 GLM Anthropic 网关的标准协议选择；
`0bbd8d27` 修复的是 OpenAI Chat 的 hosted 工具能力投影。它们仍在主链，
不等价于本次网关组合契约。原 GLM 回归内部 transport 固定返回 200，
请求没有工具历史，无法发现这次失败。禁止通过删除 hosted 工具、改名、
切换 provider 或 HTTP 200 包装错误让回归变绿。

唯一 owner 是 `provider-compat-core`，选择源是 provider authoring 的
`compatibilityProfile = "anthropic:goaichat"`。请求图复用
`../dagpipe/v3.operation_runner.request.graph.json` 的
`adjust_provider_private_request`，无需更改拓扑或通用协议编解码。

```mermaid
flowchart LR
    A[接收客户端请求] --> B[保留请求与工具历史]
    B --> C[投影标准 Anthropic 请求]
    C --> D[按显式网关契约补充 hosted 与 native envelope]
    D --> E[发送原目标 provider]
    E --> F[记录接受结果与配对工具往返]
```

该 profile 只在 `anthropic-messages` 请求 Compat 且包含确切 hosted 声明
`type=web_search_20250305,name=web_search` 时调整混合工具 envelope。保留原始
字段和已有 function 扩展；hosted 缺少 function 时补充同名 envelope 和空
parameters。普通工具缺少 function 时补充原 name、原 input_schema 对应的
parameters 及已有 description。native-only 请求不变。不修改调用 ID、参数、
历史、响应、控制状态或标准 `chat:glm` passthrough。
它不赋予客户端新工具，也不宣称网关原生搜索已经执行。

真实 provider 的 200 证明该形状被接受；搜索执行必须另有真实搜索 receipt，
文本模拟搜索或工具标记不算完成。本次验收要求普通工具的真实 consumer
执行输出及后续请求，同时保持原 hosted 声明。

必跑黑盒 `npm run test:v3-goaichat-hosted-tool-history-blackbox`：真实公开 HTTP
Responses JSON/SSE、Chat、Messages -> 外部 TCP Anthropic peer -> 客户端执行
完整 `exec_command`/`write_stdin` 配对历史 -> 客户端执行 `exec_command` 的
确定性 consumer -> 匹配输出的下一轮 -> 最终正常响应。外部 peer 对缺少
hosted 或 native envelope 的混合声明返回真实 HTTP 400。
每轮只允许一次接受的 provider 请求；重试或切换后成功仍判失败。
标准 `chat:glm` 对照要求 hosted 声明没有私有 function 字段。
该套件同时纳入 provider-compat gate 和 V3 canonical CI 的 CLI 测试列表。
真实 provider 错误的客户端隔离仍遵守项目 AGENTS 的所有入口统一禁令。
