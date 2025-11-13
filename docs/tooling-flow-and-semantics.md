Title: RouteCodex 工具处理全链路与对齐分析（详尽版）

Scope
- 目标：澄清我们对“工具调用/转换/引导/结果处理”的完整流程认知，并给出与 claude-code-router（CCR）做法的对照。
- 不涉及代码改动，仅为设计与运行文档，便于评审与后续对齐。

术语
- 本地执行：由路由器/服务进程直接调用本地 handler 执行工具逻辑（非上游模型）。
- 统一治理（governTools）：在 OpenAI Chat 侧做响应侧工具规范化（canonicalize）与 enhancetool 聚合/容错（响应侧）。
- Transformer（CCR）：对不同 provider 的入站/出站请求与响应做格式与策略适配（包括工具使用策略）。

一、我们的总流程（所有协议 → 统一 OpenAI 再治理）
- 关键策略：所有入站协议（含 Anthropic Messages）先转换为 OpenAI Chat 形状，再统一进行工具治理，之后再根据需要转换回目标协议（如 Anthropic）。

1) Anthropic → OpenAI（请求侧）
- 编码器：sharedmodule/llmswitch-core/src/v2/conversion/codecs/anthropic-openai-codec.ts:1
- 主要映射：
  - content[].text → OpenAI message.content（字符串）
  - content[].tool_use → assistant.tool_calls[].function（arguments 串化为单一 JSON 字符串）
  - tools（Anthropic input_schema）→ OpenAI function-tools（parameters）
- 治理调用：在转换完成后，进入工具治理（见第 3 节）

2) OpenAI → Anthropic（响应侧）
- 编码器：sharedmodule/llmswitch-core/src/v2/conversion/codecs/anthropic-openai-codec.ts:140
- 主要映射：
  - assistant.tool_calls → content[].tool_use
  - finish_reason → stop_reason（tool_calls → tool_use；stop → end_turn；length → max_tokens）

3) 统一工具治理（OpenAI Chat 侧）
- 入口：sharedmodule/llmswitch-core/src/v2/conversion/shared/tool-governor.ts:120
- 职责：
  - 移除系统工具指引注入与工具 schema 严格化；
  - 响应侧 canonicalize（将文本化工具规范化为 tool_calls，补齐 finish_reason 等）；
  - Enhancetool（响应侧）：非流宽松解析/修补；流式吞并工具增量，完整交付。

4) shell 稳定性与安全约束（可选）
- 如需保留可执行稳定性，可在后续评审中决定是否继续沿用：
  - 注册器：sharedmodule/llmswitch-core/src/v2/tools/tool-registry.ts:71（控制符折叠与写入禁止）
  - 请求规范化：sharedmodule/llmswitch-core/src/v2/conversion/shared/openai-message-normalize.ts:363
  - Responses 桥接：sharedmodule/llmswitch-core/src/v2/conversion/responses/responses-openai-bridge.ts:182

ASCII 时序（Anthropic 客户端 → 我们）
client(Anthropic) → endpoint(/v1/messages)
  → codec(anthropic→openai) 映射 content/tool_use/tools
  → governTools(OpenAI Chat 侧)
     - 增强 tools schema
     - 注入系统工具指引（如未注入且 tools 存在）
  → upstream provider（OpenAI Chat 形状）
  → 响应：finalize/canonicalize tool_calls
  → codec(openai→anthropic) 映射 tool_calls→tool_use + stop_reason
  → SSE/JSON 回送给客户端

二、claude-code-router（CCR）对照（核心是 Transformer + 本地 Agent）

1) Agent 工具注入（仅 Anthropic 形状）
- preHandler 命中 Agent：将该 Agent 的工具以 Anthropic 形状追加到 req.body.tools，并可注入“Agent 专用”system 文本（非通用工具指引）：
- 证据：
  - ../../claude-code-router/src/index.ts:149（tools 注入）
  - ../../claude-code-router/src/agents/image.agent.ts:167（图片场景的系统提示注入）

2) Transformer（Provider 适配 + 工具策略）
- （更新）已移除 @musistudio/llms 相关描述，统一由 llmswitch-core 实现工具治理与透明代理。
- 职责：
  - 请求/响应入站与出站格式适配（含流）：OpenAI ↔ Anthropic、Gemini、DeepSeek 等
  - 工具定义与结果在不同协议间的形状互转
  - 工具使用策略（参数级引导）：
    - tooluse：通过设置 tool_choice（如 required/auto）提升工具调用概率（文档列出）
    - enhancetool：对工具参数做容错（启用后不再流式返回工具调用信息）
- 证据：../../claude-code-router/README.md:352–388（transformers 列表与说明）

3) 本地工具执行（仅注册 Agent 的工具）
- SSE 钩子：
  - content_block_start → 标记工具/索引/id
  - input_json_delta → 累计 JSON 片段
  - content_block_stop → JSON5 解析 → 调用本地 handler(args) → 生成 tool_result → 追加两条消息（assistant tool_use + user tool_result）并再次 POST /v1/messages
- 证据：../../claude-code-router/src/index.ts:186, 198, 204, 213, 235, 243
- 默认仅注册 imageAgent.analyzeImage（本地执行范围非常窄）：../../claude-code-router/src/agents/index.ts:54

对比要点（我们 vs CCR）
- 我们：所有协议先归一到 OpenAI Chat，再做统一治理（响应 canonicalize + enhancetool +（可选）shell 安全）
- CCR：强调 Transformer 在 provider 出/入站的字段策略（包括 tool_choice 强制或偏好），并且仅对已注册 Agent 的工具在本地执行；不注入通用工具指引文本。

三、捕获样本中的“我们实际做了什么”（证据）
- 送模前载荷出现通用“工具使用指引”system 文本：[Codex Tool Guidance] …
  - 文件：~/.routecodex/codex-samples/openai-chat/unknown_compat-pre.json:1
- llmswitch-core 前/后计数变化：system 从 1 → 2（新增通用工具指引）
  - 注入前：~/.routecodex/codex-samples/openai-chat/req_..._pre-llmswitch.json:1
  - 注入后：~/.routecodex/codex-samples/openai-chat/req_..._post-llmswitch.json:1
- 响应与 SSE 一致：上游仅返回标准 tool_calls，finish_reason=tool_calls，无重复收割
  - ~/.routecodex/codex-samples/openai-chat/req_..._sse-events.log:1

四、结论
- CCR 的“工具引导”主要体现在 Transformer 的参数级策略（tool_choice、enhancetool），并非通用文本注入。
- 我们的“工具引导”集中在 OpenAI 侧统一治理（enhancetool +（可选）shell 安全），入口单一；策略与 CCR 对齐为“参数/响应侧”为主。

五、Enhancetool 模式（默认开启）的设计与运行

目标
- 对齐 CCR 的 enhancetool：在“响应侧”对工具调用参数做容错/聚合，避免因增量与不规范 JSON 导致失败；必要时牺牲工具调用的逐片段流式输出，保证交付完整、可解析的工具参数。
- 保持我们“OpenAI 统一治理”的单一入口前提不变。

开关与默认
- 开关名（提案）：RCC_TOOL_ENHANCE=1（默认开启）
  - 1/true：启用增强；0/false：关闭增强
  - 生效范围：Chat/Responses 两端点；仅影响“工具调用相关分支”，不改变普通文本增量行为

行为语义（按通道）
- 非流（JSON）响应：
  1) 遍历 choices[0].message.tool_calls[*].function.arguments；
  2) 严格 JSON.parse 失败时，尝试宽松解析（JSON5/尾逗号/单双引号修补等）；
  3) 若宽松仍失败：以 { text: raw } 或等价的“可诊断载荷”兜底交付，并打点（repair:false, reason:"parse_failed"）；
  4) 成功解析后，回写为单一 JSON 字符串（OpenAI 规范），同时记录修补统计（repaired:true, diff_len, original_len）。

- Chat 流（SSE）响应：
  1) 识别并累计 delta.tool_calls 的增量（按 index 聚合 partial arguments）；
  2) 聚合期间不向下游透出“工具调用增量”（避免半成品 JSON）；
  3) 在可确定收束的时点（finish_reason=tool_calls，或 index 关闭信号）一次性交付完整工具调用（仍以 OpenAI 形状 tool_calls 出现在最终 chunk.final/汇总处）；
  4) 普通文本 delta（非工具）保持原样透出。该模式仅“吞并”工具增量，非工具内容不受影响。

关键不变量
- 不修改工具的“语义结果”：仅改变传输/解析策略，保证 arguments 最终是可解析的 JSON。
- 不跨越职责边界：
  - 统一治理/增强仍在 llmswitch-core 完成；
  - 兼容层只做 provider 特有字段（如 reasoning_content）最小处理；
  - 服务器端点不实现工具逻辑。

可观测性
- 每次“修补/吞并”的事件记录（建议）：
  - fields：requestId, phase(request/response), endpoint(chat/responses), repaired(bool), repair_kind(json5|quote_fix|commas|merge), original_len, fixed_len, tool_count, stream_hold_ms
  - 输出：~/.routecodex/codex-samples 下与原有快照并存（*_govern-response_before/after）。

常见问答
- Q: 启用后是否完全“非流”？
  A: 否。仅“工具调用增量”不再逐片段外放；普通文本 delta 仍按原样流式输出。
- Q: 与我们“Fail Fast”冲突吗？
  A: 该增强仅限于“参数解析”与“分片合并”的技术性补救，不掩盖业务错误；解析完全失败时仍以带诊断信息的载荷交付并报错。该策略优先满足“可用且可诊断”。
