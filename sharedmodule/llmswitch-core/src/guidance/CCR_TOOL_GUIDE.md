# CCR 对齐的工具引导与处理设计（llmswitch-core v2）

> 目标：在不精简（不改写/不删除）现有系统提示词正文的前提下，单独注入一条规范化的“系统工具指引”消息；并将三端（Chat / Responses / Messages）的工具治理统一到 llmswitch-core v2 的唯一入口，保证幂等、可观测、可配置、无兜底。

## 1. 统一入口与职责边界
- 唯一入口（v2）：
  - 请求侧：`conversion/shared/tool-governor.ts::processChatRequestTools`
  - 响应侧：`conversion/shared/tool-governor.ts::processChatResponseTools`
- 三端共用：
  - Chat OpenAI 形状 → 直接治理
  - Responses → 先桥接到 Chat 再治理（`responses/responses-openai-bridge.ts` 内部调用）
  - Messages（Anthropic）→ 编码器统一到 OpenAI Chat 后治理
- 严格边界：
  - Server 端点与 Provider/兼容层不得重复实现工具收割、指引注入、结果回灌等逻辑。
  - Provider 仅负责 HTTP I/O，兼容层仅做供应商字段最小标准化。

## 2. 工具指引注入（不精简系统提示词，单独注入）
- 注入策略：
  - 若请求中存在任意 `tools`（OpenAI shape），则在消息队列最前面插入“一条新的系统消息（system）”，内容为规范化的工具指引块。
  - 保留原有系统提示词，不做精简/替换/删除；即：不修改已有 system 内容，仅额外“单独注入”新的 system 指引消息。
- 幂等保护：
  - 指引文本带有唯一标记（`[Codex Tool Guidance]`）。若已存在该标记的系统消息，则不再注入。
- 默认开关：
  - 默认开启；可通过 `RCC_SYSTEM_TOOL_GUIDANCE=0` 临时关闭（调试/灰度用途）。
- 注入内容（要点，与 CCR 一致）：
  - 明确要求使用 `assistant.tool_calls[].function.{name,arguments}` 调用工具，不在纯文本中嵌入工具调用。
  - `function.arguments` 必须是单个 JSON 字符串。
  - shell 工具：参数全部放入 `command` 数组，不得造新键；禁止通过 shell 写文件（重定向、heredoc、sed -i、ed -s、tee 等），写文件一律用 `apply_patch`。
  - apply_patch：仅发送补丁文本；支持 internal "*** Begin Patch" 或 GNU unified diff。注意 "*** Update File" 不会隐式创建文件；创建文件请用 "*** Add File:"（或 /dev/null diff）。修改同一文件时尽量只提交一段连续补丁，多个不相邻位置请拆成多次调用。
  - update_plan：始终保持“仅一个 in_progress 步骤”。
  - view_image：仅用于图片文件路径；禁止用来读取文本文件。
  - 不叙述“准备调用工具/工具调用已生成”等提示，直接生成 `tool_calls`。

## 3. 请求侧处理（结构化工具治理、规范化与预算）
- 工具定义增强（augment）：
  - 校正/补全 `function.parameters` 的 JSON Schema；删除多余键；维持幂等增强。
- 结构化 tool_calls canonicalize：
  - 仅处理结构化的 `assistant.tool_calls[]`：确保 `function.arguments` 为 JSON 字符串、必要时补 `id`、并在“仅 tool_calls/无可见文本”时标准化 `content=null`（OpenAI 兼容族一致行为）。
  - 不从纯文本中“收割/提升”工具调用；若上游返回 `<tool:...>` 等文本标记，应作为问题暴露而非在此兜底。
- 预算与降噪：
  - 不删除消息，仅在必要时对过长的工具结果文本（tool 角色历史）做分层裁剪（最近 N 条更宽、较旧更窄）与截断提示（可配置，默认 512–1024 字符等级）。
  - 绝不将裁剪视为“失败回退”；不做兜底值返回。

## 4. 响应侧处理（Chat 与 Responses）
- Chat（OpenAI 形状）：
  - 对 `choices[0].message.tool_calls` 做结构化 canonicalize；`finish_reason` 在命中 `tool_calls` 时补齐为 `tool_calls`；保持 `content=null` 策略。
  - 流式（SSE）对齐 CCR：
    - 先发送 `delta.role=assistant`（一次）、再发送 `delta.tool_calls[].function.name` 和 `function.arguments` 的增量片段，最后发送 `chunk.final` 与 `done`（或等效结束信号）。
- Responses（OpenAI Responses 形状）：
  - 非流：当 `tool_calls` 存在时，生成 `required_action.submit_tool_outputs.tool_calls`（`function.arguments` 始终是 JSON 字符串）；对非法调用（name 为空/为 "tool"）过滤，收集警告到 `required_action.validation.warnings`。
  - 文本字段中剥离 rcc.tool 结果包，避免“结果包”被误当可见文本。

## 5. 工具执行结果返回（tool 角色消息）
- 返回形状：
  - Chat：使用 `role=tool`，带 `tool_call_id` 与 `content`（文本）。
  - Responses：按块写入 `output[]` 中的 message/tool 部分，或生成 `required_action` 驱动客户端继续。
- 结果文本策略：
  - 若结果为 rcc.tool.v1 envelope（成功/失败 + 结构化字段），优先保留 envelope 以利于后续审计；同时在可见文本中给出简洁摘要（例如“执行成功（无输出）”或“执行失败：<首行摘要>”）。
  - 对“写文件”类命令（cat 重定向、sed -i、ed -s、tee、heredoc 不当用法等）进行识别，并：
    - 阻止/警告；
    - 不回显完整写入脚本（避免大段无效回显）；
    - 引导使用 `apply_patch`。
  - 对长输出按预算裁剪，并在首行加截断提示（例如 `[输出已截断至 512 字符]`）。

## 6. 幂等性与可观测性（含快照点）
- 幂等：
  - 工具指引注入通过标记防二次注入；工具增强与结构化 tool_calls 规范化均为幂等处理。
- 采样与日志（新增“变更前/后快照”）：
  - 根目录：`~/.routecodex/codex-samples/{openai-chat|openai-responses|anthropic-messages}`
  - 命名：`req_<requestId>_govern-<stage>.json`（不重复写入，已存在即跳过）
  - 请求侧（仅增强/注入，不做文本→工具）：
    - `before_augment_tools` → `after_augment_tools`
    - `before_inject_guidance` → `after_inject_guidance`
  - 响应侧（结构化 tool_calls 规范化 + Responses required_action）：
    - `response_before_canonicalize` → `response_after_canonicalize`
    - `response_before_required_action` → `response_after_required_action`
  - 仍保留既有采样：`*_provider-request.json`、`*_provider-response.json`、`*_responses-final.json`、`*_sse-events.log`

## 7. 配置与开关（建议）
- `RCC_SYSTEM_TOOL_GUIDANCE`（默认 ON）：是否注入“系统工具指引”独立消息。
- `RCC_TOOL_TEXT_RECENT / RCC_TOOL_TEXT_OLDER / RCC_TOOL_TEXT_MIN`：历史工具文本分层裁剪阈值（字符数）。
- `RCC_TOOL_OUTPUT_LIMIT`：单条结果输出的最大字符数（带截断提示）。
- 以上开关仅用于调试/灰度，默认策略应满足生产需求，避免长期依赖开关。

## 8. 不做的事（Fail Fast / No Fallback）
- 不在服务端点/兼容层重复实现工具转换/注入/结果处理。
- 不在 Provider 侧做“修复/兜底”；Provider 只做 HTTP I/O。
- 不做“容错默认值”式的沉默回退；一旦验证/解析失败，快速暴露问题并在上层捕获处理。

## 9. 参考实现位置（llmswitch-core v2）
- 指引模块：`v2/guidance/index.ts`
- 工具治理入口：`v2/conversion/shared/tool-governor.ts`
- 工具 canonicalize（native）：`rust-core/crates/router-hotpath-napi/src/hub_reasoning_tool_normalizer.rs`
- Responses 桥接：`v2/conversion/responses/responses-openai-bridge.ts`
  - Responses→Chat 请求适配统一由 `v2/conversion/shared/responses-request-adapter.ts` 暴露，所有入口复用该模块避免逻辑分叉。
- OpenAI 编解码：`v2/conversion/codecs/openai-openai-codec.ts`
- Anthropic 编解码：`v2/conversion/codecs/anthropic-openai-codec.ts`

## 10. 端到端流程简述（CCR 对齐）
1) Server 接收原始请求 → 交由 llmswitch-core v2 统一入口。
2) 若含 tools → 注入“系统工具指引”独立 system 消息（幂等标记）。
3) 工具定义增强 + 指引单独注入（请求侧不做文本→工具，写 before/after 快照）。
4) Chat：响应侧仅对结构化 tool_calls 规范化（写 before/after 快照）；Responses：若有 tool_calls 则在响应格式化阶段合成 required_action（写 before/after 快照）；Messages：按策略桥接。
5) 工具执行结果：以 tool 角色消息返回，长输出裁剪并标注，写文件引导使用 apply_patch。
6) 采样落地与失败快速暴露。

---

本设计确保：
- 不精简用户/系统既有提示词，只“单独注入”规范化工具指引；
- 三端共享同一治理逻辑，避免分散实现与行为不一致；
- 行为确定、可审计、可回溯，符合 RouteCodex 统一入口/快速死亡/暴露问题/配置驱动/模块化原则。
