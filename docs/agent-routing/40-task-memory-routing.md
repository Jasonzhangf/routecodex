# 任务跟踪与记忆路由

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L18 `bd-routing`：BD 工作流。
- L20-L28 `memory-routing`：MEMORY/CACHE/memsearch 边界。
- L30-L35 `skills-index`：相关 skills。

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

## 相关 skills
- `bd-task-flow`
- `memsearch-flow`
- `conversation-memory`
