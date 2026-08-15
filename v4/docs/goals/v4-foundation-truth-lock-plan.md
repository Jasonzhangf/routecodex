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
- `.appsdk/maps/resource-map.json`：67 条，32 active / 32 design / 3 contract_bound；
  与 YAML 双源一致由 `v4_parity_gate_resource_binding` 机器锁校验。
- `v4_parity_gate_resource_binding` 已锁：binding_status 合法性、anchored 准入
  （owner_crate 存在 + gate 注册 + owner_symbols 在 crate 源码顶层声明 +
  .appsdk status=active）、design 无漂移、.appsdk 未登记 v4 资源（7/7 红测）。
- DSH review r1（commit `4bcf7c48b`）FAIL：P1 anchored 无代码符号绑定、
  P2 自测 case 5 覆盖错分支、计划文档计数过期；修复后需重审。
- DSH review r2（commit `9cc33f97e`）FAIL：P1 符号绑定是文本正则启发式
  （method/local 可误通过）、P2 计划文档残留过期断言、P2 anchored crate
  未纳入 `cargo test --workspace`（仅 test-consumer 编译，属已知 workspace
  gate 缺口）。r3 修复：符号声明收窄到列 0 顶层声明 + pub use，文档断言更新。
- DSH review r3（commit `a9417528b`）PASS（无 P0/P1），唯一 P2 为计划文档
  红测计数未同步 7/7；由 `40cd8cb9f` 修正。
- DSH review r4（commit `40cd8cb9f`）PASS（无 P0/P1），仅提示 review 轮次
  台账需补录；本行即补录 r3/r4 结果，随后 r5 复核。
- 完成标准 1（coverage 103/103）机器化：新增
  `v4/docs/architecture/v4-v3-abstraction-coverage.yml`（103 条六轴归类，
  information 23 / data 22 / control 44 / diagnostic 14）与
  `v4_parity_gate_v3_resource_coverage` 机器 gate（10/10 红测），校验
  v3 resource map 全量覆盖、kind_rules 一致性、轴计数与
  pipeline-abstraction.contract.json / parity map 声明一致。
- DSH review coverage-gate r1（commit `05648667a`）FAIL：P1 六轴不变量未在 V3 覆盖层
  校验（gate 只读 axis/operator_kind/status，未触碰 V3 的 may_enter_provider_body /
  may_enter_client_body / allowed_writers / allowed_readers）；P2 duplicate resource_id
  检查为死代码（Map 构造已去重）；P2 红测只覆盖 4 类，contract/parity 漂移分支无红测；
  P2 readYaml/readJson 未容错。修复 commit 内容见本行提交（git log
  `fix(v4): enforce six-axis plane invariants in v3 resource coverage gate`）：
  gate 现校验控制轴禁入 provider/client body、数据轴 allowed_writers 禁控制/调试 owner、
  诊断轴禁 live path 读取（已登记 dry-run / timing 两个诊断投影例外），红测扩展到 10/10。
  修复 commit：`e3e8719d5`。
- DSH review coverage-gate r2（commit `e3e8719d5`）reviewer 终稿为字面
  `VERDICT: PASS`（仅 P2，无 P0/P1、无“修复后再审”），但 dsh-mcp 裁决解析器误判 FAIL：
  解析器对 `**VERDICT: PASS**`（markdown 加粗）不识别，且把正文里 “the P0
  control/payload separation surface is not directly altered” 的 P0 词面误当 blocking
  finding。已修 dsh-mcp 解析器（去 markdown 强调 + P0/P1 仅按 finding 头行判定）。
  P2-1：控制轴“client_body 例外”为死分支（V3 源图 v3.error.client_projection 本身
  false/false），已删除例外分支并修正 model doc 口径（例外只在 V4 目标图
  v4.error.client_projection 派生投影，由 plane-isolation gate 校验）；
  P2-2：10/10 红测未接 CI，已新增 `verify:v4-foundation-red` npm script + CI step；
  P2-3：诊断红测改为显式目标 `v3.debug.artifact`（不再依赖矩阵排序）。
  修复 commit 见 git log `fix(v4): address dsh coverage-gate r2 P2 findings`；
  需 coverage-gate r3 重审。
- DSH review coverage-gate r3（commit `50d64bf0e`）reviewer 终稿 `VERDICT: PASS`
  （无 P0/P1，仅一条非阻塞 P2 观察：ledger 声称的 dsh-mcp 解析器修复不在 repo 内，
  需在工具自身变更控制中留痕），但 dsh-mcp 解析器对 “No P0 or P1 findings.” 仍误判
  FAIL（否定句中的 P0/P1 词面）；已补修 dsh-mcp 并在工具侧留痕，见
  `~/.agents/skills/dsh/CHANGELOG.md`。
- DSH review coverage-gate r4（commit `50d64bf0e`，解析器修复后重跑）机器 PASS：
  `state=completed, verdict=pass, reason=final_verdict_pass`，final 字面
  `VERDICT: PASS`、无 P0/P1、无“修复后再审”；唯一 P2 观察（dsh-mcp 修复需工具侧
  留痕）已由 `~/.agents/skills/dsh/CHANGELOG.md` 落地。完成标准 1
  （coverage 103/103）DSH 门禁闭环。
- 完成标准 2（GAP=0）尚未全量机器锁：checkpoint gap（26/26）与资源 gap（103/103）
  已锁；contract 声明的 feature GAP（`coverage_v3_features total=12 gaps=0`）
  无独立机器 gate（仅 parity gate 覆盖 26 个 checkpoint），需补 feature-GAP gate
  才算 criterion 2 完全闭环。
- 已记录 known gaps：target_triple、public_api_hash（派生非真 API 提取）、edge 再冻结、
  workspace gate 修正：runtime/config/control/error 四个 anchored crate 依赖
  `--extern` 注入，只经 build-link test-consumer 编译（CI `v4-active-link`
  job），未纳入 `cargo test --workspace`（见 `v4-active-artifact-linking-test-design.md` §5）。

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
