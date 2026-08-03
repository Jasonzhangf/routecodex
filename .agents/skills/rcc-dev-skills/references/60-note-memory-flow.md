# 60 Note Memory Flow

## 何时用
- 你在整理 `note.md`
- 你要决定某条信息去 `MEMORY.md` 还是 skill
- 你要把旧流水账压缩成可复用结论

## 职责边界
- `note.md`：raw 调查、假设、踩坑、样本、时间线
- `MEMORY.md`：已验证的长期项目事实
- `SKILL.md` / `references/*.md`：可复用动作、判断法、反模式
- `CACHE.md`：短期会话上下文

## 当前项目规则
- `note.md` append-only
- 顶部放 consolidation index
- 正文不删 raw 调查
- 同主题冲突时 latest verified timestamp wins
- `MEMORY.md` append-only：只加 dated correction

## 提炼流程
1. 先按主题聚类 `note.md`
2. 标记：
   - `verified_current`
   - `superseded`
   - `contradicted`
   - `one_off`
   - `skill_candidate`
3. 已验证事实写 `MEMORY.md`
4. 可复用动作写 skill references
5. one-off 保留在 `note.md`

## 什么该进 MEMORY
- 当前 owner 真相
- 当前 gate 真相
- 当前运行时路径 / 配置真相
- 已证实的线上/真实样本结论
- 当前禁区 / 删除规则 / durable contract

## 什么该进 skill
- 触发信号
- 关键判断
- 最小动作序列
- 边界 / 反模式
- 验证口径
- 对 servertool / stopless / hook skeleton，这还包括固定 slice 顺序、debug 切段法、黑盒必经路径、删 TS 准入条件。
- 若已经形成“整个开发/调试怎么做”的标准主流程，也必须进 skill；wiki/mainline 只锁目标，不替代执行流程。

## servertool 专项追加规则
- `docs/architecture/wiki/servertool-hook-skeleton-mainline-source.md`、mainline manifest、call map 负责锁目标骨架。
- `references/22-servertool-hook-skeleton-workflow.md` 与 `references/23-servertool-hook-dev-debug-flow.md` 负责锁开发/debug 流程。
- 只把 servertool 全流程写进 goal、聊天或 `note.md`，不算沉淀完成；必须回写 skill reference 或 lessons。

## 什么不要进 MEMORY
- “可能 / 猜测 / 待确认”
- 纯时间线
- 一次性中间状态
- 只对本次 shell session 有意义的临时命令结果

## consolidation index 推荐格式
```md
## YYYY-MM-DD note.md consolidation index
- <主题>: latest=<date>; promoted -> MEMORY.md <section>
- <主题>: superseded by <date>
- <主题>: contradicted by <file/test>
```

## 验证
- `head -40 note.md`
- `rg '^## 2026-06-14' MEMORY.md`
- `git diff --check`

## 相关 references
- [80-skill-routing-convention.md](./80-skill-routing-convention.md)
- [91-lessons-2026-05.md](./91-lessons-2026-05.md)
- [92-lessons-2026-06.md](./92-lessons-2026-06.md)
