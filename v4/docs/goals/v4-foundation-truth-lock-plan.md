# V4 Foundation Truth Lock Plan

## 目标

把 V4 foundation 从"功能绿但注册表半 design"推进到机器可审计的 truth 状态：
资源 binding_status 全部准确（anchored 或显式 design）、YAML 与 `.appsdk` JSON 双源一致、
binding 有机器 gate、DSH review PASS。之后再进入 Relay/Continuation slice。

## 验收标准

1. `v4/docs/architecture/v4-resource-operation-map.yml` 每个资源：
   - `binding_status: anchored` 必须有对应实现证据 + verification_gate + 资源关系测试；
   - 未实现资源显式 `binding_status: design` 并标注未来阶段，禁止无 gate。
2. 新增机器 gate `verify-v4-resource-binding.mjs`（或扩展既有 verify-v4 gate）校验：
   - anchored 资源的 owner_crate/owner_node/verification_gate/evidence 存在且 gate 在
     verification-map.json 注册；
   - YAML `binding_status` 与 `.appsdk/maps/resource-map.json` `status` 一致；
   - 禁止 anchored↔design 双源漂移。
3. 修复 `v4.control.metadata_center` 双源漂移（YAML=anchored / JSON=design 二选一，按证据定）。
4. 新 gate 接入 `verify:v4-foundation` + `.github/workflows/test.yml`。
5. 全量验证绿后跑 DSH review（opencode-go/deepseek-v4-flash），取得语义 PASS。
6. 只动 `v4/` + verify 脚本 + package.json + CI；不碰 v3。

## 范围

### In scope

- 资源注册表真源审计与状态修正（49 条逐个核对）。
- `.appsdk/maps/resource-map.json` 双源同步。
- binding_status 机器 gate + CI 接线。
- DSH review 门禁与 claim 关闭。

### Out of scope

- Relay / Continuation / Provider expansion / PluginManager / WebUI（后续阶段）。
- V3 任何改动、V3 工作树清理。
- 新增业务能力（新 provider/协议/endpoint/错误语义/routing/continuation 规则）。

## 当前缺口（2026-08-15 证据）

- `v4-resource-operation-map.yml`：49 资源，17 `anchored`（实现落地 + gate 绿），
  32 仍为显式 `design`（计划 owner 或未落地切片，禁止引用为真源）。
- `.appsdk/maps/resource-map.json`：67 条，31 active / 33 design / 3 contract_bound；
  与 YAML 双源一致由 `v4_parity_gate_resource_binding` 机器锁校验。
- `scripts/architecture/verify-v4-*.mjs` 无任何 `binding_status` / 双源一致性检查（无机器锁）。
- commit `23766d6cf` 尚未跑 DSH review（AGENTS §36 门禁未过）；claim 仍 `implementing`。
- 已记录 known gaps：target_triple、public_api_hash（派生非真 API 提取）、edge 再冻结、
  workspace gate 修正（见 `v4-active-artifact-linking-test-design.md` §5）。

## 实施步骤

1. 逐资源审计 49 条：有实现证据的标记 anchored（request/response/error/config/control
   已实现切片内资源），未实现的保留 design 并给 gate 豁免/阶段标注。
2. 同步 `.appsdk/maps/resource-map.json` status。
3. 新增 `scripts/architecture/verify-v4-resource-binding.mjs`，锁 anchored 准入 + 双源一致。
4. 接入 package.json `verify:v4-foundation` 与 CI。
5. 全量验证（cargo workspace + test-consumer + verify:v4-foundation + appsdk admission）。
6. DSH review，修复 findings 后重验重审（上限 5 轮）。
7. 关闭 claim、更新 MEMORY.md / note.md。

## 验证矩阵

- `cargo test --workspace --manifest-path v4/Cargo.toml`
- `cargo run ... test-consumer --consumer routecodex-v4-runtime ...`（各模块）
- `npm run verify:v4-foundation`（含新 resource-binding gate）
- `appsdk verify --admission v4`
- DSH review 语义 PASS

## DoD

- 49/49 全部收敛为准确状态（anchored 或显式 design），双源一致，机器 gate 绿，
  DSH review 语义 PASS。
