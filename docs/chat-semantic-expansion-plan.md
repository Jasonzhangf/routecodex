## Chat 语义扩展与接线计划

> 目标：让 llmswitch-core 中的 Chat Process / Standardized 桥承接四种协议的语义，不再依赖 metadata 透传 “raw payload”，并按顺序分阶段完成。

> 术语约定：本文中的 “chat process” 指代码层面的 `chat_process` 阶段（工具治理/路由/协议重建的必经处理段）。

### 阶段 0：现状确认

1. **协议扫描**  
   - `chat-mapper.ts`：系统提示、工具空数组、未知字段依赖 `metadata.systemInstructions/extraFields/toolsFieldPresent`。  
   - `responses-mapper.ts`：resume/include/store 等通过 `metadata.responsesContext/responseFormat` 储存。  
   - `anthropic-mapper.ts`：system blocks、tool alias、内容 shape 等塞进 `metadata.extraFields`。  
   - `gemini-mapper.ts`：systemInstruction、safetySettings、generationConfig、toolConfig 均在 metadata/parameters。
2. **chat process / standardized 桥**  
   - 只理解 `messages/tools/toolOutputs/parameters`，其余通通进 `metadata.capturedContext`。

### 阶段 1：扩展 Chat Process + Standardized 桥

1. **类型扩展**  
   - 在 `ChatEnvelope`、`StandardizedRequest` 新增 `semantics`，并明确区分：  
     - **通用横向字段**：如 `semantics.session.previousResponseId`、`semantics.system.textBlocks`，用于跨协议共享。  
     - **协议专属命名空间**：`semantics.responses` / `semantics.anthropic` / `semantics.gemini`。每个命名空间内定义稳定 contract，禁止随意往里塞 provider extras。  
     - **providerExtras** 仅用于临时透传，默认禁止业务逻辑读取，后续接线完成后应趋近于空。
   - `chatEnvelopeToStandardized` / `standardizedToChatEnvelope` 深拷贝 `semantics`。
2. **chat process 适配**  
   - `runHubChatProcess`、工具治理、路由决策只读 `request.semantics`；除 mapper/bridge 外，任何模块不得写入 `semantics`。  
   - Metadata 退回诊断角色：仅保留 `missingFields/providerMetadata` 等调试字段，`capturedContext` 禁止再夹带业务语义。
3. **模块测试**  
   - 新增 spec：构造 `ChatEnvelope` (含 system/responses/anthropic/gemini)，执行标准化→还原→chat process，断言 `semantics` 原样保留。

> 完成该阶段后，chat process 成为“语义承接层”，为后续接线提供可靠落点。

### 阶段 2：协议语义接线（分批）

1. **OpenAI Chat**  
   - 将 `metadata.systemInstructions`/`extraFields`/`toolsFieldPresent` 迁移到 `semantics.system` / `semantics.tools`，只允许在 `semantics.providerExtras` 做临时镜像。  
   - 迁移期间保持“语义双写”：写入 semantics 后，兼容代码仍可读旧 metadata，但新逻辑必须只读 semantics。  
   - 更新现有 chat mapper 测试，确认 round-trip 不丢数据。
2. **Responses**  
   - `captureResponsesContext` 输出的 include/store/responseFormat/resume 等写入 `semantics.responses`，必要时临时镜像到旧 metadata。  
   - SubmitToolOutputs、resume、responses-roundtrip 仅依赖 `semantics.responses`；现有逻辑若仍读 metadata，需先迁移。  
   - 针对 responses 的 mock sample 回放，验证 `semantics.responses` 中包含 `previousResponseId`、`resumeToolOutputs` 等。
3. **Anthropic**  
   - system blocks、alias map、passthrough metadata、anthropicMirror -> `semantics.anthropic`。  
   - outbound mapper 从 `semantics` 还原 payload，metadata.extraFields 仅做兼容写；新读路径统一指向 semantics。  
   - 更新 `tests/sharedmodule/gemini/anthropic` 相关断言。
4. **Gemini**  
   - systemInstruction、safetySettings、toolConfig、generationConfig、`__rcc_stream` → `semantics.gemini`，仅在兼容期间写 metadata 镜像。  
   - generationConfig / toolConfig 通过 `semantics` 显式传递，metadata 不得再承载业务语义。  
   - 确认 `buildGeminiRequestFromChat` 仅依赖 `chat.semantics.gemini`。

每完成一个协议接线：  
- 编写/更新对应 spec。  
- 运行协议相关现有测试（tool-loop、responses-submit、anthropic roundtrip、gemini mapper）。  
- 确认黑盒模块测试（阶段 1）依然通过。

### 阶段 3：清理与回归

1. **移除遗留 metadata 键**  
   - 删除 `metadata.systemInstructions/extraFields.responsesContext` 等已迁移字段，保留 `missingFields/providerMetadata`。  
   - 更新文档与类型约束。
2. **回归测试矩阵**  
   - `npm run test:sharedmodule`  
   - `npm run verify:e2e-toolcall`（覆盖 responses tool loop）  
   - `scripts/tests/apply-patch-loop.mjs` / `responses-submit` 样本回放  
   - Anthropic / Gemini 专属 dry-run（若有）。
3. **文档更新**  
   - `docs/responses-...`, `docs/pipeline/...` 添加新语义字段说明。  
   - 记录“metadata 仅用于诊断，业务语义全部进入 `semantics`”的新约束。

### 注意事项

- **严格顺序**：阶段 1 完成并通过黑盒测试后，才能启动阶段 2 的任何接线工作。  
- **只读语义**：除 Semantic Mapper / Bridge 外，任何模块不得写 `semantics`； chat process 之后的所有节点禁止从 metadata/raw 读取业务语义。  
- **最小增量**：每个协议接线尽量独立 PR/commit，便于回滚。  
- **兼容期双写**：阶段 2 中需维护 semantics & metadata 双写（写 semantics → 同步旧字段）；读路径优先 semantics，metadata 仅保底兼容，直到阶段 3 清理完成。  
- **验证方式**：所有语义字段必须能在 `StandardizedRequest.semantics` 中观测到，且 chat process/路由/工具治理仅依赖该结构。

### 审查建议

- **横纵拆分**：在 `semantics` 结构中明确跨协议共享字段（例如 `semantics.session.previousResponseId`、`semantics.system.textBlocks`），避免每个协议重复定义同义字段；协议专属字段需在命名空间内列出 contract，并写测试覆盖。  
- **提交策略**：阶段 2~3 的每个协议迁移都需更新 spec + 运行现有样本（responses submit、anthropic/gemini roundtrip 等），并用黑盒模块测试确认 semantics 不丢失。  
- **metadata 清理**：阶段 3 清理前做 StandardizedRequest/ChatEnvelope 快照测试，确保 metadata 只剩诊断信息；用 codex samples 回放检查 semantics 是否完整覆盖我们关心的语义。  
- **与“禁止 raw 打洞”对齐**：任何绕开 semantics、试图回读 raw/metatada 的逻辑都应视为架构违规；新文档明确强调这一点，保持与工具链路治理的统一思路。
