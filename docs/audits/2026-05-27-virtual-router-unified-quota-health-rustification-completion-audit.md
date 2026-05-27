# 2026-05-27 Virtual Router unified quota/health rustification completion audit

## 索引概要
- L1-L9 `scope`: 本次 audit 目标与证据边界
- L11-L31 `done-definition`: 按计划 Done Definition 1-7 逐条核验
- L33-L58 `test-matrix`: 测试/Shadow/Replay 覆盖矩阵当前态
- L60-L73 `build-smoke`: build/install/runtime smoke 当前态
- L75-L83 `verdict`: 当前结论与剩余缺口

## 范围
本 audit 对照：
- `docs/goals/virtual-router-unified-quota-health-rustification-plan.md`
- `docs/agent-routing/10-runtime-ssot-routing.md`

核验原则：
- 只接受当前仓库文件与本轮命令输出作为硬证据；
- 历史 `note.md` 只作为索引，不直接代替当前态证明；
- 若证据只能证明“局部通过”而不能证明“计划要求的全量完成”，状态记为“未完成”或“弱证”。

## Done Definition 逐条核验

### 1. Rust 成为 quota/health/availability 唯一真源
- 当前证据：
  - unified runtime second ingress 已物理删除的 focused proof：`tests/manager/quota/quota-manager-module.spec.ts`
  - public mutate fallback 已 fail-fast 的 focused proof：
    - `tests/server/daemon-admin/quota-rust-host-mutate-contract.spec.ts`
    - `tests/server/daemon-admin/quota-rust-host-setquota-control-contract.spec.ts`
  - route decision same-shape shadow proof：
    - `tests/sharedmodule/virtual-router-quota-shadow-compare-native.spec.ts`
    - `tests/sharedmodule/virtual-router-quota-health-shadow-regression.spec.ts`
- 反证/缺口：
  - `sharedmodule/llmswitch-core/src/router/virtual-router/health-manager.ts`
  - `sharedmodule/llmswitch-core/src/router/virtual-router/engine/cooldown-manager.ts`
  - `sharedmodule/llmswitch-core/src/quota/quota-manager.ts`
  这些 TS 壳/状态仍在仓库中，虽然当前主链依赖面已大幅收缩，但尚未完成计划 Phase E 所要求的“纯桥接/展示壳化或物理删除”的全量审计证明。
- 结论：弱证，未完成。

### 2. route decision 不再依赖 TS 第二决策中心
- 当前证据：
  - `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/virtual-router-quota-view-second-center-native.spec.ts tests/sharedmodule/virtual-router-quota-shadow-compare-native.spec.ts tests/sharedmodule/virtual-router-last-provider-quota-view-native.spec.ts tests/sharedmodule/virtual-router-quota-health-shadow-regression.spec.ts tests/sharedmodule/virtual-router-quota-resetat-multikey-native.spec.ts tests/sharedmodule/virtual-router-last-provider-quota-resetat-native.spec.ts`
  - 结果：6 suites / 12 tests 全绿。
  - 这些用例当前证明：TS `quotaView` 污染前后，Rust-only 与 TS-poisoned 的 route decision / singleton recoverable hint / multi-key reroute same-shape 等价。
- 结论：已证（focused 范围内）。

### 3. last-provider guard 稳定生效
- 当前证据：
  - `tests/sharedmodule/virtual-router-health-last-provider.spec.ts`
  - `tests/sharedmodule/virtual-router-last-provider-quota-resetat-native.spec.ts`
  - `tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`
  - `tests/server/runtime/http-server/request-executor.spec.ts` 中 recoverable cooldown wait / singleton wait 相关用例
- 当前态验证：这些 tests 已在本轮 focused 集合中通过（见下方 focused regression）。
- 结论：已证（focused 范围内）。

### 4. quota exhausted 只冻结当前 providerKey；多 key 隔离稳定
- 当前证据：
  - `tests/sharedmodule/virtual-router-quota-resetat-multikey-native.spec.ts`
  - `tests/sharedmodule/virtual-router-quota-health-shadow-regression.spec.ts` 的 `quota exhausted with resetAt remains providerKey-isolated...`
- 关键当前态真相：multi-key case 下，providerA 的 quota 会冻结，route 改到 providerB；同时当前 Rust health 允许 providerA 处于 `tripped`，这不构成 second center 回归。
- 结论：已证（focused 范围内）。

### 5. 最后一个 provider 永远不能被永久打空，只允许短暂冷却后恢复可选
- 当前证据：
  - `tests/sharedmodule/virtual-router-last-provider-quota-resetat-native.spec.ts`
  - `tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`
  - `tests/server/runtime/http-server/request-executor.spec.ts` 中 singleton recoverable cooldown wait
- 结论：已证（focused 范围内）。

### 6. Rust 单测、shadow/replay、focused regression、build:dev、installed binary/runtime smoke 全部通过
- Rust 单测：
  - 已直接执行 full Rust gate：`cargo test -p router-hotpath-napi virtual_router_engine -- --nocapture`。
  - 结果：`100 passed / 0 failed`。
  - 期间唯一 blocker 是 `virtual_router_engine::health::tests::test_aggressive_ban_auto_trip_on_threshold` 的旧测试叙事把第三次失败后的 cooldown TTL 写死为 `90_000ms`；当前 Rust 真相实际是 `DEFAULT_COOLDOWN_MS` 固定窗口。唯一正确修改点是 `health.rs` 内测断言，不是运行时 health 主链实现。
  - 结论：已证。
- shadow/replay：
  - 已执行 `node scripts/tests/virtual-router-quota-health-shadow-regression.mjs`，通过。
  - 已执行 focused shadow compare Jest 集合，当前通过。
  - 但计划要求的是“固定 replay/shadow 输入集 + 收敛报告入口”；当前仓内虽有脚本/专用 gate，但还没有一份 requirement-by-requirement 的完整 replay 输入清单与收敛报告。
  - 结论：弱证，未完成。
- focused regression：
  - 已执行：
    `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts tests/sharedmodule/virtual-router-health-last-provider.spec.ts tests/servertool/virtual-router-quota-health-override.spec.ts tests/server/runtime/http-server/request-executor.spec.ts tests/sharedmodule/virtual-router-quota-health-shadow-regression.spec.ts tests/sharedmodule/virtual-router-quota-shadow-compare-native.spec.ts tests/sharedmodule/virtual-router-quota-view-second-center-native.spec.ts tests/sharedmodule/virtual-router-last-provider-quota-view-native.spec.ts tests/sharedmodule/virtual-router-quota-resetat-multikey-native.spec.ts tests/sharedmodule/virtual-router-last-provider-quota-resetat-native.spec.ts`
  - 结果：`10 suites / 56 tests` 全绿。
  - 补充说明：Jest 进程尾部仍提示 open handles，但测试断言结果本身已全绿。
  - 结论：已证。
- `npm run build:dev`：
  - 本轮已通过 build + install:global + 全局 CLI E2E。
  - 结论：已证。
- installed binary / runtime smoke：
  - install:global 成功；CLI E2E 成功。
  - 但本轮 `routecodex restart` 输出：`No RouteCodex server found on localhost:5555`，所以“managed restart 成功”本轮不能成立。
  - 结论：部分已证，runtime smoke 未完整闭环。

### 7. 旧 TS 重复逻辑已物理删除或收缩成纯桥接/展示壳，无长期双真源残留
- 当前证据：
  - unified runtime second ingress 已删除
  - unified public mutate fallback 已删除
  - host-driven TS second-center writer 已删除
- 缺口：
  - 本轮 inventory 进一步确认：计划文档里写到的 `sharedmodule/llmswitch-core/src/router/virtual-router/health-manager.ts` 与 `.../engine/cooldown-manager.ts` 在当前仓库并不存在；当前仍承载 TS quota/availability 语义的真实残余 owner 主要是：
    - `sharedmodule/llmswitch-core/src/quota/quota-manager.ts`
    - `src/manager/modules/quota/quota-manager.ts`
    - `src/manager/modules/quota/quota-adapter.ts`
    - `src/manager/modules/quota/provider-quota-daemon*.ts`
  - 这些文件当前已明显收缩为 host snapshot / hydration / persistence / admin view / legacy shell 混合体，但还没有完成逐文件“纯桥接/展示壳 or 仍属活跃语义 owner”的最终判定表。
- 结论：未完成。

## 测试 / Shadow / Replay 覆盖矩阵当前态

### 已直接执行并通过
- `node scripts/tests/virtual-router-quota-health-shadow-regression.mjs`
- `tests/sharedmodule/virtual-router-quota-health-shadow-regression.spec.ts`
- `tests/sharedmodule/virtual-router-quota-shadow-compare-native.spec.ts`
- `tests/sharedmodule/virtual-router-quota-view-second-center-native.spec.ts`
- `tests/sharedmodule/virtual-router-last-provider-quota-view-native.spec.ts`
- `tests/sharedmodule/virtual-router-quota-resetat-multikey-native.spec.ts`
- `tests/sharedmodule/virtual-router-last-provider-quota-resetat-native.spec.ts`

### 已直接执行并通过（较大 focused 集）
- `tests/server/runtime/http-server/request-executor.spec.ts`
- `tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`
- `tests/sharedmodule/virtual-router-health-last-provider.spec.ts`
- `tests/servertool/virtual-router-quota-health-override.spec.ts`

### 仍缺的强证据
- 完整 replay 输入集 + 收敛报告
- 当前最终版 10-file focused 集合全绿一次性输出

## build / install / runtime smoke 当前态
- `npm run build:dev`：通过。
- `install:global`：通过。
- `routecodex --version`：通过（0.90.2301，本轮构建产物）。
- 全局 CLI E2E：通过。
- `localhost:5555` restart：未完成；本轮输出为 `No RouteCodex server found on localhost:5555`。

## 当前结论
1. 当前 closeout 已非常接近 Done Definition，但仍不能宣称总目标完成。
2. 当前最主要缺口不是新的运行时真源 bug，而是 completion audit 所需的最终强证据仍不完整：
   - 缺 Rust-only test gate 现跑证据；
   - 缺完整 replay/shadow 收敛报告；
   - 缺 TS residue inventory / Phase E 收尾清单；
   - 缺 runtime smoke 中“有运行中 5555 服务并成功刷新”的当前态证据。
3. 因此当前状态应定为：
   - 主链 focused 语义：大体已证；
   - 计划全量完成：未证，目标继续保持 active。
