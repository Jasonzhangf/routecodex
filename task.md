# CI/CD 任务进度与模块修复记录

## 当前任务状态 (2026-01-18)

## Unified Hub Framework V1（逐步收口骨架）（更新：2026-01-18）

- 计划文档：`docs/plans/unified-hub-framework-v1.md`
- 目标：把参数白名单/字段布局/工具形态/ServerTool followup 等“政策”从分散实现，收敛到 llmswitch-core 的统一骨架（single execution path + 强制 policy + ProtocolSpec 注册表）。
- 当前基线（已具备）：HubPipeline 已捕获 `capturedChatRequest`，ServerTool followup 已实现 entry-aware payload 与统一 followup metadata（详见下方 “ServerTool followup 统一规范” 章节）。

### 里程碑（可回滚、按协议逐步收紧）

- [ ] Phase 0：PolicyEngine observe-only（不改写，只统计/快照）
- [ ] Phase 1：parameterPolicy 收口（provider outbound：sanitize/normalize/layout）
- [ ] Phase 2：toolSurface 收口（definition/call/result 形态统一 + 可配置 A/B）
- [ ] Phase 3：followup 收口完善（由 core 明确 followup protocol/metadata；Host 移除兜底修补）
- [ ] Phase 4：语义迁移到 Operation Table（协议只保留 wire ↔ ops 映射）
- [ ] Phase 5：删除旧路径 + CI/Lint 禁绕过（仅保留 ProtocolSpec + PolicyEngine + ops 执行器）

### 交付与门禁（每段必须满足：黑盒对比 + 回归通过 + 可渐进切换）

- **渐进式改造**：每个 Phase 都必须提供 `off → shadow(observe) → enforce → widen` 的切换路径，默认保持 `off` 或 `shadow`，并支持按协议/按 route 逐步开启。
- **黑盒对比（必须）**：在同一条输入上同时产生 baseline 与 candidate 的输出，并做稳定化 diff（忽略 requestId/timestamp 等非确定性字段），`diff=0` 才允许切换到 enforce。
- **完整回归（必须）**：每个 Phase 都要新增或更新对应的回归集（Jest + scripts），并在 CI 中可重复运行。

#### 黑盒对比基线工具（现有）

- 端到端重放 + 产物落盘：`scripts/replay-codex-sample.mjs`
- 黑盒对比（RouteCodex vs rccx）：`scripts/compare-codex-rccx.mjs`（包含稳定字段子集比较）
- 入站/出站 payload 对比（按 requestId）：`scripts/compare-responses-request.mjs`
- Anthropic 直通 vs 编解码对比：`scripts/anthropic-compare-modes.mjs`
- 多 provider 回归（基于 codex-samples）：`scripts/outbound-regression-codex-samples.mjs`

#### 统一错误归档（默认开启）

- Policy 违规/改写归档：`~/.routecodex/errorsamples/policy/**`（同时仍会写入 `~/.routecodex/codex-samples/__policy_violations__/`）
- 黑盒对比 diff 归档：`~/.routecodex/errorsamples/unified-hub-shadow/*.json`

#### Phase 0/1 开关（Host 注入，默认 enforce）

- 默认开启 enforce（Phase 1：Responses-first outbound policy；目前仅对 `openai-responses` 的 provider outbound 生效）：无需设置 env
- 显式关闭：`ROUTECODEX_HUB_POLICY_MODE=off`
- 显式启用 observe-only：`ROUTECODEX_HUB_POLICY_MODE=observe`
- 显式启用 enforce：`ROUTECODEX_HUB_POLICY_MODE=enforce`
- 可选采样率：`ROUTECODEX_HUB_POLICY_SAMPLE_RATE=0.25`（范围 [0,1]，未设置则全量记录）

#### 每个 Phase 的“必须有”的黑盒用例（建议最小集）

- Phase 0（observe-only）：输出不变 + 仅新增快照/统计（diff=0）
- Phase 1（parameterPolicy/layout）：provider outbound payload（JSON）必须一致；违规字段仅记录到 policy diff，不允许出站变更
- Phase 2（toolSurface）：工具循环（definition/call/result）在三条入口 `/v1/chat|responses|messages` 下必须结构一致（diff=0）
- Phase 3（followup）：servertool followup 的二/三跳请求必须 entry-aware 且 non-stream，且 Host 不再做协议修补（diff=0）
- Phase 4（Operation Table）：语义等价（semantic diff=0），允许实现路径变化但输出一致

### Phase 1 回归用例清单（parameters/layout 收口）

- `/v1/chat/completions` → outbound(OpenAI/Responses/Anthropic/Gemini) 方向：`providerPayload` 必须 diff=0（shadow 模式）
- `/v1/responses`：确保 provider outbound **不出现** `parameters` wrapper（已经有 sharedmodule 回归：`responses request must not include parameters wrapper regression passed`）
- 三类入口分别覆盖：
  - “仅 messages + parameters”
  - “含 tools（function tools）+ tool_choice”
  - “含 response_format / stop / seed / parallel_tool_calls”
- 非确定性字段处理：`requestId` 必须固定，diff 忽略 timestamp/随机字段（现有 compare harness 已固定 requestId）

#### Responses（首个落地点）

- 黑盒对比（compliant payload，允许切换前提）：`npm run test:unified-hub-responses-enforce`
- 渐进开关（Host）：`ROUTECODEX_HUB_POLICY_MODE=enforce`（先对 `/v1/responses` 入口 + responses provider 小流量灰度）

## 路由指令 / stopMessage / ServerTool（更新：2026-01-18）

### ✅ ServerTool followup 统一规范（不裁剪历史 + 入口一致 + entry-aware payload）
- 统一目标：所有 servertool 的 followup 都满足
  - 客户端/Provider 透明：不裁剪历史、不丢上下文
  - followup 统一走 chat process 入口语义（基于 capturedChatRequest + 最新响应组合）
  - followup metadata 记录原始入口端点，且禁用 sticky / routeHint 干扰
  - followup payload 根据入口端点自动选择 Chat/Responses/Anthropic 形状（entry-aware）
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts`
  - 在 Hub Pipeline 统一捕获 `metadata.capturedChatRequest`（model/messages/tools/parameters），并使用 `jsonClone` 深拷贝，避免后续就地修改污染快照。
- `sharedmodule/llmswitch-core/src/servertool/engine.ts`
  - followup 默认强制：`preserveRouteHint=false`、`routeHint=''`、`disableStickyRoutes=true`、`serverToolOriginalEntryEndpoint=<原始入口>`。
- `sharedmodule/llmswitch-core/src/servertool/handlers/followup-request-builder.ts`
  - 新增通用 builder：从 `capturedChatRequest` 提取 seed（兼容 `messages` / `input`），并构建 entry-aware followup payload。
- 受影响的 servertool（followup payload 统一 entry-aware）：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/web-search.ts`
  - `sharedmodule/llmswitch-core/src/servertool/handlers/vision.ts`
  - `sharedmodule/llmswitch-core/src/servertool/handlers/iflow-model-error-retry.ts`
  - `sharedmodule/llmswitch-core/src/servertool/handlers/exec-command-guard.ts`
  - `sharedmodule/llmswitch-core/src/servertool/handlers/apply-patch-guard.ts`
- 回归测试（已加入 `package.json#test:routing-instructions`）：
  - `tests/servertool/server-side-web-search.spec.ts`（新增：followup 对 `/v1/responses` 生成 `input` 形状）
  - `tests/servertool/vision-flow.spec.ts`（新增：followup 对 `/v1/responses` 生成 `input` 形状）
  - `tests/servertool/iflow-model-error-retry.spec.ts`（新增：followup 对 `/v1/responses` 生成 `input` 形状）
  - `tests/servertool/apply-patch-guard.spec.ts`（新增：/v1/responses followup 形状）
  - `tests/servertool/exec-command-guard.spec.ts`（新增：/v1/responses followup 形状）

### ✅ stopMessage followup 透明性
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
  - followup payload 基于 `capturedChatRequest` 深拷贝；兼容两种 capture 形状：
    - Chat 入口：`{ messages: [...] }`
    - Responses 入口：`{ input: [...] }`（先 `buildChatRequestFromResponses` 还原 messages，再构造 followup）
  - 追加「上一条 assistant 输出」+「stopMessage user 消息」。
  - `/v1/responses` followup 通过 `buildResponsesRequestFromChat(..., { stream:false, parameters })` 构建，避免丢失 `parameters` 且强制 non-stream。
  - followup metadata：`disableStickyRoutes: true`、`preserveRouteHint: false`、`serverToolOriginalEntryEndpoint`。
- `sharedmodule/llmswitch-core/src/servertool/engine.ts`
  - 支持 `preserveRouteHint=false`：followup 时清空继承的 `routeHint`，避免 sticky / routeHint 干扰。
- 测试：
  - `tests/servertool/stop-message-auto.spec.ts`
  - 已加入 `package.json` 的 `test:routing-instructions`（回归集）
  - 额外：followup 返回 `status:"requires_action"`（工具调用）时，不再被误判为“空 followup”并抛出 `SERVERTOOL_EMPTY_FOLLOWUP(502)`（见 `sharedmodule/llmswitch-core/src/servertool/engine.ts` + sharedmodule 回归脚本 `scripts/tests/servertool-followup-requires-action.mjs`）。

### ✅ Gemini 空回复自动续写（gemini_empty_reply_continue）透明性
- `sharedmodule/llmswitch-core/src/servertool/handlers/gemini-empty-reply-continue.ts`
  - followup payload 不裁剪历史；兼容两种 capture 形状（`messages` / `input`）。
  - followup 通过 `buildResponsesRequestFromChat(..., { stream:false, parameters })` 构建，避免 `parameters` 丢失/stream 冲突导致上游返回空 payload。
  - followup metadata：`disableStickyRoutes: true`、`preserveRouteHint: false`、`serverToolOriginalEntryEndpoint`。
  - 将本轮 assistant 内容（finish_reason=length 场景）写入 followup history，避免丢上下文。
- `sharedmodule/llmswitch-core/src/conversion/hub/semantic-mappers/gemini-mapper.ts`
  - 修复：Gemini outbound 构造 `functionCall.args` 时，对**全量历史** tool_calls 做参数别名对齐，确保与本次请求的 tool schema 一致，避免 Cloud Code 返回 `MALFORMED_FUNCTION_CALL` → 空回复 → `SERVERTOOL_EMPTY_FOLLOWUP`。
  - 覆盖的历史参数对齐（按 schema keys 裁剪）：
    - `exec_command`: `cmd` → `command`
    - `apply_patch`: `patch/input` → `instructions`（patch 文本走 string）
    - `write_stdin`: `text` → `chars`
- `src/providers/core/runtime/gemini-cli-http-provider.ts`
  - 对齐 gcli2api：在 provider 预处理阶段扁平化意外的 `payload.request` 容器，避免出现 `body.request.request.*` 的非法形状（可能导致上游忽略请求或返回空回复）。
- 测试：
  - `tests/servertool/gemini-empty-reply-continue.spec.ts`
  - `tests/providers/core/runtime/gemini-cli-http-provider.unit.test.ts`
  - `tests/sharedmodule/gemini-mapper-functioncall-args.spec.ts`（新增：history tool args 全量对齐回归）
  - 已加入 `package.json` 的 `test:routing-instructions`（回归集）
  - 🧪 可选上游端到端验证（默认跳过，需要本地 token）：`npm run verify:e2e-gemini-followup-sample`（需 `ROUTECODEX_VERIFY_ANTIGRAVITY=1`）
  - （可选，上游直连）`npm run smoke:antigravity`：直接用 `GeminiCLIHttpProvider` 打 Antigravity upstream，验证请求形状与响应不为空（含 3 次重试，避免上游偶发“thought-only”造成误报；不纳入默认回归，需本地 token）。

### ✅ Responses 工具回包：format="freeform" 参数形态
- `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`
  - 当客户端 raw tool 声明 `format:"freeform"` 时（例如 Codex 的 `apply_patch`），回包中的 `function_call.arguments` 输出为原始 patch 文本（非 JSON wrapper），避免客户端侧解析/执行失败。
- sharedmodule 回归脚本：`sharedmodule/llmswitch-core/scripts/tests/responses-freeform-tool-args.mjs`

### 🚧 apply_patch：Freeform（非 JSON Schema）透传 + 响应侧 Tool Governance 兼容（A/B）

目标：为 `apply_patch` 增加一个 **freeform（非 JSON schema）模式**，允许客户端在请求里以“透传/无 schema”的方式声明工具，并在**响应侧工具治理**里做兼容（后续用于 A/B 测试）。

#### 约束（必须遵守）
- 不返回 `status:"failed"` 形态的 Responses 回包（失败由客户端自行暴露/处理）
- 不静默失败：治理/桥接出错至少要有可追踪日志/采样；回包结构必须保持协议正确
- “能修就修”：允许做形态归一/别名修补；“修不了就退回原样”并让客户端报错

#### 任务拆分
1) **开关与 A/B 入口**
   - [x] 增加 env A/B 开关（全局）：`RCC_APPLY_PATCH_TOOL_MODE=freeform`（或 `RCC_APPLY_PATCH_FREEFORM=1`）
   - [ ] 在 Hub Pipeline capture 的 metadata 中记录本次请求使用的模式（用于 response stage 判定，后续做按请求 A/B）

2) **请求侧透传（Client tools Raw）**
   - [x] 允许客户端 tools 声明 `format:"freeform"` 且不提供 `parameters`（或 `parameters:{}`），不强制注入 apply_patch structured schema
   - [x] 确保 capture 的 `toolsRaw` 完整保留（顺序/字段不丢失），用于后续响应侧对齐（已在 Hub Pipeline 做 jsonClone）

3) **响应侧 Tool Governance（apply_patch）兼容**
   - [x] 识别 client tool format 为 freeform 时：治理内部仍可做 `apply_patch` 解析/修补，但**回传给客户端的 arguments 保持 freeform 文本**
   - [x] client tool 存在 JSON schema 时：维持 schema-aware 的 key 对齐/裁剪（修不了则回退原 arguments）
   - [x] freeform 模式错误快照写入 meta：`applyPatchToolMode`（用于区分按哪种风格修复）

4) **回归测试（必须纳入回归集）**
   - [x] 新增：freeform 模式下 `apply_patch` 的出站 arguments 保持为纯文本（Responses output + required_action 两条路径）
   - [x] 新增：schema 模式下 `apply_patch` key 对齐（cmd/command、patch/instructions 等）保持兼容
   - [x] 新增：freeform A/B 模式下不强制 apply_patch structured schema（tool mapping passthrough）
   - [x] 新增：治理失败时回包仍为协议正确工具调用（不引入 failed payload）

5) **端到端验证（可选，但建议）**
   - [ ] 启动 Antigravity upstream，走 Provider 直连（不通过 mock），用 errorsamples 中的负载跑 `apply_patch` tool call 循环
   - [ ] 对比 A/B 两种模式的 client 行为（是否能继续发 tool_result、是否会卡住）

### 📝 改进项：UPSTREAM_HEADERS_TIMEOUT / SSE headers timeout
- 现象：部分 upstream 在建立 SSE 时超过 ~30s 才返回 headers，触发 `UPSTREAM_HEADERS_TIMEOUT`。
- `src/providers/core/runtime/http-transport-provider.ts`
  - 新增 env 覆盖：
    - `ROUTECODEX_PROVIDER_STREAM_HEADERS_TIMEOUT_MS` / `RCC_PROVIDER_STREAM_HEADERS_TIMEOUT_MS`
    - `ROUTECODEX_PROVIDER_STREAM_IDLE_TIMEOUT_MS` / `RCC_PROVIDER_STREAM_IDLE_TIMEOUT_MS`
- 待评估：若用户配置了较短的 `ROUTECODEX_PROVIDER_TIMEOUT_MS`，headers timeout 仍可能受全局 timeout 约束，需要明确推荐值/分离策略。

### 🔍 现场问题：All providers unavailable for route longcontext（需要进一步可观测性）
- 现象：路由命中 `longcontext` 时出现 `PROVIDER_NOT_AVAILABLE`，日志只看到 message，缺少 “attempted” 细节（health/context/empty pool）。
- 待改进：在 debug 模式下输出 VirtualRouter 的 attempted 诊断（例如 `:max_context_window` / `:health`），便于快速定位。

### ✅ 已完成：Session ID 回传
- HTTP 成功响应路径：`src/server/runtime/http-server/index.ts`
- HTTP 错误响应路径：`src/server/handlers/handler-utils.ts`
- 回传 header: `session_id`, `conversation_id`（SSE + JSON 路径覆盖）

### ✅ 已完成：Host CI 修复
#### 根因：测试引用 sharedmodule 绝对路径，CI 环境无 sharedmodule 源码
- ✅ CI 已强制 `BUILD_MODE=release npm run llmswitch:ensure`
- ✅ jest 配置新增 moduleNameMapper，将 sharedmodule 源码路径映射到 npm 包
- ✅ 本地验证 `npm run test:routing-instructions` 通过

---

## 🔥 当前优先任务：Lint Warning 修复（模块逐步推进）

### 当前模块：`src/server/**` + `src/providers/**`
- ✅ 已修复：
  - **server 模块**:
    - 移除 `hasVirtualRouterSeriesCooldown` 未使用导入
    - `any` 类型修复为 `Record<string, unknown>` (3处)
    - 移除 `_followupTriggered/_maxAttempts/_attempt` 未使用变量
    - `buildRequestMetadata` 改为 async（支持动态 import session-identifiers）
    - 修复 `utf8-chunk-buffer.ts` 的 curly 警告（3处）
  - **providers 模块**:
    - 移除 `iflow-cookie-auth.ts` 未使用的 fs/path 导入
    - 移除 `oauth-lifecycle.ts` 未使用的导入（4个）
    - 移除 `antigravity-quota-client.ts` 未使用的 path 导入
    - 修复 `base-provider.ts` 参数命名（context → _context）
    - 修复 `http-request-executor.ts` 的 no-useless-catch 错误
    - 修复 `provider-error-reporter.ts` 的重复 providerKey + prefer-const
    - 修复 `camoufox-launcher.ts` 的 curly 警告（2处）
  - 新增 tsconfig 路径映射：`@jsonstudio/llms/dist/conversion/hub/pipeline/session-identifiers.js`

- 🚧 现存 warnings（171个）:
  - 主要分布：
    - `src/cli/**`: 约 60 个（未使用导入 + curly + any 类型）
    - `src/providers/**`: 约 80 个（any 类型 + 未使用变量 + curly）
    - `src/server/**`: 约 20 个（any 类型 + 未使用变量）
    - `src/modules/**`: 约 11 个

---

### 后续模块修复顺序（按模块逐步推进）
1. ✅ `src/server/**` - 初步清理完成
2. ✅ `src/providers/**` - 部分清理完成
3. ⏳ `src/cli/**` - 待清理
4. ⏳ `src/config/**` - 待清理
5. ⏳ `src/tools/** + src/commands/**` - 待清理
6. ⏳ `src/modules/**` - 待清理

---

## CLI 拆分计划：`src/cli.ts`（分阶段、可回滚）

> 目标：把 `src/cli.ts`（当前 >2000 行）拆成可测试的模块化结构；**先新增新实现并通过测试/验证**，再逐步移除旧代码。

### Phase 0（盘点，不改行为）
- [x] 盘点 `src/cli.ts` 的命令清单与副作用（读写文件/网络/kill/spawn/`process.exit`），形成表格（见 `docs/cli-command-inventory.md`，2026-01-18）
- [x] 明确每个命令的"输入/输出契约"（stdout/stderr、exit code、必选参数、默认值）（见 `docs/cli-command-inventory.md`，2026-01-18）

### Phase 1（可测试骨架）
- [x] 新增 `src/cli/runtime.ts`：`CliRuntime` 抽象（最小 writeOut/writeErr）+ `createNodeRuntime()`
- [x] 新增 `src/cli/main.ts`：`runCli(argv, runtime): Promise<number>`（不直接 `process.exit()`）
- [x] 新增 `src/cli/program.ts`：`createCliProgram(ctx): Command`（目前只做基础 wiring；尚未接管 `src/cli.ts`）
- [x] 新增 `tests/cli/smoke.spec.ts`：覆盖 `--help`、未知命令、返回码路径（当前仅覆盖 program 框架）

### Phase 2（抽公共工具，仍由旧命令逻辑驱动）
- [x] 迁移 `safeReadJson/normalizePort/host 归一化` 到 `src/cli/utils/*`
- [x] 迁移 `createSpinner/logger/version+pkgName 解析` 到 `src/cli/*`

### Phase 3（低风险命令迁移 + 单测）
- [x] 迁移 `env` → `src/cli/commands/env.ts`
- [x] 迁移 `port` → `src/cli/commands/port.ts`
- [x] 迁移 `examples` → `src/cli/commands/examples.ts`
- [x] 迁移 `clean` → `src/cli/commands/clean.ts`

### Phase 4（中风险命令迁移 + 单测）
- [x] 迁移 `config` → `src/cli/commands/config.ts`
- [x] 迁移 `status` → `src/cli/commands/status.ts`

### Phase 5（高风险：server 生命周期命令迁移 + 集成测）
- [x] 迁移 `start` → `src/cli/commands/start.ts`
- [x] 迁移 `restart` → `src/cli/commands/restart.ts`
- [x] 迁移 `stop` → `src/cli/commands/stop.ts`

### Phase 6（迁移 `code` 命令 + 单测）
- [x] 迁移 `code` → `src/cli/commands/code.ts`

### Phase 7（删除 legacy 代码，逐段验收）
- [x] 抽出 `env/clean/examples/port` 注册到 `src/cli/register/basic-commands.ts`，并从 `src/cli.ts` 移除对应注册块（2026-01-18）
- [x] 验证：`npm run build:dev`（2026-01-18）
- [x] 抽出 `status/config` 注册到 `src/cli/register/status-config-commands.ts`，并从 `src/cli.ts` 移除对应注册块（2026-01-18）
- [x] 验证：`npm run build:dev`（2026-01-18）
- [x] 抽出 `stop` 注册到 `src/cli/register/stop-command.ts`，并从 `src/cli.ts` 移除对应注册块（2026-01-18）
- [x] 验证：`npm run build:dev`（2026-01-18）
- [x] 抽出 `restart` 注册到 `src/cli/register/restart-command.ts`，并从 `src/cli.ts` 移除对应注册块（2026-01-18）
- [x] 验证：`npm run build:dev`（2026-01-18）
- [x] 抽出 `start` 注册到 `src/cli/register/start-command.ts`，并从 `src/cli.ts` 移除对应注册块（2026-01-18）
- [x] 验证：`npm run build:dev`（2026-01-18）
- [x] 抽出 `code` 注册到 `src/cli/register/code-command.ts`，并从 `src/cli.ts` 移除对应注册块（2026-01-18）
- [x] 验证：`npm run build:dev`（2026-01-18）

---

## 说明
- Host CI 必须使用 release 模式的 @jsonstudio/llms（不依赖 sharedmodule 源码）
- Sharedmodule CI 由 llmswitch-core 仓库独立运行
- 每个模块 lint 清理完成后再推进下一个模块
- **lint 总计：171 warnings, 0 errors** (最新数据：2026-01-18)
