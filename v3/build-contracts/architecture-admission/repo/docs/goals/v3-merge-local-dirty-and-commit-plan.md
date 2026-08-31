# V3 远端合并、本地 dirty 整理与提交计划

## 1. 目标与验收标准

### 目标

在不丢失、不静默覆盖本地 dirty 修改的前提下，将已审查通过的远端 integration 结果与本地修改整合，完成必要验证，并只提交经过确认属于本次 change set 的文件。

已确认的远端合并结果：

- 基线：`origin/main`（当前记录为 `1a3117085`）
- integration commit：`3b53e2aae90006a0a084231b0b1e74423eb0adba`
- 内容：Responses `agent_message` 中过滤 `encrypted_content`，含回归测试及 map 更新
- AGY Review：`PASS`，findings 为空
- 远端 SSE 修复：已包含在 `origin/main`，不重复合并

### 验收标准

- 本地 dirty 文件逐项审查后保留或按明确决策合并，不被 reset、restore、stash、checkout 或覆盖。
- 远端 integration commit 只合并一次，不重复创建同义任务或重复实现。
- `node_modules`、`target`、dist、日志、临时目录、运行时产物不进入提交。
- 无未解决的语义冲突、架构越界、重复实现或 fallback。
- 受影响定向测试、构建、安装、`routecodex restart`、在线健康检查完成并有证据。
- 提交前检查 staged stat/name-status，只提交声明的 change set。
- 提交后本地 HEAD、远端目标分支和待推送 commit 关系明确；未经明确授权不 push。

## 2. 范围与边界

### In scope

- 审查当前主树 dirty 文件及未跟踪文件的归属、语义和生成物属性。
- 将 `3b53e2aae` 与本地真实修改整合到隔离 worktree 或当前目标分支。
- 处理可证明的无歧义冲突；保留现有架构和协议语义。
- 运行与变更映射对应的测试、构建、安装、重启及在线验证。
- 精确暂存并提交经过确认的文件。

### Out of scope

- 不处理 2026-08-19 之前的远端分支。
- 不合并含 fallback 的 WebUI observability 分支。
- 不重复合并已在 `origin/main` 的 SSE 修复。
- 不删除或直接编辑 `.agent-collab`、journal、claims、mailbox 或 task JSON。
- 不提交任何依赖安装目录或运行时生成物。
- 不擅自处理无法判断归属的本地 dirty；遇到业务语义歧义必须停下询问 Jason。

## 3. 设计原则

1. 先检查真源：读取 `note.md`、相关 run notes、当前 git 状态、分支图和远端 commit 内容，再决定动作。
2. 先隔离后整合：优先在干净的 `playground/<issue>-<run_id>/` worktree 中复现整合，主树仅在确认 change set 后落地。
3. 本地 dirty 不等于可提交：逐文件判定为本地业务修改、远端应合入修改、生成物、临时文件或歧义项。
4. 无 fallback、无 silent strip、无请求侧 cleanup、无架构旁路；控制面与业务 payload 保持物理隔离。
5. 所有 task 生命周期变化使用 Collab CLI/MCP；不直接改 `.agent-collab` 内部状态。
6. 代码修改后按模块边界、定向测试、构建、安装/重启/在线样本、AGY Review 顺序验证。若代码在 PASS 后再改，旧 PASS 失效，必须重新验证和 review。
7. 禁止使用 `git reset`、`git restore`、`git stash`、`git checkout`、批量删除或 broad kill；任何需要改变 index/worktree 的动作先核对目标路径和可逆性。

## 4. 技术方案与文件清单

### 远端输入

- `origin/main`
- `codex/integration-v3-remote-review-20260828`
- `3b53e2aae90006a0a084231b0b1e74423eb0adba`

### 已知重叠风险文件

至少重新核对以下路径，不能依据文件名直接覆盖：

- `v3/package.json`
- `v3/package-lock.json`
- `v3/admin-webui/requests.html`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec_extra_tests.rs`

### 本地 dirty 处理规则

- 先用 `git diff --`、`git diff --name-status`、`git diff --stat` 和必要的源文件阅读确认每个文件。
- 对已有本地业务修改：保留并在隔离 worktree 合并；若与远端同一语义冲突，报告双方证据后询问。
- 对远端新增文件：只在内容与架构边界明确时合并。
- 对生成物：不提交；不得为了清理它们运行 destructive 命令。
- 对 `node_modules`：确认被 `.gitignore` 忽略且未 tracked；绝不 `git add`。
- 对无主 untracked 文件：先报告路径、类型和来源，不能猜测后删除或提交。

### 提交策略

使用明确路径的 `git add -- <path...>`，禁止 `git add .`、`git add -A` 或按 glob 批量吸入 dirty。提交前必须核对：

```sh
git diff --cached --stat
git diff --cached --name-status
```

若出现未声明文件、他人 dirty、生成物或 `node_modules`，停止提交并报告。

## 5. 风险与规避

| 风险 | 规避 |
| --- | --- |
| 合并覆盖本地 dirty | 隔离 worktree；逐文件审查；禁止 reset/restore/stash/checkout |
| package 版本被 install 脚本改写 | 区分远端真实改动与安装生成 dirty，依据 diff 和版本契约决定 |
| WebUI 本地改动与远端变更重叠 | 只保留已确认需求；语义冲突交 Jason 决策 |
| 生成物误提交 | git status、check-ignore、staged name-status 三重检查 |
| AGY PASS 失效 | PASS 后不改代码；若必须改，重跑完整验证和新 review |
| 远端分支重复合并 | 先查 merge-base、log、diff；只使用现有 integration commit |
| task/claim 状态漂移 | 只用 `collab task update/close/dispatch`，不直接编辑内部文件 |

## 6. 测试与验证矩阵

| 阶段 | 必须验证 |
| --- | --- |
| 整合前 | `git status`、分支/commit 图、dirty 文件分类、远端 diff |
| 定向功能 | `cargo test -p routecodex-v3-runtime responses_agent_message_with_encrypted_content_part_does_not_leak_ciphertext` |
| 构建 | 受影响 V3 crate/build gate；记录实际命令与结果 |
| 安装 | `npm run install:v3`；确认 isolation gate 通过 |
| 重启 | 仅使用全局安装的 `routecodex restart` |
| 在线 | 验证配置中的全部 listener `/health`，并确认运行版本对应整合 commit |
| 架构 | resource/function/mainline/verification map 与模块边界 gate |
| Review | AGY Review `mode=commit`，controller verdict 必须为 `pass` |
| 提交前 | staged stat/name-status、无生成物、无未声明路径 |
| 提交后 | `git show --stat`、HEAD 与提交内容一致；push 前再确认目标和 HEAD |

## 7. 实施步骤

1. 读取 `~/.codex/USER.md`、项目 `note.md`、相关 run notes、`.agent-collab` 状态，并确认 Collab 身份。
2. 读取当前主树 status、dirty diff、远端 refs 和 integration commit；不改主树。
3. 在干净 worktree 中基于正确基线重现 integration，并逐文件对照本地 dirty。
4. 对每个重叠文件确认唯一 owner、架构边界、保留内容和冲突决策；有歧义立即暂停并询问 Jason。
5. 合并已确认的本地业务修改与 `3b53e2aae`；生成物和无主临时文件不进入 change set。
6. 先执行定向测试，再执行构建、安装、聚合重启和在线真实检查。
7. 若代码发生改变，完成模块边界自检并重新执行 AGY Review；只接受 controller `verdict=pass`。
8. 使用精确路径暂存；检查 staged stat/name-status；发现越界或生成物立即停止。
9. 用合规 Conventional Commit 提交；提交后核验内容。未经 Jason 另外授权，不 push。
10. 通过 Collab CLI/MCP 更新 task 的 merge/close 生命周期，并再次检查 `collab who`、`collab task status`、`collab inbox`。

## 8. 完成定义（DoD）

- 远端 integration commit 与已确认的本地 change set 已整合。
- 本地 dirty 中未授权或有歧义的内容仍被保留且有报告。
- 只有一个 master，runtime 为 tmux；无旧 Herdr active claim 被误删或遗留为未说明状态。
- 任务板、evidence、worktree、branch 关系可追溯。
- 定向测试、构建、安装、重启、在线检查和 AGY Review 均有证据。
- commit 只包含声明的文件；无 `node_modules`、target、dist、日志或临时产物。
- 最终报告包含：改动、验证、提交 hash、剩余风险、未完成项和下一步。

## 9. 可直接执行的端点提示词

复制以下内容作为最终执行提示词。本任务不再生成新的提示词，直接按本文档执行。

```text
/goal
目标：在不丢失或覆盖本地 dirty 的前提下，合并已审查通过的远端 integration commit 3b53e2aae，并把经过确认的本地修改精确提交。

实现文档：docs/goals/v3-merge-local-dirty-and-commit-plan.md

先读取 USER.md、note.md、相关 run notes、Collab 状态和当前 git status。远端 integration 已基于 origin/main 合并，SSE 修复已在 origin/main；不要重复合并。

执行规范：
- 主树 dirty 逐文件审查；禁止 reset、restore、stash、checkout、批量删除、git add .、git add -A 和覆盖本地文件。
- 优先使用干净 playground worktree 整合；本地业务修改、远端修改、生成物、临时文件和歧义项必须分类。
- node_modules、target、dist、日志、运行时产物绝不提交；无主 untracked 不得猜测删除或纳入。
- 无语义歧义且不改变架构才合并；遇到冲突、归属不明或架构选择必须暂停并询问 Jason。
- task/claim/journal/mailbox 只能通过 Collab CLI/MCP 修改。

验证：
- 定向测试、构建、npm run install:v3、全局 routecodex restart、全部 listener /health、架构 gate。
- 代码改变后必须重新执行 AGY Review；只接受 controller verdict=pass。
- 提交前检查 git diff --cached --stat 和 git diff --cached --name-status，只允许声明 change set 入 commit。

完成标准：
- 远端 integration 与确认后的本地修改已合并并提交。
- 本地未授权 dirty 未被改动或丢失。
- commit 不含 node_modules 或其他生成物；报告 commit hash、验证证据、剩余风险和未完成项。
```
