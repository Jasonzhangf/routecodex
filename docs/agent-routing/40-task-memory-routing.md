# 任务记忆路由

## 真源

- `memory/index.md`：稳定 L1 入口，只维护四类路由。
- `memory/plan.jsonl`：目标、架构、owner、边界和约束。
- `memory/path.jsonl`：节点、调用边、流程、清单和执行规则。
- `memory/knowledge.jsonl`：单条已核实事实、合同、函数、资源或设置。
- `memory/lesson.jsonl`：已验证的历史经验、根因、陷阱或解决方式。
- SQLite、FTS5 和 WeMM 候选是可重建投影，不是项目真源。

## 写入流程

1. 先读 `AGENTS.md`、相关 V3 maps、local Skill 和历史证据，逐条区分项目合同、当前实现、历史状态和未核实项。
2. 用户已确认且与现有真源一致的事实进入对应 JSONL；冲突事实先整改唯一 owner，或明确标成待整改，禁止写成已实现。
3. 用户未提及的实现细节、协议版本名和历史证据继续留在 review 清单，不按关键词批量删除。
4. 使用 `project-memory entry` 或逐条核实后的最小 `apply_patch` 写入；每条保留 `source_refs`，不得复制整份 architecture map。
5. 运行 `project-memory index`、`verify`、分类 query/get 和 `compact`。这些只证明记忆结构与检索，不替代源码、构建、运行时或 review 证据。
6. 任务结束写回只使用 `project-memory review --run <run-id>`；无明确候选允许 `no_update`。

## 归属边界

- 项目事实、架构基线、硬约束和 owner：`AGENTS.md`。
- 可复用执行流程、触发条件、反模式和验证：对应 local Skill。
- 任务过程与证据：当前 Collab run notes。
- 当前待澄清清单：`docs/goals/routecodex-memory-truth-review.md`。
- AppSDK lifecycle evidence、Guide 和 Collab 状态不复制到 project memory。

## 入口

- `.appsdk/skills/project-memory/SKILL.md`
- `.appsdk/docs/design/project-memory.md`
- `.appsdk/contracts/memory/memory-entry.schema.json`
