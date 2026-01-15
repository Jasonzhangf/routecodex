# RouteCodex Mock 测试覆盖计划 (TOON 启用后更新)

## 背景

项目已启用 TOON（Tool Object Object Notation）格式用于工具调用参数编码，需要更新 mock 测试覆盖计划。

## 目标

1. 构建基于 Virtual Router classifier 的 codex 样本分类脚本
2. 完善 mock provider 测试，特别是 TOON 工具、apply_patch 测试
3. 确保所有新样本在加入 CI 前通过验证

## 执行计划

### 新增：基于 codex-samples 的统一回归框架

> 目标：用一套样本（来自 `~/.routecodex/codex-samples`）同时驱动 sharedmodule 单元/形状测试 + 主包 mock-provider 端到端回归，覆盖各入口协议与主要 provider。

#### A. 样本与注册表基础设施

- [x] 完成 `scripts/mock-provider/extract.mjs`：
  - [x] 支持 `--req <requestId>` / `--all` 从 `~/.routecodex/codex-samples/{openai-chat|openai-responses|anthropic-messages}` 抽取 `*_client-request.json` / `*_provider-request.json` / `*_provider-response.json`。
  - [x] 统一落盘到 `samples/mock-provider/<entry>/<providerKey>/<stamp>/`，并生成 `request.json` / `response.json` / 可选 `client-request.json`。
  - [x] 维护 `_registry/index.json`，记录 `reqId` / `entry` / `providerId` / `path` / `tags`。
- [x] 完成 `scripts/mock-provider/validate.mjs`：
  - [x] 校验样本目录完整性（必需文件、JSON 可解析）。
  - [x] 校验 `reqId`、`entryEndpoint`、`providerId`、`model` 一致性。
  - [x] 校验 `providerId` 形如 `provider.alias.model`，并与 Virtual Router 约定一致。
- [ ] 规划样本覆盖面：
  - [ ] 为 antigravity（gemini-3-pro-high / claude-sonnet-4-5 / claude-sonnet-4-5-thinking）至少各保留 1–2 条 chat/responses/messages 入口样本，含工具 / 无工具、流式 / 非流式。
  - [ ] 为 tab/tabglm/iflow/glm 系列至少各保留工具 + 普通对话样本。

#### B. sharedmodule（llmswitch-core）形状 / 单元测试

- [x] 新增 codex-samples 驱动的形状回归测试（仅 JSON，不启动 server）：
  - [x] 在 `sharedmodule/llmswitch-core/scripts/tests/` 增加统一入口（`codex-matrix-regression.mjs`）。
  - [x] 读取一小批 codex-samples 的 `_provider-response.json`，分别通过：
    - [x] openai-chat 路径：provider-response → Chat → Chat 输出 invariants。
    - [x] openai-responses 路径：provider-response → Chat → Responses → Chat。
    - [ ] anthropic-messages 路径：provider-response → Chat → Anthropic → Chat。
  - [x] 对每条样本验证核心 invariants：
    - [x] `tool_use` / `tool_result` 配对（id 不丢、不孤立）。
    - [x] `finish_reason` / `stop_reason` 映射正确（通过既有矩阵脚本覆盖）。
    - [x] `tool_calls[].function.arguments` 始终为字符串。
    - [x] Gemini / Claude-thinking 特有约束（例如不再生成孤立的 `tool_use_id`）。
- [x] 在矩阵脚本中注册上述测试文件（`scripts/tests/run-matrix-ci.mjs` 增加 `matrix:codex-samples` 步骤）。

#### C. 主包 mock-provider 端到端回归增强

- [x] 扩展 `scripts/mock-provider/run-regressions.mjs`：
  - [x] 基于 `_registry/index.json` 的 `tags` 做精细化筛选和统计（例如 `invalid_name` / `missing_tool_call_id` / `tool_pairing` / `anthropic_claude_thinking`）。
  - [x] 除现有“非法 name 清理”检查外，逐步加入：
    - [x] tool_call_id 存在性与风格检查（fc / preserve）。
    - [x] `required_action.submit_tool_outputs[*].tool_call_id` 必须在 `output.tool_calls` 中找到对应项。
    - [ ] 针对 antigravity Claude-thinking 样本，断言不会再出现“孤立 `tool_use_id`”导致的 400（例如检查 mock provider response 中不存在未配对的 tool_call_id）。
  - [x] 支持按 providerType / entryEndpoint / route 统计覆盖（输出 summary）。
- [x] 将 `npm run mock:regressions` 保持在主包 `build:dev` 的流水线中，作为端到端健康门槛。

#### D. 持续演进策略

- [ ] 每次线上 bug 定位后，形成标准流程：
  - [ ] 先把对应 codex-sample 通过 `extract.mjs` 转成 mock-provider 样本，并在 `_registry/index.json` 打上针对性 `tags`。
  - [ ] 在 sharedmodule 形状测试中加一个针对该样本的 invariants 检查。
  - [ ] 在 `run-regressions.mjs` 中为该 `tag` 注册端到端断言，确保回归。

### Phase 1: 基础分析

- [x] 分析现有 mock-provider samples
- [x] 识别 TOON 相关样本（在 `samples/mock-provider` 中发现 TOON 编码样本）
- [x] 创建 Virtual Router classifier 分类脚本
- [x] 从最新 codex samples 提取 TOON 工具样本

### Phase 2: Mock Provider 测试增强

#### 2.1 基础测试矩阵

- [x] Mock provider 基础实现
- [x] 普通工具调用测试
- [x] apply_patch 工具测试
- [x] shell command 测试
- [x] TOON 工具测试（新增）

#### 2.2 TOON 特殊测试

- [ ] TOON 参数编码 mock 响应
- [ ] TOON 参数解码验证
- [ ] 复杂 TOON 场景（多行、特殊字符）
- [ ] TOON 与现有工具格式兼容性

### Phase 3: 样本分类与筛选

#### 3.1 创建分类脚本

创建 `scripts/classify-codex-samples.mjs`：

```javascript
// 按 Virtual Router classifier 分类
- providerKey 分类（glm, gemini, openai, anthropic）
- 工具类型分类（apply_patch, TOON, shell, 普通工具）
- 识别 tool_calls 结构
- 标记未覆盖场景
```

#### 3.2 第一批覆盖目标

- [x] 普通工具调用：已有 mock samples
- [x] apply_patch：已有 `mock.apply_patch.toolloop`
- [x] TOON 工具：从最新 samples 筛选
- [ ] shell command：筛选复杂命令样本

### Phase 4: 测试文件组织

```
tests/servertool/
├── mock-provider-tests.spec.ts
├── apply-patch-compat.spec.ts
├── toon-tool-compat.spec.ts      # 新增
├── shell-command-compat.spec.ts
└── tool-loop-compat.spec.ts
```

### Phase 5: CI 集成检查清单

- [ ] 所有测试本地通过
- [ ] TOON 编码/解码测试覆盖完整
- [ ] 测试运行时间 < 30s
- [ ] 无外部依赖
- [ ] CI 配置更新

## 下一步行动

1. 编写 `scripts/classify-codex-samples.mjs` 分类脚本
2. 从最新 codex samples 提取 TOON 工具样本
3. 创建 TOON 工具 mock 测试
4. 验证后集成到 CI
5. 记录并排期：全局安装的 iFlow CLI 需要在修复 stopMessage 问题后更新模型配置，确保：
   - `config.json` 与 `providers/iflow/*` 中的模型列表同步最新 iflow 模型库
   - GLM-4.7 的模型写法与 provider 要求一致（包括 key、alias、路由映射）
   - 在真实 CLI 环境里重新安装/链接后能够成功调用并完成一次完整对话验证
6. **统一 apply_patch 结构化转换**：在 chat-process 阶段实现 apply_patch arguments 的结构化 JSON / TOON → unified diff `{input, patch}` 规范化，移除各协议 codec 中的重复过滤器，确保所有入口（OpenAI、Responses、Anthropic、Gemini 等）共享同一逻辑。

---

## Chat 语义扩展：跨协议字段命名去重清单

> 阶段 2 开始跨协议迁移时，以下语义需统一命名并写入 `ChatSemantics`，避免重复的 metadata / extraFields / protocolState。

- **系统指令 & 原始块**
  - 当前来源：`metadata.systemInstructions`（OpenAI/Gemini）、`metadata.systemInstruction`/`originalSystemMessages`（bridge actions）、`protocolState.systemMessages/systemInstruction`、`responsesContext.originalSystemMessages`。
  - 统一命名：`semantics.system.textBlocks`（文本数组）+ `semantics.system.rawBlocks`（原始 JSON block），Responses 也复用同名字段。

- **空工具列表哨兵**
  - 当前来源：`metadata.toolsFieldPresent`（OpenAI/Anthropic/Gemini）、`metadata.extraFields.toolsFieldPresent`、Gemini provider metadata `__rcc_tools_field_present`。
  - 统一命名：`semantics.tools.explicitEmpty=true`；其它写法仅做兼容期双写，迁移完成后删除。

- **Anthropic 专属语义**
  - `anthropicToolNameMap` 同时写在 metadata / extraFields / AdapterContext。
  - `metadata.extraFields.anthropicMirror` 记录 message content 形状。
  - 统一命名：`semantics.anthropic.toolAliasMap`、`semantics.anthropic.messageShapeMirror`，不再复制到 context。

- **Responses resume / include / responseFormat**
  - 目前藏在 `metadata.responsesContext`、`metadata.responseFormat`、`metadata.responsesResume`。
  - 统一命名：`semantics.responses.context`（include/store/stream/responseFormat 等）+ `semantics.responses.resume`（previousRequestId、tool outputs）。

- **Provider metadata / passthrough**
  - Anthropic & Gemini 同一份 provider metadata 同时写入 `metadata.providerMetadata`、`parameters.metadata`、`metadata.extraFields`。
  - 统一命名：`semantics.providerExtras.<protocol>.providerMetadata` 或协议命名空间下的字段；metadata 仅保留诊断。

- **WebSearch / 其它 providerExtras**
  - 新语义已写在 `semantics.providerExtras.webSearch`；后续清理 `metadata.webSearch`、`Virtual Router metadata.webSearch` 的旧读取路径。

迁移每个协议时遵循：
1. 写 semantics（以以上命名为准）→ 兼容期双写 metadata。
2. Chat-process / 路由仅读 semantics。
3. 阶段 3 清理 metadata/extraFields 中的同义字段，新增快照测试确保只剩诊断信息。

### 协议出站白名单 + 矩阵覆盖要求

- **语义→wire 映射显式化**  
  - 每个协议的 outbound mapper（OpenAI / Responses / Anthropic / Gemini）必须维护一张“语义字段映射表”，仅允许从 `chat.semantics.<namespace>` 抽取白名单字段还原到 wire payload；其它 semantics / metadata 内部字段一律忽略。
  - 构造 `payload` 时，使用 `ALLOWED_KEYS`（或类似常量）限定可进入 wire 的键，禁止把 `metadata.*` / `providerExtras.*` 整块透传给 provider，避免内部诊断字段造成 4xx。
  - 返回前执行 defensive prune（如 `stripInternalFields(payload)`），确保 `systemInstruction`、`responsesContext`、`anthropicMirror` 等内部字段不会进入 HTTP 请求体。

- **矩阵回归覆盖**  
  - Matrix CI 最少覆盖：OpenAI Chat / Responses / Anthropic / Gemini 四条链路的 roundtrip，用 codex samples 验证新语义字段的往返；新增字段必须在 matrix 中出现并断言值正确。
  - 每次扩展白名单或语义映射时，更新 matrix fixtures（或新增针对性样本）确保关键字段（系统指令、resume、tool alias、generationConfig 等）被采集进报告；否则视为测试缺失。
  - Matrix 报告必须断言“白名单外字段不在 wire payload 出现”，通过 snapshot 或 diff 校验，防止内部字段漏清理。

### Chat 语义扩展阶段 2 进度

- [x] OpenAI Chat：`semantics.system/textBlocks`、`semantics.providerExtras.openaiChat.extraFields`、`semantics.tools.explicitEmpty` 双写完成，outbound 仅读 semantics。
- [x] Responses：`semantics.responses.context/resume` 接线，Submit Tool Outputs 及 resume 链路只读 semantics。
- [x] Anthropic：`semantics.anthropic.systemBlocks/toolAliasMap/mirror/providerMetadata` 接线，metadata 仅作兼容。
- [x] Gemini：`semantics.gemini` 记录 systemInstruction/safetySettings/generationConfig/toolConfig/providerMetadata，`semantics.tools.explicitEmpty` 标记空工具；出站白名单优先消费 semantics（systemInstruction、generationConfig、safetySettings、toolConfig、providerMetadata），metadata 仅作为 fallback。
- [ ] 阶段 3：删除 metadata/extraFields 中的同义字段，新增快照守护诊断字段清单。

---

## Antigravity 429 调查任务（gcli2api ⇄ RouteCodex）

> 目标：从 **gcli2api 能 200 的请求形态** 和 **RouteCodex 当前 429 的 upstream 请求** 两端出发，靠 curl 一步步「收敛」，精确锁定导致 429 的最小差异，然后再回写到 RouteCodex。

### Phase A：收集两边的真实请求形态

- [x] A1 在 RouteCodex 上开启 `ROUTECODEX_DEBUG_ANTIGRAVITY=1`，打一次失败的 `claude-sonnet-4-5-thinking` 请求，拿到 `~/antigravity-rc-http.json`（RC → Antigravity 的真实 HTTP 请求）。
- [x] A2 在 gcli2api 上用同一个 token + 同一个模型打一次成功请求，确认生成/更新 `~/antigravity-debug-request.json`（gcli2api → Antigravity 的真实 HTTP 请求）。

### Phase B：从 gcli2api 200 形态向 RouteCodex 收敛（curl 实验）

- [x] B1 以 `antigravity-debug-request.json` 为 baseline，用 curl 直接打 Antigravity，确认 200（作为对照组）。
- [x] B2 在 gcli2api 环境中，把 baseline 的 `request.contents` 换成 RouteCodex 那条请求的 contents（保持 systemInstruction / generationConfig / headers 不变），用 curl 验证仍然 200（目前对于复杂 contents 会触发 400，已记录）。
- [x] B3 在不动 contents 的前提下，按 RouteCodex 现在的形态，依次改动：
  - B3.1 删除 / 修改 `generationConfig`；
  - B3.2 删除 `systemInstruction`；
  - B3.3 删除 / 修改 `requestType`；
  - B3.4 对齐 RouteCodex 当前的 headers 组合；
  每一步用 curl 打一次，记录第一次从 200 → 429（或 400）的拐点（已经确认“删除 systemInstruction”是 200→429 的拐点）。

### Phase C：从 RouteCodex 429 形态往回收敛到 200

- [x] C1 以 `antigravity-rc-http.json` 为起点，用 curl 直接打 Antigravity，确认可以稳定复现 429。
- [x] C2 在不改 URL 和 token 的前提下，按「最小修改」顺序，一步步往 gcli2api 200 形态靠拢：
  - C2.1 补回/调整 `request.systemInstruction`（用 gcli2api 的 Antigravity 固定 prompt 形态）；
  - C2.2 补回/调整 `generationConfig`（对齐 gcli2api 的 `build_antigravity_generation_config` 输出）；
  - C2.3 仅在 Claude 路径下，按 gcli2api 的 openai→Gemini 转换结果，修正 `contents` 中 tools / tool_use_id 的结构；
  每一步 curl 一次，记录第一次从 429 → 200 的拐点。

### Phase D：对齐 RouteCodex Provider 行为

- [x] D1 把在 Phase B/C 中验证过的「必要字段 + 结构」固化进 `GeminiCLIHttpProvider`，区分 Gemini 与 Claude：
  - D1.1 Antigravity 必须始终注入 `request.systemInstruction`（且前缀为 gcli2api 的 Antigravity 固定 prompt）；
  - D1.2 按 gcli2api 的规则生成/映射 `generationConfig`（尤其是 Claude 的 thinkingConfig / topP 剥离逻辑）；（当前实验证明在简单用例中可选，保留为后续优化项）
  - D1.3 对 Claude 工具消息，调用/对齐 gcli2api 的 openai→Gemini 转换逻辑，保证 `contents` 结构与 200 样本一致。（受限于“Provider 层不做工具语义转换”的架构约束，暂不在 Provider 层实现）
- [x] D2 用同一个 token + 同一个模型，在 RouteCodex 上重打请求，确认 provider snapshot 与 `antigravity-debug-request.json` 关键字段一致（model / requestType / userAgent / systemInstruction / contents 结构）。
- [x] D3 回归：在 RouteCodex 上对 `gemini-3-pro-low/high` 和 `claude-sonnet-4-5(-thinking)` 分别跑一轮，确认不再出现「同一个 token gcli2api=200 / RouteCodex=429」的形态差异（当前仅 `gemini-3-flash` 仍返回 429，已单独标记为后续 case）。

---

## Daemon / Token 管理 UI ＆ Config V2 Provider 视图任务

> 目标：将 token / quota / health / credentials 管理和基于 Config V2 的 Provider 管理统一到一个独立 WebUI 模块中，前端仅通过 API 获取数据。

### 1. Daemon / Token 管理 UI（现状 & 后续）

- [x] 设计整体信息架构（Tabs：Overview / Token & Quota / Credentials / Providers / Settings）。
- [x] 落盘静态设计页面 `docs/daemon-admin-ui.html`。
- [x] 设计并落盘 daemon/token 管理模块的文件结构（后端路由 / handler 模块 / 前端静态资源路径），文档：`docs/daemon-admin-module-structure.md`。
- [x] 设计并记录后台所需 API（daemon status / quota / credentials / providers runtimes），文档：`docs/daemon-admin-api-design.md`。
- [x] 在 host/daemon 中实现只读 API（本地访问，隐藏敏感数据）。
- [x] 将静态页面改造为通过 API 拉取数据的动态视图（保持只读）。
- [x] 对 Daemon 管理 UI 做端到端集成测试（在 `scripts/verify-e2e-toolcall.mjs` 中附加 `/daemon/status`、`/daemon/credentials`、`/quota/summary`、`/providers/runtimes` smoke 校验，随 `npm run build:dev` 自动执行）。

### 2. Providers (Config V2) 管理视图

- [x] 设计基于 Config V2 的 Provider 管理视图（数据来源 / 边界 / 布局 / API 草案）。
- [x] 将设计落盘为文档：`docs/provider-config-v2-ui-design.md`。
- [x] 在 daemon-admin UI 中增加 Providers 二级 Tab：`Runtime health` / `Config V2`。
- [x] 接入 `/config/providers/v2*` 只读 API，完成列表 + 详情视图（基于 `loadProviderConfigsV2` 读取 `~/.routecodex/provider/*/config.v2.json`，仅返回非敏感字段）。
- [x] 与 Credentials / Runtime health 视图打通跳转（从 Credentials 行点击跳转到 Providers(Config V2) 并按 `credentialsRef` 过滤列表，前端仅做过滤与高亮，不改动路由逻辑）。
- [x] 对 Providers(Config V2) 视图做端到端集成测试（在 `scripts/verify-e2e-toolcall.mjs` 中附加 `/config/providers/v2` smoke 校验，确保 Config V2 列表 API 正常响应）。

---

## TOON 工具协议统一任务（全工具 TOON 化）

> 目标：对“模型视角”统一所有工具的调用参数为 TOON 格式，在 chat process 中实现唯一的 TOON ⇄ JSON 解码层，先改工具治理，再扩展解码器，并用 codex samples 做回放验证。

### Phase T1：协议与治理设计

- [ ] 梳理当前工具协议与治理位置：
  - 工具注册与描述：`sharedmodule/llmswitch-core/src/tools/tool-registry.ts`、`sharedmodule/llmswitch-core/src/guidance/index.ts`。
  - 工具治理与过滤：`sharedmodule/llmswitch-core/src/conversion/shared/tool-filter-pipeline.ts` 及其 hooks。
  - TOON 解码过滤器：`sharedmodule/llmswitch-core/src/filters/special/response-tool-arguments-toon-decode.ts`。
- [ ] 确认“模型统一协议”的设计原则：
  - 模型侧所有工具一律使用 `arguments.toon`（不再区分 shell TOON / exec_command JSON）。
  - 工具说明中明确：模型只需写 TOON，不关心最终 JSON 字段名。
  - 执行器（CLI / daemon / provider）只消费结构化 JSON，由 chat process 负责 TOON ⇄ JSON。

### Phase T2：工具治理调整（先改治理，再改解码）

- [ ] 更新工具治理与系统提示：
  - 在全局 guidance 中统一变更工具使用说明，声明“所有工具参数均使用 TOON”，避免混合协议。
  - 针对 exec_command / shell / apply_patch / search / web_search / 文件读取写入等工具，移除“JSON 形态示例”，改为抽象 TOON 说明。
- [ ] 收紧 / 统一工具注入规则（与现有治理兼容）：
  - 保持现有 image / web_search / search / coding 等工具的注入时机与路由规则不变，只改变“对模型暴露的参数形态”为 TOON。
  - 确保 exec_command 在模型视角只暴露 TOON（避免 cmd-only JSON 与 TOON 混用）。

### Phase T3：TOON 解码器扩展与唯一化

- [ ] 在 chat process / filter 管线中明确唯一的 TOON 解码入口：
  - 保证 TOON ⇄ JSON 转换仅存在于 llmswitch-core 的一处（当前 response 侧已有基础过滤器，需扩展与归一）。
- [ ] 扩展 TOON 解码逻辑覆盖所有工具：
  - 将 `ResponseToolArgumentsToonDecodeFilter` 从“只支持部分工具（shell/exec/apply_patch）”扩展为：只要 `arguments.toon` 存在，就尝试通用 TOON 解析。
  - 基于 tool name / tool family（文件读写 / search / coding / web_search / apply_patch / exec_command 等）映射到对应的 JSON schema，构造统一的结构化参数对象。
  - 确保 apply_patch 仍生成兼容 Codex `apply_patch` CLI 的 unified diff `{ input, patch }`。
- [ ] 确保 TOON 编码/解码对称：
  - 请求侧：JSON → TOON（用于工具描述 / 模型系统提示）。
  - 响应侧：TOON → JSON（用于真实工具执行）。
  - 其他层（HTTP server / provider / CLI 执行器）不再各自实现 TOON 逻辑。

### Phase T4：测试与回放验证

- [ ] 更新 / 扩展测试用例：
  - 在 `tests/sharedmodule` 下新增 / 扩展 TOON 解码测试，覆盖多种工具（exec_command、shell、apply_patch、search、文件工具等）。
  - 保证 apply_patch 测试仍通过真实 `apply_patch` CLI 执行，验证 unified diff 正确性。
- [ ] 使用 codex samples 做回放验证：
  - 选取最新 codex samples 中包含 TOON 工具调用的样本，验证新解码器可正确解析并生成结构化参数。
  - 对历史上 exec_command 与 TOON 混用产生的错误样本，确认在“全 TOON 协议 + 新解码器”下行为合理（要么被正确解析，要么返回清晰错误）。
- [ ] 回归检查：
  - 确保 web_search / search / coding / longcontext / tools 等路由池在“全 TOON 协议”下行为与现有预期一致（不改变路由逻辑，只改变参数编码方式）。
  - 将关键错误样本加入标准回归路径（错误样本脚本 / 矩阵测试脚本），防止未来回归。

---

## Provider Quota / Virtual Router 健康管理（文件落盘 & Daemon 路线）

> 目标：将 provider 健康 / 流控 / 熔断统一抽象为 quota，由 daemon 落盘维护 `~/.routecodex/quota/provider-quota.json`，virtual-router 仅通过快照决定进入路由池与优先级，错误处理集中在 daemon 的 errorhandler。

### Phase Q1：Quota 逻辑中心（纯函数，不接线）

- [x] 设计并落盘文档 `docs/provider-quota-design.md`（文件结构、错误规则、分阶段计划）。
- [x] 在 host/daemon 仓库新增 `provider-quota-center` 模块（无文件 I/O）：
  - [x] 定义 `QuotaState` / `ErrorEvent` / `SuccessEvent` / `UsageEvent` 类型。
  - [x] 实现 `applyErrorEvent`：支持 429 与其它可恢复错误的 1/3/5 分钟回退 + 连续三次 6 小时锁定逻辑。
  - [x] 实现 `applySuccessEvent`：在成功时清零“连续”错误计数，必要时恢复 `inPool`。
  - [x] 实现 `applyUsageEvent` / `tickWindow`：按分钟窗口维护 `requestsThisWindow` / `tokensThisWindow`，支持静态 rateLimitPerMinute / tokenLimitPerMinute。
  - [x] 为上述逻辑补充完整的单元测试（错误梯度、成功重置、quota 用尽 / 窗口翻转）。

### Phase Q2：落盘存储层（Provider Quota Store）

- [x] 实现 `provider-quota-store` 模块（仅在 daemon 侧使用）：
  - [x] `loadSnapshot` / `saveSnapshot`：基于 `~/.routecodex/quota/provider-quota.json`，采用临时文件 + rename 的原子写方案。
  - [x] `appendErrorEvent`：将标准化 `ErrorEvent` 追加写入 `provider-errors.ndjson`，供调试或冷启动恢复使用。
  - [x] 为 store 编写读写 / 容错单元测试（包含损坏文件、权限失败、不存在文件等场景）。
- [x] 提供 `scripts/quota-dryrun.mjs`：
  - [x] 从本地 fixture（错误 / 成功 / usage 序列）读事件，驱动 quota center。
  - [x] 输出 `provider-quota.json` 快照，便于人工核对与回归测试使用。

### Phase Q3：Quota Daemon & Errorhandler 集成（先独立跑，再接线）

- [x] 在 daemon 进程中集成 quota center + store：
  - [x] 新增错误事件订阅入口（当前通过 `providerErrorCenter.subscribe` 旁路订阅 `ProviderErrorEvent`）。
  - [x] 接入成功 / usage 事件（来自 provider 成功响应与 virtual-router 使用记录）。
  - [x] 周期性执行窗口翻转 / 冷却与锁定过期检查，并写回 `provider-quota.json`。
- [x] 为 quota daemon 增加 `--dry-run` / `--once` 模式：
  - [x] 提供 `routecodex quota-daemon --once [--replay-errors] [--dry-run]`（不连接真实虚拟路由器）。
  - [ ] 执行一轮 quota 更新与落盘后退出，用于 CI / 本地验证（后续可接入 CI）。
- [ ] 在 host 侧 errorhandler 中仅新增“向 daemon 发 ErrorEvent”的可选 sink（通过环境变量开启），不改变现有 HTTP 映射逻辑。

### Phase Q4：Virtual Router 读取 quota 快照（按 feature flag 渐进接线）

- [x] 在 virtual-router 构建 provider 池时，增加可选 quota 快照读取逻辑：
  - [x] 当 `ROUTECODEX_QUOTA_ENABLED=1` 时由 host 注入 `QuotaView`（daemon 会在启动时读取 `~/.routecodex/quota/provider-quota.json` 并转为只读 view）。
  - [x] 过滤 `inPool !== true` 或仍处于 `cooldownUntil / blacklistUntil` 窗口内的 provider。
  - [x] 按 `priorityTier` 做 tier 调度（与当前池子轮询逻辑解耦）。
  - [x] 为 quota 驱动的路由行为补充单元测试 / 集成测试：
  - [x] 针对 `inPool`/`cooldownUntil`/`blacklistUntil`/`priorityTier` 构造 view，验证 virtual-router 在不同阶段的入池 / 出池决策与预期一致。
  - [x] 确保在未启用 `ROUTECODEX_QUOTA_ENABLED` 时行为与现有生产逻辑完全一致（向后兼容）。

### Phase Q5：错误中心切换到 daemon + quota（分阶段替换健康管理）

> 目标：保持现有 providerErrorCenter / RouteErrorHub / ErrorHandlerRegistry 作为“观测与聚合层”，将真正的健康/熔断/流控决策迁移到 daemon + quota center 中，virtual-router 只通过 quota 快照决定能否入池与优先级。

- [ ] Q5.1 旁路订阅：为 daemon 增加错误事件 sink（不改现有行为）
  - [x] 在 ManagerDaemon 中新增 quota-error-sink 模块（现为 `ProviderQuotaDaemonModule`）：
    - [x] 启动时通过 `getProviderErrorCenter()` 订阅 `providerErrorCenter`，监听 `ProviderErrorEvent`，抽取 `providerKey` / `status` / `code` / `timestamp` / fatal 标记。
    - [x] 将事件映射为 `ErrorEventForQuota` + `ProviderErrorEventRecord`，调用 `appendProviderErrorEvent` 写入 `~/.routecodex/quota/provider-errors.ndjson`，并使用 `applyErrorEvent` 驱动内存中的 `QuotaState`。
  - [ ] （可选）在 RouteErrorHub 或 ErrorHandlerRegistry 中增加只读 sink：
    - [ ] 针对 `rate_limit_error` / `provider_error` / `SSE_DECODE_ERROR` 等错误模板，将 `providerKey` / `status` / `code` 额外投递给 quota-error-sink，补充未通过 providerErrorCenter 进入的错误信号。

- [x] Q5.2 虚拟路由器读取 quota 快照，弱化 engine-health 的 rate-limit 决策
  - [x] 在 virtual-router 初始化/路由决策中新增可选 `QuotaView` 扩展点：
    - [x] 当 `ROUTECODEX_QUOTA_ENABLED=1` 时由 host 注入 `QuotaView`（daemon 读写 `~/.routecodex/quota/provider-quota.json`）。
    - [x] 构建 provider 池时按快照过滤：`inPool !== true` 或仍处于 `cooldownUntil/blacklistUntil` 窗口的 provider 一律排除；按 `priorityTier` 做 tier 调度（含 forced/sticky 路径）。
  - [x] 在 `engine.ts` 中调整 `handleProviderError` 对 429 / series cooldown 的处理：
    - [x] 当 `QuotaView` 存在时，不再在 engine-health 内部做 429/backoff/series cooldown 等健康决策，避免与 daemon/quota-center 重复维护；长期熔断依赖 quota 快照。

- [x] Q5.3 将 QUOTA_DEPLETED / QUOTA_RECOVERY 决策从 virtual-router 迁到 daemon
  - [x] 调整 `QuotaManagerModule` 与 virtual-router 的关系（按 feature-flag 渐进）：
    - [x] 保留现有 `QUOTA_DEPLETED` / `QUOTA_RECOVERY` 事件格式，daemon (`ProviderQuotaDaemonModule`) 会据此更新 `QuotaState`（`inPool` / `cooldownUntil` / `blacklistUntil`）。
    - [x] 当 `QuotaView` 存在时，virtual-router 不再在 engine-health 中处理 QUOTA 事件（避免重复维护）。

- [ ] Q5.4 关闭 legacy 429 backoff，统一用 quota 管控
  - [ ] 梳理 `ErrorHandlerRegistry` 中默认注册的 429 backoff handler（`RateLimitHandlerContext` / `RateLimitHandlerHooks`）。
  - [ ] 在 quota daemon 完全接管 429 限制后：
    - [ ] 将 429 handler 改为仅发送 telemetry（调用 hooks.errorCenter.handleError），不再发起 `processWithPipeline` 重放；或
    - [ ] 通过 feature flag（例如 `ROUTECODEX_RATE_LIMIT_HANDLER=legacy`）控制是否启用老的 HTTP 层 429 backoff 逻辑。

- [ ] Q5.5 集成测试与回退策略
  - [ ] 新增 quota+错误中心集成测试套件：从固定错误序列驱动 daemon + quota center，生成 `provider-quota.json`，启动 virtual-router 使用 QuotaView，验证入池/出池行为与预期一致（包含 429、其它错误、fatal 错误与 QUOTA_DEPLETED/RECOVERY）。
  - [ ] 确保所有切换点（QuotaView、生效的 error sink、engine-health rate-limit 逻辑、429 backoff handler）都受环境变量控制，必要时可逐项回退到旧行为。
