# RouteCodex Mock 测试覆盖计划

---

# CI/CD 从零构建计划（基于现有模块 + regression）

> 目的：把“本地可验证”的 build/test/regression 变成可重复、可审计的 CI 门禁，并为 release（`@jsonstudio/rcc`）提供可控的 CD 流水线。

## 现状盘点（已验证）

- 现有 CI：`.github/workflows/test.yml` 仅跑 sharedmodule 部分测试（4 个 spec），未覆盖主包 `npm test`（含 `mock:regressions`）。
- 本仓库可复用的验证脚本（来自 `package.json`）：
  - `npm run build:min`：构建 `dist/`（不包含 dev 全验证栈）
  - `npm run test`：`test:routing-instructions` + `mock:regressions`
  - `npm run lint:strict` / `npm run format:check`：静态检查
  -（重型）`npm run build:dev`：包含大量 verify + `install:global`，不适合作为 CI 默认门禁（会改全局环境）

## 会话标识回传（session_id / conversation_id）

> 需要确认：是否要求 **HTTP 响应回传**入口 `session_id` / `conversation_id`（便于客户端复用会话/对话标识、实现 sticky/stop-message 等能力）？

### 当前代码行为（已在仓库内代码中核对）

- 入口解析已做：Host 会把入站 headers 快照到 `metadata.clientHeaders`，并调用 llmswitch-core 的 `extractSessionIdentifiersFromMetadata()` 写入 `metadata.sessionId` / `metadata.conversationId`（`src/server/runtime/http-server/index.ts`）。
- 上游转发已做：Provider 会透传入站 `session_id` / `conversation_id` 到上游；Codex UA 模式下还会在缺失时生成并注入到上游请求头（`src/providers/core/runtime/http-transport-provider.ts`，并由 `scripts/verify-client-headers.mjs` 覆盖）。
- 回传客户端 **目前不保证**：Host 只透传“上游响应头”（上游返回了相关 header 才会出现在客户端响应里），不会基于入口 metadata 主动注入 `session_id` / `conversation_id`。

### 待决策 & 任务（建议纳入 CI 回归门禁）

- [ ] 明确回传 header 名称（建议：至少回 `session_id`/`conversation_id`；必要时镜像 `anthropic-session-id`/`anthropic-conversation-id`）。
- [ ] 明确策略：仅“有则回传”还是“缺失也生成并回传”。
- [ ] 若需要回传：
  - [ ] 在 `RouteCodexHttpServer.executePipeline()` 返回前，向 `PipelineExecutionResult.headers` 注入 `session_id` / `conversation_id`（不覆盖上游同名 header）。
  - [ ] 覆盖 JSON + SSE + error 三条路径（尤其是 `respondWithPipelineError()`）。
  - [ ] 新增 e2e regression：请求带 `session_id` / `conversation_id`，断言响应必携带。

## 设计原则（与 Working Agreement 对齐）

- CI 只做“验证”，不做“修复/回退/热补丁”；失败必须 fail fast。
- 不在 CI 中做全局安装（`install:global` / `install:release`），避免污染 runner。
- 不提交/不缓存进 git：`dist/`、tarball、token、OAuth 凭据、`~/.routecodex` 运行态数据。
- 分层验证：PR 门禁用 deterministic + offline 回归；nightly 才跑长耗时/联网 smoke（可选）。

## 任务拆解（用此文件跟踪）

### Coverage 90% 标准（每个模块）

> 目标：CI 对每个“模块（module）”强制覆盖率 ≥ 90%（branches/functions/lines/statements），并且覆盖率报告可追溯、可复现。

#### 模块边界（建议先这样定义，后续可调整）

- **host/server**：`src/server/**`
- **providers**：`src/providers/**`
- **config**：`src/config/**`
- **tools & cli**：`src/tools/**` + `src/commands/**`
- **sharedmodule/llmswitch-core**：`sharedmodule/llmswitch-core/src/**`（单独 job/单独 jest config）

#### 覆盖率采集策略（落地方式）

- [ ] 为主包新增 CI 专用 coverage 配置（例如 `jest.ci.config.js`）：
  - [ ] `collectCoverageFrom` 仅包含已纳入门禁的模块路径（避免“一刀切 src/** 导致现阶段无法达标”）。
  - [ ] `coverageThreshold` 设置为：
    - [ ] `global` 作为兜底（90%）
    - [ ] 每个模块路径单独设阈值（90%），确保“模块级标准”真正生效。
- [ ] 为 sharedmodule 单独新增 coverage job：
  - [ ] 在 `sharedmodule/llmswitch-core` 目录运行其自己的 test/coverage（或在根仓库用独立 jest config 覆盖 `sharedmodule/llmswitch-core/src/**`）。

#### 覆盖率门禁上线策略（避免一次性打爆主分支）

> 标准是 90%，但需要分阶段把模块逐个纳入门禁，否则 CI 会因历史未覆盖代码大面积失败。

- [ ] Phase A（立即）：只对“已有回归测试覆盖的模块”启用 90% 门禁（例如 server/runtime + tools/bridge 相关）。
- [ ] Phase B：逐模块补齐测试，把 providers/config 等逐步纳入门禁，直到覆盖上述全部模块。
- [ ] Phase C：清理或迁移当前 `jest --coverage` 下无法通过的历史测试（只做与覆盖率门禁相关的最小修复）。

### Phase 0：明确 CI 门禁范围

- [ ] 列出 PR 必跑项（建议：`npm ci` + `npm run build:min` + `npm run test` + `npm run lint:strict` + `npm run format:check`）。
- [ ] 决定 Node 版本策略（建议：Node 20 为主；是否加 Node 18 matrix）。
- [ ] 明确哪些脚本允许联网（默认：`mock:regressions`/单元测试必须离线；联网 smoke 放 nightly）。

### Phase 1：搭建 CI（PR/push）

- [ ] 新增/重构 GitHub Actions：`.github/workflows/ci.yml`
  - [ ] job: `ci`（最小门禁）：
    - [ ] `actions/checkout@v4`
    - [ ] `actions/setup-node@v4`（cache npm）
    - [ ] `npm ci`
    - [ ] `npm run build:min`
    - [ ] `npm run test`（含 regression）
  - [ ] job: `lint`（可并行）：
    - [ ] `npm ci`
    - [ ] `npm run lint:strict`
    - [ ] `npm run format:check`
  - [ ] 加 `concurrency` 防止同分支并发浪费 runner
  - [ ] 失败时上传必要的 debug artifact（仅测试输出，不含密钥）
- [ ] 替换/合并现有 `.github/workflows/test.yml`（避免重复跑、避免漏跑）。
- [ ] 在 README 加 CI badge（可选）。

### Phase 2：增强一致性/可维护性

- [ ] 增加 `npm run ci`（聚合上面 CI 步骤，便于本地复现）。
- [ ] 让 sharedmodule 测试并入同一套 CI（保留原来的 spec，但纳入统一 job）。
- [ ] 对“是否需要构建 sharedmodule dist”给出明确策略：
  - [ ] 若 PR 触及 `sharedmodule/llmswitch-core/src/**`，则在 CI 中先在该目录 `npm ci && npm run build && npm test`（或现有矩阵脚本）。
  - [ ] 未触及 sharedmodule，则只跑主包测试。

### Phase 3：CD（release 仅针对 `@jsonstudio/rcc`，routecodex 不发布）

- [ ] 新增 `.github/workflows/release-rcc.yml`
  - [ ] 触发：tag（如 `rcc-v*`）或手动 workflow_dispatch
  - [ ] `BUILD_MODE=release npm run build:min`（或 `npm run build`，视 pack 脚本需要）
  - [ ] `node scripts/pack-mode.mjs --name @jsonstudio/rcc --bin rcc`
  - [ ] 上传产物 `jsonstudio-rcc-*.tgz` 到 GitHub Actions artifact / GitHub Release assets
  - [ ]（可选）有 `NPM_TOKEN` 才执行 `npm publish`，否则只产出 tarball
- [ ] 明确版本策略（tag 驱动 vs package.json 驱动，避免构建自动 bump 影响可追溯性）。

### Phase 4：Nightly（可选）

- [ ] nightly 跑长耗时检查：`npm run test:comprehensive` / `npm audit` / `depcheck`（挑选对你们最有价值的 1-2 项起步）。
- [ ] nightly 可跑“联网 smoke”（例如 provider 兼容探测），但必须：
  - [ ] 使用 GitHub Secrets 注入 token
  - [ ] 严格遮蔽日志中的 Authorization
  - [ ] 不写入 repo、不写入 artifact

---

## 背景

完善 mock-provider 回归覆盖，确保工具调用与协议兼容在 CI 前可验证。

## 目标

1. 构建基于 Virtual Router classifier 的 codex 样本分类脚本
2. 完善 mock provider 测试，特别是 apply_patch 与工具调用兼容性
3. 确保所有新样本在加入 CI 前通过验证

## 执行计划

### 新增：基于 codex-samples 的统一回归框架

> 目标：用一套样本（来自 `~/.routecodex/codex-samples`）同时驱动 sharedmodule 单元/形状测试 + 主包 mock-provider 端到端回归，覆盖各入口协议与主要 provider。

#### A. 样本与注册表基础设施

- [x] 完成 `scripts/mock-provider/extract.mjs`：
  - [x] 支持 `--req <requestId>` / `--all` 从 `~/.routecodex/codex-samples/{openai-chat|openai-responses|anthropic-messages}` 抽取 `*_client-request.json` / `*_provider-request.json` / `*_provider-response.json`。
  - [x] 统一落盘到 `samples/mock-provider/<entry>/<providerKey>/<stamp>/`，并生成 `request.json` / `response.json` / 可选 `client-request.json`。
  - [x] 维护 `_registry/index.json`，记录 `reqId` / `entry` / `providerId` / `path` / `tags`。
- [x] 修复 codex-samples 快照落盘分目录：第一层按入口 `entryEndpoint`（openai-chat/openai-responses/anthropic-messages）分类，第二层按 `providerKey`，避免因 provider 上游 endpoint（如 `/messages`）导致写入错误入口目录。
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
- [x] 创建 Virtual Router classifier 分类脚本

### Phase 2: Mock Provider 测试增强

#### 2.1 基础测试矩阵

- [x] Mock provider 基础实现
- [x] 普通工具调用测试
- [x] apply_patch 工具测试
- [x] shell command 测试

### Phase 3: 样本分类与筛选

#### 3.1 创建分类脚本

创建 `scripts/classify-codex-samples.mjs`：

```javascript
// 按 Virtual Router classifier 分类
- providerKey 分类（glm, gemini, openai, anthropic）
- 工具类型分类（apply_patch, shell, 普通工具）
- 识别 tool_calls 结构
- 标记未覆盖场景
```

#### 3.2 第一批覆盖目标

- [x] 普通工具调用：已有 mock samples
- [x] apply_patch：已有 `mock.apply_patch.toolloop`
- [ ] shell command：筛选复杂命令样本

### Phase 4: 测试文件组织

```
tests/servertool/
├── mock-provider-tests.spec.ts
├── apply-patch-compat.spec.ts
├── shell-command-compat.spec.ts
└── tool-loop-compat.spec.ts
```

### Phase 5: CI 集成检查清单

- [ ] 所有测试本地通过
- [ ] 工具参数归一化测试覆盖完整
- [ ] 测试运行时间 < 30s
- [ ] 无外部依赖
- [ ] CI 配置更新

## 下一步行动

1. 编写 `scripts/classify-codex-samples.mjs` 分类脚本
2. 从最新 codex samples 提取工具样本
3. 创建工具 mock 测试
4. 验证后集成到 CI
5. 记录并排期：全局安装的 iFlow CLI 需要在修复 stopMessage 问题后更新模型配置，确保：
   - `config.json` 与 `providers/iflow/*` 中的模型列表同步最新 iflow 模型库
   - GLM-4.7 的模型写法与 provider 要求一致（包括 key、alias、路由映射）
   - 在真实 CLI 环境里重新安装/链接后能够成功调用并完成一次完整对话验证
6. **统一 apply_patch 结构化转换**：在 chat-process 阶段实现 apply_patch arguments 的结构化 JSON → unified diff `{input, patch}` 规范化，移除各协议 codec 中的重复过滤器，确保所有入口（OpenAI、Responses、Anthropic、Gemini 等）共享同一逻辑。

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
