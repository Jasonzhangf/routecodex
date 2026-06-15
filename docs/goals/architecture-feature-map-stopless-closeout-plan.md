# Architecture Feature-Map Stopless 三件套一致性收口计划

> Owner: Jason
> Theme: 修复 stopless 域 feature_id 三件套（function-map / verification-map / source anchor）双侧注册不一致，使 `verify:architecture-feature-map-growth-discipline` + `verify:architecture-feature-id-anchors` 全 PASS，恢复 `install-global.sh` 的 `build:min` 链可用
> Date: 2026-06-14
> Status: pending (out-of-scope of direct-path-error-reroute-and-candidate-exhaustion-plan)
> 触发来源: docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md P4-A wiring 收口时被该 gap 阻塞 install

## 0. 触发现状（已实测）
- `pnpm run verify:function-map-compile-gate` 在 65 features 扫到两条 stopless 双侧不一致：
  1. `hub.servertool_stopless_transparent_continuation` (function-map line 208 已在)
     - source anchor 缺（已尝试补 `stopless_orchestration_contract.rs` header，验证 anchor PASS）
     - 但补 anchor 后立即触发 `verify:architecture-feature-map-growth-discipline` 新 fail：source anchor 存在但 `verification-map` 缺条目
  2. `hub.servertool_stopless_cli_projection_seed` (反向)
     - source anchor 在 `cli_contract.rs` 已存在
     - 但 `function-map` 缺条目（verification-map 状态待查）
- 影响：`install-global.sh` 调起的 `build:min` 链强制走 `verify:function-map-compile-gate`，任何子 gate 失败即 abort install → 无法刷新 runtime dist
- 与本计划（direct-path 错误流 P4-A）的关联：**仅是 install/restart 链被阻塞**，不是 P4-A 自身业务回归

## 1. 目标
1. `hub.servertool_stopless_transparent_continuation` 三件套一致：function-map 已在 → 补 verification-map 条目（unit/contract/smoke/build/notes）+ 补 source anchor（如未补）
2. `hub.servertool_stopless_cli_projection_seed` 三件套一致：source anchor 已在 → 补 function-map 条目（owner_kind/owner_module/canonical_builders/allowed_paths/forbidden_paths/required_tests/required_gates/notes） + verification-map 条目
3. 跑 `pnpm run verify:function-map-compile-gate`（13 子 gate）全 PASS
4. 重跑 `install-global.sh` 成功 + 三端口 `/health` 绿 + live `/v1/responses` SSE 完成
5. 收口汇报 + MEMORY.md 提炼

## 2. 唯一修改点
| ID | 文件 | 修改类型 | 目的 |
|----|------|----------|------|
| S1 | `docs/architecture/function-map.yml` | 新增 | `hub.servertool_stopless_cli_projection_seed` 条目（owner_module / allowed_paths / forbidden_paths 复用 cli_contract.rs 与其 native bridge） |
| S2 | `docs/architecture/verification-map.yml` | 新增 | `hub.servertool_stopless_transparent_continuation` 条目（unit/contract/smoke/build/notes） |
| S3 | `docs/architecture/verification-map.yml` | 新增 | `hub.servertool_stopless_cli_projection_seed` 条目（unit/contract/smoke/build/notes） |
| S4 | `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs` | 改 | header 补 `// feature_id: hub.servertool_stopless_transparent_continuation`（最小一行） |
| S5 | （若 function-map S1 允许的 owner_path 下没有任何 anchor 文件）`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs` | 检查 | 已有 `// feature_id: hub.servertool_stopless_cli_projection_seed`？如缺则补 |

> 注：S5 仅在 `rg -n 'feature_id: hub.servertool_stopless_cli_projection_seed' sharedmodule/ src/ tests/` 不命中时执行；否则跳。

## 3. 验证
- `pnpm run verify:function-map-compile-gate` 13 子 gate 全 PASS（重点：`verify:architecture-feature-map-growth-discipline` / `verify:architecture-feature-id-anchors` / `verify:architecture-owner-queryability`）
- `pnpm run verify:servertool-rust-only`（确认 stopless 域 Rust-only 约束未破）
- `npx tsc --noEmit`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`
- 三端口 `/health`（5555 / 5520 / 10000）绿 + live `/v1/responses` SSE `response.completed` + `response.done`

## 4. 反向测试
- 删掉任一 anchor / function-map / verification-map 条目 → 三件套 gate 必须 fail（防止单边失守）
- `hub.servertool_stopless_transparent_continuation` 与 `hub.servertool_stopless_cli_projection_seed` 必须双向命中 function-map ↔ verification-map
- 若新增 stopless 子特性（如 stopless_followup_xxx），必须按同样三件套登记；不得让 install 链再次被新缺口打断

## 5. 完成信号
1. 65 features 全部三件套一致（`verify:architecture-feature-map-growth-discipline` 输出 0 fail）
2. install-global.sh 完整跑通；`routecodex --version` 升级；`~/.rcc/install/current` 指向新 snapshot
3. 5555/5520/10000 `/health` 全绿；live `/v1/responses` SSE 完成
4. 直接复用本计划 P4-A 已有的 5 spec focused Jest + 5 个相关 gate 重跑确认无回归

## 6. 风险与边界
- 本计划**只动 function-map / verification-map / 一行 anchor 注释**，不写任何业务代码
- 若发现 stopless 域有更深缺口（e.g. servertool-core 的 module mod 链路缺导出），独立开新 plan 收口；不在本计划扩范围
- 完成本计划后才能让 `direct-path-error-reroute-and-candidate-exhaustion-plan.md` 的 install / live / MEMORY 提炼解阻塞
