# CI/CD 任务进度与模块修复记录

## 当前任务状态 (2026-01-17)

### ✅ 已完成：Session ID 回传
- HTTP 成功响应路径：`src/server/runtime/http-server/index.ts`
- HTTP 错误响应路径：`src/server/handlers/handler-utils.ts`
- 回传 header: `session_id`, `conversation_id`（SSE + JSON 路径覆盖）

### 🔧 当前优先任务：Host CI 失败修复

#### 根因：测试引用 sharedmodule 绝对路径，CI 环境无 sharedmodule 源码
- 失败样例：
  - `tests/servertool/virtual-router-quota-routing.spec.ts`
  - `tests/servertool/virtual-router-series-cooldown.spec.ts`
  - `tests/server/runtime/request-executor.single-attempt.spec.ts`

#### 解决策略：Host 测试统一使用 release 模式的 @jsonstudio/llms
- ✅ CI 已强制 `BUILD_MODE=release npm run llmswitch:ensure`
- ✅ jest 配置新增 moduleNameMapper，将 sharedmodule 源码路径映射到 npm 包
  - `../../sharedmodule/llmswitch-core/src/* → @jsonstudio/llms/dist/*`
  - `../../../../sharedmodule/llmswitch-core/dist/* → @jsonstudio/llms/dist/*`

#### 本地验证
- ✅ `npm run test:routing-instructions` 通过

---

## 下一阶段：Lint Warning 修复（模块逐步推进）

### 当前模块：`src/server/**`
- ✅ 已修复部分 mixed-tabs、unused imports
- ⛳️ 目标：清零 server 模块 warnings
- 现存 warning 需要继续清理：
  - `src/server/runtime/http-server/routes.ts`（any 类型）
  - `src/server/runtime/http-server/stats-manager.ts`（any 类型）
  - `src/server/runtime/http-server/request-executor.ts`（unused var）
  - `src/server/utils/utf8-chunk-buffer.ts`（var-requires）
  - `src/server/utils/warmup-storm-tracker.ts`（unused var）

### 后续模块修复顺序（按模块逐步推进）
1. `src/server/**`
2. `src/providers/**`
3. `src/config/**`
4. `src/tools/** + src/commands/**`
5. `sharedmodule/llmswitch-core`（独立 CI）

---

## CLI 拆分计划：`src/cli.ts`（分阶段、可回滚）

> 目标：把 `src/cli.ts`（当前 >2000 行）拆成可测试的模块化结构；**先新增新实现并通过测试/验证**，再逐步移除旧代码。

### Phase 0（盘点，不改行为）
- [ ] 盘点 `src/cli.ts` 的命令清单与副作用（读写文件/网络/kill/spawn/`process.exit`），形成表格
- [ ] 明确每个命令的“输入/输出契约”（stdout/stderr、exit code、必选参数、默认值）

### Phase 1（可测试骨架）
- [x] 新增 `src/cli/runtime.ts`：`CliRuntime` 抽象（最小 writeOut/writeErr）+ `createNodeRuntime()`
- [x] 新增 `src/cli/main.ts`：`runCli(argv, runtime): Promise<number>`（不直接 `process.exit()`）
- [x] 新增 `src/cli/program.ts`：`createCliProgram(ctx): Command`（目前只做基础 wiring；尚未接管 `src/cli.ts`）
- [x] 新增 `tests/cli/smoke.spec.ts`：覆盖 `--help`、未知命令、返回码路径（当前仅覆盖 program 框架）

### Phase 2（抽公共工具，仍由旧命令逻辑驱动）
- [x] 迁移 `safeReadJson/normalizePort/host 归一化` 到 `src/cli/utils/*`
- [ ] 迁移 `createSpinner/logger/version+pkgName 解析` 到 `src/cli/*`
- [ ] `src/cli.ts` 改为调用新模块（行为不变）

### Phase 3（低风险命令迁移 + 单测）
- [x] 迁移 `env` → `src/cli/commands/env.ts`（已替换 `src/cli.ts` 的 env 命令注册；保留行为一致）
- [x] 迁移 `port` → `src/cli/commands/port.ts` + `tests/cli/port-command.spec.ts`
- [x] 迁移 `examples` → `src/cli/commands/examples.ts` + `tests/cli/examples-command.spec.ts`
- [x] 迁移 `clean` → `src/cli/commands/clean.ts` + `tests/cli/clean-command.spec.ts`

### Phase 4（中风险命令迁移 + 单测）
- [x] 迁移 `config` → `src/cli/commands/config.ts` + `tests/cli/config-command.spec.ts`
- [x] 迁移 `status`（端口探测/health check）→ `src/cli/commands/status.ts` + `tests/cli/status-command.spec.ts`（stub fetch+config）

### Phase 5（高风险：server 生命周期命令迁移 + 集成测）
- [ ] 抽 `src/cli/server/*`：pidfile / port-probe / kill / start-server 等
- [ ] 迁移 `start/restart` 到 `src/cli/commands/*`
- [x] 迁移 `stop` → `src/cli/commands/stop.ts` + `tests/cli/stop-command.spec.ts`
- [ ] 增加最小集成测试：临时 config + 随机端口启动 server，等待 `/health`，再 stop（不得静默失败）

### Phase 6（迁移 `code` 命令 + 单测）
- [ ] 迁移 `code` → `src/cli/commands/code.ts`
- [ ] 测试只校验参数拼装与解析（stub spawn），不真的启动 `claude`

### Phase 7（删除 legacy 代码，逐段验收）
- [ ] 每迁移并通过测试后，删除 `src/cli.ts` 对应旧实现块（保持 `src/cli.ts` 最终只做入口转发）
- [ ] 每次删除都跑：`npm run build:dev`（包含现有 verify 链路）

---

## 说明
- Host CI 必须使用 release 模式的 @jsonstudio/llms（不依赖 sharedmodule 源码）
- Sharedmodule CI 由 llmswitch-core 仓库独立运行
- 每个模块 lint 清理完成后再推进下一个模块
