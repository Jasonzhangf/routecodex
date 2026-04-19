---
name: rcc-dev-skills
description: RouteCodex/llmswitch-core 的 PipeDebug 与架构索引技能。用于定位请求在 Hub Pipeline / Virtual Router / Provider Runtime 各阶段的问题，并快速落到唯一功能块与改动文件。
---

# RCC Dev Skills

## 索引概要
- L1-L20 `purpose`: RouteCodex/llmswitch-core 开发技能索引
- L21-L40 `chat-process`: Chat Process 定义与阶段说明
- L41-L60 `tool-governance`: 工具治理唯一真源位置
- L61-L80 `heredoc`: Heredoc 工具引导/收割架构
- L81-L100 `diagnosis`: PipeDebug 诊断流程
- L101-L160 `restart`: 服务器重启与热加载（SIGUSR2）
- L161-L240 `snapshot-startup`: Snapshot 启动策略（默认轻量 + 显式 stage）

## Chat Process 定义

**Chat Process = req_process + resp_process**

这是 inbound/outbound 之间的**核心处理阶段**，负责：
1. 输入输出协议归一化
2. 工具调用归一化（工具治理、兼容处理）
3. servertool 编排

**全局唯一的地方**，所有工具相关的处理都在这里。

### 阶段说明

| 阶段 | 目录 | 功能 |
|---|---|---|
| **req_process_stage1** | `stages/req_process/req_process_stage1_tool_governance.rs` | 请求侧工具治理、heredoc 引导注入 |
| **req_process_stage2** | `stages/req_process/req_process_stage2_route_select.rs` | 路由选择、metadata attach |
| **resp_process_stage1** | `stages/resp_process/resp_process_stage1_tool_governance.rs` | 响应侧工具收割、heredoc 剥离 |
| **resp_process_stage2** | `stages/resp_process/resp_process_stage2_finalize.rs` | finalize payload |
| **resp_process_stage3** | `stages/resp_process/resp_process_stage3_servertool_orchestration.rs` | servertool followup 编排 |

**注意**：`req_outbound_stage3_compat` 和 `resp_inbound_stage3_compat` 是 **provider 格式转换层**，不是工具治理的位置。
- continuation/state 统一补丁（2026-04-17）：**非 Responses 协议的 response continuity 也必须在 `chat_process.resp` 恢复到 `chat.semantics.continuation`**；不要把 session/conversation 状态恢复留给 outbound remap。可复用动作：先看 `response-mappers.ts` 是否把 request-side `semantics.continuation` 回填到 chat response，再看 `buildProcessedRequestFromChatResponse` / outbound 是否只做映射消费。
- Anthropic alias fidelity（2026-04-19）：`Bash/Glob/...` 这类客户端原始工具名必须同时落盘到 `semantics.tools.toolNameAliasMap + clientToolsRaw`，必要时再镜像到 `semantics.anthropic.*`；response-side client remap 只能消费这些 semantics 恢复原始 tool name，不能回读 metadata。

## 工具治理唯一真源

### 请求引导（注入 heredoc）

| 文件 | 作用 |
|---|---|
| `req_process_stage1_tool_governance.rs` → `apply_unified_tool_text_guidance` | **统一入口** |
| `shared_tool_text_guidance.rs` → `build_tool_text_instruction` | **SSOT** 构建引导文本 |

### 响应收割（剥离 heredoc → function call）

| 文件 | 作用 |
|---|---|
| `resp_process_stage1_tool_governance.rs` → `strip_heredoc_wrapper` | 剥离 heredoc wrapper |
| `resp_process_stage1_tool_governance.rs` → `collect_harvest_text_variants` | 收割工具调用 |

**注意**：`hub_reasoning_tool_normalizer.rs` 的 heredoc 收割逻辑不在 chat process pipeline 中，是下游 conversion 层的二次清洗。

## Heredoc 协议

### 两种变体

1. `<<RCC_TOOL_CALLS_JSON\n{...}\nRCC_TOOL_CALLS_JSON`
2. `<<RCC_TOOL_CALLS\n{...}\nRCC_TOOL_CALLS`

### 收割流程

```
文本 → strip_heredoc_wrapper() → 剥离 wrapper → 内部 JSON →
       后续收割逻辑（extract_json_candidates_from_text 等）→ function call
```

**关键点**：heredoc 只是 wrapper，剥离后内部 JSON 格式和正常 function call 一样，收割方式也一样。
- DeepSeek-Web 收敛规则（2026-04-11）：响应侧工具收割优先用 **RCC heredoc 容器唯一来源**；容器外 prose/patch/quote/bullet 一律不得参与 tool 解析，避免把正文噪声误收成调用。
- DeepSeek-Web 边界修复只允许 **容器边界补闭合**（如缺尾标记时按容器尾部收束）；JSON 无法直接解析、tool 不在 allowlist、或缺必需字段时，按无效调用处理，不转正文启发式。
- 收割命中后的内容清理规则（2026-04-11）：**只剥离 tool marker / heredoc wrapper，本轮剩余 prose 要保留**；禁止成功 harvest 后无条件 `content=""`，否则会吞掉容器外解释文本并让 provider 兼容行为漂移。
- XML 兼容收割补充（2026-04-11）：若上游仍吐出 `<execute_command>...<command>...` / `<apply_patch>...` 这类**反面教材**，只能在 `resp_process_stage1_tool_governance` 统一入口做兼容收割；禁止新增旁路入口。只要标签残缺但仍能恢复出足够参数，就按 allowlist + 参数 mask 归一为结构化 `tool_calls`。
- `execute_command` 兼容别名（2026-04-11）：响应侧必须归一到 `exec_command`，且 `cmd/command/workdir` 等已恢复字段尽量保全，不得靠“删字段/删工具调用”规避兼容问题。
- 文本工具收割边界（2026-04-12）：**要解析顶层工具壳，不要解析 shell 正文**。`apply_patch / execute_command / exec_command` 这类顶层 tag/name/wrapper/field alias 要兼容恢复；但 `bash -lc '...'` 里面的 body 一律只当字符串透传，禁止根据正文内容猜工具、拆命令、改引号或修空格。
- 缺 name 的 shell/apply_patch 负样本（2026-04-12）：如果响应只有 `{"input":{"cmd":"..."}}`、patch body、或类似 sentinel payload，但**没有明确顶层工具名/tag/wrapper**，不得推断成 `exec_command` / `apply_patch`；这类内容保留为正文或无效调用，让模型自己看到失败上下文。
- malformed 显式容器保留规则（2026-04-14）：若响应命中了 **RCC heredoc / 显式 wrapper**，但内部仍**恢复不出合法 tool_call**（如缺 `name`），**不得把 wrapper 清洗成空回复**；只能在“成功 harvest 合法调用”时剥离容器，否则保留原文交给客户端显式报错。
- shell text-tool canonical shape（2026-04-11）：请求引导统一要求 shell 只用 `exec_command + input.cmd`，且 `cmd` 必须是单字符串 `bash -lc '...'`；禁止再引导 `shell/command/workdir/cwd` 形状。
- shell 收割硬规则（2026-04-11）：响应侧只做**外层壳归一**（tool/tag/field alias → `exec_command` / `cmd`），**绝不修正文**；像 `catdocs/...`、`.md2>&1`、`&&head` 这类原始命令内容必须原样保留到 `cmd`。
- DeepSeek-Web prompt 反嘴炮精华（2026-04-12）：若样本出现“前几轮会调工具、后面突然改成 `我来分析...```bash`”，先查 DeepSeek prompt 尾部是否被**空 tool/user block**污染成裸 `<｜User｜>`；空 `function_call_output` / 空 tool turn 必须在 prompt builder 侧直接丢弃。
- DeepSeek-Web addendum 最小化（2026-04-12）：provider-specific addendum 只保留 **DeepSeek 自身约束**；不要混写 Qwen，不要把历史失败样本大段灌进 provider addendum，也不要在每轮尾部重复“保密 dry-run 合同”重话术。共享 dry-run 契约留在 `shared_tool_text_guidance`，DeepSeek 尾提醒只保留最小必需句。
- DeepSeek-Web 主链结论（2026-04-14）：5520 实测表明 DeepSeek upstream 即使被要求“直接输出标准 function call”，仍常回 **RCC fence** 或 `<tool_call>...</tool_call>` 这类文本工具壳；因此 **文本 fence 才是当前 provider 真正稳定主路径**，客户端看到的标准 `function_call` 只是 harvest/bridge 结果，不要反过来把“原生标准 function call”当 SSOT。
- QwenChat tools 边界（2026-04-12）：**qwenchat 不要改全局 system prompt**。当前 Jason 允许的最小方案是：**仅在声明 tools 时**做 request-side 最小 override（头部 prepend 一条极短 system 提示），再配合 `tools` schema/description；消息正文语义保持原样，响应 harvest 继续走统一 `resp_process_stage1_tool_governance`。
- QwenChat tool 实战结论（2026-04-13）：tool 场景要关闭 qwenchat upstream `thinking_*`，否则会放大嘴炮；关闭后它可能吐 **顶层函数样式文本壳**（如 `apply_patch(path=\"...\", content=\"...\")`），响应侧要在 `resp_process_stage1_tool_governance` 用**顶层壳 shape**收割，不解析 shell 正文。
- QwenChat tool follow-up 实测（2026-04-13）：5520 真实 `/v1/responses` 回放显示，最小 override 可以把 `tool_code_interpreter(...)` 这类内建工具幻觉压成“file inaccessible”式拒绝，但**仍可能不出 declared tool call**。若 `tool_choice=required` 下 qwenchat 继续返回 `completed + plain text refusal`，优先判定为**上游隐藏系统提示词压过最小覆盖**；下一步应只加强 **qwenchat 专属头部 override / tool descriptions**，不要回灌到 DeepSeek 共享层。
- QwenChat provider override 强化命中（2026-04-13）：若 qwenchat 仍报 “tool not found / file inaccessible”，provider 层头部覆盖要明确三件事：**declared tools 确实存在**、**external runtime 会执行**、**输出这类抱怨文本视为失败**。5520 live 验证后，qwenchat 已可从 plain-text complaint 转成 `finish_reason=tool_calls`。
- QwenChat malformed 新分支（2026-04-13）：若 5520 最新 `provider-response.json` 只吐出 `<<RCC_TOOL_CALLS_JSON` 或半截 dry-run 容器，先**直接从 SSE `delta.content` 拼回 assistant 文本**；能从半截 JSON/`cmd`/`patch` 恢复 declared tool call 就恢复，恢复不了就从 fence 开头整段切掉并显式报 **retryable** 错误，禁止继续糊成通用 `MALFORMED_RESPONSE`。
- QwenChat malformed 再分流（2026-04-13）：若最新真实样本里 `provider-response.raw` 出现 `phase=function_call.name=web_extractor` / `tool_code_interpreter` 等 **qwen 内建 native tool**，即使 bridge fallback context 丢了 declared-tool allowlist，也要在 `provider-response-converter` 直接 remap 成 `QWENCHAT_HIDDEN_NATIVE_TOOL`；不要继续落成通用 `MALFORMED_RESPONSE`。
- QwenChat hidden-native-tool 前置止血（2026-04-13）：`qwenchat-http-provider-helpers` 里对 `web_search / web_extractor / tool_code_interpreter` 这类**已知隐藏原生工具**的拦截，**不能依赖 declaredToolNames 非空**；否则一旦请求侧没把 allowlist 透传进 helper，live SSE 会先掉进 bridge malformed，再表现成 `finish_reason=unknown` 或空回复。
- 主链策略（2026-04-13）：**真实工具调用优先，文本 dry-run/harvest 只做兼容补救**。不要再把“彻底禁止模型原生工具”当硬前提；我们的职责是 RouteCodex 自己不依赖它，并在模型偷跑到隐藏原生工具、半截容器、或 malformed wrapper 时给出显式错误/恢复，而不是静默吞掉。
- QwenChat auth 透传闭环（2026-04-13）：`qwenchat-http-provider-helpers` 虽支持 `authHeaders`，但 **provider 本体也必须把 `authProvider.buildHeaders()` 过滤后的 `Authorization/Cookie` 传进去**；否则所有 qwenchat runtime 都会退化成 guest 语义，出现“同一组 runtime 一会儿能用、一会儿无权限/没资源”的假随机问题。
- Qwen Camoufox goto timeout 边界（2026-04-18）：`camo goto` 的 `page.goto timeout` 可能是**非致命**（页面已在 portal/qwen/google/callback）；处理要点是用 `list-pages` 判定是否已进入 OAuth 相关页并继续自动流程，同时抑制原始 Playwright 堆栈直出，避免把自动鉴权误判成“必须手动”。
- Qwen OAuth 浏览器边界（2026-04-18）：调试 **qwen code** 鉴权时，**禁止走默认浏览器/Chrome 路径做登录或取证**；只允许使用 camoufox 已录制的隔离 profile（如 `rc-auth.<alias>` / `rc-qwen.<alias>`）执行授权与验证，否则会把错误状态写进另一套浏览器会话，污染结论。
- Qwen / QwenChat 排查隔离（2026-04-19）：**调 qwen 时禁止查看、引用、推导 qwenchat 的实现/样本/结论；调 qwenchat 时也禁止反向引用 qwen。** 两者是不同 provider，只能各自沿本链真源排查，不能因为域名/页面相似就混用证据。
- Qwen transport 真相纠偏（2026-04-19）：`qwen` 必须沿 **Qwen Code / qwen-oauth / official `resource_url`** 链路走 `openai-http-provider`；`qwenchat-http-provider` 只属于 `qwenchat` / `chat:qwenchat-web`。若看到 `chat:qwen` 被隐式归到 qwenchat transport，这是错误分类，必须先修 `classifyQwenChatProviderIdentity` / provider-factory，再谈鉴权。
- QwenChat Uint8Array 边界（2026-04-13）：若 qwen upstream 经过 `Readable.fromWeb()` 后发出 `Uint8Array`，**不止 prelude inspect**，后续 `createOpenAiMappedSseStream / collectQwenSseAsOpenAiResult` 也必须统一用 UTF-8 decoder；只修 prelude 会让前置 business rejection 好转，但后段仍可能掉进 malformed/空回复。
- 文本 harvest mask 策略（2026-04-13）：当上游经常吐半截 fence / bullet / XML wrapper / heredoc wrapper 时，**先 mask 关键 wrapper，再只解析容器内顶层工具壳**，成功率会显著高于直接在全正文里做 JSON/regex 猜测。核心动作：1）识别 wrapper 起止与 bullet 噪声；2）只剥 wrapper，不吞容器外 prose；3）无明确 name/tag/container 时宁可报 invalid/retryable，也不要从 shell/patch 正文反推工具。
- 文本 harvest 可恢复性设计（2026-04-13）：请求侧引导要故意把工具调用放在**输出末尾、独立容器、参数保持肌肉记忆原形**（`exec_command.input.cmd` 单字符串 shell、`apply_patch` 原始 patch 字符串）。这样响应侧即使只拿到半截，也能按“容器开头以后整段切掉 / 局部补闭合 / 明确 retryable”稳定处理，避免正文污染。
- 空容器边界（2026-04-13）：`{"tool_calls":[]}`、只有 opener/closer、或 wrapper 内无有效 name/arguments 的内容，都**不算 harvest 成功**。处理规则应是“保留为正文或显式 retryable/invalid”，禁止把空容器当成工具轮完成信号，否则会制造 `finish_reason=stop` / 空回复 / 假成功。
- DeepSeek/Qwen 共用边界（2026-04-13）：**响应侧 harvest/mask 框架应共用**，因为稳定性来自统一容器边界与 wrapper-only 解析；但**请求侧 guidance 强度不要完全共用**。DeepSeek 保持共享 dry-run 契约 + 最小 provider addendum 即可，Qwen 才需要更强的“不要 native function call、只吐 RCC 容器”覆盖。
- XML exec wrapper 语义护栏（2026-04-14）：`<command>` / `<grep_command>` 这类 wrapper 只有在 body **明显像 shell 命令**时才能恢复成 `exec_command`；像 `<command-line>继续</command-line>` 这种 prose/控制词，哪怕 tag 名里带 `command` 也必须保留为正文，不能猜工具。
- QwenChat fence 设计边界（2026-04-13）：qwen 专属 override 要强约束“**不要只吐 opener**”，同时参数形状继续贴近模型肌肉记忆：`exec_command.input.cmd` 保持**单字符串 shell 原形**，不要拆 argv；`apply_patch` 保持 patch/string 原形，便于半截时做最小恢复。
- 5520 鉴权实查（2026-04-13）：5520 inbound auth 先看**进程环境变量** `ROUTECODEX_HTTP_APIKEY`，不要去配 `target`/config 绕路；本轮 live 验证已经确认 5520 不带 key 会直接 `Unauthorized`。
- QwenChat apply_patch 兼容（2026-04-13）：若上游吐 `apply_patch(path=..., content=...)` 这类可安全恢复的 shape，可在 harvest 阶段**仅合成 `*** Add File:` patch**；这样现有文件只会安全失败，不会被“自动修坏”。
- Qwen / QwenChat 共享工具定义强化（2026-04-12）：若 qwen-family 仍然嘴炮、不肯直接调工具，先不要碰 system prompt；优先把修复收敛到**共享的 tools schema/description**，明确“直接调用，不要先口头列计划”，并对 `exec_command.cmd` / `apply_patch.patch` 强化单字符串 canonical shape。
- DeepSeek-Web 历史工具示例对齐（2026-04-12）：历史 assistant `tool_calls` 进入 DeepSeek prompt 时，必须用**同一个 RCC heredoc 容器**包起来；不要一边要求“唯一正确格式是 heredoc”，一边在历史上下文里喂裸 `{\"tool_calls\":...}`，否则会削弱强约束并诱发模型改回 prose/code fence。
- DeepSeek-Web 历史 shell 示例 canonicalize（2026-04-12）：历史 assistant `exec_command` 示例进入 DeepSeek prompt 前，必须先做**外层壳 canonicalize**：只保留 `input.cmd` 与必要的 `justification`，并把 `command -> cmd`；`command/cwd/workdir` 这类 alias 绝不能继续喂回 prompt，否则模型会在后续 turn 里继续模仿坏字段。
- apply_patch native compat 边界（2026-04-12）：若 `*** Update File:` envelope 内仍是 legacy context hunk（如 `*** 123,4 ****` / `--- 123,4 ----`）且**没有现代 `@@` hunk**，native compat **不得先把旧 hunk 头剥掉**；要么原样保留给下游 normalizer，要么直接转成 `@@`。否则会制造新的 `unsupported_patch_format` 假失败。
- 响应工具 allowlist 闭环（2026-04-11）：`resp_process_stage1_tool_governance` 必须以 **requestSemantics / capturedChatRequest 派生的请求工具集合** 为唯一允许集；文本 harvest 要先按 allowlist 过滤再落 `tool_calls`，否则会误吞正文并把未声明工具透传到客户端。
- helper 对齐规则（2026-04-12）：若 TS/client helper（如 `processChatResponseTools`）与 chat pipeline 行为漂移，优先检查它是否绕开 `resp_process_stage1_tool_governance`。helper 必须先复用 unified resp-process native entry；旧 `hub_reasoning_tool_normalizer` 只能做**显式 name 的 malformed 文本 salvage**，不得恢复缺 name 的 shell/apply_patch 调用。
- Provider snapshot 背压精华（2026-04-13）：**provider snapshot 不要在请求路径直接 await 写盘**；必须走**有界异步队列**，并在队列满或内存预算超限时**丢弃最旧 pending item**。仅靠“本地最近 N 条保留”不能阻止慢磁盘/失败写盘把待写 payload 长时间堆在内存里。
- Errorsamples 背压精华（2026-04-13）：**errorsamples 也不能同步直写**；必须和 snapshot 一样走**有界异步队列 + drop oldest pending**。`429/502` 这类瞬时上游错误默认**直接跳过写盘**，否则最容易在重试风暴里把磁盘和内存一起打爆。
- Snapshot 固定文件并发写精华（2026-04-18）：`__runtime.json` 这类**固定文件名**若会被 Rust hook 与 TS mirror 共同落盘，必须使用**create-if-missing / 原子链接或 rename**；禁止对同一路径直接 `fs::write` 覆盖，否则会出现“前半段旧 JSON + 后半段新尾巴”的拼接坏样本。
- Snapshot 双实现扫描动作（2026-04-18）：排查样本坏文件时，先 grep 同名文件是否同时存在 **native hook 写盘** 与 **host mirror 写盘** 两套实现；如果两边都写同一路径，只允许一边 `create_new`，另一边只能幂等跳过。
- DeepSeek 静默失败排查（2026-04-12）：若日志出现 `finish_reason=stop` + `no assistant content`，先查 `resp_process_stage1_tool_governance::sanitize_reasoning_fields_after_tool_harvest`。**ChunkingError / 沙箱失败正文只有在 message 已成功带上非空 `tool_calls` 后才允许去噪；无 tool_calls 时必须保留原始失败正文。**
- finish_reason 对齐铁律（2026-04-12）：**只要最终 payload 里有非空 `tool_calls`，`finish_reason` 必须是 `tool_calls`**；不允许让 `metadata.finish_reason=stop` 或其它旧字段覆盖它。排查点先看 `shared_responses_response_utils::resolve_finish_reason_impl` 与 `resp_process_stage2_finalize::normalize_choices`。

## PipeDebug 诊断流程

### 问题定位

1. 检查样本目录：`~/.rcc/codex-samples/openai-responses/`
2. 关键文件：
   - `req_process_stage1_tool_governance.json` — 看引导是否注入
   - `resp_process_stage1_tool_governance.json` — 看收割是否成功
   - `req_outbound_stage3_compat.json` — 看 provider 格式转换

### 常见问题

| 问题 | 原因 | 检查点 |
|---|---|---|
| `prompt is empty` | 请求格式转换丢失 messages | `req_outbound_stage3_compat` 的 payload |
| `finish_reason=stop` 无 tool_calls | heredoc 未被收割 | `resp_process_stage1_tool_governance.json` |
| 工具列表缺失 | snapshot summary 压缩了 tools | 检查 `req_process_stage1` 的原始 payload |
| qwen `invalid_parameter_error: bad request` | qwen-oauth 缺少首条 system envelope（`content:[{type:text,cache_control:ephemeral}]`） | provider `qwen-profile.buildRequestBody` 是否注入并合并 system messages |
| 路由池未耗尽却直接把 `429` 漏给客户端 | `request-executor` 把 `routingDecision.pool`（当前命中 tier）误当成整条 route 已耗尽，错误触发 `retry_same_provider` | 先看 `request-executor` 的 `singleProviderPool/holdOnLastAvailable429`；**singleton pool 不能证明没有低优先级 fallback pool** |
| 想做“全局错误中心”收口 | 独立 center/event bus 只会形成第二中心，真正策略真源应在 Router | 先看 `docs/error-handling-v2.md` 与 `Virtual Router policy`；若某层只有 `emit/subscribe/normalize` 而不掌握 retry/reroute/backoff/fail，就应删除而不是升格 |

## 禁止事项

1. **禁止在 `req_outbound_stage3_compat` 或 `resp_inbound_stage3_compat` 中做工具治理**
2. **禁止静默吞错误** — 所有错误必须 propagate 或显式失败
3. **禁止重复处理** — 工具引导/收割只在 chat process 阶段，全局唯一

## 性能与预算精华（2026-04-06）

- 触发信号：`--snap` / retry 场景出现 OOM，同时日志窗口里 `provider-switch`、`ServerTool followup failed`、`SERVERTOOL_TIMEOUT` 密集共现。  
- 可复用动作：先把根因锁到“风暴链 + 等待队列 + 大 payload retry/snapshot 放大”三件套；不要先怀疑 `~/.rcc/errorsamples` 这类小文件目录。  
- 可复用动作：429 / concurrency / recoverable followup 一律保持“阻塞 + 指数回退”，但必须给 **recoverable backoff queue** 和 **provider traffic acquire queue** 都加 waiter 上限；否则只是把重试风暴改成排队堆内存。  
- 可复用动作：本地盘 snapshot gate 要在 `provider.send.start` 之后、`processIncoming` 之前放行；如果等 provider 返回后才放行，`provider-request / provider-response / provider-error` 的本地 mirror 会整段丢失。  
- 可复用动作：查 5555/5520 的 SSE snapshot 缺口时，不要只看 generic `postStream` 分支；`executePreparedRequest`（SDK transport）返回的 `__sse_responses` 也必须走同一套 `wrapUpstreamSseResponse + provider-response snapshot` 收口。  
- 触发信号：`SSE timeout after 1000000ms`、`PROVIDER_TRAFFIC_SATURATED` 高频、WindowServer watchdog/panic。  
- 可复用动作：优先排查“深拷贝 + 双写落盘 + 超长超时”三件套；请求/响应大历史块一律走**零拷贝摘要（mmap-hint）**，禁止在热路径做全量 JSON 深拷贝。  
- 日志口径边界（2026-04-12）：`[session-request][rt] internal` **不应包含 SSE decode**。若要看真正核心内耗，口径应为 `total - external - sseDecode`; rollup 的 `avg.core_internal` 只能再扣 `codec` 超出 `sse` 的残余，不能把 SSE 重复减两次。
- 反模式：在 handler / retry 路径对完整 payload 执行 `JSON.parse(JSON.stringify(...))`，会放大内存与 GC 抖动。  
- 触发信号：`restoreRequestPayloadFromRetrySnapshot.oversized_skip` 频发（>2MB payload）。  
- 可复用动作：重试种子优先保留 `structuredClone` 的对象快照；字符串快照仅作小体积辅助，超限直接弃用，避免“大 payload 无 seed”与 parse 噪声。  
- 触发信号：`SERVERTOOL_TIMEOUT` 出现 `followup timeout after 500000ms`，且伴随多 provider 重试风暴。  
- 可复用动作：把 servertool/followup 默认超时收敛到 120s/90s（并设上限），并对 `reasoning_only_continue/ reasoning_stop_guard/ reasoning_stop_continue` 启用 auto-limit，避免无限续轮卡死。  
- 触发信号：`429`（含 `insufficient_quota`）重试链路出现 64s/120s 级退避，拖慢切换。  
- 可复用动作：recoverable backoff 按错误分级：429 类保持小退避（<=4s）快速换 provider；servertool 类保持中退避（<=12s）避免重放风暴。  
- 触发信号：Node 进程 **虚拟内存/常驻内存随运行时间单调上涨**，但 FD / TCP 连接数基本平稳，同时日志里长期存在 `429` / timeout / aborted / provider error。  
- 可复用动作：优先排查 **requestId → meta/context** 的内存 Map（如 codec `ctxMap`、v2 pipeline `requestMetaStore`）；凡是“只在 `convertResponse` 删除、错误路径不清理”的，都必须补 **TTL + 容量上限 + 写入前 prune**，否则失败/中断请求会永久滞留并把 VM 慢慢顶高。  
- 触发信号：热路径里的“仅供观测/调度”的 request Map（如 `StatsManager.inflight`、`RequestActivityTracker.byRequestId`）在长时间运行后缓慢变大，且正常路径理论上应在 `finally/end` 删除。  
- 可复用动作：这类 Map 不要只信 happy-path 清理；统一补 **TTL + max entries + 每次读写前/后 prune**，并确保 prune 时同步回收派生计数（如 tmux active counts），避免长挂请求把非关键状态常驻在内存里。  
- 触发信号：Responses/OpenAI bridge 出现 **registry Map + inline `__responses_*` 字段** 双保留，且同一 payload 还会按 `id/request_id` 多 key 缓存。  
- 可复用动作：优先让 **registry 有 TTL/max/prune**，并让多 key 共享**同一份已克隆 snapshot 引用**；不要对同一个大 response 在 registry / inline / alias key 上重复 deep clone。  
- 触发信号：session/tmux 相关路径出现频繁 `tmux has-session` 子进程调用（QPS 高时放大为进程风暴）。  
- 可复用动作：对 `isTmuxSessionAlive`/`resolveTmuxSessionWorkingDirectory` 增加短 TTL 缓存 + 容量上限（默认 1.2s / 256 项），并在 kill/注入结果点做缓存失效或回写，避免每次 metadata/cleanup 都 spawnSync。  
- 触发信号：heartbeat 周期内重复调用 `isTmuxSessionIdleForInject`，导致 `list-panes/capture-pane` 高频子进程创建。  
- 可复用动作：对 idle 探针同样做短 TTL 缓存（仅缓存 true/false，异常不缓存），把缓存失效点放在注入前与注入后，确保性能和准确性平衡。  
- 触发信号：session startup cleanup / registry cleanup 一轮内对同一 tmuxSession 多次活性探测。  
- 可复用动作：在 cleanup 函数内部增加“单轮 memoized liveness cache”，与 probe TTL 缓存叠加，进一步降低重复探测开销。  

- 触发信号：日志出现 `web_search-auto-capability`、`session=unknown project=-`，并伴随 `provider traffic lock acquire timed out` / `recoverable retry waiters overloaded`。  
- 可复用动作：`web_search` 只能由**显式工具链**续写命中；禁止根据用户意图关键词或 `serverToolRequired` 自动切到 `web_search` 路由，否则匿名联网请求会绕开工具显式边界并放大成 provider 风暴。  
- Rust/TS classifier 对齐（2026-04-12）：若线上仍出现 `web_search:servertool-required`，先查 **Rust hotpath** `virtual_router_engine/classifier.rs` 是否还保留旧分支；TS classifier 修好了但 Rust 没同步，5520/5555 仍会继续误命中。  
- servertool → client remap 闭环（2026-04-12）：若日志出现 `CLIENT_TOOL_NAME_MISMATCH unknown=[review|clock|...]`，不要去放宽 client allowlist；先查 `strip-servertool-calls.ts` 是否按 **`tool_outputs.tool_call_id`** 剥掉所有已执行 servertool 调用，避免 internal servertool 泄露到客户端工具集合校验。  
- followup 剥离护栏（2026-04-14）：若 `reasoning.stop` / `review` / `clock` 这类 internal servertool 在 **followup** 样本里出现在 `required_action.submit_tool_outputs` 或 `output.function_call`，优先检查 `resp_process.stage2_finalize` 是否错误跳过 `filterOutExecutedServerToolCalls`；servertool followup 也必须剥离已执行 internal tool_call，不能因为 `serverToolFollowup` 标记而放行。  
- followup 编排顺序（2026-04-14）：若 followup 样本里 internal RCC tool_call 只在 `resp_process.stage1_tool_governance` 后才出现，但 `resp_process.stage3_servertool_orchestration` 仍在 governance 之前且对 `serverToolFollowup` 直接 bypass，就会出现“统一请求注入了、统一响应收割却没吃到”的假象；要补 **post-governance servertool pass**，不能只靠 pre-governance orchestration。  
- reasoning.stop 单一真源（2026-04-14）：`reasoning.stop` 的 schema/注入只能以 **chat-process request tooling** 为真源；guard/followup 只能 `preserve_tools + ensure_standard_tools`，禁止再用 `append_tool_if_missing` 造第二份工具定义，否则 followup 的 declared tools 与 host validator 会漂移成 `unknown_tool`。
- stopless 越界修复（2026-04-14）：**不要为了逼模型调用 `reasoning.stop` 而砍掉真实工具面，也不要额外注入“本轮只能 reasoning.stop/工具缺失”这类约束文案。** 正确动作只有两步：保留真实 tools（`preserve_tools + ensure_standard_tools`），并在 `reasoning.stop` 工具定义/validator 上坚持“未调用不得停止”；若线上出现“exec_command 不存在”式自造阻塞，先回查是否有人为缩了 followup tools。
- stopless 只读任务边界（2026-04-15）：若任务本身就是 **plan mode / audit / 其它有意只读交付**，`reasoning.stop` 说明与 schema 里要显式提供 `stop_reason=plan_mode`，并要求同时给 `is_completed=true + completion_evidence`；不要把这类任务误判成“必须继续写动作”或硬塞成 blocked reason。
- tool-call reject 可观测性（2026-04-14）：`provider-response-converter` 对 canonical client tool args 的拒绝，必须同时上浮 **toolName + validationReason + validationMessage + missingFields**，并继续映射到 HTTP error body；只报内部 reason code 会让模型/客户端都不知道到底缺了什么。

## 静默失败治理精华（2026-04-07）

- 触发信号：`catch {}` / `.catch(() => {})` 出现在 runtime 热路径（tmux probe、SSE write/end、startup cleanup、provider init/reporter）。  
- 可复用动作：保持 best-effort 语义不变，但统一升级为“非阻断 + 可观测”：记录 `stage + requestId/providerKey/tmuxSessionId`，并对高频路径做节流日志。  
- 重点补位：`provider-runtime-resolver`、`oauth-recovery-handler`、`daemon-admin/control`、`http-client` 这类“异常分支才触发”的路径，优先打点 non-blocking 日志，避免无声丢线索。  
- 触发信号：每请求路径的 best-effort 注入（如 middleware header hint）若直接 `console.warn`，会在异常风暴时放大日志。  
- 可复用动作：这类高频非关键路径必须加 stage 级节流（建议 60s），避免“修复静默失败”反向引入日志风暴。  
- health probe / guardian / restart 判断精华（2026-04-16）：`fetch/json/auth` 异常若统一塌缩成 `false/null/status=n/a`，调用方会把“网络错 / 401 / 响应非法 / 服务真离线”误判成同一种离线；正确做法是返回结构化 probe result（`kind + status + parseOk + bodySnippet`），并只在最外层决定是否 fallback。  
- 状态持久化 best-effort 精华（2026-04-16）：`cooldown` / `leader-lock` / `pending-tool-sync.clear` 这类“允许不中断主链”的状态写失败，也必须至少打一次节流日志并带 `operation + key/sessionId/providerKey + filepath`；否则线上只会看到重复 followup、冷却丢失、锁竞争异常，却没有第一现场。  
- 静默失败门禁精华（2026-04-16）：审计脚本不能只抓 `catch {}`；还要覆盖 `catch { return null/false }` 与 `.catch(() => null/false)`。固定证据入口：`scripts/ci/silent-failure-audit.mjs` + `tests/scripts/silent-failure-audit.spec.ts`。  
- 错误收口主链（2026-04-16）：排查 provider 执行期错误时，先确认主路径是否仍是 **`provider-error-reporter -> reportProviderErrorToRouterPolicy -> Virtual Router policy`**；如果又看到 `providerErrorCenter` + `RouteErrorHub` 双上报、或 HubPipeline 重新直接订阅 legacy center，优先判定为“第二中心回流”。  
- stopless 硬校验（2026-04-16）：若 `stopless=on/endless` 但响应已 `completed/stop` 且缺 `[app.finished:reasoning.stop]` finalized marker，Host `RequestExecutor` 必须抛 `STOPLESS_FINALIZATION_MISSING`；不要把这种“完成但未 finalize”的响应当成功，避免客户端静默停住。  
- provider-switch 退避边界（2026-04-16）：若 retry 已经决定 `exclude_and_reroute`，generic 401/403/非 blocking 错误的 backoff 也必须按 **provider 维度**计数，不能沿用全请求 `attempt` 指数增长；否则不同 provider 会被无端抬高 backoff，看起来像调度在“全局连坐”。  
- provider-switch 观测口径（2026-04-16）：当你在日志里看不清“到底是在同 provider 等待，还是已决定换 provider”时，先补齐 `decisionLabel + backoffScope + stage`。最少要区分：`provider_backoff_then_reroute`、`recoverable_backoff_same_provider`、`attempt_backoff_same_provider`。
- provider-switch 装配真源（2026-04-16）：`switchAction + decisionLabel + runtimeScopeExcludedCount` 不要在 `runtime_resolve`、`provider.send`、followup 各自手拼；优先收口到单点 helper（当前 `resolveProviderRetrySwitchPlan(...)`），否则日志口径和 reroute 排除策略会再次分叉。
- provider exclusion 真源（2026-04-16）：`promptTooLong`、Antigravity `verify/429`、`reauth`、alias rotate 这些“是否排除当前 provider / 是否把 antigravity 标成 `avoidAllOnRetry`”的规则，也要单点 helper 化（当前 `resolveProviderRetryExclusionPlan(...)`）；否则 reroute 行为会在 send/followup 边界重新分叉。
- provider retry 资格真源（2026-04-16）：`attempt/maxAttempts`、blocking recoverable、`promptTooLong` budget、Antigravity `verify/reauth` 的 retry 条件，也要单点 helper 化（当前 `resolveProviderRetryEligibilityPlan(...)`）；不要让 `runtime_resolve` 和 `provider.send` 各自维护一份 shouldRetry 分支。
- provider retry orchestrator（2026-04-16）：当 `eligibility / exclusion / switch / backoff` 都已有 helper 后，不要停在“四段手工串接”；继续把 `recordAttempt -> eligibility -> exclusion -> backoff -> switch` 收口成单一 async orchestrator（当前 `resolveProviderRetryExecutionPlan(...)`），让 `runtime_resolve` / `provider.send` 退化为 thin shell。
- provider retry telemetry（2026-04-16）：当 `executionPlan` 已存在后，`provider-switch` warn 和 `provider.retry` stage payload 也不要分支手拼；继续收口到 telemetry helper（当前 `buildProviderRetryTelemetryPlan(...)`），否则日志字段又会在 `runtime_resolve` / `provider.send` 间漂移。
- provider error reporting 装配真源（2026-04-16）：`errorCode/upstreamCode/statusCode/stageHint` 不要在 `runtime_resolve`、`provider.send`、followup 边界各自手拼；统一先过单点 helper（当前 `resolveRequestExecutorProviderErrorReportPlan(...)`），再交给 `reportRequestExecutorProviderError(...)`，否则 `provider.sse_decode` / `provider.followup` / `provider.runtime_resolve` 的阶段口径又会漂。
- provider error reporting marker 真源（2026-04-16）：`resolveRequestExecutorProviderErrorReportPlan(...)` 自己就要先读 `requestExecutorProviderErrorStage`（含 `details`）；不要要求调用方先手动 resolve fallback stage，否则“谁负责读显式 marker”会再次分叉。
- provider.http 单报规则（2026-04-16）：`converted` 出来的 retryable HTTP 401/429/5xx 不能先在 try 内 `emitProviderError('provider.http')`，再被外层 catch 二次上报；只允许打一个 `provider.http` stage marker，然后统一走 `reportRequestExecutorProviderError(...)`。
- provider.followup 健康边界（2026-04-16）：servertool/client-inject/followup payload 这类 `provider.followup` 错误本质是 orchestration/internal error，不得污染 provider 健康；`RequestExecutor` 要按 stage 直接判 `affectsHealth=false`，`emitProviderError(...)` 也必须尊重显式 `affectsHealth=false`，不能再用“non-recoverable 一律健康受损”覆盖。
- provider.followup 外层 fail-fast（2026-04-16）：**inner followup 可以在它自己的请求链内重试/切 provider，但 outer 主请求一旦拿到显式 `provider.followup` stage，必须停止继续 reroute。** 否则会把 followup 编排失败再次放大成主请求 provider 风暴。
- followup stage marker 前移（2026-04-16）：不要只靠 `SERVERTOOL_*` code 在 request-executor 外层猜 `provider.followup`；在 `provider-response-converter` 源头就给 followup 错误打 `requestExecutorProviderErrorStage='provider.followup'`，外层优先读 marker。
- sse-decode stage marker 前移（2026-04-16）：不要只靠 `SSE_DECODE_ERROR/HTTP_502/message contains sse` 在外层猜 `provider.sse_decode`；SSE wrapper / bridge remap 一旦确认来源于解码链路，就直接在源头打 `requestExecutorProviderErrorStage='provider.sse_decode'`，legacy `executor-response` 也要同步。
- host followup 源头 marker（2026-04-16）：`client-injection-flow` 这类 host 内部直接创建 followup/inject 失败错误的地方，也要直接打 `requestExecutorProviderErrorStage='provider.followup'`；不要把“已知是 followup 的 host 错误”继续留给 converter / request-executor 外层按 code 前缀猜。
- host followup dispatch 单点化（2026-04-16）：`executor-response.ts` / `provider-response-converter.ts` 里的 `reenterPipeline` / `clientInjectDispatch` 不能各自手拼 nested metadata、clientInjectOnly、nested execute；统一先过 `servertool-followup-dispatch.ts`，否则 followup 看似“回到普通请求链”，实际 host 壳层还是双实现。
- host followup error 单点化（2026-04-16）：`SERVERTOOL_*` → `provider.followup` 的 stage marker、compact reason、默认 502 不要分散在多个 converter/catch 里重复写；统一压到 `servertool-followup-error.ts`，这样 request-executor 才能稳定读到唯一口径。
- followup 最终可见日志单出口（2026-04-16）：`markServerToolFollowupError(...)` 只负责打 `provider.followup` marker 和默认状态，不要自己再 `console.warn`；真正面向运行日志的最终错误出口统一走 `convert.bridge.error`，否则同一次 followup 失败会出现“warn 一条 + stage log 一条”的双出口。
- executor non-blocking 日志 helper 单点化（2026-04-16）：`request-retry`、`provider-response-converter` 这类 executor 壳层的 non-blocking 日志，不要再各自维护 `formatUnknownError + throttle Map`；统一复用一个 stackless + throttled helper（当前 `servertool-runtime-log.ts`），否则日志口径会再次分叉。
- reasoning_stop_continue provider pin（2026-04-16）：若 servertool followup 需要保持原 provider/alias，**不要只读 `adapterContext.providerKey`**；真实线上常只有 `adapterContext.target.providerKey`。缺这层 fallback 时，`reasoning_stop_guard/continue` 会掉回默认路由池，表现为 followup 串到别的模型。
- router metadata builder 不可裁指令（2026-04-16）：如果 followup metadata 明明带了 `__shadowCompareForcedProviderKey`，但线上仍串 provider，先查 Rust `build_router_metadata_input` / TS `buildRouterMetadataInputWithNative`。这个 native builder 若不把 `__shadowCompareForcedProviderKey`、`disabledProviderKeyAliases` 从 metadata 根透传到 RouterMetadataInput，Virtual Router 根本看不到 pin/disable 指令。
- `thinking/forced` 快速定位（2026-04-16）：如果普通用户轮日志出现 `thinking/forced` / `tools/forced`，先查 `~/.rcc/sessions/.../session-*.json` 是否已落盘 `forcedTarget`；真源优先看 Rust `virtual_router_engine/engine/route.rs` 是否把 **metadata force/disableSticky** 误持久化进 session state。
- Provider v2 多文件约定（2026-04-16）：若 `provider/<id>/config.v2.<suffix>.json` 新 provider “加了但不生效”，先查 `src/config/provider-v2-loader.ts` 是否只加载 base `config.v2.json`；这类 suffixed 文件应被视为**独立 provider 文件**，且必须显式声明 `providerId/provider.id`。
- weighted 路由被锁首组（2026-04-16）：若 v2 路由只有 `loadBalancing.weights`、没有显式 `targets/order`，而线上总是只打第一个 provider/model，先查 Rust `engine/selection.rs` 是否把 **TS bootstrap 合成出来的 `mode=priority + strategy=weighted`** 当真优先级执行；Rust 真源必须让 `strategy=weighted` 胜出，不能让 synthetic priority 锁死首组。
- virtual-router bootstrap 真源（2026-04-17）：若路由配置已改但展开结果仍旧像“读缓存/认旧 provider”，先查 **Rust `routing/bootstrap.rs`** 而不是 TS `bootstrap/routing-config.ts`。现在 `normalizeRouting/expandRoutingTable` 已由 native `bootstrapVirtualRouterRoutingJson` 产出，TS 只保留 provider runtime/webSearch 薄壳；排查 weights/order/model 校验时以 Rust 输出为准。
- multimodal 实机验图边界（2026-04-18）：若 5555/5520 带图请求命中 `multimodal:media-detected`，但上游返回 `The image length and width do not meet the model restrictions [height:1 or width:1 must be larger than 10]`，先判定为 **测试图本身是 1x1/过小占位图**，不是 multimodal 路由失效。先对照 `provider-request.json` 看图片是否已变成 anthropic `image/base64`，live 验证必须改用 `>=16x16` 的真实 PNG/JPG。
- Auth 排查硬护栏（2026-04-18）：**除非 Jason 明确要求并授权当前轮触发认证，否则排查 qwen/gemini/iflow/antigravity auth 问题时一律只做静态审计（代码、日志、token 文件、官方实现对照）**；禁止主动拉起 `oauth`/browser/camoufox/device-flow，先证明“为什么现有 token / refresh 链路失效”。
- qwen daemon auto 边界（2026-04-18）：`token-daemon` 的 qwen 自动鉴权失败后**禁止自动回退 headful manual**；应直接失败并交给 auto-suspend/noRefresh 节流，否则 5555 会反复打印 device-code + manual fallback，形成“无限 OAuth”假象。
- qwen/iflow auto OAuth 收口（2026-04-19）：`qwen` 与 `iflow` 的 **auto OAuth 已整体移除**；background repair、token-daemon、root `oauth <selector>` 自动探测都不得再注入 `ROUTECODEX_CAMOUFOX_AUTO_MODE=qwen/iflow`。这两类 provider 只允许显式手动 OAuth，不允许请求期/守护进程自动拉起浏览器。
- virtual-router responses 当前轮边界（2026-04-19）：Responses `context.input` 判断 `latestMessageFromUser` 时，**不能只找最后一个 user message**；必须先看**最后一个有效 entry 的角色**（`message/function_call/function_call_output`），并只统计**latest user boundary 之后**的当前轮 tool 信号。否则会把 `user -> function_call -> function_call_output` 的续轮误判成 `thinking:user-input`。
- responses request replay 保参补口（2026-04-19）：若 `/v1/responses` 出站请求明明带了 `text/modalities` 等参数，但最终 wire 丢失，先查 `responses-mapper-from-chat.ts` 与 `responses-openai-bridge.ts`。**`chat.semantics.responses.requestParameters + 显式字段` 必须先回填到 chat/context，再在 `prepareResponsesRequestEnvelopeWithNative(...)` 之后补一次 missing request params**；否则 native prepare 只保留部分 host-managed 字段，看起来像“语义落盘了但出站没回放”。
- 协议兼容收口验收（2026-04-19）：**不要只跑 synthetic mapper/unit test。** 若要宣称协议映射“完备/兼容”，至少拿一份真实 `codex-samples` 的 `provider-request.json + provider-response.json`，分别走当前代码的 request replay / response replay，再对比 **hub canonical 输入** 与 **重放后的 outbound/client 输出** 关键字段；这一步会直接暴露像 Anthropic `system` 重复这类纸面测试看不出的真缺口。
- responses → Codex client 兼容点（2026-04-19）：对照 `~/code/codex` 时，**真正被消费的是 `output[*]` item 结构，不是顶层 `output_text` 摘要**。可复用规则：`message.content[*].type=output_text` 文本必须原样保留（禁止 trim / join 注入换行）；`reasoning` 若由 raw content 回填 summary，也必须**继续保留 `content`**，并显式带 `encrypted_content: null`，否则 Codex raw reasoning 模式会丢语义。
- 多模态语义保真（2026-04-19）：协议经过 chat canonical 时，**图片块不能丢**；Anthropic `image` / OpenAI `image_url` / Responses `input_image` 都必须保持可逆映射，禁止被 `flatten_text` 或纯文本 normalize 吃掉。验收直接看真实样本 `provider-request.json` 的 request roundtrip compare。
- servertool compare 边界（2026-04-19）：`clock/review/reasoning.stop` 这类 **servertool injected tools** 属于内部 feature，**不回客户端**；做协议矩阵 compare 时不要把它们当成客户端协议字段缺口，只比较真实 wire 可见的 client input/output 字段。
- qwen token 诊断优先级（2026-04-19）：若 qwen 出现反复 OAuth / refresh 失败，先分别验证三件事：`userinfo` 是否 401、runtime `/chat/completions` 是否 401、`/oauth2/token` refresh 是否回 JSON。若 refresh 直接回 **Aliyun WAF HTML** 或 access token 同时打不通 `userinfo + runtime`，应优先判定为**上游 credential / anti-bot blocker**，不是本地 header/UA 小差异。
- qwen official CLI 对照法（2026-04-19）：若已经把 `resource_url`、UA、DashScope headers 对齐官方实现，但 RouteCodex 仍报 `401 invalid_api_key / invalid access token`，下一步要直接用**官方全局 `qwen` CLI** 在临时 HOME 复现同一 token。若官方 CLI 也同样 401，则优先判定为**token/profile/upstream** 问题，不再把锅甩给 RouteCodex transport。

## qwen OAuth 精华（2026-04-07）

### 触发信号
- qwen provider 返回 `insufficient_quota` 或 `bad request` 错误
- qwen OAuth token enrichment 失败（`Invalid token payload for OAuth device code flow`）
- qwen vs qwenchat 配置混淆（两者是**不同 provider**）

### 关键区分：qwen vs qwenchat（不可混淆！）

| Provider | Endpoint | 模型名 | 认证方式 |
|----------|----------|--------|----------|
| **qwen** | `dashscope.aliyuncs.com/compatible-mode/v1` | `coder-model` / `vision-model` | OAuth access_token + `X-DashScope-*` headers |
| **qwenchat** | `chat.qwen.ai/api/v2` | `coder-model` | baxia tokens + web session |

### qwen OAuth Token 处理要点
- **位置**：`src/providers/auth/oauth-lifecycle.ts` → `prepareTokenForStorage`
- **必须处理**：
  - `expires_in` 必须是有效数字（从 `expires_at` 计算，或默认 21600 秒）
  - `access_token` 规范化为 string
  - `apiKey` 和 `api_key` 字段同步
- **失败表现**：token enrichment 报错 → 请求用错误格式 → compatible-mode 返回 `invalid_api_key`，旧 portal 常见 `invalid access token or token expired`

### qwen compatible-mode 请求格式要求
- **System message** 必须是 array + `cache_control`：
  ```json
  [{"role": "system", "content": [{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}]}]
  ```
- **Headers** 必须完整：
  ```
  X-DashScope-AuthType: qwen-oauth
  X-DashScope-SSE: enable
  Authorization: Bearer <token>
  ```

### 常见错误与解决方案

| 错误 | 真实原因 | 解决方案 |
|------|----------|----------|
| `insufficient_quota` | token 格式错误，非真实 quota | 检查 `prepareTokenForStorage` 的 qwen 处理 |
| `bad request` | 缺少 X-DashScope headers | 检查 `qwenFamilyProfile` header injection |
| `model not supported` | 模型名错误 | 映射为 `coder-model` 或 `vision-model` |
| OAuth enrichment 失败 | `expires_in` 不是有效数字 | 在 `prepareTokenForStorage` 添加 qwen block |

### 调试流程
1. 确认 provider 类型：qwen vs qwenchat（**不可混淆**）
2. 检查 OAuth token：`~/.rcc/oauth/qwen/*.json` → 看 `expires_in` 是否为数字
3. 检查请求格式：system message array + X-DashScope headers
4. 检查 `prepareTokenForStorage` 是否有 qwen 专用 block
5. 参考 CLIProxyAPI：`/Users/fanzhang/Documents/github/CLIProxyAPI`（qwen CLI 真实实现）

### 反模式
- ❌ 混淆 qwen 和 qwenchat（endpoint/认证完全不同）
- ❌ 让 token 里的 `resource_url=portal.qwen.ai` / `chat.qwen.ai` 覆盖 qwen runtime baseUrl
- ❌ 忽略 OAuth enrichment 错误（token 格式错误会导致请求失败）
- ❌ 在 config.v2.json 中使用 v1 格式字段（`defaultRoutingPolicyGroup` 等）
- ❌ 把 Responses 原始 `input_text`/`input_image`/`input_video` 原样透传到 qwen upstream（会触发 400 `invalid_value`）

### 边界条件
- qwen OAuth token 默认有效期 6 小时（21600 秒）
- `expires_at` 是毫秒级 timestamp，计算 `expires_in` 时需除以 1000
- qwen OAuth 推理真源应对齐 `dashscope.aliyuncs.com/compatible-mode/v1`；`portal/chat.qwen.ai` 只可视为旧 auth/userinfo 痕迹，不能反向覆盖 runtime
- compatible-mode 的 system message **必须**带 `cache_control: ephemeral`

### 内容类型兼容精华（2026-04-07）
- 触发信号：qwen 返回 `Invalid value: input_text`（或同类 `input_*` 类型错误）。
- 可复用动作：在 `req_outbound_stage3_compat/chat:qwen` 统一归一化 `messages + input`：`input_text/output_text/commentary → text`，`input_image → image_url`，`input_video → video_url`，避免在 provider 请求层再分叉修补。

### Qwen Code 对齐精华（2026-04-10）
- 触发信号：provider-request 已有 `session_id/conversation_id`，但 response/servertool 侧 sticky scope 仍拿不到，表现为 stopless/stopMessage 失效。  
- 可复用动作：不要在 transport 末端“header 倒灌 metadata”；正确修复是 **先在 metadata/runtime mapping 真层生成或归一 `sessionId/conversationId`，再映射到 provider header**。同时检查 raw metadata 提取链：JSON 字符串必须先 parse 再 regex，避免把 `codex_cli_conversation_*` 截成半截 token。  

- 触发信号：portal.qwen.ai 可用但工具场景更容易 `finish_reason=stop`、且源码里的 qwen provider 头部/系统 envelope 与真实 Qwen CLI 漂移。  
- 可复用动作：对 `chat:qwen` 先对齐 **非提示词形状**：保留首条 system envelope 的 `cache_control: ephemeral` 结构、补齐 `X-Stainless-*` 头、并把 `reasoning.effort` 同步镜像为 `reasoning_effort`；同时对齐 Qwen CLI 的 header 习惯，`User-Agent / X-DashScope-UserAgent / session_id / conversation_id / originator` 都不要透传客户端值，统一按 qwen-cli 指纹重建。未经授权不要改 system/prompt 文本。  

- 触发信号：qwen provider 配的是 DashScope compatible base，但日志/错误样本仍漂到 `https://portal.qwen.ai/v1`，token 文件里同时出现 `resource_url=portal.qwen.ai`、`api_key==access_token`、`norefresh=true`。  
- 可复用动作：把这组字段视为 **legacy 污染**：qwen runtime 必须忽略 `portal/chat.qwen.ai` 的 `resource_url` 覆盖；token 落盘时必须丢弃 fake `api_key=access_token` 与随之产生的 `norefresh`，只保留真实 `access_token/refresh_token`，若 userinfo 返回独立稳定 apiKey 才写回 `api_key + norefresh`。  

- 触发信号：qwen 的 `User-Agent / X-DashScope-* / X-Stainless-*` 已与 Qwen CLI 对齐，但工具场景仍更容易 `finish_reason=stop`。  
- 可复用动作：不要继续怀疑 header；优先检查 `chat:qwen` 是否像当前历史回归那样改写了**非 system messages**（删除空 assistant/tool turn、回填 `tool_call_id`、重写 tool call id 等）。Qwen CLI 真实现只做 system envelope 注入/合并；最小正确修复是保留非 system history 原样透传，响应侧继续按客户端语义对称恢复。  

- 触发信号：`/v1/responses` 的 Qwen 样本里 upstream 明明已有 1 个 native `tool_calls`，但客户端返回出现重复 `function_call` 或额外空参数 `{}` 调用；同时 `reasoning_content` 里常带 XML/JSON 形式的工具片段。  
- 可复用动作：优先检查 **response-side reasoning normalizer**，不要只盯 provider request/header。若 assistant 已经有结构化 `tool_calls/function_call`，必须禁止再从 `reasoning_content` 二次 harvest；否则会把 reasoning 里的示例/XML/JSON 再抽成第二个工具调用，污染后续多轮上下文并放大成莫名其妙的 `stop`。  

- 触发信号：`stopless` 明明已开启，但在线表现仍像完全没生效；`reasoning-stop-guard.spec` 同时从 “tool_flow” 退化成 “passthrough”。  
- 可复用动作：先查 `reasoning-stop-guard` 这类 **post-hook** 是否误从 `ctx.base`（响应）读取 request-only 字段（如 `tools`）；在 servertool auto hook 里，`ctx.base` 默认是模型响应，不是原始请求。请求级判定应改读 `capturedChatRequest` / sticky session state，而不是 response payload。  
- 触发信号：直连 `/v1/responses` 或 direct-model 场景里，request 已带 `<**stopless:on**>`，但 response 侧 followup 没触发，sticky state 里也没有 `reasoningStopMode`。  
- 可复用动作：先查 response converter 是否在 `bridgeConvertProviderResponse` 前**回填 `capturedChatRequest + sessionId/conversationId` 并立刻调用 `syncReasoningStopModeFromRequest`**；其次检查 `reasoning-stop-guard` followup 是否显式补回 `reasoning.stop` 工具（`preserve_tools + ensure_standard_tools + append_tool_if_missing`），避免首跳是无工具请求时续轮失去 stopless 护栏。  
- 触发信号：router、stop_message、sticky state 对同一轮 continuation 给出不同 sticky key，或只有 Responses 能续轮而 openai-chat / anthropic / gemini 走回 session/request fallback。  
- 可复用动作：先查 `sharedmodule/llmswitch-core/src/router/virtual-router/engine/routing-state/keys.ts` 是否仍被旁路；`request_chain/session/conversation/request` 必须都从统一 continuation helper 解析，`stop-message-auto/runtime-utils.ts` 之类 sidecar 只能复用该 helper，`responsesResume.previousRequestId` 只允许保留为 migration fallback。  
- 触发信号：`stopless:endless` 文案说“绝不停止”，但真实需求是“完成可停、不可抗阻塞也可停”，线上表现出现文档/提示词/validator/finalize 四处语义打架。  
- 可复用动作：把 **停止条件** 固化成单一真源：`completed + completion_evidence`，或 `attempts_exhausted=true + cannot_complete_reason + blocking_evidence + next_step 为空`（若需用户参与再加 `user_input_required + user_question`）；同步检查 tool schema、validator、summary parser、finalize gate 与设计文档是否完全一致。  

### Qwen OAuth 多账号实操精华（2026-04-10）
- 触发信号：`qwen-auto`/device-code 已打开浏览器，但页面 selector 漂移、Google/Qwen 跳转链变长，导致自动点击卡在 `element_not_found:qwen_authorization` 或长时间 timeout。  
- 可复用动作：**保留原 device-code 框架，不改提示词**；对每个 alias 只使用其隔离 profile（`rc-auth.<alias>` / `rc-qwen.<alias>`），先在 `rc-auth.<alias>` 完成 `chat.qwen.ai/auth?user_code=...` → Google account chooser → Qwen 已登录首页，再重新访问 `authorize?user_code=...` 并点击 `.qwen-confirm-btn`；成功后立即 `camo stop` 关闭该 alias 浏览器，避免串号/泄露。  
- 触发信号：portal `Continue` 后并不直接跳 Google/`/authorize`，而是**先停在 `https://chat.qwen.ai/auth?...` 登录页**，随后 device-code 长时间 timeout。  
- 可复用动作：qwen auto 必须把 **portal → qwen `/auth` 登录页 → Google OAuth** 当成合法链路；不要只等 Google/confirm。若 `/auth` 是晚到页面，也要继续点击 `.qwenchat-auth-pc-other-login-button` 把流程推进到 Google，否则会出现“浏览器已打开但自动化提前停住”的假成功。  
- 反模式：在不同 alias 间复用浏览器；账号已成功还留着 session；在 Google consent 页用宽泛 selector（如 `button:last-of-type`），容易点到无关按钮而不是“Continue/继续”。  
- 触发信号：qwen 明明已有多个 token 文件，但线上 provider 仍只像在用一个账号，且主配置里只有 `tokenFile: "default"`。  
- 可复用动作：qwen 多 token 的**主真源**是 `~/.rcc/provider/qwen/config.v2.json` 的 `provider.auth.entries[]`；不要再拆多份 `config.v2.<alias>.json` 企图替代主配置。修完后先用 bootstrap 真源确认展开出 `qwen.<alias>.<model>` 多 runtime，再 `SIGUSR2` 热重载并用在线请求/日志验证。  

### OpenAI-compatible chat reasoning outbound 精华（2026-04-11）
- 触发信号：`/v1/chat/completions` 客户端在 `reasoning_details` 上报 `sequence item 0: expected str instance, dict found`，或 Python `''.join(message['reasoning_details'])` 直接崩溃。  
- 可复用动作：**不要删除 `reasoning_details` 逃避兼容问题**；保留结构化真源在 `message.reasoning`，保留主文本在 `message.reasoning_content`，同时把兼容投影 `message.reasoning_details` 规范为 `Array<string>`（例如 `[type] text`），做到信息不丢、客户端可 join。  
- 验证：Rust outbound 单测 + `tests/monitoring/resp-outbound-stage.test.ts` 断言 `reasoning_details.join('')` 可用 + 5555 live chat 验证 `reasoning/reasoning_content/reasoning_details` 三者同时存在。  

## 服务器重启与热加载（合并自 rcc-server-restart）

### Jason 重启固定动作（2026-04-14）
- 触发信号：Jason 直接要求“编译 / 全局安装 / 重启 5555 和 5520”，或用户明确要让**运行中的端口吃到本地新代码**。  
- 固定顺序：**先 build，再 install，再 restart，再验活**；不要现场猜是 `SIGUSR2`、`start` 还是别的路径。  
- 当前项目已验证可复用命令：
  1. `npm run build:min`
  2. `npm run install:global`
  3. `routecodex restart --port 5555`
  4. `routecodex restart --port 5520`
  5. `curl -s http://127.0.0.1:5555/health && curl -s http://127.0.0.1:5520/health`
  6. `lsof -nP -iTCP:5555 -sTCP:LISTEN && lsof -nP -iTCP:5520 -sTCP:LISTEN`
  7. `tail -n 30 ~/.rcc/logs/process-lifecycle.jsonl && tail -n 30 ~/.rcc/logs/server-5555.log && tail -n 30 ~/.rcc/logs/server-5520.log`
- 成功信号：`/health.version` 等于新版本、PID 发生变化、日志出现 `Server started on 0.0.0.0:<PORT>`。  
- 反模式：没 build/install 就猜“为什么线上还是旧代码”；或者 5520 又切回 `start` / 手动 kill / broad kill。

### 标准流程（推荐）
1. 读取端口 PID 文件：`cat ~/.rcc/server-<PORT>.pid`
2. 对该 PID 发 SIGUSR2：`kill -SIGUSR2 <PID>`
3. 验证：`curl -s http://127.0.0.1:<PORT>/health`

### 何时使用
- 修改 `~/.rcc/config.json` 后
- 修改 `~/.rcc/provider/<provider>/config.v2.json` 后
- 需要最小扰动热加载，不做 stop/start

### 认证与边界
- `routecodex restart --port <PORT>` 若返回 401（daemon 管理口认证），使用 PID+SIGUSR2 路径。
- 禁止 broad kill（`pkill`/`killall`/`xargs kill`/`kill $(...)`）。
- SIGUSR2 后以日志 “Server started on 0.0.0.0:<PORT>” 作为成功信号。

### 5520 tooltext-isolated 实操真经（2026-04-11）

#### 1. 鉴权怎么拿
- 5520 若绑定非 loopback/public host，`/v1/*` 需要 **HTTP apikey**。
- 先查环境变量：
  - `printenv | rg 'ROUTECODEX_HTTP_APIKEY|RCC_HTTP_APIKEY'`
- 当前这套 5520（`/Volumes/extension/.rcc/config.tooltext-isolated.json`）实测使用：
  - `ROUTECODEX_HTTP_APIKEY`
- 发请求时带：
  - `Authorization: Bearer $ROUTECODEX_HTTP_APIKEY`
- 先看配置真源，别猜：
  - `jq '.server // .httpserver // {}' /Volumes/extension/.rcc/config.tooltext-isolated.json`
  - 当前可见：`server.apikey = "${ROUTECODEX_HTTP_APIKEY}"`

#### 2. 怎么确认配置里的鉴权来源
- 先看配置本身：
  - `jq '.server // .httpserver // {}' /Volumes/extension/.rcc/config.tooltext-isolated.json`
- 若配置里没显式 apikey，不代表没鉴权；还要再看环境变量：
  - `printenv | rg 'ROUTECODEX_HTTP_APIKEY|RCC_HTTP_APIKEY'`
- 结论规则：
  - **config 明写** → 用 config
  - **config 为空但环境变量存在** → 用 env
  - **两边都空** → 本地 loopback 通常可免鉴权；若仍 401，再查运行时 merge/config loader

#### 3. 5520 精确重启方式
- **唯一允许命令**：`routecodex restart --port 5520`
- **禁止**用 `routecodex start --port 5520 ...` 代替重启；`start` 会先抢占端口，可能对现有 child 发 `SIGTERM`，破坏用户自己拉起的长期进程链。
- **禁止**在 5520 上改走 `SIGUSR2`、PID 定位、手动 kill 等替代路径；Jason 已明确要求这里**只能**用 `restart`。
- 执行前必须先核对**配置 + 源码**，不要凭印象：
  - 配置：`/Volumes/extension/.rcc/config.tooltext-isolated.json`
  - restart CLI：`src/cli/commands/restart.ts`
  - daemon-admin auth：`src/server/runtime/http-server/daemon-admin-routes.ts`
- 当前源码实情（2026-04-11）：
  - 5520 的 server 配置里虽然有 `apikey`
  - 但 `routecodex restart` **当前没有像 heartbeat/session-admin 那样解析并附带该 apikey**
  - 且 `daemon-admin` 注释已声明“**不再使用 apikey 鉴权（改为密码登录）**”
  - 所以 `routecodex restart --port 5520` 在这套环境里可能直接 `401 unauthorized`
- 经验规则：
  - **先看配置，再看 restart 源码，再执行 restart**
  - 如果看到 `401 unauthorized`，先判定为“restart auth 模型与 server apikey 配置漂移”，不要再现场瞎猜“是不是没带 key”

#### 4. 5520 重启后怎么健全校验
- 健康检查：
  - `curl -s http://127.0.0.1:5520/health`
- 期望看到：
  - `ready=true`
  - `pipelineReady=true`
  - `version=<新版本>`
- 进程校验：
  - child PID 变化（说明确实换了新进程）
- 生命周期日志校验：
  - `tail -n 20 ~/.rcc/logs/process-lifecycle.jsonl`
  - 期望看到：与 `restart` 对应的重启链条事件，以及新的 child/session 生命周期事件；不要再把 `SIGUSR2` 当成 5520 的手工操作指令
- 服务日志校验：
  - `tail -n 80 ~/.rcc/logs/server-5520.log`
  - 期望看到：`Server started on 0.0.0.0:5520`

#### 5. 5520 真实请求健全方式
- 带鉴权请求：
  - `Authorization: Bearer $ROUTECODEX_HTTP_APIKEY`
- 目标不是只看 200，而是看：
  - 返回里 `required_action.submit_tool_outputs.tool_calls`
  - `metadata.deepseek.toolCallState = text_tool_calls`
  - `cmd` shape 是否已被修正（例如 `cat docs/...`，而不是 `catdocs/...`）

#### 6. 本轮已验证的在线事实（写入 skill，避免重复搜）
- 纠偏补充（2026-04-11）：**Jason 自己拉起的 5520 长驻进程只能用 `routecodex restart --port 5520`**；不要再用 `routecodex start --port 5520 ...`、`SIGUSR2`、PID kill 等替代方式。
- 纠偏补充（2026-04-11）：下次遇到 5520 restart / health / auth 问题，**先读配置文件和对应源码**，把“鉴权来源、restart 路径、health 校验方式”一次性写进 skill；不要每次重新问、重新试错。
- 纠偏补充（2026-04-12）：**5520 的 `/v1/*` apikey** 现在也应作为 **daemon-admin `/daemon/*` 的共享鉴权** 使用；不要再把它们当成完全割裂的两套。正确目标是：同一个 `server.apikey` 既能打业务入口，也能打 `daemon/restart(-process)`。
- 纠偏补充（2026-04-12）：当前修复真相要点：
  - `src/cli/commands/restart.ts` 走的是 `POST /daemon/restart-process`
  - CLI 现在要从 `ROUTECODEX_HTTP_APIKEY` / `RCC_HTTP_APIKEY` 或 config 解析出同一个 key，并附带到 restart 请求
  - `src/server/runtime/http-server/daemon-admin-routes.ts` 需要把解析后的 `server.apikey` 挂到 daemon-admin 守卫上
  - `src/server/runtime/http-server/daemon-admin/auth-handler.ts` 的 `authenticated` 也要接受同一个 apikey
- 纠偏补充（2026-04-12）：如果 `routecodex restart --port 5520` 仍报 `401 unauthorized`，先用同一个 apikey 直打：
  - `curl -i -H "x-api-key: $ROUTECODEX_HTTP_APIKEY" http://127.0.0.1:5520/daemon/auth/status`
  - 若返回 `apiKeyConfigured=true` 但 `authenticated=false`，说明 **线上 5520 仍是旧代码**，不是新逻辑失败。
- 纠偏补充（2026-04-12）：对 5520 的正确动作仍然是：
  - **只能继续用** `routecodex restart --port 5520`
  - **不能**因为线上还是旧代码就切到 `SIGUSR2` / `start` / kill / 其他旁路
  - 先完成代码修复、build/install；再等线上实例吃到一次新代码后，用同一条 restart 命令闭环验证
- 纠偏补充（2026-04-12）：5520 文本工具问题调试时，默认先看三处：
  - `~/.rcc/logs/server-5520.log`
  - `src/server/runtime/http-server/executor/provider-response-converter.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- 纠偏补充（2026-04-19）：**5520 不一定读 `/Volumes/extension/.rcc/config.json`**。若线上路由/provider 行为与该文件不一致，先以启动日志里的 `User config:` 为真源；本机 qwen lane 当前实际读的是 `/Volumes/extension/.rcc/config.qwen-5520.json`。

## Snapshot 启动策略（默认轻量，防爆炸）

### 默认只抓这些 stage
- `client-request`
- `http-request`
- `provider-request`
- `provider-response`
- `provider-error`
- `provider-request.retry`
- `provider-response.retry`

### 启动方式
- 轻量默认（推荐）  
  - `node dist/cli.js start --port 5555 --snap`
- 显式增加某些 stage（支持前缀通配 `*`）  
  - `node dist/cli.js start --port 5555 --snap --snap-stages "client-request,provider-request,provider-response,provider-error,chat_process.req.*"`
- 全量分析（高开销）  
  - `node dist/cli.js start --port 5555 --mode analysis`

### 环境变量
- `ROUTECODEX_SNAPSHOT_STAGES` / `RCC_SNAPSHOT_STAGES`
  - 逗号分隔
  - 支持 `chat_process.req.*`
  - `*` / `all` = 全量抓取

### 反模式
- 常规压测直接全量抓取（`*`）导致 IO/CPU/内存放大。
- 修改了 snapshot stage 选择但未重启就判定“不生效”。
