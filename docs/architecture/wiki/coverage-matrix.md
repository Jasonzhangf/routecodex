# Architecture Wiki Coverage Matrix

## Purpose

这页只回答一件事：哪些架构逻辑已经有 wiki 面，哪些还没有。
它是补图清单，不是第二份规则真源。

## Current Coverage

| Area | Wiki page | Status | Notes |
| --- | --- | --- | --- |
| Mainline call graph | `docs/architecture/wiki/mainline-call-graph.md` | done | 自动生成，自 `function-map.yml` + `mainline-call-map.yml` |
| Mainline HTML render | `docs/architecture/wiki/html/mainline-call-graph.html` | done | 自动生成，自 `docs/architecture/wiki/mainline-call-graph.md`；正式 repo 文档，不是临时验证页 |
| Wiki entry index | `docs/architecture/wiki/README.md` | done | 入口导航 |
| Request mainline detail | `docs/architecture/wiki/request-mainline-call-graph.md` | done | 自动生成，请求主线分页面 |
| Response mainline detail | `docs/architecture/wiki/response-mainline-call-graph.md` | done | 自动生成，响应主线分页面 |
| Error chain detail | `docs/architecture/wiki/error-mainline-call-graph.md` | done | 自动生成，错误主线分页面 |
| Runtime lifecycle detail | `docs/architecture/wiki/runtime-lifecycle-call-graph.md` | done | 自动生成；明确 `ROUTECODEX_SESSION_DIR` 只是 runtime workdir root，`tmuxSessionId / sessionId / conversationId` 不共用身份语义 |
| Servertool ownership map | `docs/architecture/wiki/servertool-ownership-map.md` | done | 自动生成，按 `hub.servertool_*` 聚合 |
| Virtual Router ownership map | `docs/architecture/wiki/virtual-router-ownership-map.md` | done | 自动生成，按 `vr.* / virtual_router.*` 聚合 |
| Stopless runtime metadata source | `docs/architecture/wiki/stopless-session-mainline-source.md` | done | stopless 当前请求闭环主线、CLI stdout 恢复、无 file/tmux/sessionDir 依赖专题页 |
| Pipeline topology | `docs/design/pipeline-type-topology-and-module-boundaries.md` | done | 结构真源，不放在 wiki 重复写 |

## Missing Wiki Pages

| Area | Target page | Priority | What it should cover |
| --- | --- | --- | --- |
| Metadata boundary detail | `docs/architecture/wiki/metadata-boundary-map.md` | done | request/response metadata carrier、continuation owner、provider/client leak boundary |
| Chat-process protocol mapping | `docs/architecture/wiki/chat-process-protocol-mapping.md` | done | `openai-chat / openai-responses / anthropic-messages` 统一语义字段与映射漏洞 |
| Responses direct/relay detail | `docs/architecture/wiki/responses-direct-relay-map.md` | done | direct vs relay ownership、continuation owner、passthrough boundary |
| Servertool followup call graph | `docs/architecture/wiki/servertool-followup-call-graph.md` | done | followup / CLI projection / stopless lifecycle / backend-route |
| Server SSE bridge surface | `docs/architecture/wiki/server-responses-sse-bridge-map.md` | done | server JSON/SSE facade、Rust projection owner、JSON/SSE equality gaps |

## Rule

新增一条长期架构逻辑时，先决定它是：

1. `function-map` owner
2. `mainline-call-map` edge
3. wiki review page

三个里面至少要有两个先落盘，再进入实现。

## Generated Pages

- Rebuild:
  - `node scripts/architecture/render-architecture-wiki-pages.mjs`
  - `npm run render:architecture-wiki-html`
- Verify sync:
  - `node scripts/architecture/verify-architecture-wiki-sync.mjs`
  - `npm run verify:architecture-wiki-html-sync`

## Human And Machine Surfaces

- Human-readable formal docs:
  - `docs/architecture/wiki/*.md`
  - `docs/architecture/wiki/html/*.html`
- Machine-readable formal docs:
  - `docs/architecture/function-map.yml`
  - `docs/architecture/mainline-call-map.yml`
  - `docs/architecture/verification-map.yml`

规则：HTML/Markdown 负责 review surface；YAML/manifest/gate 负责机器消费。两类都必须在 repo 内正式落盘。
