## Responses/Chat/Anthropic/Gemini 骨架统一化任务

> 背景：目前还有若干旧的 Responses bridge 逻辑（instructions/history/tool/metadata/输出字段等）没有迁入 llmswitch-core 的共享动作，导致不同协议的语义不一致，也阻碍了 mock 回归。以下是按阶段拆解的 TODO。

### 1. 中性化共享动作

1. `messages.ensure-system-instruction`  
   - 从 `responses-openai-bridge.ts` 中移除 system/history→instructions 折叠逻辑，落地到共享动作。  
   - Chat/Responses/Anthropic/Gemini `request_outbound` 统一启用。
2. `messages.normalize-history`  
   - 把 `convertMessagesToBridgeInput`、`mapResponsesInputToChat` 的 role/内容/推理拆分逻辑抽象成 action（仅做语义对齐，不做兜底）。  
   - 在所有协议的 inbound/outbound 计划里调用。
3. `messages.ensure-output-fields`  
   - 新增 action，用于在 canonical Chat 层确保 assistant/tool 消息包含 `output`/`output_text`，配合 Responses/Gemini/Anthropic 的强 schema 要求。
4. `tools.ensure-placeholders` & `tools.capture-results`  
   - 将 `bridge-actions.ts` 内的工具占位、`capturedToolResults`、`metadata.extra-fields` 逻辑改为协议无关动作，并在四条协议的 request_inbound/request_outbound 中启用。
5. `reasoning.attach-output`  
   - 把 `responses.output-reasoning` 改名为中性动作，并在所有 SSE response pipeline 中调用，保持推理/文本治理一致。

### 2. Hub Registry / Plan 接入

- 更新 `hub/registry.ts`，让 Chat/Responses/Anthropic/Gemini inbound/outbound plan 都引用上述动作组合。  
- 删除旧桥文件里已经迁出的逻辑，避免重复执行。  
- 明确 action 顺序：`messages.normalize-history` → `tools.*` → `messages.ensure-output-fields` → `messages.ensure-system-instruction`。

### 3. 回归与验证

1. Mock 样本  
   - ✅ `samples/mock-provider/_registry/index.json` 已加入 `missing_output` 回归样本，`run-regressions.mjs` 现同时回放 `invalid_name` + `missing_output`。  
   - ✅ 新增 `missing_tool_call_id` 样本（Kimi Responses 工具回路），校验 `call_id` 不被重新命名。  
   - ✅ 新增 `require_fc_call_ids` 样本（OpenAI Responses 官方链路），强制 `input[].id` 以 `fc_` 开头，防止又恢复 `call_*`。  
2. 构建验证  
   - 每完成一批动作：`npm run build:dev`、`npm run mock:regressions`、`npm run install:global`。  
3. 真实流量记录  
   - 捕获 `/v1/responses` 工具请求，确保回放时也能验证 instructions/history/tool/output/metadata 等治理。

### 5. 兜底清理进度

- ✅ 移除 `conversion/shared/bridge-request-adapter.ts` 及相关进口，Responses 路径统一依赖 `responses-openai-bridge.ts`。  
- ✅ Anthropic/Responses 不再从 raw payload/meta 恢复 system 指令，全部依赖 Chat 层 `messages.ensure-system-instruction`。  
- ✅ Responses inbound 若无法生成消息直接抛错，移除 `mapResponsesInputToChat` 的 user fallback，保持“无兜底”策略。  
- ✅ Responses request 回环保持工具 `call_id` 原样；mock provider 校验直接阻止 `fc_` 再次覆盖。  
- ✅ 2025-12-07：`responses-mapper` 删除 user/instruction fallback，instructions 仅由共享动作与 `buildResponsesRequestFromChat` 生成。  
- ✅ 2025-12-07：`mapResponsesInputToChat` 等旧桥函数迁入共享 helper（`convertBridgeInputToChatMessages`），Responses 与其他协议共用同一工具/推理骨架。
- ✅ 2025-12-07：Responses 工具声明归一逻辑迁入 `shared/tool-mapping.ts`，通过 `mapBridgeToolsToChat` / `mapChatToolsToBridge` 为多协议复用，桥接文件不再直接解析工具字段。
- ✅ 2025-12-07：Anthropic/Gemini mapper 使用共享 `metadata-passthrough` helper 编码/解码 `tool_choice` 等字段，去除协议专属逻辑。  
- ✅ 2025-12-07：Anthropic/Gemini codec 工具映射改用 `shared/tool-mapping.ts`，codec 不再保留私有工具解析。  
- ✅ 2025-12-07：Responses 输出/required_action 由 `shared/responses-output-builder.ts` 统一生成，`responses-openai-bridge.ts` 只负责格式拼装。

### 4. 清理与文档

- 清理 `responses-openai-bridge.ts` 中冗余逻辑（instructions/history/tool/metadata），把所有阅后即焚代码指向共享动作。  
- 在 `README.md`/`docs` 中补充新的动作说明，强调“所有协议先映射到 Chat 语义，再映射回目标协议”。
