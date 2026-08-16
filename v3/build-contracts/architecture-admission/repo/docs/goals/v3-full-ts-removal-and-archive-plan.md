# V3 全量 TS 移除 + 无用归档执行计划

Date: 2026-08-04
Status: design（目标态，非现状）
Scope: 全仓移除 TypeScript 生产代码，其余无用统一归档/移除，最终 V3 全 Rust。

## 1. 目标与验收标准

目标：把仓库收敛为 Rust 唯一真源。`src/`（TS）全量退役，其余无用（configsamples/samples/webui/退役 V2/死代码）统一归档或物理移除。最终 `npm run build` 不再需要 `tsc`，运行时不再有 node TS 入口。

验收标准：
- `src/` 全量 TS 文件退役到 `deprecated/`（有 owner 依据）或物理删除（已证明死代码）。
- `dist/` 不再由 `tsc` 编译产出 TS 产物；只保留 Rust 二进制 + 必要 assets。
- 无任何生产进程以 `node dist/*.js` 或 `tsx src/*.ts` 启动业务（guardian/launcher 等编排迁到 Rust）。
- `verify:v3-rust-only-server-entry` 扩展为"全仓 Rust-only"门禁，锁死 TS 复活。
- 所有退役/删除动作逐块 owner 核实，禁脚本批量替换；每块补 red fixture 防复活。

## 2. 现状盘点（证据，2026-08-04）

| 项 | 值 |
| --- | --- |
| `src/` TS | 490 文件 / 97,783 LOC（tsc 一对一产出 dist 490 js） |
| `dist/` | 490 js（tsc 编译产物）+ `bin/rccv3`（Rust Mach-O） |
| V3 Rust workspace | 12 crates / 163 .rs / 58 features / 100 resources |
| `sharedmodule/llmswitch-core` | src 已 0 TS（全 Rust + assets + json） |
| `deprecated/v2/` | 32 文件归档 |
| `configsamples/` `samples/` `webui/` | 已移除 + red-lock |
| 生产 server | `dist/bin/rccv3 server start`（Rust），监听 10000/5520/5555，0.90.4116 |

### 关键运行面事实
- `src/index.ts` 已物理删除；`verify:v3-rust-only-server-entry` 锁禁 `node dist/index.js`。
- `src/cli.ts`（484 行）仍是完整 TS CLI，编译为 `dist/cli.js`。
- guardian daemon 仍以 `node dist/cli.js __guardian-daemon` 运行（实测 PID 2192），监听 localhost:50415。
- Rust CLI（`v3/crates/routecodex-v3-cli/src/main.rs`）已覆盖 `server start/status/stop` 等；**未覆盖** guardian daemon、launcher、restart/stop/start 编排、code/claude/codex 命令、guardian 客户端。
- `build:base` 仍跑 `tsc`（`node scripts/gen-build-info.mjs && tsc && node scripts/copy-v3-cli-bin.mjs`）。

## 3. 退役边界与前置依赖

### 不能直接删（有生产引用，需 Rust 先接管）
- guardian daemon + 客户端：`src/cli/commands/guardian-daemon.ts`、`src/cli/guardian/client.ts`、`src/utils/managed-server-pids.ts`、`src/cli/commands/launcher*.ts`、`start/restart/stop` 编排。
  → Rust CLI 需新增 guardian 等价能力（HTTP 守护进程 + 生命周期编排），或确认 guardian 可退役（server 已 Rust 托管）。
- `src/cli.ts` 及其 register/commands：TS CLI 全量入口。
- 被 `dist/cli.js` / guardian 加载的 `src/config`、`src/constants`、`src/server/utils` 等依赖。

### 可先归档/删除（死代码或已 Rust 接管）
- `sharedmodule/llmswitch-core/src` 已 0 TS，其 package.json/jest/tsconfig/tsbuildinfo 若不再被消费可归档。
- `src/` 内已证明退役的 V2 模块（需逐块 owner 审计）。
- `dist/` 内除 `bin/rccv3` 外的 490 ts 编译 js（tsc 停产后不再产出）。
- 残留 `configsamples/` `samples/` `webui/`（已 red-lock，确认无引用后归档）。

## 4. 分阶段执行顺序

### Phase A：确认 guardian 退役可行性（决策点）
- 判定：guardian daemon 是否还需保护 Rust 托管 server？若 Rust `V3ManagedLifecycle` 已提供重启/健康/守护，guardian TS 可退役。
- 产出：决策记录 + Rust 等价能力清单。未决前不删 guardian 相关 TS。

### Phase B：Rust CLI 编排收口
- 把 guardian/launcher/restart/stop 编排迁到 Rust CLI（或确认 Rust 已覆盖）。
- 完成后 `dist/cli.js` 无生产引用，TS CLI 退役。

### Phase C：src/ 逐块 owner 审计退役
- 按 function-map owner + import graph 审计 `src/server`（37,650 LOC）、`src/providers`（18,229）、`src/modules`（7,902）、`src/cli`（10,051）等。
- 只迁移已证明退役的模块到 `deprecated/`；禁整目录搬移。

### Phase D：build 管线去 TS
- `build:base` 移除 `tsc` 步骤；`tsconfig.json`/`jest.config.js` 停用或归档。
- `dist/` 只保留 Rust 产物 + 必要 assets。

### Phase E：无用统一归档
- 死代码/退役 V2/残留生成物统一归档 `deprecated/` 或删除，补 red fixture 防复活。

### Phase F：全仓 Rust-only gate
- 扩展 `verify:v3-rust-only-server-entry` 为全仓 Rust-only 门禁，接入 build。

## 5. 风险与规避
- 风险：guardian 未迁就删，断生产守护/重启。规避：Phase A 先决策。
- 风险：删 `dist/cli.js` 依赖的 config/constants，断 guardian。规避：Phase B 先收口。
- 风险：tsc 停产但某模块仍被 runtime 引用。规避：逐块 owner 审计 + import graph。
- 风险：整目录搬移违背 AGENTS P0。规避：逐文件 apply_patch/定向 mv + 证据。
- 风险：死代码误删导致 gate 失败。规避：每块先红后绿 + 引用核查。

## 6. 完成定义
- `src/` 全量退役；`dist/` 无 tsc 产物；无 node TS 生产入口。
- 全仓 Rust-only gate 接入 build 并 PASS。
- guardian/编排已 Rust 接管或有明确退役授权。
- 所有退役/删除逐块 owner 核实 + red fixture。
