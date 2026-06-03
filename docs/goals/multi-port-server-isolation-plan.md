# Multi-Port Server Isolation Plan

## 目标与验收标准

### 目标

修复 `config.toml` 同进程启动多个 server/port（如 5520 / 10000 / 5555）时的隔离缺口，确保每个端口在请求、日志、错误、snapshot、session、stats、health/quota/traffic/admin 面向上具备明确 port scope，禁止端口间状态污染。

### 验收标准

- 10000 / 5520 / 5555 均能返回真实 HTTP 响应，禁止 `Empty reply from server`。
- 每个端口有独立 `serverId` / session dir / request scope / log namespace。
- per-port 日志包含启动日志、请求日志、错误日志、snapshot 标记；全局日志必须带 port/serverId 标签。
- 错误处理、stats、health、quota、traffic governor、routing/session state 不得跨端口污染。
- provider snapshot / errorsample / servertool event / provider-stats / process-lifecycle 必须可按 port/serverId 过滤或分桶。
- daemon admin / quota / credentials / ports 控制接口不得在非授权端口暴露全局控制能力。
- 红测必须覆盖真实 HTTP 入口，不得只测私有函数。

## 范围与边界

### In Scope

- 多端口启动链：`httpserver.ports[]`、`startHttpServer()`、`startPortListener()`、`PortRegistry`。
- per-port context：`serverId`、`portContext`、`routingPolicyGroup`、`matchedPort`、`entryPort`。
- per-port observability：console router、jsonl logs、snapshot、errorsamples、stats。
- per-port runtime state：error center、stats manager、manager daemon modules、provider traffic governor、health/quota state。
- 10000 forwarder/router 真实 HTTP 黑盒修复。
- red tests + live smoke。

### Out of Scope

- 不重构 provider 协议语义。
- 不改 Hub Pipeline / Virtual Router provider-specific 规则。
- 不通过 fallback/silent sanitizer 修补污染；发现缺 scope 必须 fail-fast 或红测失败。
- 不引入 provider 特例修复 10000；forwarder 差异只在 provider runtime / config bootstrap 真源内处理。

## 设计原则

1. **端口即 server scope**：每个 `httpserver.ports[]` 条目必须产生唯一 `PortServerScope`，至少包含 `port`、`host`、`mode`、`routingPolicyGroup/providerBinding`、`serverId`、`logRoot`、`sessionDir`。
2. **scope 显式传递**：请求、错误、日志、snapshot、stats、admin 操作必须从 `PortServerScope` 派生，不得从全局 `server.config.server.port` 猜。
3. **无 fallback**：缺少 port scope 时返回显式 HTTP 500 / 启动 fail-fast，不允许写到默认 5520 或全局 bucket。
4. **共享需显式标记**：provider runtime 可以暂时共享，但 traffic/quota/health/stats/log 必须按 port 或 serverId 分桶；若不能隔离，报告状态必须显式标 `shared=true`。
5. **真实入口验证**：所有关键验收必须从 `fetch/curl http://127.0.0.1:<port>/...` 或测试 listener 发真实 HTTP 请求。

## 当前审计证据

完整审计报告：`/tmp/isolation-audit-20260602.md`。

已确认非隔离点：

| 缺口 | 证据 |
|------|------|
| 单一 Express app | `src/server/runtime/http-server/index.ts:235` |
| 单一 `serverId` | `src/server/runtime/http-server/index.ts:240` |
| 单一 `StatsManager` | `src/server/runtime/http-server/index.ts:215` |
| 单一 `QuietErrorHandlingCenter` | `src/server/runtime/http-server/index.ts:237` |
| 单一 `ManagerDaemon` | `src/server/runtime/http-server/http-server-lifecycle.ts:49` |
| shared traffic governor | `src/server/runtime/http-server/provider-traffic-governor.ts:1426` |
| providerHandles 共享 | `src/server/runtime/http-server/index.ts:192` |
| provider-stats 全局 jsonl | `src/server/runtime/http-server/stats-manager.ts:114` |
| servertool-events 全局 jsonl | `src/server/runtime/http-server/servertool-admin-state.ts:57` |
| process-lifecycle 全局 jsonl | `src/utils/process-lifecycle-logger.ts:27` |
| errorsamples 全局目录 | `src/utils/errorsamples.ts:55` |
| provider snapshot 无 port 子目录 | `src/providers/core/utils/snapshot-writer.ts:130` |

实测：

- `curl http://127.0.0.1:5520/v1/chat/completions` 返回 200 JSON。
- `curl http://127.0.0.1:10000/v1/chat/completions` 返回 `Empty reply from server`。
- `/Volumes/extension/.rcc/log/config.toml/ports/` 下有 `5520/5555/4444`，无 `10000/`。

## 技术方案

### 1. 建立 `PortServerScope` 唯一真源

新增或扩展文件：

- `src/server/runtime/http-server/port-config-types.ts`
- `src/server/runtime/http-server/port-registry.ts`
- `src/server/runtime/http-server/server-id.ts`
- `src/server/runtime/http-server/http-server-lifecycle.ts`
- `src/server/runtime/http-server/index.ts`

要求：

- 每个 `PortConfig` 在启动前 materialize 为 `PortServerScope`。
- `serverId = canonicalizeServerId(portConfig.host, portConfig.port)`，不是主 config server port。
- `PortRegistry.attachServer()` 保存 `scope`，不是只保存 `config`。
- `buildHttpHandlerContext()` 必须从 socket/Host 匹配到 `PortServerScope`；匹配失败 fail-fast HTTP 500。

### 2. 请求隔离

文件：

- `src/server/runtime/http-server/http-server-lifecycle.ts`
- `src/server/runtime/http-server/index.ts`
- `src/server/handlers/*-handler.ts`

要求：

- metadata 注入 `portScope` / `entryPort` / `matchedPort` / `serverId` / `routingPolicyGroup`。
- `executePortAwarePipeline()` 禁止没有 `PortServerScope` 的 router/provider 请求继续。
- 10000 `gateway_coding_10000` 必须能解析到自己的 group pipeline。

### 3. 日志隔离

文件：

- `src/server/runtime/http-server/port-log-context.ts`
- `src/server/runtime/http-server/stats-manager.ts`
- `src/server/runtime/http-server/servertool-admin-state.ts`
- `src/utils/process-lifecycle-logger.ts`

要求：

- 启动日志必须写入每个 port 目录：`<logRoot>/<configName>/ports/<port>/server-<port>.log`。
- 请求栈 console 已通过 ALS 分流，但启动/后台/daemon 日志必须显式传 `PortServerScope` 或至少带 `port/serverId` 字段。
- `provider-stats.jsonl`、`servertool-events.jsonl`、`process-lifecycle.jsonl` 必须增加 `port` / `serverId` 字段；可保留全局文件，但必须可按 port 过滤。

### 4. 错误隔离

文件：

- `src/server/runtime/http-server/index.ts`
- `src/server/handlers/handler-utils.ts`
- `src/error-handling/*`
- `src/utils/errorsamples.ts`

要求：

- error payload 必须包含 `entryPort/serverId/routingPolicyGroup`。
- `QuietErrorHandlingCenter` 可保留进程单例，但内部记录必须按 `serverId` 分桶；否则改为 per-port center。
- errorsamples 路径增加 port/serverId 维度：`errorsamples/<serverId>/<group>/<kind>/...` 或写入 metadata + 可过滤索引。

### 5. Snapshot 隔离

文件：

- `src/providers/core/utils/snapshot-writer.ts`
- `src/debug/snapshot-store.ts`
- `src/modules/llmswitch/bridge/snapshot-recorder*.ts`

要求：

- provider snapshot 路径加入 port 维度：`<SNAPSHOT_DIR>/<entryEndpoint>/ports/<port>/<providerKey>/<requestId>/...`。
- bridge/errorsample snapshot metadata 必须包含 `entryPort/serverId`。
- 不允许 marker 有 port 但目录无 port；路径和 metadata 必须一致。

### 6. Runtime 状态隔离

文件：

- `src/server/runtime/http-server/provider-traffic-governor.ts`
- `src/server/runtime/http-server/request-executor.ts`
- `src/manager/modules/health/*`
- `src/manager/modules/quota/*`
- `src/manager/modules/routing/*`

要求：

- `ProviderTrafficGovernor` 按 `serverId + providerKey` 分桶，禁止单纯 providerKey 全局限流��
- health/quota/routing session state 按 serverId 分桶。
- provider runtime 可以共享 transport，但 health/quota/traffic/status 必须 per-port，除非明确标记共享并在 admin/status 中暴露。

### 7. Admin 路由隔离

文件：

- `src/server/runtime/http-server/routes.ts`
- `src/server/runtime/http-server/daemon-admin/*`

要求：

- admin/daemon/quota/credentials/ports 路由只在明确 admin port 或主控端口开放。
- 非 admin 端口访问必须返回 404/403，禁止 10000 控制 5520/5555。
- admin 操作若指定 port，必须只影响该 port scope；全局操作需显式 `scope=all`。

### 8. 10000 启动/forwarder 修复

文件：

- `src/config/virtual-router-builder.ts`
- `src/config/provider-v2-loader.ts`
- `src/providers/profile/forwarder-types*.ts`
- `src/server/runtime/http-server/http-server-runtime-setup.ts`

要求：

- `buildVirtualRouterInputV2(config.toml, providerRoot, { routingPolicyGroup: 'gateway_coding_10000' })` 必须成功。
- 若 forwarder/bootstrap 失败，启动必须 fail-fast，不能启动半死 listener。
- `resolveHubPipelineForRoutingPolicyGroup()` 返回 null 时必须 HTTP 500 JSON，不能 empty reply。

## 测试计划

### 红测（先红）

1. `tests/server/http-server/multi-port-isolation.red.spec.ts`
   - 用真实 Express listener 启 2-3 个端口。
   - 请求 5520/10000/5555，断言 metadata/log/snapshot/stats/error 分桶。
2. `tests/red-tests/forwarder_bootstrap_must_surface.test.ts`
   - 保留并扩展：10000 live running 时必须 HTTP response，不能 empty reply。
3. `tests/server/runtime/http-server/entry-port-snapshot-isolation.red.spec.ts`
   - 扩展 provider snapshot path 必须包含 `ports/<port>`。
4. admin route 红测：10000 访问 `/admin/ports` 返回 404/403。
5. errorsample 红测：不同 port 的错误样本目录/metadata 可区分。
6. traffic/quota 红测：5520 的 provider cooldown 不影响 10000 同名 provider（或状态 key 包含 serverId）。

### 绿测/验证

- 定向 jest：上述新增/修改测试。
- build：`npm run build` 或项目现有构建命令。
- live smoke：
  - 启动 config.toml。
  - `curl 5520 /v1/chat/completions` 返回 HTTP JSON。
  - `curl 10000 /v1/chat/completions` 返回 HTTP JSON。
  - `curl 5555 /v1/chat/completions` 返回 HTTP JSON。
  - 检查 log 目录含 `ports/5520`、`ports/10000`、`ports/5555`。
  - 检查 snapshot/errorsample/stats 带 port/serverId。

## 风险与规避

| 风险 | 规避 |
|------|------|
| 单一 app 改 per-port app 影响大 | 第一阶段保留单 app，但所有状态强制 port scope；第二阶段再评估 per-port app |
| provider runtime 全量 per-port 复制成本高 | transport 可共享；health/quota/traffic/stats 必须分桶 |
| snapshot 路径迁移影响历史样本 | 新样本按 port 写；历史样本不迁移，读取端支持旧路径只读 |
| admin 路由收紧影响现有使用 | 明确 admin port 或主控端口；非 admin 返回 403 并写日志 |
| 10000 forwarder 问题被隔离修复掩盖 | 单独保留 HTTP 黑盒红测，先复现 empty reply，再修根因 |

## 实施步骤

1. 增加红测：multi-port request/log/error/snapshot/admin/traffic 隔离。
2. 建 `PortServerScope`，让 `PortRegistry` 和 `buildHandlerContext` 使用 scope。
3. 修 session/serverId：每 port 独立 serverId/sessionDir。
4. 修 10000 empty reply：bootstrap fail-fast + handler HTTP 500 JSON + forwarder group 成功解析。
5. 日志与全局 jsonl 加 port/serverId 字段。
6. snapshot/errorsample 路径加 port/serverId 维度。
7. stats/error center/manager daemon/traffic/quota 分桶。
8. admin routes 限制到 admin port，非业务端口禁止全局控制。
9. 跑定向红绿测试 + live smoke。
10. 把验证结论提炼到 `MEMORY.md`，压缩 `CACHE.md`。

## 完成定义（DoD）

- 5520 / 10000 / 5555 均能独立响应真实 HTTP 请求。
- 任一端口的请求、日志、错误、snapshot、session、stats、health/quota/traffic/admin 状态都有明确 port/serverId scope。
- 无 `Empty reply from server`。
- 无无 scope 的全局写入（除非显式带 `port/serverId` 标签）。
- 所有新增红测先红后绿，定向测试通过，live smoke 有日志/HTTP 证据。
