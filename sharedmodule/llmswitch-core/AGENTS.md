# llmswitch-core AGENT 指南

- **函数化模块**：所有模块都应拆分为可组合的纯函数，并通过单一的编排函数（orchestrator）
  组装业务流程。禁止在文件顶层堆叠长脚本式逻辑。
- **分层职责**：数据提取、事件生成、I/O 等分别放入独立函数，主流程只负责把这些函数串联
  起来，便于测试与复用。
- **转换节点约束**：conversion/in/out 只做形状映射；所有工具治理放在 `process` 节点。
- **SSE/流式实现**：保持 Responses/Chat SSE from JSON 逻辑在独立函数内，通过配置驱动行为。
- **文档同步**：若规则扩展或新增实验流程，务必更新 `docs/` 和相关 README。

## 工具治理与兼容层

- `process` 是唯一的工具治理入口：解析/配对工具调用、TOON 编解码、工具结果注入、server-tool 循环等均在此节点完成。
- conversion/in/out 严禁触碰工具语义（仅字段/形状映射）。
- 兼容层以 `filter` 节点形式存在：
  - 默认直通（passthrough）。
  - provider-aware + 协议-aware（仅在配置命中时启用）。
  - 由配置中的 `compatibility` 字段驱动，无需用户修改其他配置项。

## 流水线拓扑（解耦）

- 入站/出站的流与转换完全解耦：
  - 入站：`SSE -> JSON -> conversion v3 -> JSON -> process`
  - 出站：`process -> JSON -> conversion v3 -> JSON -> SSE`
  - SSE 是否开启与 conversion 无关；conversion 只做协议/形状映射。
- 三条接口类型按 provider.type 动态路由（仅四类）：`openai | anthropic | responses | gemini`。

## 协议转换唯一真相

- **请求链路**：入口端点（`/v1/chat|responses|messages`）唯一决定 inbound converter（protocol→Chat）、同时记录入口协议与 streaming 意图；Virtual Router 选定的 providerType/providerProtocol 决定 outbound converter（Chat→provider 协议）。
- **响应链路**：providerType/providerProtocol 决定 inbound response converter（provider 协议→Chat）；原入口端点（含“当初是否为 SSE”）决定 outbound response converter（Chat→入口协议，并决定 JSON/SSE 形态）。
- **SSE 规则**：入站若为 SSE，一律由 `SSEInputNode` 聚合为 JSON 再进入 conversion；出站是否发 SSE 仅取决于入口请求的 streaming 标记（Responses 例外：固定 JSON in/SSE out）。任何节点不得绕过这一判定去硬编码 SSE 行为。

| 入口端点 | 请求链（入口→provider） | 响应链（provider→客户端） | SSE 行为来源 |
| --- | --- | --- | --- |
| `/v1/chat/completions` | `SSEInput` (opt) → `ChatInput` → `ChatProcess`/VR → outbound node 取决于 providerType：openai→`OpenAIOutput`，responses→`ResponsesOutput`，anthropic→`AnthropicOutput`，gemini→`GeminiOutput` | providerType→对应 response-input（含 Gemini）→`ResponseProcess`→`OpenAIOutput`→`SSEOutput`（按客户端是否 stream） | 入站 SSE：客户端；provider 是否 SSE：看我们 outbound `stream`；出站 SSE：客端原始 `stream` |
| `/v1/responses` | `SSEInput` (opt) → `ResponsesInput` → `ChatProcess`/VR → outbound node by providerType | providerType→对应 response-input→`ResponseProcess`→`ResponsesOutput`→`SSEOutput`（Responses 线路固定 SSE，因为对 provider 请求我们配置 `stream=true`） | 入站 SSE：客户端；provider 是否 SSE：我们 outbound `stream=true`；出站 SSE：协议特例固定 |
| `/v1/messages` | `SSEInput` (opt) → `AnthropicInput` → `ChatProcess`/VR → outbound node by providerType（openai→OpenAIOutput，anthropic→AnthropicOutput，responses→ResponsesOutput，gemini→GeminiOutput） | providerType→对应 response-input→`ResponseProcess`→**`AnthropicOutput`**→`SSEOutput`（按客户端 `stream`） | 入站 SSE：客户端；provider 是否 SSE：看 outbound `stream`（当前 GLM/LMStudio 仍发 `false`）；出站 SSE：入口 `/v1/messages` 的 streaming 标记 |

## 配置驱动

- 使用 JSON Schema 定义配置（内部提供），通过 `setConfig/getConfig` 读写；
- 按流水线（pipeline）选择节点清单：输入(in)/处理(process)/输出(out)；
- 兼容层仅当 profile、direction、providerMatch 同时命中时生效。

## 快照与验证

- 每个节点输出可选快照，`verbose` 供开发调试，`release` 默认关闭落盘；
- 快照内容禁止引入循环引用（`Error` 对象需收敛为 `{ name, message, stack }`）。
- 自检/健康检查应覆盖模块动态加载可用性，而非仅进程存活。

## 代码风格

- 模块内部尽量保持「函数 + 编排」的组织方式；超大文件应拆分为纯函数并由 orchestrator 组装；
- 注释仅在复杂逻辑前提供简短上下文，避免冗余注释；
- 默认 ASCII，除非文件已使用 Unicode 且场景需要。

## BD 执行顺序（默认）

- 任务默认按 **优先级排序** 执行；同优先级按 **创建/排列顺序** 依次推进。
- 不反复询问“做哪个”；按规则自动继续并在 BD 中记录进展与证据。
