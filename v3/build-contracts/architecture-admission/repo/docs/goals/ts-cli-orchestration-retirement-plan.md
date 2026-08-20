# TS CLI 编排层退役计划（含 guardian）

Date: 2026-08-05
Status: design（目标态）
Scope: 退役 V2 TS CLI 编排层（cli.ts + start/stop/restart/launcher/guardian），收敛到 Rust `rccv3` CLI。

## 1. 现状（证据）

- 生产已全 Rust：唯一 RouteCodex 进程 = `rccv3 server run-managed-child --config ~/.rcc/config.v3.toml`（PID 38966，Rust `~/.local/bin/rccv3`）。无 guardian、无 `node dist/cli.js`。
- guardian（HTTP 注册表守护进程 /health /register /stop /lifecycle，记录 source:pid→port/tmux/metadata）是 V2 TS CLI 编排层（launcher/start/restart ensureGuardianDaemon）的进程登记表，不承担 server 生命周期。V3 server 的 tmux 引用仅是请求 scope 头解析（x-rcc-tmux-session-id），非 guardian 进程编排。
- Rust CLI（`v3/crates/routecodex-v3-cli`）Command enum 覆盖：Config(Check)、Start、Status、Restart、Stop。Rust `V3ManagedLifecycle` 用 run-managed-child 子进程托管，不依赖 guardian。
- TS CLI 编排层仅在 `INSTALL_V2_MODE=1`（install 脚本 --v2 标志，默认 0）时被要求（dist/cli.js）。默认 V3 安装不需要。blackbox 测试 import `dist/server/handlers/*`（不是 cli.js）。
- guardian 深嵌 TS CLI：src/cli.ts、launcher-kernel（2000+ 行）、start/stop/restart、guardian-daemon-command、user-data-paths、http-health-probe + tests（guardian-client.spec、stop-command.spec、http-health-probe.spec）。

## 2. 退役边界

- 退役单元：整个 TS CLI 编排层（cli.ts + cli/register/* + cli/commands/{start,stop,restart,launcher*,guardian*,code,claude,codex,clean,env,hook,port,run,servertool,status}）。因 guardian 被 start/stop/restart/launcher 共同依赖，不能单点删 guardian。
- 前置：Rust CLI 需覆盖 TS CLI 的用户可见语义（start/stop/restart/status/config check 已覆盖；launcher/guardian 是 V2 特有多进程/tmux 编排，生产不用）。确认 `rccv3` 的 stop/restart 与 TS CLI 行为等价（含 tmux 会话清理、guardian 登记清理）。
- 测试迁移：`tests/cli/*`（guardian-client.spec、start-command.spec、stop-command.spec、port-utils.spec、restart-command.spec、code-command.spec）+ blackbox 若调用 TS CLI 需改走 Rust 或删除。
- `verify-v3-rust-only-server-entry` 禁 `node dist/index.js`（server 入口），不禁 `dist/cli.js`（CLI 入口）。退役 TS CLI 后应扩展该 gate 禁 `dist/cli.js`/guardian 复活。

## 3. 分步执行

### Phase A：确认 Rust CLI 语义覆盖（已完成决策）
- 已确认生产全 Rust rccv3，guardian 无生产调用。guardian 可退役。
- 待补：Rust `rccv3 stop/restart` 与 TS CLI 行为等价验证（含 tmux/guardian 登记清理）。

### Phase B：TS CLI 依赖盘点 + Rust 补齐
- 完整盘点 TS CLI 编排层用户命令（start/stop/restart/status/launcher/guardian/code/claude/codex/clean/env/hook/port/run/servertool）。
- Rust CLI 补齐缺失命令（若有生产用途）或确认废弃（V2 特有）。
- 确认 Rust `rccv3 stop/restart` 语义等价。

### Phase C：退役 TS CLI 编排层
- 移除 cli.ts 对 guardian/launcher 的调用；确认依赖清零后物理删除退役的 cli/register + cli/commands，禁止迁入 deprecated/ 保留死实现。
- 迁移/删除 tests/cli/* 依赖 TS CLI 的测试。
- 扩展 verify-v3-rust-only-server-entry 禁 `dist/cli.js`/guardian 复活。

### Phase D：build 去 TS CLI 产物
- `build:base` 不再要求 dist/cli.js（已默认 INSTALL_V2_MODE=0）。
- 移除 INSTALL_V2_MODE 相关 dist/cli.js 校验（或标记废弃）。

### Phase E：全仓 Rust-only gate
- 扩展全仓 Rust-only gate 覆盖 CLI 编排层。

## 4. 风险与规避
- 风险：退役 guardian 破坏 start/stop/restart（都依赖）。规避：整层退役（Phase C），非单点删；先确认 Rust CLI 语义覆盖。
- 风险：tests/cli/* 依赖 TS CLI。规避：Phase C 迁移/删除。
- 风险：Rust stop/restart 语义不等价。规避：Phase B 等价验证。
- 风险：guardian 复活。规避：Phase C 扩展 gate 禁 dist/cli.js。

## 5. 完成定义
- TS CLI 编排层（cli.ts/register/commands/guardian）确认依赖清零后物理删除，无生产调用、无 deprecated 副本。
- Rust `rccv3` 覆盖 start/stop/restart/status/config check 用户语义，等价验证 PASS。
- tests/cli/* 迁移或删除；verify-v3-rust-only-server-entry 禁 dist/cli.js 复活。
- build 不要求 dist/cli.js；全仓 Rust-only gate 覆盖 CLI。

## 6. 当前状态
- Phase A 决策完成（guardian 可退役，生产全 Rust）。
- 未执行退役动作（涉及 launcher-kernel 2000+ 行 + 多测试，需 Rust CLI 语义确认后分步做）。
