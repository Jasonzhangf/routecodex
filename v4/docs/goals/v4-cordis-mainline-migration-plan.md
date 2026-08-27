# V4 Cordis 主线迁移开发计划

状态：`planned`。

目标：将 RouteCodex V4 的生产主线切换为“Cordis 编排、生命周期与发布真源 + Rust 数据面执行器”。每个请求从 admission 到 terminal 固定绑定一个 Cordis 发布的 immutable execution epoch。V3 保持独立，直到 V4 完成 parity、live、release 并取得显式切换批准。

本文件是 M00→M12 的执行顺序、验收证据和合并纪律的唯一计划入口。领域细节由以下 canonical docs 承载：

- `v4/docs/architecture/v4-cordis-mainline-adr.md`
- `v4/docs/architecture/v4-cordis-node-plugin-architecture.md`
- `v4/docs/architecture/v4-data-control-plane-boundary.md`
- `v4/docs/architecture/maps/resource-map.json`
- `v4/docs/architecture/maps/function-map.json`
- `v4/docs/architecture/maps/mainline-call-map.json`
- `v4/docs/architecture/maps/verification-map.json`

## 1. 最终完成定义

只有同时满足以下条件才允许称为 V4 Cordis 主线完成：

1. 无已发布 active epoch 时，V4 不接受业务请求；每个请求和 SSE 从入口到 terminal 使用同一个 immutable epoch。
2. Cordis 是 active plugin graph、插件组合、顺序、selection group、Fiber/Context 生命周期、candidate mount/validate/smoke/publish 的唯一真源。
3. Rust 是 HTTP/SSE/WebSocket、provider bytes、buffer/backpressure、admission、epoch lease、ExecutionEngine 和 request-local typed ControlFrame 的唯一 owner；resolver 只解析 identity，不决定策略或顺序。
4. 数据 payload 不经过 Cordis event bus；routing、switching、continuation、retry、health、debug、snapshot、error、scope、servertool/stopless 控制语义不进入正常 payload、协议 metadata、provider body 或 client body。
5. `runtime-bin` 不拥有生产路由、provider、retry、continuation、tool、协议 projection 业务编排，不维护第二套 plugin graph/registry/NodeContainer。
6. Responses、Chat、Anthropic、Gemini、WebSocket 与保留 tools/servertool/stopless 功能完成 differential pass、live pass，并具备 prepare/commit/abort/drain/rollback、canary、审计和 release evidence。
7. 每个 milestone 都有独立 claim/branch/worktree、red/green/build/evidence，精确合并到 V4 重构主树；milestone 完成后再合并仓库 `main`，在 `main` 复验并同步后才能开始下一 milestone。

## 2. 范围与硬边界

范围包括 Cordis Host daemon、generic plugin factory、typed bridge、NativePlugin ABI/resolver/catalog/config、ExecutionEpochBundle、NodeContainer、ExecutionEngine、runtime-bin 收缩、Responses request/response、async server/provider transport、SSE、Router/Error/Health/Continuation、协议 codec、tools、servertool、stopless、Admin、parity、release，以及相应 maps/wiki/manifest/red tests/CI gates。

禁止：把 Cordis 做成逐请求/逐节点/逐 SSE frame 的解释器；把 payload、protocol metadata、history 作为控制面；请求侧 cleanup、handler/SSE/outbound fallback 或 V3 fallback；恢复已移除 provider；修改用户真实配置作为代码补丁；自动 V3 cutover。

## 3. 固定主线与所有权

```text
Cordis config/catalog -> compile graph + mount Fibers -> PrepareEpoch
  -> Rust validate/resolve/smoke -> CommitEpoch -> admission + epoch lease
  -> ExecutionEngine: node -> node -> terminal -> RuntimeFact/diagnostic projection
```

控制面由 Cordis owning boundary 处理 publish、drain、rollback、enable/disable、admin、lifecycle command/event。数据面由 Rust owning boundary 处理 HTTP、SSE、WebSocket、provider transport、backpressure 与 payload。请求控制使用 Rust request-local typed `ControlFrame`，只异步发布 bounded RuntimeFact。

## 4. Milestone 顺序与退出门禁

每个 milestone 是独立交付单元，必须完成合同/实现、定向红绿测试、构建、边界自检、evidence 和 commit；随后按本计划第 5 节合并并复验。

### M00 — 架构冻结与 ratchet

落地 ADR、ExecutionEpochBundle、NativePluginCatalog、Control protocol、NodeOutcome 合同；登记当前 bypass（内部 NodeContainer、静态 registry、runtime-bin 直调、丢弃 node output、测试 binding）；建立“违规只能减少”的 gate。M00-T07 只冻结未来 live transport 的真实 provider-bound/raw evidence owner 合同，实际 async/native transport 与 live capture integration 归 M08；不得用 M00 的 server/diagnostic contract 重建或伪造 provider wire。退出：合同可解析、maps/manifest/wiki 同步、违规清单可测量且不得新增，T05 live provider admission blocker 解除，M00-T07 evidence-owner contract 完成。

### M01 — NativePlugin ABI 与 resolver

实现 NativePlugin、PluginContext/Config/Outcome/Failure/Identity、NativePluginResolver、薄 adapter 和 deterministic catalog exporter。退出：identity/version/hash/config unknown fail-fast，catalog hash deterministic，无业务语义复制。

### M02 — Cordis generic plugin factory

加载 canonical native catalog，通用 factory 创建 Fiber、挂载 native identity、dispose；移除正式路径对 `v4.test.*` 的依赖。退出：真实 request/response plugin 经 Cordis mount，Fiber ACTIVE，Cordis graph 与 Rust catalog 一致。

### M03 — 生产 Cordis Host daemon

实现 child startup、version/capability handshake、control socket、reconnect、heartbeat、generation、state directory、snapshot query、shutdown、reconciliation。退出：无 active epoch 不 ready；Cordis 故障不打断进行中的 Rust SSE；重启后 generation/graph hash 可核对。

### M04 — ExecutionEpoch 两阶段发布

实现 Prepare/Commit/Abort/Drain、query 和必要 rollback；处理 stale base、hash drift、重复 command、lease 与旧 epoch disposal。退出：失败保留旧 epoch；发布不切换旧请求；lease 归零后才 dispose。

### M05 — 唯一 Rust ExecutionEngine

建立 `ExecutionEngine::execute(entrypoint, frame, epoch_lease)`，使 NodeOutcome Continue/Branch/Terminal/Failure 真实串联；物理删除第二 NodeContainer、静态生产 graph、runtime 自排序/按名构图。退出：每节点执行一次且输出被下一节点消费。

### M06 — Responses JSON request 主线

迁移 admission、normalize、Responses direct-provider continuation classify、governance、route facts、target、provider semantic、wire build；本地/relay continuation、seed、context materialization 物理删除，旧 helper 只作不发送请求的 shadow baseline。Responses relay/local `previous_response_id` 在 owning boundary fail-fast。退出：同 request old/new provider-bound wire 无 unexplained diff，control 不进 wire。

### M07 — Responses JSON response 主线

迁移 raw decode、response governance、tool harvest、direct-provider continuation commit、client semantic、frame build；不得生成本地 continuation record/seed；旧/新 projector 对同一 raw response differential。退出：JSON/tool/usage/error fixtures 全绿，direct save 唯一归 RespChatProcess。

### M08 — Async server 与 native provider transport

采用项目锁定的 async server/native HTTP client、connection pool、CancellationToken、deadline、bounded buffer、graceful drain；移除 `/bin/sh + curl` 热路径。退出：并发 SSE 无队头阻塞，client drop 可取消 provider，安装/restart/health 通过。

### M09 — SSE 主线

固定 provider bytes → frame parser → response pipeline → client frame → backpressure writer；SSE 不进 Cordis event bus，每 frame 不发生 TS/Rust IPC。退出：正常、malformed、EOF、provider failure、旧 epoch/client drop 全部按合同闭环。

### M10 — Router/Error/Health/Continuation

把 route group/pool/capability/priority/weight、provider error policy、health scope/recovery、direct-provider continuation 接入唯一 Rust owner 与 typed chain；本地/relay continuation 标记 retired 并由 gate 锁死。退出：正反状态、错误、session 隔离、direct continuation 多轮 differential/live 全绿，无 fallback。

### M11 — 协议、工具与管理面

接入 Chat、Anthropic、Gemini、WebSocket、function/custom/web-search/servertool/stopless；Admin 接 catalog、epoch、candidate、validate、smoke、publish、drain、rollback、audit。退出：每 endpoint 有 Cordis plan，工具不降级为文本，管理命令不触碰业务 payload。

### M12 — 全产品 parity 与 release

完成 protocol/provider/mode/state/lifecycle/concurrency differential matrix、live、canary、drain、rollback 和 managed restart。每个 feature 进入 `production_integrated → differential_pass → live_pass → frozen`，生成切换准备报告；实际切换仍需单独批准。

## 5. Worktree、claim、合并与同步协议

1. 从当前已验证基线创建唯一 semantic claim、`codex/<milestone>-<run>` branch 和 `./playground/<task>-<run_id>/` worktree；在 actor/owner 记录 base、owner、allowed paths。
2. 开工前刷新 `.agent-collab`，读取 resource/function/mainline/verification maps、module registry、canonical docs、KILL_SWITCH。
3. 先设计并固化最小 red fixture；red 通过后才修改唯一 owner。所有实现、测试、边界自检只在 task worktree。
4. 完成定向测试、locked build，以及适用时的全局安装、聚合 `routecodex restart`、全部成员 health、在线旧样本 replay；写入 evidence.jsonl。
5. checker 核对 change set、dirty 文件、owner 边界、相邻调用边、payload/control isolation、无 fallback/重复实现和 evidence；通过后写 merge queue。
6. 只把声明 change set 精确合并到 `codex/v4-cordis-refactor-main`，在重构主树运行受影响 gates。主树复验失败时不得推进依赖 task。
7. 一个 milestone 的全部 task 合并且主树复验通过后，才把 V4 重构主树整体精确合并仓库 `main`；在仓库 `main` 复验，并让 V4 重构主树同步新的 `main`。
8. 下一 milestone 只能从同步后的已验证 `main` 创建新 claim/worktree；不得从旧 branch/worktree 开始。

## 6. 必须证据与正反测试

合同必须有 schema、maps、manifest、wiki 和 CI/build gate；红测必须证明 bypass、丢 output、第二 NodeContainer、control leak、非相邻边和重复 writer 会失败。白盒、模块、集成、differential、构建、部署、在线和 AGY review 都必须绑定精确 candidate/artifact/tree。状态机、stream、timeout、retry、continuation、错误投影、资源清理必须成对覆盖 success/failure、terminal/non-terminal、already-terminal/still-running、prepare/abort、new epoch/old lease、Cordis alive/crash、client connected/drop、direct/relay。

## 7. 当前启动点

首个执行单元是 M00。先完成本计划、ADR、合同、ratchet 和 canonical gate 闭包；在 M00 全部 task 合并并复验前，不得 claim M01/M03/D0/M08，也不得自动切换 V3。
