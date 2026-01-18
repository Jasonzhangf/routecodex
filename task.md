# CI/CD 任务进度与模块修复记录

## 当前任务状态 (2026-01-18)

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
