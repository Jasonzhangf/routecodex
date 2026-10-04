# Goaichat hosted 工具与调用历史的请求兼容

缺陷 `908e8aa`：Codex Responses 进入标准 Anthropic Messages 投影后，
Goaichat AI / GLM-5.3 网关在 hosted `web_search_20250305` 与已有普通
`tool_use`/`tool_result` 历史同时出现时返回 400 `invalid function name`。
同一真实请求的工具单独声明可接受；移除 hosted 声明可接受；保留全部声明与
历史并增加 `function: {name: "web_search", parameters: {}}` 可接受。
只有 `function.name` 仍失败，名称长度 64/65/77 与 namespace 均不是触发原因。

第二轮只给普通声明增加嵌套 `function`，在新的85条完整历史请求中引入回归。
两个配置网关的原始路径/查询正反向实验均为：部分声明400 → 补全普通工具
`type: "function"` 后200并生成当前声明的 `exec_command` → 恢复部分声明400。
完整私有声明同时需要类型和嵌套参数。旧150条 flat 请求后来可以200，
不能把组合风险写成每个请求都必然失败，也不能从错误文本推断网关内部实现。
第二轮已用新的 revert 合并恢复，修复在恢复后的 main 上重新验证。

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
    C --> D[按显式网关契约补充 hosted 声明]
    D --> E[发送原目标 provider]
    E --> F[记录接受结果与配对工具往返]
```

该 profile 只在 `anthropic-messages` 请求 Compat 中处理包含确切 hosted 声明
`type=web_search_20250305,name=web_search` 的工具列表。保留原始字段和已有
function 扩展；hosted 缺少 function 时补充同名 envelope 和空 parameters。
已声明的普通工具缺少 type 时补 `function`，缺少嵌套 function 时从同一声明
复制 name、input_schema、description。完整声明重复处理保持幂等。
native-only 工具列表、其他协议及标准 `chat:glm` passthrough 均不调整。
不改变当前工具数量、顺序、名称、schema、调用 ID、历史、响应或控制状态。
它不赋予客户端新工具，也不宣称网关原生搜索已经执行。

历史中的工具可能已经不在当前声明中；必须保留其调用和结果，不补充新的
可调用工具。增加历史工具声明或 functions roster 会扩大客户端能力，禁止
作为兼容方案。实际上游可能生成未声明的历史工具；flat 和完整声明均曾出现
此行为，本修复不能宣称已限制上游生成能力。

真实 provider 的 200 证明该形状被接受；搜索执行必须另有真实搜索 receipt，
文本模拟搜索或工具标记不算完成。本次验收要求普通工具的真实 consumer
执行输出及后续请求，同时保持原 hosted 声明。

必跑黑盒 `npm run test:v3-goaichat-hosted-tool-history-blackbox`：真实公开 HTTP
Responses JSON/SSE、Chat、Messages -> 外部 TCP Anthropic peer -> 客户端执行
`exec_command` 的确定性 consumer -> 匹配输出的下一轮 -> 最终正常响应。
公开入口同时携带 write_stdin 和已退役 `update_plan` 调用及配对结果，当前工具
只有 web_search、exec_command、write_stdin。外部 peer 对不完整的混合声明返回400；历史
调用、当前声明数量和完整普通声明必须同时正确，不能只断言 hosted envelope。
每轮只允许一次接受的 provider 请求；重试或切换后成功仍判失败。
标准 `chat:glm` 对照要求 hosted 声明没有私有 function 字段。
该套件同时纳入 provider-compat gate 和 V3 canonical CI 的 CLI 测试列表。
真实 provider 错误的客户端隔离仍遵守项目 AGENTS 的所有入口统一禁令。
