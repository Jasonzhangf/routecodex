# Goal 提示词（RouteCodex AppSDK 治理统一升级）

```text
/goal
身份：本目标编排者；先判定宿主——DSH 走 dsh-create，Codex Desktop/TUI 走 codex-orchestrator。
目标：把 RouteCodex 仓库内三个 AppSDK 受管根（根 .appsdk、v3/.appsdk、v4/.appsdk）
  统一升级到 appsdk 0.1.0014，让治理合同、验证准入、CI 与 Git hook 入口一致，并把
  升级结果合入 origin/main。
范围与约束：允许 .appsdk/**、.appsdk-prepare.json、docs/goals/**、v3/.appsdk/**、
  v4/.appsdk/**、.github/workflows/test.yml、.githooks/**、与准入直接相关的 package.json。
  共享准入门与 hook 回归已落在 .githooks/**（允许列表内）。技术必需但超出允许列表、
  待用户裁定的是 contracts/**、v3/contracts/**、v4/contracts/**（AppSDK 把字面
  `contracts/...` 前缀硬编码为 canonical，无法改指 .appsdk/contracts/**），以及
  .gitignore 的 v4 memory 例外一行。禁改运行时/协议/provider/payload/Rust 语义；禁触
  .agent-collab/、~/.collab/、~/.appsdk/、daemon 生命周期；禁 appsdk init（会触发全局注册
  与 Collab 初始化）、禁 --fresh --discard-legacy 及任何 reset/破坏性迁移；禁手工删
  journals/mailbox/身份/任务/claim/worktree；禁 --no-verify、改 hooksPath、删 hook、降级断言；
  禁覆盖他人 worktree/分支/进程。
依据：docs/goals/routecodex-governance-unification-plan.md（§8 T0 结论、§9 执行记录、
  §10 第二轮范围裁定与并发编排）。
验收：三根 sdk.lock 与 project.json#/sdk/version 均为 0.1.0014，sdk.bin 不提交；
  根、v3 的 appsdk verify --admission 返回 ok:true；v4 合同级错误全部消失，交付级
  ACTIVE_ARTIFACT_MISSING 作为 typed 缺口如实保留；CI 不再 clone 旧 v0.1.5 且对三根做
  版本一致准入；hook 绑定真实暂存/推送内容；变更经独立 Review PASS 合入 origin/main
  并有远端回执。
笔记：/Volumes/Intel/playground/routecodex/governance-upgrade-20261010/docs/goals/
  routecodex-governance-unification-plan.md 与 .worker-runs/governance-upgrade-20261010/
  下各 worker note.md；按 coding-principals 绑定总目标、本轮验收和节点结果的目标影响。
开发节奏：本轮交付「三根治理升级 + CI/hook 准入一致 + Review-4 通过 + 合入 origin/main」
  这条可用主线；后续目标 B（requirements.json）、C（治理/门禁类 backlog）、
  E（v4 active 制品使交付级 admission 通过）、D（结案经验审计）。
执行：observation 后交独立 gpt-6.1-sol planner 规划，先画受影响 DAG 简图，按当前约束形成
  最小充分模型和最短必要流程，再按依赖并发实现、自检、debug 和黑盒验证。完整功能/修复
  完成作者验收后，每次正式代码提交/合并前按 Review 合同独立复核修改正确性；milestone
  同次审整体架构。长期目标结束时做一次独立经验审计。派单、回报、等待时及时补位；局部
  阻塞只停真实下游，任务实质变化才重规划。执行 peer 优先，负责任务验收和资源回收；
  未注册 Collab 不找 Master。
直接执行本任务，不再为它生成一层提示词。
```
