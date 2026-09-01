# AppSDK / Collab 统一治理盘点（2026-09-01）

## 边界

- 候选 worktree：`playground/apps-sdk-collab-unified-20260901`，基于 `origin/main` 的 `21ad6e83d409cfa6794892c341b91ebf3ad49146`。
- 目标 branch：`codex/apps-sdk-collab-unified-20260901`。
- 原仓库 `main` 有既有 dirty，未修改、未清理。
- AppSDK 唯一执行器：`/Users/fanzhang/.local/bin/appsdk`，版本 `0.1.6`。
- Collab 唯一执行器：`/Users/fanzhang/.cargo/bin/collab`，v1；不创建 v2 控制面。

## 冻结快照

快照时间：2026-09-01（本地 Pacific 时间）。

| 控制面 | 对象计数 | 快照摘要 |
|---|---:|---|
| AppSDK project | 1 | `.appsdk/project.json`，`appsdk verify .` = `ok=true, stage=contract_bound` |
| AppSDK maps | 4 | resource/function/mainline-call/verification；由 0.1.6 `pin-lock` 生成目标映射，并保留 0.1.5 snapshot |
| AppSDK migration | 1 | `.appsdk/migrations/0.1.5-to-0.1.6/record.json`，bundle digest `sha256:0681d689b16389cd42591e2a82e2a84a87aa28e321c18127f0c8532e5a106124` |
| Collab canonical root | 1 | `<repo>/.agent-collab`；v1 migration `migration-1788234889845` 已 `plan → apply → daemon restart → verify`，snapshot `fnv1a64:39725961c0ba498d`，admission resumed |
| Collab historical roots | 47 | `playground/**/.agent-collab`；只读盘点，全部保留，不拼接、不自动认领、不删除 |
| Canonical claims | 8 | `<repo>/.agent-collab/claims/**/owner.json` |
| Canonical runs | 18 | `<repo>/.agent-collab/runs/**` |
| Canonical merge queues | 1 | `<repo>/.agent-collab/merge-queue/**` |

AppSDK 迁移文件 hash（候选 worktree）：

```text
project.json          407c26f53dbdf27d5bcf5da20b9ce80fc9b4d7cd68165f46d26250b5c6e068ab
sdk.lock              948a605c952cc958b9233aea80b0c03c4def7f07128364b1741132772efb80c5
resource-map.json     f6acff041c1826b3108e51bd0327074edec380e72f9a0c5aa217bdf7321663b0
function-map.json     19be986ab3ec2f56ee8efd4b2a6256c69f70a6adab801725d02d9264a5948dcd
mainline-call-map    1650f58333fa49fcd80a24b0d6f0b50d1c7aa5825c68d0aaaee493f18c7275d9
verification-map      1ca6da5f74a8537b20fe089e3d98d3ad131352b56b216a9e428e9773678c423b
```

Collab root 路径清单的 sha256（按 `find playground -name .agent-collab | sort` 的字节序列）：

```text
4160a21b66eb2c74d56108516dc9a2474ea67be642a5d88663663b9f98d2215a
```

## 对象映射

| 对象 | 统一 owner / truth store | 处理结果 |
|---|---|---|
| project / module / lifecycle | `appsdk::project_contract`、`appsdk::fix_lifecycle`；`.appsdk/project.json`、`.appsdk/records/**` | AppSDK-only truth，Collab 只保留 task binding |
| issue / semantic claim | issue 属 AppSDK record graph；claim 属 Collab task owner | conflict 时不自动合并；通过 canonical adapter 建 binding |
| resource / function / mainline / verification | `appsdk::maps`；四张 map | 0.1.5 map 作为迁移快照，0.1.6 map 为 live truth |
| task / worktree / lease / queue | Collab v1 server journal/task/claim/worktree truth | 保留原 owner 与 source identity；不复制 token、不重写 task |
| daemon / staging | Collab v1 daemon 与其 exact project socket | 只允许官方 `collab down/up` 维护；staging 仅在 receipt 证明 disposable 后清理 |
| Active / Protected / generated | AppSDK compiler/lifecycle；对应 zone | 只通过 `appsdk` 生成；禁止手写 hash、复制或软链 |
| migration record | AppSDK `.appsdk/migrations/**` + Collab migration journal | 两者分别保留，映射关系写入本文件，不拼接历史 |

分类结论：AppSDK project 是唯一生命周期真源；仓库根 `.agent-collab` 是唯一 Collab v1 控制面；47 个 playground Collab roots 属于 Collab-only 历史/并行运行态，当前不具备统一 owner 转移条件，全部保留为审计证据。

## 已执行的官方动作

1. 在干净 `origin/main` worktree 执行 AppSDK 0.1.6 `pin-lock`。
2. 执行 `appsdk compile .` 与 `appsdk verify .`，均通过。
3. 根 Collab v1 已有官方 `inspect → plan → apply → daemon restart → verify` 记录；当前 migration `migration-1788234889845` phase=`verified`，admission 已恢复，worker=4/task=3/message=0。
4. 未直接编辑任何 AppSDK record、hash、Active、Protected、Collab task、claim、journal、mailbox 或 token。
5. 未清理任何 historical root、daemon、lease、queue 或 staging。

## 未执行及原因

当前安装的 AppSDK 0.1.6 与 Collab v1 CLI 均没有“Collab → AppSDK record graph”官方 adapter/import/owner-transfer 命令。v4 子项目仍为旧 0.1.5 lock，且 `appsdk pin-lock v4` 首个失败点为 `SDK_MIGRATION_OPEN_REVIEW:routecodex-v4-error`；`appsdk verify --review-admission v4 --module routecodex-v4-error` 为 `MISSING_RECORD:module-artifact`，不能用手工 JSON、hash、identity 或伪造 candidate 绕过。

因此以下动作保持冻结，直到出现官方 record-producing adapter：

- Collab-only task/claim 向 AppSDK issue/claim 的 owner 转移；
- 任意 historical root 删除或合并；
- disposable staging/lease/queue 清零；
- AppSDK architecture review / promotion / Active / Protected 发布。

回滚边界：本候选 branch 可删除而不触及原 `main`、根 Collab journal 或 47 个历史 root；AppSDK 0.1.5 map snapshot 与 Collab migration snapshot 均可独立解析。

## 后续验收序列

```text
official record-producing adapter
→ exact AppSDK FixCandidate/PreReview/Collaboration records
→ appsdk verify --review-admission . --module routecodex-governance
→ Collab migration verify（snapshot/count/identity/socket）
→ 定向测试与 release build
→ 用户入口安装/重启/health
→ AGY review
→ exact commit → integration worktree → remote receipt → cleanup disposable state
```
