# CCR 工具与协议对齐目标任务（执行与追踪）

本文档用于对齐 RouteCodex 与 CCR（claude-code-router）在“工具治理 / 指引注入 / 协议桥接 / GLM 兼容 / 预算清洁 / 构建发布 / 观测诊断”上的实现差距，并作为后续迭代的单一追踪页。每次实施后更新本页的状态与验收记录。

## 0. 范围与边界
- 覆盖端点：/v1/chat/completions（Chat）、/v1/responses（Responses）、/v1/messages（Anthropic）
- 唯一入口：工具解析、工具白名单校验、文本→tool_calls 统一在 `sharedmodule/llmswitch-core`
- 兼容层（GLM）：只做最小字段标准化；禁止工具解析、禁止兜底
- Provider 层：只做 HTTP 通信；禁止工具/提示词处理
- 不做：业务逻辑变更、额外 fallback 容错（Fail Fast）

## 1. 工具治理（单一入口 + 白名单 + 参数校验）
- 目标
  - 工具白名单与参数严格校验（CCR 风格），文本→tool_calls 的统一抽取与相邻去重。
  - assistant 含 tool_calls 时将 content 置 null（仅当为空/空白），finish_reason=tool_calls（若缺）。
- 关键文件
  - `sharedmodule/llmswitch-core/src/conversion/shared/tool-canonicalizer.ts`
  - `sharedmodule/llmswitch-core/src/tools/tool-registry.ts`
- 验收要点
  - 仅允许工具：shell / apply_patch / update_plan / view_image / MCP（list/read/templates）
  - apply_patch 必含 patch；shell.command 支持 string/array；写入型命令（重定向/heredoc/sed -i/tee）一律拒绝
  - shell 含管道/与或/分号且未 bash -lc → 规范化为 ['bash','-lc','<script>']
  - 文本化工具四类全部收敛，且相邻重复去重
- 状态
  - [x] 工具白名单与参数校验（含 bash -lc 规范化、写入型拒绝）
  - [x] 文本→tool_calls 收敛与相邻去重
  - [ ] 全量用例回归（多工具、多轮、复杂 arguments）

## 2. 工具指引（统一注入/精炼，幂等）
- 目标
  - 工具指引仅在 llmswitch-core 注入与精炼；server/compat/provider 禁止重复实现。
  - refine 策略“替换式精炼”而非简单追加，确保不重复不冲突。
- 关键文件
  - `sharedmodule/llmswitch-core/src/guidance/index.ts`
  - `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`
- 验收要点
  - 有工具时首条 system 为规范化指引块（幂等标记），其它零散片段不再重复
- 状态
  - [x] refineSystemToolGuidance 替换式精炼确认/加固
  - [ ] 三端（Chat/Responses/Anthropic）一致性验证

## 3. Responses 协议桥接（SSE 与 JSON）
- 目标
  - 真流桥接与服务端合成流的事件序与载荷对齐（含“早/晚”两次 required_action，幂等）。
  - 非流 JSON：出现 function_call 时，必生成 required_action.submit_tool_outputs.tool_calls。
- 关键文件
  - 真流：`sharedmodule/llmswitch-core/src/conversion/streaming/openai-to-responses-transformer.ts`
  - 合成：`src/server/handlers/responses.ts`
  - JSON：`sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`
- 验收要点
  - 事件序：created → in_progress → output_item.added(tool_call) → tool_call.delta/arguments.delta → arguments.done → output_item.done → required_action（早/晚）→ completed → done
  - required_action 包含 response 标识与完整 tool_calls 列表
- 状态
  - [x] 真流添加早/晚 required_action，统一事件命名
  - [x] 合成流对齐同形态（server fallback）
  - [x] 非流 JSON 所有分支均生成 required_action（全面走查）

## 4. Chat 合成流（OpenAI Chat 语义）
- 目标
  - 仅发 OpenAI Chat 增量，不发 required_action。
  - 顺序：role → content（非工具 JSON/补丁）→ tool_calls name → tool_calls arguments（分块）→ final。
- 关键文件
  - `src/server/utils/streaming-manager.ts`
- 验收要点
  - canonicalizeChatResponseTools 先行归一化；短窗去重生效；finish_reason=tool_calls 仅在真实工具出现时给出
- 状态
  - [x] unwrap → canonicalize → 合成增量 + 短窗去重
  - [ ] 采样验证（出现 name 与 arguments 增量且 final 前置齐全）

## 5. GLM 兼容层（最小标准化）
- 目标
  - 禁止文本工具解析与兜底；仅做：reasoning_content 处理、arguments 字符串化/对象化、字段映射与必要清理。
- 关键文件
  - `src/modules/pipeline/modules/compatibility/glm-compatibility.ts`
- 验收要点
  - 不再抽取/搬运工具；历史工具调用不过度清理；避免“遗忘历史/循环”
- 状态
  - [x] 移除工具收割逻辑，保留最小标准化
  - [x] 过滤历史“unsupported call/工具调用不可用”噪声（预检）
  - [ ] 继续复盘 GLM 500 样本（超大 system、空 assistant 消息）

## 6. 上下文预算与系统提示上限（配置驱动）
- 目标
  - 读取模型预算（config.json 模型级 + modules.json 默认 + 环境覆盖），按预算缩减工具历史/输出。
  - 系统提示仅“截断上限”，不做合并；默认上限 8KB（可配置）。
- 关键文件（计划）
  - `sharedmodule/llmswitch-core/src/conversion/shared/openai-message-normalize.ts`（预算执行点）
  - `sharedmodule/llmswitch-core/src/config-unified/*`（预算读取门面，如存在）
- 验收要点
  - provider-request.json 体积显著下降；不再因巨型 system/历史回显触发 500
- 状态
  - [ ] 预算读取与执行
  - [ ] systemTextLimit 实施

## 7. Schema 路径解析（无 fallback）
- 目标
  - 仅支持：baseDir 相对（host 包根）或 routecodex 包根两类解析；禁止 cwd 等隐式回退。
- 关键文件
  - `sharedmodule/llmswitch-core/src/conversion/schema-validator.ts`
- 状态
  - [x] 去除多层 fallback；严格解析（已改）

## 8. 存量实现收敛与移除
- 目标
  - 禁止 server/compat/provider 重复工具逻辑；移除旧实现目录与死代码。
- 任务
  - [ ] 确认并移除：`src/modules/pipeline/modules/llm-switch` / `src/modules/pipeline/modules/llmswitch`（若仍存在）
  - [ ] 统一 debug 目录，仅保留在 `src/modules/debug`（如现状不一致）
  - [ ] 评估并合并 `src/core` / `src/debug` / `src/patches` / `src/providers` / `src/config` / `src/modules/config-manager` 的重复实现

### 8.1 现存分散实现与替换计划（列出→移植→删除）
- 已替换为统一入口（将删除分散逻辑的代码块）：
  - `sharedmodule/llmswitch-core/src/conversion/codecs/openai-openai-codec.ts`
    - 旧：内联 `canonicalizeChatRequestTools`/`canonicalizeChatResponseTools` + augment + guidance 注入
    - 新：统一调用 `processChatRequestTools` / `processChatResponseTools`
  - `sharedmodule/llmswitch-core/src/conversion/codecs/responses-openai-codec.ts`
    - 旧：内联 `canonicalizeChatRequestTools`/`canonicalizeChatResponseTools`
    - 新：统一调用 `processChatRequestTools` / `processChatResponseTools`
  - `sharedmodule/llmswitch-core/src/conversion/codecs/anthropic-openai-codec.ts`
    - 旧：末尾调用 `canonicalizeChatRequestTools`
    - 新：统一调用 `processChatRequestTools`
  - `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`
    - 旧：本地 augment/inject/refine + messages 直接返回
    - 新：构造 `reqObj` 后统一调用 `processChatRequestTools` 获取规范化的 messages/tools
  - `src/server/utils/streaming-manager.ts`
    - 旧：在 Chat 合成流中直接 `canonicalizeChatResponseTools`
    - 新：统一调用 `processChatResponseTools`

- 待删除/确认无引用的旧文件或分支（测试通过后执行删除）：
  - 若仍存在：`src/modules/pipeline/modules/llm-switch/**`, `src/modules/pipeline/modules/llmswitch/**`
  - 若仍存在旧 SSE 实现：`src/server/responses-sse-transformer.ts`（统一到 llmswitch-core 真流或 server fallback with parity）
  - 任意 `server/compat/provider` 中涉及工具解析/指引/规范化的残留代码块（grep 检查，无引用后删除）

## 9. 构建与安装（只用 npm install -g）
- 规范
  - 先模块、后整包：
    1) `npm --prefix sharedmodule/llmswitch-core run build`
    2) `npm run build`
    3) `npm install -g .`
  - 禁止使用 quick-install 或任何 fallback；发布包包含 `config/` 目录。
- 状态
  - [ ] 验证全局路径 `routecodex/config/schemas/*.json` 可被解析

## 10. 观测与验收
- 采样日志
  - Chat：`~/.routecodex/codex-samples/openai-chat`（raw/pre/post/provider/sse-events）
  - Responses：`~/.routecodex/codex-samples/openai-responses`（responses-initial/final/provider-response/sse-events）
- 头部标记（可选）
  - Responses：`x-rc-sse-impl: llmswitch-core | server-fallback`
  - Chat：`x-rc-sse-impl: server-synth`
- curl 验收
  - Chat（SSE）：
    - `curl -N -H 'Accept: text/event-stream' -H 'Content-Type: application/json' -d @chat-tool.json http://127.0.0.1:5520/v1/chat/completions`
    - 期望：name → arguments 增量均出现；final=tool_calls
  - Responses（SSE）：
    - `curl -N -H 'Accept: text/event-stream' -H 'Content-Type: application/json' -d @responses-tool.json http://127.0.0.1:5520/v1/responses`
    - 期望：output_item.added(tool_call) → arguments.delta/done → required_action（早/晚） → completed → done
  - Responses（JSON）：
    - `curl -H 'Content-Type: application/json' -d @responses-tool.json http://127.0.0.1:5520/v1/responses`
    - 期望：required_action.submit_tool_outputs.tool_calls 存在

---

## 附录 A：当前已完成（代码层）
- 工具白名单与参数校验（含 bash -lc 自动化、写入型拒绝）：`sharedmodule/llmswitch-core/src/tools/tool-registry.ts`
- 文本→tool_calls 收敛与相邻去重、assistant content=null、finish_reason=tool_calls：`sharedmodule/llmswitch-core/src/conversion/shared/tool-canonicalizer.ts`
- Responses 真流/合成流 required_action 早/晚齐发：
  - 真流：`sharedmodule/llmswitch-core/src/conversion/streaming/openai-to-responses-transformer.ts`
  - 合成：`src/server/handlers/responses.ts`
- Chat 合成流：unwrap → canonicalize → 增量；短窗去重：`src/server/utils/streaming-manager.ts`
- 过滤历史“unsupported call/工具调用不可用”工具结果：`src/modules/pipeline/utils/preflight-validator.ts`
- Schema 路径解析无 fallback：`sharedmodule/llmswitch-core/src/conversion/schema-validator.ts`

## 11. 对外 API 统一（稳定面向外部调用）
- 新增稳定出口：`rcc-llmswitch-core/api`
  - Orchestrator：`SwitchOrchestrator`
  - 工具治理：`processChatRequestTools` / `processChatResponseTools`
  - Responses 桥接：`captureResponsesContext` / `buildChatRequestFromResponses` / `buildResponsesPayloadFromChat`
  - 流式转换：`transformOpenAIStreamToResponses`
  - 归一化（高级）：`normalizeChatRequest`
  - 指引（高级）：`buildSystemToolGuidance` / `refineSystemToolGuidance`
  - 校验（可选）：`SchemaValidator`

> 说明：后续模块仅依赖该稳定 API，不再直接引用内部子模块文件路径，避免 breaking changes。

## 附录 B：待办关键项（需优先）
- refineSystemToolGuidance 替换式精炼落实，三端一致
- Responses 非流 JSON 所有分支生成 required_action 的代码走查与补齐
- 预算执行（模型预算 + systemTextLimit 8KB 截断）
- 全量回归与采样日志比对（包含你给出的故障样本：如 `req_1761923002482_24qe9kr0w`）

## 变更记录（请在每次实施后补充）
- 2025-11-01
  - 初版建立，勾选已完成项：工具白名单/参数校验、文本→tool_calls 收敛与去重、Responses 早/晚 RA、Chat 合成流去重、历史噪声过滤、Schema 解析无 fallback。
