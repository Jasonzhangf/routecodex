# V3 最近两日未合入 main 的提交与 worktree 集成计划

## 目标与验收标准

审计当前日期前最近两天的 V3 提交、分支和 worktree，找出尚未进入本地 `main` 且确实属于 V3 主线的缺失改动；逐项确认其 owner、依赖、测试和架构边界后，精确合并必要变更到 `main`。V4 文件、分支、worktree、配置、进程和运行时均不得修改。

验收：

- 输出最近两日 V3 候选提交、所属分支、worktree 状态、是否已被 main 语义覆盖及处理结论。
- 所有实际需要的 V3 改动以可审查的 merge/cherry-pick 进入本地 `main`；重复、过时、被后续提交覆盖或与脏改动冲突的提交不得强行合入，并记录原因。
- 每个合入项均通过对应定向测试、架构边界检查、V3 编译/安装和聚合重启后的在线健康验证。
- 合入后的运行版本与源码一致；V3 listener 全部健康；没有把 V4 改动带入 V3 集成。
- 清理前确认 worktree 无未提交改动、分支无未合入唯一提交；只删除已确认干净且已合入的 V3 worktree。保留 dirty/user-owned worktree 并报告。

## 范围与边界

### In scope

- `main` 最近两天的 V3 commit graph、V3 分支、V3 worktree、V3 runtime/config/server/provider/compat/reasoning/SSE/error/continuation 改动。
- 提交语义覆盖审计：patch 是否已经由 `main` 的后续提交实现，不能只按 commit hash 判断。
- 合并冲突的逐文件、逐 hunk 处理；只保留已验证的 V3 语义。

### Out of scope

- 所有 V4 文件、V4 分支、V4 worktree、V4 配置、V4 进程和 V4 文档目标态。
- 不相关的远端历史重写、force push、批量 reset、批量 checkout、删除 dirty worktree。
- 用 bypass、fallback、provider/status 特判或请求侧 cleanup 掩盖缺失实现。

## 设计原则

1. 先查 `MemoryPalace`、项目 `MEMORY.md`/`note.md`，再查 resource map、function map、mainline call map、verification map 和模块 registry，确认唯一 owner 与相邻调用边。
2. 以 `main` 的实际源码和测试为真源；比较提交的语义、调用边和测试，不以分支名或 commit message 直接认定“未合入”。
3. V3 统一遵守 `Error01→Error06`、Direct/Relay 隔离、continuation 三键隔离、控制面与 payload 物理隔离，以及 provider error“先配置分类再处理”的架构。
4. 不引入 fallback、绕过、重复 provider 特例或散落 helper；发现同义实现时收敛到唯一 owner。
5. 保护所有已有 dirty 改动。需要合并时使用干净、独立的 V3 worktree；冲突无法安全判定时停止该项并记录，不覆盖用户改动。

## 技术方案与文件/资源清单

- 版本/范围：`git log --since='2 days ago'`、`git branch --all`、`git worktree list --porcelain`；按路径过滤 V3，明确排除 `v4/`。
- 架构真源：
  - `docs/architecture/v3-resource-operation-map.yml`
  - `docs/architecture/v3-function-map.yml`
  - `docs/architecture/v3-mainline-call-map.yml`
  - `docs/architecture/v3-verification-map.yml`
  - module registry、mainline wiki、相关 `docs/goals/`
- 代码 owner：`v3/crates/routecodex-v3-runtime/`、`v3/crates/routecodex-v3-server/`、`v3/crates/routecodex-v3-config/`、`v3/crates/routecodex-v3-provider-responses/`、`sharedmodule/llmswitch-core/rust-core/crates/provider-compat-core/`；仅当 map 明确允许时修改相邻模块。
- 运行时真源：全局安装的 V3 `rccv3`，配置 `/Volumes/extension/.rcc/config.v3.toml`；重启只能用 `routecodex restart`，不得使用 V4 或手动 start/stop。

## 风险与规避

- “提交不在 main”不等于“语义缺失”：先做 patch/符号/测试覆盖比对，避免重复合并。
- dirty worktree 可能包含用户未提交实现：逐 worktree 读取状态和 diff，禁止 reset/checkout/批量清理。
- 最近提交可能依赖未合入的前置提交：建立依赖链，按最小完整变更集合入。
- 安装会生成版本文件：只提交与本次 V3 安装一致的机械 build identity，不裹带无关 dirty 文件。
- 远端与本地可能分叉：未获明确授权不得 force push 或重写远端；报告本地 merge 与远端发布状态。

## 验证矩阵

| 层级 | 必须验证 |
|---|---|
| 静态/架构 | `git diff --check`；资源/function/mainline/module/verification map；V3 架构和 owner gate |
| 定向单测 | 每个合入提交关联的 Rust unit/integration/regression tests，正向与反向成对 |
| 编译 | `cargo check -p routecodex-v3-runtime -p routecodex-v3-server`，必要时完整 V3 build |
| 安装 | `npm run install:v3`，确认安装二进制 hash/version 与源码一致 |
| 运行 | `routecodex restart --config /Volumes/extension/.rcc/config.v3.toml --timeout-ms 60000`；验证所有 V3 listener `/health` HTTP 200 |
| 旧样本 | 对相关最近两日 V3 错误/SSE/reasoning/400/502/continuation 样本做在线重放或等价真实入口验证；不得用口头结论替代 |
| 清理 | 复查 `git worktree list`、每个已处理分支状态、claims/handoff/evidence；仅清理已确认干净且已合入的 V3 worktree |

## 实施步骤

1. 刷新 `.agent-collab` 状态，读取 active runs、claims、handoff、merge queue 和 kill switch；建立本轮 run/claim。
2. 审计最近两日 V3 commit、分支和 worktree，形成候选表：`commit/branch/worktree/paths/owner/deps/main coverage/decision`。
3. 对每个候选提交做源码、测试、调用边和配置分类审查，先排除 V4、重复实现、已覆盖语义和纯文档/生成物漂移。
4. 为每个确认缺失项建立干净 V3 worktree，执行定向测试和架构边界检查；通过后写 evidence/handoff/merge queue。
5. 按依赖顺序把最小完整变更集合精确合并到本地 `main`；冲突逐 hunk 解决，禁止覆盖无关 dirty 改动。
6. 在 `main` 重新运行受影响验证、安装 V3、聚合重启、所有 V3 端口健康检查和旧样本在线复测。
7. 复查合并后的 diff 是否越过 owner/资源边界；只清理已合入且干净的 V3 worktree，保留 dirty/user-owned worktree 并记录。
8. 最终报告列出已合入、已覆盖、拒绝合入、保留 dirty、未验证和远端未发布项；不把未验证项宣称完成。

## 完成定义（DoD）

- 最近两日 V3 未合入项已经逐项有证据和结论。
- 必要 V3 改动进入本地 `main`，没有 V4 变化。
- 定向测试、编译、安装、聚合重启、在线健康和相关旧样本验证完成。
- 清理只影响已合入且干净的 V3 worktree；所有保留项有明确原因。
- 报告包含 commit、测试、运行版本、健康结果、剩余风险及远端发布状态。
