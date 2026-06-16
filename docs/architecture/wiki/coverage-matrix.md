# Architecture Wiki Coverage Matrix

## Purpose

这页只回答一件事：哪些架构逻辑已经有 wiki 面，哪些还没有。
它是补图清单，不是第二份规则真源。

## Current Coverage

| Area | Wiki page | Status | Notes |
| --- | --- | --- | --- |
| Mainline call graph | `docs/architecture/wiki/mainline-call-graph.md` | done | 自动生成，自 `function-map.yml` + `mainline-call-map.yml` |
| Wiki entry index | `docs/architecture/wiki/README.md` | done | 入口导航 |
| Pipeline topology | `docs/design/pipeline-type-topology-and-module-boundaries.md` | done | 结构真源，不放在 wiki 重复写 |

## Missing Wiki Pages

| Area | Target page | Priority | What it should cover |
| --- | --- | --- | --- |
| Response mainline detail | `docs/architecture/wiki/response-mainline-call-graph.md` | high | resp-01/02/03/04 owner、边、split binding、入口协议 |
| Request mainline detail | `docs/architecture/wiki/request-mainline-call-graph.md` | high | req-00..05、split binding、request owner 路径 |
| Error chain detail | `docs/architecture/wiki/error-mainline-call-graph.md` | high | error Err01..06、policy consumer、client projection |
| Runtime lifecycle detail | `docs/architecture/wiki/runtime-lifecycle-call-graph.md` | medium | pid cache / stop-intent / instance registry |
| Servertool followup detail | `docs/architecture/wiki/servertool-followup-call-graph.md` | medium | followup / CLI projection / stopless lifecycle |

## Rule

新增一条长期架构逻辑时，先决定它是：

1. `function-map` owner
2. `mainline-call-map` edge
3. wiki review page

三个里面至少要有两个先落盘，再进入实现。
