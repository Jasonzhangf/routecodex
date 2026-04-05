# 任务跟踪与记忆路由

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L18 `bd-routing`：BD 工作流。
- L20-L31 `memory-routing`：MEMORY/CACHE/memsearch 边界。
- L33-L48 `skill-distillation`：成功/失败探索的 skill 精华沉淀规则。
- L50-L55 `skills-index`：相关 skills。

## 覆盖范围
适用于：任务状态管理、结论沉淀、历史检索与复盘。

## BD 路由
1. 任务生命周期真源使用 `bd-task-flow`。
2. `.beads/issues.jsonl` 只保留结论和证据路径。
3. 避免超长 notes，必要时先清理 oversized notes。

## 记忆路由
- `MEMORY.md`：项目长期可复用结论。
- `memory/`：单任务过程性记忆。
- `CACHE.md`：短期上下文（只读为主，不手写）。
- 需要检索/写入记忆时优先走 `memsearch-flow`。

## Skill 精华沉淀（强制）
1. 每次探索结束（无论成功/失败），必须更新对应 local skill（`.agents/skills/*/SKILL.md`）。
2. 记录的是“经验精华”，不是流水账。至少提炼以下 4 项：
   - 触发信号：什么日志/症状说明要走这条路径；
   - 关键判断：如何区分真因与假因；
   - 可复用动作：下次应直接执行的最小动作序列；
   - 边界/反模式：哪些做法会导致复发，明确禁止。
3. 单条沉淀建议 4-8 行，要求“可执行 + 可复用 + 可验证”；禁止堆叠无结论的时间线。
4. 技能沉淀与 `MEMORY.md` 职责分离：
   - `SKILL.md`：方法论、排障路径、动作模板（面向下次执行）；
   - `MEMORY.md`：项目事实、决策结论、状态真相（面向知识留存）。
5. 若当前项目尚无对应 local skill，先在 `.agents/skills/` 新建后再沉淀。
6. 推荐统一模板（写入 local skill）：
   - `触发信号`
   - `关键判断`
   - `可复用动作（最小闭环 3-4 步）`
   - `反模式/边界`
   - `验证口径（哪个指标算改善）`

## 相关 skills
- `bd-task-flow`
- `memsearch-flow`
- `conversation-memory`
