# RouteCodex V2 → V3 迁移审计报告

Date: 2026-08-04
Scope: 全仓审计，评估 V2 → V3 迁移现状、迁移完成度、剩余工作与执行顺序。

## 结论摘要（先给结论）

Jason，当前项目已从"V2 为主"切换为"V3 为主 + V2 收尾退役"阶段。V3 是生产主运行面（`rccv3` 二进制为 Rust Mach-O，入口 `dist/bin/rccv3 server start`），V2 已物理归档到 `deprecated/v2/`（32 文件，只读参考，无 runtime import）。**迁移方向正确，但未完成**：`src/` 仍有 490 TS 文件 / 97,783 LOC 在生产树中，其中相当比例是已退役 V2 兼容壳或待 Rust 接管的旧语义，需要按 owner 逐块退役。迁移本身是"渐进式 Rust 化收口"，不是一次性整目录搬移。

## 一、现状盘点（证据）

### 根目录布局（已按 2026-08-04 audit 锁定）
| Root | 分类 | 决策 |
| --- | --- | --- |
| `v3/` | V3 Rust workspace + 语义 runtime | 生产主源 |
| `sharedmodule/llmswitch-core` | 共享 Rust/NAPI/core | 保留，不复制进 v3 |
| `src/` | Node/TS 壳/CLI/IO/兼容 | 保留到逐模块 owner 审计退役 |
| `deprecated/v2/` | V2 归档 | 只读，32 文件 |
| `configsamples/`、`samples/`、`webui/` | 退役 V2 | 已移除 |
| `artifacts/`、`dist/`、`node_modules/` | 生成物 | 非源 |

### V3 Rust workspace
- `v3/Cargo.toml`：12 crates（config/debug/error/route-classifier/virtual-router/target/sse/provider-responses/runtime/server/lifecycle/cli）。
- 163 Rust 源文件。
- 入口：`v3/crates/routecodex-v3-cli`，安装命令 `rccv3`，默认配置 `~/.rcc/config.v3.toml`。
- V3 架构 map：58 function-map features、55 verification features、100 resources。

### 共享 Rust/NAPI
- `sharedmodule/llmswitch-core/rust-core/crates`：stop-message-core、route-classifier-core、traffic-governor-core、provider-compat-core、router-hotpath-napi、followup-core、servertool-core/servertool-cli、sse-transport-core。

### 生产运行面（已统一）
- `package.json` bin：`routecodex`/`rcc`/`rccv3` 全部指向 `dist/bin/rccv3`（Mach-O arm64 Rust 二进制）。
- `src/index.ts` 已物理删除；`verify:v3-rust-only-server-entry` 锁定禁止 `node dist/index.js` 复活。
- 实测运行：`rccv3 server run-managed-child`（PID 38966）监听 10000/5520/5555，版本 0.90.4116（install:v3 产出），health 报告 `version=3`。

### V2 退役进度
- `deprecated/v2/` 32 文件归档。
- `configsamples/`、`samples/`、`webui/` 已移除并 red-lock。
- `src/` 内仍有 V2 兼容壳（如 `src/providers/profile/families`、`src/client` 等）待逐块 owner 审计退役。

## 二、迁移完成度评估

| 维度 | 状态 | 说明 |
| --- | --- | --- |
| 入口/CLI 统一到 Rust | ✅ 完成 | `dist/bin/rccv3`，src/index.ts 删除，server-entry gate 锁定 |
| V3 Rust runtime 骨架 | ✅ 完成 | 12 crates，58 features，100 resources，managed lifecycle |
| Hub Pipeline Rust 化 | 🔶 进行中 | 有 master plan + 剩余 plan；TS 仍有 semantic debt |
| Provider transport 收敛到 Rust | 🔶 进行中 | provider-responses crate 在 v3；src/providers 18k LOC 待退役 |
| 错误链唯一中心 | 🔶 进行中 | V3ErrorHandlingCenter 已建；TS mapper/RouteErrorHub 第二/第三 owner 未清 |
| V2 物理归档 | ✅ 大部分完成 | deprecated/v2 + 移除 3 目录 |
| src TS 全量退役 | ❌ 未完成 | 490 文件 / 97,783 LOC 仍生产树 |

## 三、关键遗留问题

1. **src/ 退役未完成**：490 TS 文件 / 97,783 LOC。`src/server` 37,650 LOC 最大，其中大量是待 Rust 接管的 handler/executor/error 投影。需按 function-map owner + import graph 逐块判定退役。

2. **错误链 owner 未完全统一**：`verify:error-pipeline-contract` 通过，但 V2/TS map 仍注册 `src/server/utils/http-error-mapper.ts` 为 `error.client_projection` owner；chat/messages/config/admin 等 TS handler 仍有直拼 4xx/5xx；四种 Relay runtime failure wrapper 会把具体 enum 降格成 `V3HubRuntime` 丢失 source stage/kind。下一步要为 TS host 落 Rust typed Error01-06 bridge，再物理删除 TS mapper owner 与 handler 直拼路径。

3. **Relay `try_before_resp03!`** 将多种 typed runtime error `Err(error.into())` 抛到 server wrapper 再统一降格成 generic RuntimeFailure，丢失原始 source kind/stage 的分类精度。

4. **并行 worker 未完成项**：relay tool/servertool 多轮 parity、client inbound WebSocket、live provider compat 是 production cutover 的 prerequisite gates，未绿不得 production replacement。

## 四、迁移执行顺序（建议路径）

V3 runtime unification 已有 `docs/goals/v3-runtime-unification-production-cutover-plan.md` 收口。建议按序：

1. **锁 V3 单一 runtime entry**：所有 implemented entry 只经 `V3 Entry Protocol Endpoint Binding -> single V3 Runtime entry -> Target/Provider owner -> Server response projection`；未实现协议显式 `pending_not_implemented`。
2. **清错误链 owner**：TS host 落 Rust typed Error01-06 bridge，物理删除 `http-error-mapper.ts` 第二 owner 与 handler 直拼路径；Relay 错误保留 typed kind/stage。
3. **逐块退役 src/**：按 function-map owner + import graph 审计 `src/server`、`src/providers`、`src/modules`，只迁移已证明退役的 V2 模块到 `deprecated/v2/`；禁止整目录搬移。
4. **并行 worker 前置**：等 relay tool/servertool parity、client inbound WS、live provider compat 三绿，再执行 production cutover（global install / managed restart / health/model/sample replay / rollback evidence）。
5. **gate 接线**：`verify:v3-rust-only-server-entry`、error-chain、module-boundary、resource-edge-lock 已接入 build；确保每个退役动作补 red fixture 防复活。

## 五、当前可直接执行动作（不破坏、只读/收口）

- 本审计为只读，未改动任何源码、config、install、restart。
- 若 Jason 授权，下一步可：a) 落 `docs/goals/v3-src-retirement-audit-plan.md` 逐块退役 src/；b) 落 TS host typed Error01-06 bridge 计划；c) 在三个 prerequisite worker 绿后执行 production cutover checklist。
