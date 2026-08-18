# V3 WebUI Request Observability Contract (typed snapshot + lifecycle events)

Status: implementing
Owner feature: feature_id:v3.webui_request_observability
Host: single RouteCodex WebUI = v3/admin-webui + routecodex-v3-admin (origin/main @ 8168d11c3), runtime server routecodex-v3-server

## 1. 目标
把 V3 runtime 已存在的 typed 观测真源（V3RuntimeObservability / V3RuntimeProviderFailureObservation / V3RuntimeTimingSummary / V3RuntimeUsageSummary、request_id、started_at）投影为 WebUI 可消费的结构化 snapshot + incremental lifecycle events。
WebUI 只消费本契约的 typed 事件/snapshot；禁止解析 console 文本、debug 文本或业务 payload 重建状态。

## 2. 请求唯一记录与分组
- 唯一 key：`requestKey = "<port>:<requestId>"`（port = listener port，requestId = server 已分配的 V3 request id）。一条请求在 UI 始终只有一行，route/provider/response/error 更新同一行。
- 默认分组键：`workdir + sessionId`；standard chronological order 使用 `sequence`（arrival 序，单调递增），状态更新不重排。
- scope：事件携带 `port / workdir / session` 供分组与筛选。

## 3. 事件类型（eventType）
| eventType | 语义 |
|---|---|
| request.started | request 进入即发，请求行立即出现 |
| request.route_selected | 命中 route/pool/tier/target |
| request.provider_attempt_started | 一个 provider 尝试开始 |
| request.provider_attempt_failed | 一次 provider 尝试失败（可切换） |
| request.provider_switched | provider 切换（同 requestKey，attempts[] 归属同一 transaction） |
| request.response_progress | 流式/分段响应进展（只投影状态，不含业务 chunk） |
| request.completed | 成功/正常 terminal，更新同一行 |
| request.failed | 错误 terminal，更新同一行，不产生 success 行 |
| request.cancelled | client disconnect/取消，不投影为 success/error |
| stats.snapshot | 独立 stats 投影 |

## 4. 增量事件 envelope（每个事件必含）
```jsonc
{
  "requestKey": "<port>:<requestId>",
  "sequence": 1001,            // 单调递增，stale event reject 依据
  "eventType": "request.started",
  "timestamp": 1750000000000,  // epoch ms
  "scope": { "port": 5555, "workdir": "/workspace", "session": "sess-1" },
  "patch": { ... }             // 或 full projection；前端按 requestKey upsert，不得重复建行
}
```

## 5. 请求投影（主表字段）
status、startedAt、port、endpoint、model、route、provider、durationMs、result。
折叠详情字段：identity（requestId/entryProtocol/executionMode/transport/session/workdir）、attempts[]、switch timeline、timing、usage、error、rawArtifactRef（受控 artifact reference，不带完整 body）。

## 6. 全局统计投影
request total / active / success / error / errorRate / QPS / TPS / latency percentiles / token usage / switchRate / activeSessions / activeWorkdirs / providerAvailability。stats 用独立 typed stats projection（stats.snapshot），不由 UI 临时重算为唯一真源。

## 7. 传输
- GET `/api/observability/snapshot`：初始 snapshot（含 cursor/sequence、当前 in-flight 与最近请求）。
- WS/SSE `/api/observability/events`：增量 lifecycle events；重连时带 cursor，stale event（sequence <= 已见）拒绝。
- GET `/api/observability/stats`：stats snapshot。
- 连接/权限/schema/cursor/sequence 错误显式暴露，禁止静默 fallback。

## 8. 投影隔离与边界（P0）
- WebUI、--print、per-port file log 都是上述 typed observability 的 projection sink，不拥有 runtime/routing/error truth。
- requestKey、route、provider、health、retry、debug、error 只走 typed observability/control side-channel，不进入正常 request/response payload；payload 不得反向重建控制状态。
- 不改 routing、retry、provider health、error policy、MetadataCenter 语义；不改 request/response payload。
- 单 WebUI 唯一：本页是 v3/admin-webui 的一个页面，禁止另起第二个 WebUI 实现。不实现 TUI。

## 9. 生命周期接线（server 侧投影点）
观测投影 owner 只在 runtime server 的已有 typed 观测点取样（V3RuntimeObservability 存在的生命周期点）并投影到本契约事件；不新增 payload 字段、不改 handler/outbound/inbound 语义。
