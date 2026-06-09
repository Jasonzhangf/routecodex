# Hub Pipeline 工具边界审计 Goal

## 目标与验收标准

目标：审计并清理 Hub Pipeline 内所有越权的工具处理、协议转换、文本工具收割、工具结果映射与请求/响应边界实现，确保工具语义只在 Rust 真源阶段处理，TS 只保留薄壳桥接。

验收标准：
- Hub Pipeline 各节点职责清晰，代码中没有跨阶段补丁、provider 特例、TS 重复实现或静默吞错。
- 工具调用、工具结果、servertool、apply_patch、MCP/native 工具、文本工具 markup 的处理只落在对应 Rust 阶段。
- 每个发现的违规点都有红测，且红测走真实 Hub Pipeline 阶段或 HTTP 黑盒入口，不用 mock 私有方法冒充。
- 清理后的实现不引入 fallback，不吞异常，不通过裁剪真实 payload 规避问题。
- 构建、定向测试、黑盒测试均通过；无法完成项必须列证据与剩余风险。

## 范围与边界

### In Scope
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/` 内 Hub Pipeline、request/response stage、tool governance、format build、compat、bridge actions。
- `sharedmodule/llmswitch-core/src/conversion/hub/**` 与 `src/server/**` 中调用 Hub Pipeline 的 TS 壳层审计。
- `tests/sharedmodule/**`、`tests/server/**` 中缺失的 stage/HTTP 黑盒红测。
- `AGENTS.md`、`.agents/skills/rcc-dev-skills/SKILL.md` 中最醒目的职责边界规则。

### Out of Scope
- 不改 provider token / route pool / 端口配置，除非测试隔离临时 fixture 必须。
- 不改 Virtual Router 选择语义，除非发现 Hub Pipeline 越权调用路由逻辑。
- 不做 direct/provider passthrough 换壳修补。
- 不把 provider-specific shape 修补写进 Hub Pipeline。

## Hub Pipeline 节点职责定义

1. `req_inbound`：入口协议解析与上下文捕获。负责把 `/v1/responses`、`/v1/chat/completions`、`/v1/messages` 等客户端请求读成 Hub 可理解的语义快照；保留原始语义，不做 provider 特例；不得在此阶段伪造工具结果或吞掉非法工具顺序。
2. `req_process`：请求侧工具治理唯一入口。负责工具声明注入/裁剪、文本工具 harvest、apply_patch/servertool/MCP/native 工具治理、工具调用合法性检查；所有工具治理必须在 Rust；TS 不得重建工具语义。
3. `virtual_router`：只做路由分类与目标选择。只读当前请求和本路由池状态；不得修补 payload、不得处理工具结果、不得读取别的端口/池状态。
4. `req_outbound`：把 Hub 规范语义编码成目标 provider 协议。只做协议投影与通用 compat；不得把 `tool_calls`、`function_call_output`、servertool 语义降级为普通文本；不得执行 response-side 清洗。
5. `provider_runtime`：只做 transport/auth/provider 内部协议与 provider-specific 兼容。不得承担 Hub 工具治理；provider-specific 差异只能在 provider runtime 内解决，不能反向污染 Hub。
6. `resp_inbound`：把 provider 原始响应解析回 Hub 规范响应。负责 SSE/JSON 解析与协议归一；不得做客户端展示修补；解析失败必须显式错误。
7. `resp_process`：响应侧工具治理唯一入口。负责文本工具收割、servertool followup、apply_patch 逆向转换、已执行 internal tool 剥离、工具调用合法性检查；必须 Rust-only，禁止 TS 复制逻辑。
8. `resp_outbound`：把 Hub 响应投影回客户端入口协议。负责 model/metadata/client protocol 对称还原与输出字段整理；不得修复请求侧历史污染，不得 provider 特例，不得吞掉上游错误。
9. `servertool_followup`：只能基于 origin snapshot 重建 followup；只能走 relay Hub Pipeline 单次复入；不得进入 router-direct/provider-direct 预跑或直通；不得从当前污染 payload 猜测补偿；不得绕过 req/resp process 的工具治理。
10. `direct/provider passthrough`：只做 provider passthrough + hooks；禁止进入 Hub Pipeline response conversion、chat-process、servertool orchestration 或转换错误 reroute。

## 违规判定

判定为违规的情况：
- TS 中遍历/过滤/重写 `messages`、`input`、`tool_calls`、`function_call_output`、`required_action`、servertool 或 apply_patch 语义。
- request outbound 把工具语义转成普通 `message.content` / `input_text`。
- response outbound 试图修复 request inbound/outbound 已经污染的历史。
- Hub Pipeline 或 Virtual Router 出现 provider-specific 分支、MiniMax/MCP/任意 provider runtime 特例。
- 任一阶段用 fallback、best-effort、try/catch ignore、non-blocking swallow 隐藏工具错误。
- direct path 进入 Hub Pipeline conversion 或把 direct 错误 reroute 到 executor。

## 技术方案与文件清单

优先审计文件：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_*`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance*`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_outbound_format_build.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_outbound_stage3_compat/*`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_inbound_format_parse.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance*`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics*`
- `sharedmodule/llmswitch-core/src/conversion/hub/**`
- `src/server/handlers/responses-handler.ts`
- `src/server/runtime/http-server/executor/**`

实施原则：
- 先 grep/审计，再判断是否违规；发现不等于结论。
- 每个违规先写红测，再改 Rust 真源。
- 能删 TS 语义就删；必须保留的 TS 只能是 JSON parse/serialize + native 调用薄壳。
- 不做临时 patch；错误实现确认后物理移除。

## 测试计划

红测必须覆盖：
- Responses entry 的历史 `input` 中 assistant `tool_calls` + tool output 不得变成普通文本。
- provider 文本工具 markup 不得进入下一跳 request body 的 `input_text/output_text`。
- `function_call` 与 `function_call_output` 顺序不合法时 fail-fast，不允许 silent drop。
- `resp_process` 收割出的工具调用不泄露为客户端可见文本。
- servertool followup 只用 origin snapshot 重建，不从污染 payload 猜测补偿。
- TS stage residue audit：Hub Pipeline TS 不得出现非薄壳工具语义处理。

验证命令按需执行：
- Rust 定向：`cargo test -p router-hotpath-napi <test_name> -- --nocapture`
- TS 定向：`npm test -- <spec>` 或项目现有 vitest 命令
- 构建：`npm run build:min`
- 安装/运行态 smoke：只在红绿测试通过后执行，且不改路由配置。

## 风险与规避

- 风险：把 response-side 漏洞误修到 request-side 或反之。规避：每个样本先定位污染首次出现阶段。
- 风险：为某 provider 写特例。规避：测试用通用 `provider:tool_call` / 标准 tool_calls 语义，不写 MiniMax 专属分支。
- 风险：TS 壳层残留旧逻辑。规避：加 stage residue audit。
- 风险：删除 TS 逻辑破坏入口。规避：保留薄壳 + Rust total API 覆盖。

## 实施步骤

1. 读取 `AGENTS.md`、`docs/agent-routing/10-runtime-ssot-routing.md`、`.agents/skills/rcc-dev-skills/SKILL.md`。
2. 绘制当前 Hub Pipeline request/response 节点调用链，标注每个节点输入/输出协议。
3. grep TS/Rust 中所有工具语义处理点，按节点归类。
4. 对照职责定义标记违规点，先给每个违规点写红测。
5. 将违规 TS 语义迁移/收敛到 Rust 真源，删除错误 TS 实现。
6. 跑定向红绿测试，再跑 stage residue audit。
7. 构建与必要运行态 smoke。
8. 更新 `note.md`，已验证结论提炼到 `MEMORY.md`。

## 完成定义

- 有完整违规清单、改动清单、测试证据。
- Hub Pipeline 工具处理边界写入 `AGENTS.md` 与 `.agents/skills/rcc-dev-skills/SKILL.md` 顶部醒目位置。
- 所有修复有红测；测试先红后绿证据可追踪。
- 没有新增 TS 功能代码，没有 fallback，没有 provider 特例。
