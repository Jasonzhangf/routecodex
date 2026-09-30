# Node02 接线前黑盒样本索引（2026-09-29）

本索引只记录本机 `~/.rcc/codex-samples` 中已保存的 4444 样本及可由文件直接证明的事实，不复制请求正文或工具参数。样本形成时的运行 binary 哈希未保存在这些记录中；因此它们是历史形状和回合配对基线，不能单独证明当前安装版本，也不能替代接线前后同入口重放。

2026-09-29 后续核对：下文 04:45、04:46 的三个样本目录已不在 sample store；08:54 样本在本轮读取并核对哈希后也被轮转清理。以下哈希和观察结果是读取时的记录，所有这些目录当前均不可据此执行原样重放。接线验收必须重新采集并绑定运行 binary。

## 本轮读取过的 Responses gpt-5.5 形状（目录随后被清理）

- 目录：`openai-responses/ports/4444/openai-responses-router-gpt-5.5-20260929T085401146-550990-13446/`。
- `request.json` SHA-256：`efd460ba85de818eba213f7bda140fe7485c7f7117ae093f0aa7e30b7facf206`；顶层 14 项工具同时包含 `function`、`custom`、`namespace`、`tool_search`、`web_search`。历史 `input` 同时含 `function_call`/`function_call_output`、`custom_tool_call`/`custom_tool_call_output` 与 `tool_search_call`/`tool_search_output`。
- `response.json` SHA-256：`1b92ab95655724520ecbf082f435c3a94aa05d6bec6d234e37368fd9e1b95da6`。读取时只确认了已保存响应与请求形状；尚未逐项证明本次工具调用、完整参数、客户端执行回执和 follow-up，不能算工具往返验收。

## Responses gpt-5.5 工具回合

- 首轮目录：`openai-responses/ports/4444/openai-responses-router-gpt-5.5-20260929T044517736-544158-6614/`。
- `request.json` SHA-256：`9b1d6f91b39229e865bf932539e88a58aefa7930f96c3183027ad5b8ae06ae6f`。客户端声明 14 项工具，包括 `function`、`custom`、`namespace`、`tool_search`、`web_search`；`apply_patch` 是 `custom`，`mcp__cua_repl` 是 `namespace`。
- `provider-request.json` 有一个 attempt；provider `xmcc2` 收到 14 项 `function` 工具。此事实只证明该 attempt 的投影形状，不能凭名称推断其他请求或模型的规则。
- `response.json` SHA-256：`c63fd5d030689ff75a09b7d4d6f7212823c080b03a3f245c161f8f245920013e`。客户端边界为 HTTP 200/SSE，materialized status `requires_action`，输出含 `function_call`，名称 `exec_command`，`call_id=call_ecb6d74c57d743768992af10`。
- 后续请求目录：`openai-responses/ports/4444/openai-responses-router-gpt-5.5-20260929T044551214-544177-6633/`；`request.json` SHA-256：`6ed249f9d0f483f53e9a5bddd3acfc0e172d6b68f7b0204bb89007bfebff623d`。同一 `call_id` 同时出现在历史 `function_call` 与 `function_call_output` 中，输出字段为字符串；该请求也保存了 HTTP 200 的 `response.json`。这证明样本中存在配对与 follow-up，尚未证明工具命令实际执行成功或参数未截断；须检查执行回执及完整参数。

## Responses gpt-5.6-luna 形状缺口

- 目录：`openai-responses/ports/4444/openai-responses-router-gpt-5.6-luna-20260929T044652542-544198-6654/`。
- `request.json` SHA-256：`68a615f3c29b657c9e412063fa7e8ba9d9b9cd3fedfbf3d93f180600d437ff62`。顶层 `tools` 数量为 0；`input` 中有一个 `additional_tools` 项，内部 `tools` 也为空。目录仅有 `request.json`，没有 provider request、provider response 或 client response；**不能作为 gpt-5.6 工具往返基线**。
- 接线验收须以实际 gpt-5.6-luna 请求声明的动态工具列表新建同入口成功和失败样本，并核对 Provider 声明、调用/输出、follow-up 与逆向映射。不得用 gpt-5.5 的 shape 填补该缺口。

## 其他协议与证据界限

- 当前 Codex sample store 只有 `openai-chat-completions` 与 `openai-responses` 两个顶层目录。Anthropic/Gemini 的真实入口黑盒样本需另采集或从项目声明的其他证据源定位；不能用 Responses 结果代替。
- 现有 server harness 可复用的公开边界用例在 `v3/crates/routecodex-v3-server/tests/multi_listener_server.rs`：`openai_chat_http_entry_completes_responses_tool_round_trip`、`p6_responses_endpoint_uses_runtime_provider_path_and_projects_json`、`responses_inbound_websocket_projects_json_completed_event_and_enters_runtime`、`responses_direct_last_default_projects_after_provider_failure`。这些是测试入口，仍须核对其 fixture 是否覆盖本节点的未知字段、null、原始工具形状和四协议映射。
- Node02 新实现接线前后应在相同真实入口和 mode，用相同客户端 JSON 对比原请求、canonical Value、typed inverse refs、provider-bound request、原始 provider result、客户端响应、工具执行回执和 follow-up；明确记录运行 binary/候选 SHA、session/request ID 与 terminal release。单个 HTTP 200 或 `requires_action` 不等于工具可用。

## 2026-09-29 GCM 只读工具执行基线

- 从本 worktree 新建 `codex exec --profile gcm --sandbox read-only -m gpt-5.5` 会话 `01a0efb7-737e-7233-88b7-60dfb0d2d990`。CLI 显示实际 `exec_command` 执行 `/bin/zsh -lc pwd`，退出成功，输出本 worktree 绝对路径；worker 最终答复 `tool_called=yes`。
- 同样新建 `-m gpt-5.6-luna` 会话 `01a0efb9-6e59-73c3-9967-3ccff5dc35d7`。CLI 显示同一命令执行成功和相同路径，worker 最终答复 `tool_called=yes`。两个 worker 均未改文件。
- 这两项只证明旧版 4444 下客户端确实收到并执行了一次工具调用。CLI 输出没有绑定 Provider 请求/响应形状、同一 call ID 的 follow-up，也没有候选 binary 哈希。近时段 gpt-5.6-luna sample 中存在无工具声明的失败请求，但尚未证明它与上述成功调用属于同一 request；不得混用作为完整往返证据。

## 后续动作

Node02 能力门禁和独立设计 review PASS 后，使用上述样本定位首个语义偏移，并创建最小可重放新样本补齐 gpt-5.6、OpenAI Chat、Anthropic、Gemini、失败/取消/断连路径。新旧比较只绑定同一个请求的动态 metadata，禁止按模型名或硬编码工具类型反推客户端形状。
