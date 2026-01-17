# CI/CD 任务进度与模块修复记录

## 当前任务状态 (2026-01-18)

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
- [ ] 盘点 `src/cli.ts` 的命令清单与副作用（读写文件/网络/kill/spawn/`process.exit`），形成表格
- [ ] 明确每个命令的"输入/输出契约"（stdout/stderr、exit code、必选参数、默认值）

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
- [ ] 每迁移并通过测试后，删除 `src/cli.ts` 对应旧实现块（保持 `src/cli.ts` 最终只做入口转发）
- [ ] 每次删除都跑：`npm run build:dev`（包含现有 verify 链路）

---

## 说明
- Host CI 必须使用 release 模式的 @jsonstudio/llms（不依赖 sharedmodule 源码）
- Sharedmodule CI 由 llmswitch-core 仓库独立运行
- 每个模块 lint 清理完成后再推进下一个模块
- **lint 总计：171 warnings, 0 errors** (最新数据：2026-01-18)
