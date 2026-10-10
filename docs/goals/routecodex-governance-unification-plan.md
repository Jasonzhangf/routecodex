# RouteCodex 治理统一升级计划

## 1. 总目标与最终验收

把 RouteCodex 仓库内三个 AppSDK 受管项目根统一升级到当前全局 AppSDK
`0.1.0014`，让治理合同、验证准入、CI 与 Git hook 入口一致，并把升级结果
合入 `origin/main`。

总验收（全部满足才算完成）：

1. 根 `.appsdk`、`v3/.appsdk`、`v4/.appsdk` 的 `sdk.lock` 与
   `project.json#/sdk/version` 均为 `0.1.0014`，且 `sdk.bin` 不被提交。
2. 三个根分别执行 `appsdk verify --admission <project>` 返回 `ok:true`。
3. 三个根分别执行 `appsdk config check` 等价物与 `appsdk verify` 不出现
   `INVALID_DECLARED_ZONE_CONTRACT`、`NON_CANONICAL_RECORD_CONTRACT_SET`、
   `PROJECT_SDK_VERSION_PIN_MISMATCH`。
4. CI 与 Git hook 入口对三个根执行版本一致的准入检查；CI 不再 clone 旧
   `v0.1.5` 源。
5. 变更经独立 Review PASS，合入 `origin/main` 并有远端回执。
6. 自有 worktree、临时 run 目录、进程按交付合同回收或明确保留原因。

## 2. 范围与硬约束

允许：

- `.appsdk/**`、`.appsdk-prepare.json`、`docs/goals/**`
- `v3/.appsdk/**`、`v4/.appsdk/**`
- `.github/workflows/test.yml`、`.githooks/**`、与治理准入直接相关的
  `package.json` 脚本。三根共享准入门（`.githooks/verify-appsdk-admission.mjs`）
  与 hook 回归（`.githooks/tests/appsdk-admission-hook.mjs`）已从 `scripts/**`
  迁入 `.githooks/**`，落在允许列表内。

允许列表外、技术必需（**待用户裁定**）：

- `contracts/**`、`v3/contracts/**`、`v4/contracts/**`：项目自有治理合同，
  由 `appsdk pin-lock` 自动刷新。AppSDK 准入把字面前缀 `contracts/...` 硬编码
  为 canonical（`appsdk/rust/src/main/governance.rs:1215-1231` 的
  `NON_CANONICAL_GOVERNANCE_CONTRACT`，`contract_root` 以
  `root.join("contracts/...")` 解析），无法改指 `.appsdk/contracts/**`；
  `.appsdk/project.json#/governance/record_contracts` 与
  `zone_transition_contract` 直接引用根 `contracts/**`，回退任一文件即触发
  `DECLARED_RECORD_CONTRACT_MISMATCH`（`t0-probe-20261010` 已复现）。
- `.gitignore` 中 `!v4/.appsdk/contracts/memory/` 一行：使 v4 canonical
  memory 合同入库（与 root/v3 一致），属“治理合同”本体。

禁止：

- 修改 RouteCodex 运行时、协议、provider、payload、Rust 业务语义。
- 触碰 `.agent-collab/`、`~/.collab/`、`~/.appsdk/`、daemon 生命周期。
- 执行 `appsdk init --fresh --discard-legacy` 或任何 reset/migration
  破坏性入口。
- 手工删除 journals、mailbox、身份、任务、claim、worktree。
- 用 `--no-verify`、改 hooksPath、删 hook、降级断言绕过门禁。
- 覆盖他人 worktree、分支、进程或共享资源。

## 3. 已知事实与证据

- 全局二进制：`appsdk 0.1.0014 (rust)`，`/Users/fanzhang/.cargo/bin/appsdk`。
- 目标基线：`origin/main = e8d2296fed801dbd2120d7e5c81e074baa1955c4`。
- 根治理在 `origin/main` 上仍为 `0.1.7`；主检出有未提交的 `0.1.0014`
  升级，但未提交、未合并。
- `v3/.appsdk` 锁定 `0.1.7`；`v4/.appsdk` 锁定 `0.1.5`。
- 全新 worktree 上的实测失败：
  - 根 `appsdk verify .` -> `INVALID_DECLARED_ZONE_CONTRACT`
  - `appsdk verify v3` -> `INVALID_DECLARED_ZONE_CONTRACT`
  - `appsdk verify v4` -> `NON_CANONICAL_RECORD_CONTRACT_SET`
- 规范 zone 合同为
  `contracts/transitions/zone-transition.manifest.json`；历史别名
  `zone-transition-manifest.json` 必须刷新为同一正文。规范正文比仓库内旧稿
  多 `CollabLiveClosureRecordWhenParallel` 与 `forbidden_runtime_edges`。
- `v4/.appsdk/project.json` 的 `record_contracts` 缺少规范集合中的
  `collab-live-closure-record.schema.json` 等条目。
- CI 现状：`.github/workflows/test.yml:183` 的 `v4-appsdk-admission`
  只检查 `v4`，且 `git clone --branch v0.1.5`。`.githooks/pre-commit` 与
  `pre-push` 完全没有引用 `appsdk`。
- `appsdk requirements show` 返回 `not_established`；`.appsdk/requirements.json`
  不存在。
- 未提交的根治理改动集中在 `.appsdk/**` 与
  `docs/goals/routecodex-appsdk-0.1.0014-upgrade-note.md`。

## 4. 当前增量（本轮交付）

本轮只交付「三个治理根在 `0.1.0014` 上通过准入，并被 CI/hook 覆盖」这条可用
主线。目标之外的 backlog 修复、`requirements.json` 内容填充、agent 编排改造
保留为后续目标。

本轮必需能力与验收：

- 根：从 `origin/main` 起，在独占 worktree 重新执行 `0.1.7 -> 0.1.0014`
  升级，修正 zone 合同声明，`appsdk verify --admission` 通过。
- `v3`：升级到 `0.1.0014`，修正 zone 合同声明与 `record_contracts`，
  准入通过。
- `v4`：升级到 `0.1.0014`，规范 `record_contracts` 集合与 zone 合同，
  准入通过。
- CI/hook：三个根纳入同一准入检查，clone 源版本与锁一致。

本轮非目标：运行时行为修改、P0/P1 缺陷修复、`.agent-collab` 变更、daemon
动作、`--fresh --discard-legacy`。

## 5. 后续目标与依赖

- 目标 B：建立 `.appsdk/requirements.json` 并绑定会话授权条目；依赖本轮根
  治理基线落地。
- 目标 C：按 `appsdk bug list --status open` 优先级清理治理/门禁类 backlog
  （`7c73e4b`、`84ddb45`、`b72690f`、`7df66b6`、`b36d350` 等）；依赖目标 B。
- 目标 D：结案独立经验审计与规则沉淀。

## 6. 执行与验证

1. 先做 observation，交独立 `gpt-6.1-sol` planner 规划受影响 DAG 与最小改动。
2. 按依赖并行实现三个治理根与 CI/hook 入口，写入范围互不重叠。
3. 每个工作单元做作者自检：结构检查、`appsdk verify`、
   `appsdk verify --admission`、`git diff --check`。
4. 完整候选准备提交前，做一次独立 Review PASS。
5. 合入 `origin/main` 并核对远端回执；记录 candidate/main SHA 与证据。

## 7. 笔记与恢复

- 任务 note：`note.md`（仓库根），按 `coding-principals` 绑定总目标、本轮
  验收与节点结果。
- 外置 run 目录：
  `/Volumes/Intel/playground/routecodex/.worker-runs/governance-upgrade-20261010/`
- 恢复、派单、收口先读有效节点记录；局部 DONE 不关闭总目标。

## 8. T0 结论与本轮范围修订（2026-10-10）

独立 `gpt-6.1-sol` planner（run
`/Volumes/Intel/playground/routecodex/.worker-runs/governance-upgrade-20261010/planner/`）
返回 BLOCKED，理由是 `pin-lock` 白名单不接受 `0.1.7`，且普通 `init` 触发全局注册与
Collab 初始化。编排者在隔离 scratch worktree（`t0-probe-20261010`）做了决定性探针，
结论如下。

### 8.1 已证实的 T0 结论

- 安装二进制 `appsdk 0.1.0014` 的 `pin-lock` 白名单含 `0.1.0007` 但**不含 `0.1.7`**；
  直接跑返回 `UNSUPPORTED_SDK_MIGRATION:0.1.7:0.1.0014`（已复现，非仅源码推断）。
- `0.1.7` 与 `0.1.0007` 是**同一发行的两种命名**：appsdk commit
  `be10f2b8 release: bump appsdk to 0.1.0007` 把 `sdk-0.1.6-to-0.1.7.json` 重命名为
  `sdk-0.1.6-to-0.1.0007.json`、`0.1.7` -> `0.1.0007`。RouteCodex commit `6ac5dc87d`
  记录的正是 “0.1.6 -> 0.1.7” 这次官方 pin-lock。
- 因此把根/v3 声明的孤立别名 `0.1.7` 归一化为规范名 `0.1.0007`（等价重命名，非跳级），
  再执行官方 `pin-lock` 即走真实迁移链 `0.1.0007 -> ... -> 0.1.0014`。
- scratch 实测：
  - 根：归一化 + `pin-lock` -> `0.1.0014`，`verify --admission .` = `ok:true`。
  - v3：归一化 + `pin-lock` -> `0.1.0014`，`verify --admission v3` = `ok:true`。
  - v4：`pin-lock`（0.1.5 直迁）-> `0.1.0014`，record 集合补到规范 20 条，
    但 `verify --admission v4` 报 `ACTIVE_ARTIFACT_MISSING`。
- `pin-lock` 会自动刷新 zone 合同（`install_current_transition_contracts`）、record 集合
  与 bundle，无需手工拼锁。
- `init` 的副作用确认：`try_register_global_project` + `initialize_collab_peer` 会写全局
  注册与触发 `collab init`；按硬约束**本轮不跑 `init`**，`guide compile` 仅在实际
  guidance 变化需要时再评估。

### 8.2 v4 `ACTIVE_ARTIFACT_MISSING` 定性

- v4 有 4 个 frozen 模块（base-node/control/edge/error）及对应 freeze 记录，但
  `v4/active/lib/**` 在全新 worktree 为空。
- `v4/.gitignore:4` 忽略 `/active/lib/`，即 active 制品是**本地生成的交付物**，不进
  git。主检出本地存在这些制品，全新 worktree 与 CI 默认没有。
- 这是**既有交付类缺口**（promotion 生成物），不是 AppSDK 版本/合同问题；把
  `0.1.0014` 合同修好后它才从被掩盖状态暴露出来。
- 结论：v4 的**合同级**验收本轮可闭合；v4 的**交付级 admission**需要先生成 active
  制品（v4 构建/提升），超出“治理升级”本轮增量，列为后续目标并保留原始证据。

### 8.3 本轮范围修订

- 根、v3：归一化 `0.1.7 -> 0.1.0007` + `pin-lock` 到 `0.1.0014`；两种 verify 通过，
  `verify --admission` = `ok:true`。
- v4：`pin-lock` 到 `0.1.0014`；合同级错误（`NON_CANONICAL_RECORD_CONTRACT_SET`、
  `INVALID_DECLARED_ZONE_CONTRACT`、`PROJECT_SDK_VERSION_PIN_MISMATCH`）全部消失。
  交付级 `ACTIVE_ARTIFACT_MISSING` 记录为后续目标（需 v4 生成 active 制品）。
- CI/hook：三个根纳入版本一致的准入；CI 不再 clone 旧 `v0.1.5`；hook 绑定真实提交/推送内容。
- 验收第 2 条按根拆分：根/v3 交付级 admission `ok:true`；v4 交付级 admission 待后续
  制品目标，本轮以“合同级全绿 + 明确 typed 缺口”收口，不伪造 PASS。

### 8.4 后续目标（新增）

- 目标 E：生成/恢复 v4 active 制品，使 `verify --admission v4` 交付级通过，并让 CI
  的 v4 admission 具备可复现前置（构建/提升），否则 CI 不得把缺失制品当治理失败。

## 9. 执行结果与收口记录（2026-10-10）

### 9.1 worker 结果

- `sdk-roots`（T1+T2+T3）：DONE。根/v3 归一化 `0.1.7 -> 0.1.0007` 后 pin-lock 到
  `0.1.0014`；v4 直接 pin-lock 到 `0.1.0014`。根/v3 `verify --admission` `ok:true`；
  v4 仅剩 `ACTIVE_ARTIFACT_MISSING`。
- `ci-hook`（T4）：DONE 首轮；提供共享准入脚本、CI job、两个 hook；真实负向在
  fix / fix2 后补齐。
- `v4-artifact`：只读调查完成。实际 frozen 模块为 base-node/control/edge；
  `error` 为 `source_implemented`。官方闭合入口是 `appsdk rehydrate-frozen`，属目标 E。

### 9.2 独立 Review 与修复

- Review-1 FAIL（oauth / gpt-6.1-sol）：
  - P1 #1（需求授权来源）：已用用户粘贴并设为 active goal 的
    `pasted-text-1.txt` 作为权威原文补正，闭合。
  - P1 #2（v4 早退掩盖历史记录图检查）：fix 后对 v4 全部 `stage=frozen` 模块逐个
    `appsdk verify --review-admission v4 --module <id>`，全 `ok:true` 才记 delivery
    gap；真实损坏记录负向被拒。闭合。
- Review-2 FAIL：
  - P1（hook 导出树缺 Git 对象/refs）：fix2 后在 hook 临时导出树写入
    `gitdir: <absolute-git-dir>` 只读上下文，并以真实 AppSDK 走 pre-commit/pre-push
    两个入口完成正向与损坏记录负向黑盒。闭合。
- 集成另有发现：`.gitignore` 的 `memory/` 只有 root/v3 的 negation，导致
  `v4/.appsdk/contracts/memory/memory-entry.schema.json`（v4 sdk.lock /
  bundle manifest / sdk-resources 必需）不进入版本库。已加 `!v4/.appsdk/contracts/memory/`
  并把该 canonical 合同纳入候选；干净 checkout 复测通过。

### 9.3 当前候选状态

- 组合 worktree：`/Volumes/Intel/playground/routecodex/governance-upgrade-20261010`
- 根/v3/v4 `.appsdk/project.json` 与 `sdk.lock` = `0.1.0014`；无 tracked `sdk.bin`。
- 共享门：`node .githooks/verify-appsdk-admission.mjs .` -> exit 0，
  `CONTRACT_PASS ... delivery_gaps=1`；hook 真实正/负向回归
  （`.githooks/tests/appsdk-admission-hook.mjs`，`ROUTECODEX_REQUIRE_REAL_APPSDK_FIXTURE=1`）PASS。
- v4 交付级 `ACTIVE_ARTIFACT_MISSING` 按用户 goal 原文保留为 typed 缺口，后续目标 E。
- 待办：集成提交、独立 Review-3、合入 origin/main 与远端回执、资源回收。

## 10. 第二轮编排：范围裁定、收口与并发增量（2026-10-10）

### 10.1 范围扩展（待用户裁定，未授权）

Review-3 与 Review-4 连判同一 P1：候选改了用户原 goal 允许列表之外的路径。
用户原 goal 的允许列表（逐字）为：`.appsdk/**、.appsdk-prepare.json、
docs/goals/**、v3/.appsdk/**、v4/.appsdk/**、.github/workflows/test.yml、
.githooks/**、与准入直接相关的 package.json`。此前本文件与 requirements.md
把“继续并发执行”指令读作对该列表的扩展授权，reviewer 判定该指令不含授权；
现更正为**未授权、待用户裁定**。

下列路径超出允许列表，但验收第 2/4/5 条在技术上要求它们，均为已复现事实：

- `contracts/**`、`v3/contracts/**`、`v4/contracts/**`：`appsdk pin-lock`
  官方机制刷新的**项目自有治理合同**（`852414bc3` 已删除 SDK-source mirror，
  保留的 `contracts/records/**`、`contracts/transitions/**` 由
  `project.json#/governance/record_contracts` 声明）。AppSDK 准入把字面前缀
  `contracts/...` 硬编码为 canonical（`appsdk/rust/src/main/governance.rs:1228-1245`
  的 `NON_CANONICAL_GOVERNANCE_CONTRACT`，`contract_root` 以
  `root.join("contracts/...")` 解析），故无法改指 `.appsdk/contracts/**`；
  scratch `t0-probe-20261010` 中回退
  `contracts/records/evidence-record.schema.json` 到基线即 `appsdk verify .`
  失败 `DECLARED_RECORD_CONTRACT_MISMATCH`。
- 共享准入门与 hook 回归原在 `scripts/**`（越界）。**已迁入**已允许的
  `.githooks/verify-appsdk-admission.mjs` 与
  `.githooks/tests/appsdk-admission-hook.mjs`，并同步更新 `package.json`、
  `pre-commit`、`pre-push` 与回归内部引用；门与回归复测通过。此项越界已消除。
- `.gitignore` `!v4/.appsdk/contracts/memory/`：v4 `sdk.lock` / bundle /
  sdk-resources 声明的 canonical memory 合同必须入库，否则干净 checkout 缺文件。

当前越界面仅剩 `contracts/**`（含 v3/v4）与 `.gitignore` 一行。若用户授权这两项，
保留现候选直接进入提交/PR/merge；若不授权，则回退这两项，本轮只能收口到允许
列表内的合同/锁升级，验收第 2 条无法闭合，须如实报告范围阻塞。

### 10.2 阻塞链（必须闭合才能交付）

```text
范围裁定落盘 → Review-4（独立 oauth/gpt-6.1-sol，只读）
  → 提交候选（caveman-commit）→ push 分支 → PR → CI PASS
  → admin merge 到 origin/main（--match-head-commit）
  → 远端回执 + main 上三根准入复核 → 资源回收
```

### 10.3 并发增量（写入范围互不重叠）

| 通道 | 角色 | 内容 | 写入范围 | 依赖 |
| --- | --- | --- | --- | --- |
| L1 | review | Review-4 独立复核当前候选 | 只读候选 + `.agent-collab/review/review-4/**` | 无 |
| L2 | observe | 治理 backlog 盘点（目标 C 观察） | 仅 `.worker-runs/.../backlog/**` | 无 |
| L3 | observe | 目标 E：v4 active 制品（`appsdk rehydrate-frozen`）可行性与最小方案 | 仅 `.worker-runs/.../v4-artifact-e/**`，scratch worktree | 无 |

### 10.4 本轮 DoD

- Review-4 无 P0/P1 且 controller 判 PASS。
- 候选以可追溯 commit 合入 `origin/main`，远端回执与 main 内容等价。
- main 上三根准入复核结果与候选一致（根/v3 `ok:true`；v4 仅
  `ACTIVE_ARTIFACT_MISSING` typed 缺口）。
- L2/L3 交出可执行结论与下一步依赖，不擅自改目标。
- 自有 worktree / 进程 / 临时记录按交付合同回收或明确保留原因。

### 10.5 后续目标（本轮外）

- 目标 B：建立 `.appsdk/requirements.json` 并绑定会话授权条目（依赖本轮落地）。
- 目标 C：按 `appsdk bug list --status open` 清理治理/门禁类 backlog（依赖目标 B）。
- 目标 E：生成/恢复 v4 active 制品，使 `verify --admission v4` 交付级通过。
- 目标 D：结案独立经验审计与规则沉淀。

## 11. 第三轮：Review-5 与阻塞（2026-10-10）

### 11.1 本轮已执行

- 把共享准入门与 hook 回归从越界的 `scripts/**` 迁入允许列表内的
  `.githooks/verify-appsdk-admission.mjs`、`.githooks/tests/appsdk-admission-hook.mjs`；
  同步 `package.json`、`pre-commit`、`pre-push` 与回归内部引用。
- 复测：`node .githooks/verify-appsdk-admission.mjs .` = `CONTRACT_PASS ... delivery_gaps=1`；
  真实 AppSDK hook 正/负向回归（`ROUTECODEX_REQUIRE_REAL_APPSDK_FIXTURE=1`）PASS；
  `node --check` / `sh -n` / `git diff --check` 全 OK。
- 启动 Review-5（独立 oauth / gpt-6.1-sol，只读）。

### 11.2 Review-5 裁决

`fail`（唯一 P1）。Reviewer 确认：脚本越界已消除，其余技术面均通过；Reviewer 亲读
固定 AppSDK 提交 `9dc90303` 的 `governance.rs`，确认合同刷新无法改指
`.appsdk/contracts/**`。唯一 P1 = 剩余 `contracts/**`（根/v3/v4）与 `.gitignore`
一行仍越出用户允许集合，且“依据含本轮范围修订”不构成授权，需用户明确批准。
记录见 `.worker-runs/governance-upgrade-20261010/review/review-5-findings.md`。

### 11.3 阻塞与恢复

同一阻塞（用户对 `contracts/**` + `.gitignore` 一行的明确授权）已连续出现 ≥3 个 goal
轮次，且技术替代经源码与 probe 证明不可行 → 目标置 `blocked`。恢复只需用户一句授权：
批准 `contracts/**`、`v3/contracts/**`、`v4/contracts/**` 与 `.gitignore` 的
`!v4/.appsdk/contracts/memory/` 一行；随后按 §10.2 阻塞链提交/PR/CI/merge 并复核远端回执。

### 11.4 用户授权（2026-10-10，已生效）

用户在本会话对 §10.1/§11.3 授权项回复“批准”。生效授权 = `contracts/**`、
`v3/contracts/**`、`v4/contracts/**` 与 `.gitignore` 的
`!v4/.appsdk/contracts/memory/` 一行。Review-3/4/5 的范围 P1 就此关闭；下一步
启动 Review-6 复核当前候选，通过后按 §10.2 提交/PR/CI/merge。
