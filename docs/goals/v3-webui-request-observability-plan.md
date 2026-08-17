# V3 WebUI Request Observability Implementation Plan

Status: design

## 1. 目标与验收标准

将请求/响应观测从终端主界面迁移到 WebUI：

- `routecodex start` 默认不接管当前终端的请求/响应打印，默认打开 WebUI。
- 只有显式 `routecodex start --print` 才启用本地 terminal projection；不引入 TUI。
- WebUI 以一条请求对应一条可变记录，request started 后立即出现，response/error 到达后更新原记录，不生成重复 request/response 行。
- 默认按 `workdir + sessionId` 分组展示，并支持标准顺序模式：按请求进入序列稳定排序，状态更新不改变原始顺序。
- 支持 success/error/active/retrying/switching/cancelled 筛选，provider/port/model/route/workdir/session 筛选。
- 非主表字段进入可折叠详情：identity、routing、attempts、response、timing、usage、error、raw artifact reference。
- 顶部提供全局统计：request total、active、success/error、error rate、QPS/TPS、latency percentiles、token usage、switch rate、active sessions/workdirs、provider availability。
- WebUI 使用结构化 snapshot + incremental lifecycle events；禁止解析 console 文本重建状态。
- per-port file logs 保持独立；console、WebUI、file log 是同一 typed observability 的不同 projection。

## 2. 范围与边界

### In scope

- 目标 WebUI 承载位置确认与前端入口注册。
- request transaction / lifecycle event 的结构化 projection。
- initial snapshot、incremental event stream、cursor/sequence、重连一致性。
- workdir/session grouped view 与 standard chronological view。
- 实时请求表、状态/错误筛选、折叠详情、全局统计。
- `start` 默认静默观测行为和 `--print` 显式 terminal sink。
- 真实端口、真实请求、真实响应、provider switch、错误、WebUI 与 file log 的联动验证。

### Out of scope

- TUI、alternate-screen、terminal pane rendering、terminal history scroll。
- 修改请求/响应业务 payload、provider wire payload、MetadataCenter payload 或 continuation truth。
- 改造 routing、retry、provider health、error policy 的决策语义。
- 用 console 文本、debug 文本或 raw payload 作为 WebUI 协议。
- 把完整 request/response body 放入实时主表；只允许展示受控 artifact reference。

## 3. 设计原则

1. **唯一请求记录**：`requestKey = port + requestId`；一条请求在 UI 中始终只有一行主记录。
2. **分组与排序分离**：默认分组键为 `workdir + sessionId`；standard order 使用 request arrival sequence，更新不重排。
3. **事件而非日志解析**：WebUI 只消费 typed snapshot/event projection。
4. **实时与统计分流**：request lifecycle stream 更新请求表；stats snapshot/update 更新全局统计。
5. **投影隔离**：WebUI、terminal `--print`、per-port file log 都是 projection sink，不拥有 runtime/routing/error truth。
6. **显式失败**：snapshot/event schema、cursor、scope、权限和连接错误必须显式暴露；不使用静默 fallback。
7. **控制面与数据面隔离**：requestKey、route、provider、health、retry、debug、error 等只走 typed observability/control side-channel，不进入正常 request/response payload。
8. **console 默认静默**：默认 start 只显示必要启动结果/致命启动错误；请求流仅在 `--print` 下写入当前终端。

## 4. 技术方案与文件清单

RouteCodex 唯一的 WebUI 宿主是 `origin/main` 上的 `v3/admin-webui/`（Dashboard=index.html、routes.html、providers.html 静态页）+ Rust axum 服务 `v3/crates/routecodex-v3-admin/`（feature_id `v3.admin_api`/`v3.admin_dashboard`）。本任务把请求观测作为该唯一 WebUI 的一个页面（`requests.html` + `/api/observability/*` typed API + SSE event 流）并入，禁止另起第二个 WebUI 实现。

> 分支事实（2026-08 核验）：`origin/main` HEAD（`8168d11c3`）已含上述 admin crate + `v3/admin-webui/`。本地 main 为 V4 线（ahead 107 / behind 20），不含该 WebUI；`fix-v3-config-management-live` 是该分支上进一步开发 WebUI admin server / dynamic reload / SSE/health 的叠加分支。实现基线与验收必须对照 `origin/main` 上真实存在的 WebUI，禁止假造源码路径。参考实现仅作 UI 交互参考：`/Users/fanzhang/code/sub2api/frontend/src/views/admin/ops`（OpsDashboard / OpsRequestDetailsModal / OpsErrorLogTable / subscribeQPS 的 WS 鉴权重连）。

### Backend/runtime projection

- V3 typed runtime observability owner：复用现有 request/response/error/timing/provider event truth。
- 新增或扩展 WebUI projection owner：负责 snapshot、lifecycle event、stats snapshot、sequence/cursor、scope/filter。
- server lifecycle/start owner：实现默认 WebUI open、默认不接管 terminal、`--print` 显式 sink。
- per-port file sink：继续写 `~/.rcc/logs/server-<port>.log`，不依赖 WebUI 是否连接。

目标接口语义：

```text
GET  <webui request snapshot endpoint>
WS/SSE <webui request event endpoint>
GET  <webui stats snapshot endpoint>
```

事件至少覆盖：

```text
request.started
request.route_selected
request.provider_attempt_started
request.provider_attempt_failed
request.provider_switched
request.response_progress
request.completed
request.failed
request.cancelled
stats.snapshot
```

每个增量事件必须包含：

```text
requestKey
sequence
eventType
timestamp
scope(port/workdir/session)
patch or full request projection
```

### WebUI surface

参考 sub2api 的：

- OpsDashboard 全局统计/筛选/自动刷新结构。
- OpsRequestDetailsModal 请求分页表与详情入口。
- OpsErrorLogTable 错误分类、错误详情、模型映射和状态表达。
- `subscribeQPS` 的 WebSocket 鉴权、重连、stale 检测和连接状态表达。

RouteCodex WebUI 必须新增/确认：

- workdir/session grouped table。
- standard chronological order mode。
- mutable in-flight row keyed by `port + requestId`。
- attempt/switch timeline。
- collapsible identity/routing/timing/usage/error/raw-reference sections。
- global stats panel synchronized with the same observation window。

## 5. 风险与规避

| 风险 | 规避 |
|---|---|
| WebUI 从 console 文本解析字段 | 建立 typed snapshot/event projection，console 只作为 sink |
| request/response 重复行 | 前端用 `requestKey` upsert，事件带 sequence |
| reconnect 后状态倒退/重复 | snapshot cursor + monotonic sequence + stale event reject |
| session 跨端口串组 | 分组使用 workdir + session，唯一请求使用 port + requestId |
| provider switch 被误判为新请求 | attempts[] 归属于同一 request transaction |
| stats 与请求表不一致 | stats 使用独立 typed stats projection，不由 UI 临时重算为唯一真源 |
| 默认启动仍占用终端 | start sink 默认关闭，`--print` 作为显式参数门 |
| WebUI 打开但无权限/连接失败被吞掉 | 连接和权限错误显式显示，不静默 fallback |
| raw body/控制状态进入 WebUI 普通 payload | 只传 projection 和受控 artifact reference |
| 当前没有 RouteCodex WebUI owner | 实现前锁定真实 frontend worktree、module owner、function map、mainline edge |

## 6. 测试与验证矩阵

### Schema/contract

- snapshot/event schema parse 与 unknown field gate。
- requestKey、scope、sequence、event type 正反测试。
- request/response/error/control side-channel 不泄漏到业务 payload。

### Backend lifecycle

- request started immediately visible。
- route/provider update upserts same row。
- provider failure + switch remains same request with attempts timeline。
- success terminal updates same row。
- error terminal updates same row and does not create success row。
- cancelled/client disconnect does not become provider success/error。
- reconnect snapshot plus delta does not duplicate or regress rows。

### WebUI behavior

- workdir + session grouping。
- standard chronological order stability。
- active/success/error/retrying/switching/cancelled filters。
- expand/collapse fields and error details。
- global stats updates with request events and stats snapshots。
- narrow/normal/wide browser layout。

### CLI/sink behavior

- `routecodex start` does not print request stream and opens WebUI。
- `routecodex start --print` prints local projection and does not start TUI。
- default console, `--print`, WebUI and per-port file log are independently verified projections。

### Live verification

- install the exact tested build。
- use the required managed `routecodex restart` workflow where runtime changes apply。
- verify all configured listener ports and WebUI endpoint。
- replay real success, SSE, provider switch, provider error, malformed request and client disconnect samples。
- verify WebUI row identity, grouping, ordering, stats, file logs and `--print` output from the same live requests。

## 7. 实施步骤

1. Confirm WebUI owner/worktree and read its module/function/mainline/verification maps.
2. Register the WebUI request-observability resource, feature owner, event schema and projection boundaries.
3. Define request transaction projection and lifecycle event contract from existing typed observability.
4. Implement snapshot and incremental transport with scope, cursor, sequence and reconnect behavior。
5. Implement workdir/session grouped table and one-row request upsert。
6. Implement standard chronological mode with stable request arrival order。
7. Implement success/error/retry/switch/cancelled states and collapsible details。
8. Implement global stats snapshot and realtime stats update。
9. Change `start` default to quiet terminal + automatic WebUI open；add explicit `--print` terminal projection；remove TUI from the target path。
10. Run focused tests, build, install/restart if applicable, and live verification；then run architecture review。

## 8. 完成定义（DoD）

- No TUI is part of the implementation or default startup path。
- Default `routecodex start` opens WebUI and does not take over request printing in the invoking terminal。
- `routecodex start --print` is the only opt-in local request printer。
- WebUI displays every in-flight request immediately and updates the same row on route/provider/response/error changes。
- Default workdir + session grouping and standard chronological mode both work。
- Success/error/retry/switch/cancelled filters and collapsible details work。
- Global statistics and request table use the same verified observation scope。
- Per-port logs remain available and separated。
- No request/response payload semantics or control/data-plane boundary changes occur。
- Focused tests, build, required live verification and architecture review pass with evidence。
