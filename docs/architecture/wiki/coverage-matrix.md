# Architecture Wiki Coverage Matrix

## Purpose

这页只回答一件事：哪些架构逻辑已经有 wiki 面，哪些还没有。
它是补图清单，不是第二份规则真源。

## Current Coverage

| Area | Wiki page | Status | Notes |
| --- | --- | --- | --- |
| Mainline call graph | `docs/architecture/wiki/mainline-call-graph.md` | done | 自动生成，自 `function-map.yml` + `mainline-call-map.yml` |
| Wiki entry index | `docs/architecture/wiki/README.md` | done | 入口导航 |
| Request mainline detail | `docs/architecture/wiki/request-mainline-call-graph.md` | done | 自动生成，请求主线分页面 |
| Response mainline detail | `docs/architecture/wiki/response-mainline-call-graph.md` | done | 自动生成，响应主线分页面 |
| Error chain detail | `docs/architecture/wiki/error-mainline-call-graph.md` | done | 自动生成，错误主线分页面 |
| Runtime lifecycle detail | `docs/architecture/wiki/runtime-lifecycle-call-graph.md` | done | 自动生成，runtime lifecycle 分页面 |
| Servertool ownership map | `docs/architecture/wiki/servertool-ownership-map.md` | done | 自动生成，按 `hub.servertool_*` 聚合 |
| Virtual Router ownership map | `docs/architecture/wiki/virtual-router-ownership-map.md` | done | 自动生成，按 `vr.* / virtual_router.*` 聚合 |
| Pipeline topology | `docs/design/pipeline-type-topology-and-module-boundaries.md` | done | 结构真源，不放在 wiki 重复写 |

## Missing Wiki Pages

| Area | Target page | Priority | What it should cover |
| --- | --- | --- | --- |
| Metadata boundary detail | `docs/architecture/wiki/metadata-boundary-map.md` | done | request/response metadata carrier、continuation owner、provider/client leak boundary |
| Chat-process protocol mapping | `docs/architecture/wiki/chat-process-protocol-mapping.md` | done | `openai-chat / openai-responses / anthropic-messages` 统一语义字段与映射漏洞 |
| Responses direct/relay detail | `docs/architecture/wiki/responses-direct-relay-map.md` | medium | direct vs relay ownership、continuation owner、passthrough boundary |
| Servertool followup call graph | `docs/architecture/wiki/servertool-followup-call-graph.md` | medium | followup / CLI projection / stopless lifecycle / backend-route |

## Rule

新增一条长期架构逻辑时，先决定它是：

1. `function-map` owner
2. `mainline-call-map` edge
3. wiki review page

三个里面至少要有两个先落盘，再进入实现。

## Generated Pages

- Rebuild:
  - `node scripts/architecture/render-architecture-wiki-pages.mjs`
- Verify sync:
  - `node scripts/architecture/verify-architecture-wiki-sync.mjs`
