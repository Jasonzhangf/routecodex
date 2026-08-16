# V3 Managed Live Server Lifecycle Plan

## 1. 目标与验收标准

把当前手工前台运行的 V3 5555 转为独立、可重复、可观测、可安全重启的 managed lifecycle，同时保持 V2 聚合实例与 V3 实例并行、端口归属唯一、凭据不进入配置 Manifest 或进程命令行。

验收标准：

- `rccv3 start|status|restart|stop -c|--config <path>` 形成单一 Rust lifecycle owner；不带 `-c` 时默认读取 `~/.rcc/config.v3.toml`；`rccv3 server ...` 只保留隐藏兼容入口；start/restart 不产生重复 listener 或孤儿进程。
- `rccv3 start` 是前台 console monitor：启动后不退出，强制把 V3 server startup/request console 打到当前终端；`--snap` 强制启用 V3 debug snapshots。
- instance declaration 是服务身份真相；PID 只是带启动时间/instance identity 的瞬态 cache，不能仅凭端口或陈旧 PID 接管进程。
- restart 只作用于匹配的 V3 instance，一次操作覆盖该 config 的全部 listener；禁 broad kill、按端口循环 restart 或杀任意占用者。
- V2 5520/10000/4444 与 V3 5555 并行健康；真实 JSON/SSE `/v1/responses` 在 managed restart 前后均通过。
- auth 仅由 env/token-file handle 在 provider transport 边界解析；literal secret 不进 config、Manifest、state、argv、日志或 evidence。

## 2. 范围与边界

In scope：

- V3 CLI managed lifecycle 命令与唯一 Rust lifecycle module。
- deterministic instance ID、instance declaration、PID cache、启动锁、状态探测、graceful shutdown/restart、stale cache cleanup。
- `~/.rcc/state/v3-runtime/` 的运行时状态 contract 与权限。
- `~/.rcc/config.v3.toml` 的稳定启动面和 auth handle 可用性；不得复制 literal secret。
- managed live 5555 切换、V2/V3 并行 health、JSON/SSE smoke、日志与进程身份验证。
- resource/function/mainline/verification maps、wiki、manifest、test design、red gates。

Out of scope：

- SSE Transport Core、Responses continuation、Anthropic Relay、Hub request/response semantics。
- V2 lifecycle 实现重构、V2 provider/routing 改动。
- provider payload转换、retry/routing/error policy、fallback。
- release 发布；global install 只在源码/构建/受控 blackbox 全绿且 Jason 已授权当前 V3 live replacement 的范围内执行。

Claim：`feature_id:v3.managed_server_lifecycle`

## 3. 设计原则

- Config authoring -> validated deterministic Manifest -> lifecycle；runtime 不宽松扫描目录拼能力。
- 服务身份由 config digest + instance declaration +启动 nonce/时间绑定；端口和 PID 都不是唯一真相。
- `instance_id` 由 canonical config path + config digest 定义；`executable_path` 是精确启动来源。
  只有已验证 `stopped|failed` 且其余声明字段完全一致时，才允许把同一服务前向发布到新的
  release snapshot executable。运行中、缺 terminal truth 或其他字段变化一律拒绝接管。
- start/restart/stop 只允许显式匹配 V3 instance；`start` 如发现配置 listener set 被占用，先通过匹配的 managed control 优雅停止；仍未释放时只允许向正在监听这些配置端口的 explicit PID 发送 SIGTERM，再必要时 SIGKILL。禁止 broad/unscoped kill、禁止误动 V2 aggregate 或非配置 listener 进程。
- restart 是一个 aggregate instance 操作，不逐 listener 循环。
- stop/restart 使用显式 control channel 或已验证 PID；发送前再次校验 identity，超时显式失败。
- secret handle 与 runtime state 分离；state/debug/argv 永不记录 resolved secret。
- 不做 fallback、双 supervisor、第二 server lifecycle 或 shell-only 业务真相。

## 4. 技术方案与文件清单

先查并同步：

- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/wiki/`
- `docs/design/server-runtime-lifecycle-ssot.md`（仅借鉴经过验证的 V2 身份原则，不复用 Node 业务 owner）
- `.agents/skills/rcc-dev-skills/SKILL.md`
- `.agents/skills/rcc-dev-skills/references/50-rcc-config-ssot.md`

候选实现：

- 新建 `v3/crates/routecodex-v3-lifecycle/`：实例 identity、state schema、锁、control、status、start/restart/stop plan 的唯一 Rust owner。
- `v3/crates/routecodex-v3-cli/src/main.rs`：参数解析与调用 lifecycle API 的薄壳。
- `v3/crates/routecodex-v3-server/`：只暴露 graceful shutdown/control handle 和 listener identity，不拥有进程管理策略。
- `v3/Cargo.toml`、focused tests、external CLI blackbox、controlled state fixtures。
- 对应 maps/wiki/manifest/test design/gates。

建议状态结构：

```text
~/.rcc/state/v3-runtime/instances/<instance_id>/
  instance.json       # declaration/config digest/listeners/executable identity
  pid.cache           # pid/start identity，瞬态 cache
  control.json        # 非 secret control endpoint/nonce reference
  lifecycle.lock      # 单操作锁
```

精确 schema 必须由 Rust `serde(deny_unknown_fields)` 定义，原子写入；不得把 provider/client payload、resolved auth、Metadata、Debug snapshot 写入状态目录。

## 5. 风险与规避

- PID reuse/陈旧 cache 杀错进程：校验 instance ID、executable identity、process start identity 与 health/control challenge；任一不匹配 fail-fast。
- 端口占用被误接管：端口只用于 listener locator；占用者不因此成为 managed identity。只可释放当前配置 listener set 上的 explicit listening PID；禁止 broad kill、非 listener kill、误动 V2 aggregate。
- CLI daemon 与外部 supervisor 双重拥有：只保留一个 managed lifecycle owner；若选择 OS adapter，它只能消费 lifecycle manifest，不重实现策略。
- secret 出现在 argv/state/log：只记录 handle 名；加 red scan 与进程 argv 黑盒。
- restart 先停后起失败造成长期中断：先 validate config/executable/auth handle readability、获取锁和身份，再执行 graceful replacement；失败显式报告，禁止启动旧/备用配置 fallback。
- 与三个 worker 冲突：只修改 lifecycle/CLI/server control surface；不进入 SSE、continuation、Anthropic owner。

## 6. 测试计划

- 红测先行：当前 V3 只有前台 `server start`，`status` 仅打印 config，不验证 live instance；managed restart/stop 缺失；后续用户入口必须保持旧 CLI 同形的顶层 `rccv3 start/status/restart/stop`。
- 正向白盒：deterministic instance ID、atomic state、lock、live identity、graceful stop/restart、multi-listener aggregate identity、stale cache cleanup。
- 正向白盒：补充 stopped/failed terminal state 下同 config 的 release snapshot executable 前向轮换。
- 反向白盒：PID reuse、active/missing-terminal executable rollover、wrong config digest、configured listener PID takeover failure、duplicate start、concurrent restart、malformed/unknown state field、missing auth handle、shutdown timeout、already terminal/stopped。
- CLI controlled blackbox：top-level `start -> startup console -> request console -> health -> status -> duplicate start takeover -> restart -> PID/nonce changes且 instance identity 稳定 -> stop -> listeners closed -> status stopped`；不带 `-c` 使用 `~/.rcc/config.v3.toml`；`--snap` 强制 debug snapshots；隐藏 `server ...` namespace 只做兼容验证。
- 安全黑盒：argv/state/log/evidence 不含 resolved secret；只向已验证 PID/control endpoint 发精确操作；source gate 禁 broad kill/port kill。
- live closeout：受控切换当前 5555；restart 前后 `/health`、`/v1/models`、真实 JSON/SSE `/v1/responses`；同时验证 V2 5520/10000/4444 不受影响。
- 必跑 architecture/resource/function/mainline/module/rust-only、fmt、clippy、workspace、CLI build、diff check。

## 7. 实施步骤

1. 刷新 `.agent-collab`，取得 claim；按 MemoryPalace -> V3 resource/function/mainline/verification maps -> lifecycle docs -> source 顺序定位。
2. 写 lifecycle test design、machine-readable state/instance contract 和当前红基线。
3. 实现独立 Rust lifecycle crate 的 identity/state/lock/status/control primitives。
4. 将 CLI 收缩为薄壳，Server 只提供 typed graceful control handle。
5. 绿化白盒与 external CLI controlled blackbox；加 wrong-PID/configured-listener-takeover/broad-kill/default-config/snap/foreground-console/secret red gates。
6. 同步 maps/wiki/manifest/gates，跑完整 V3 gates与 architecture review。
7. 在保留当前 live 5555 的前提下先用临时端口验证 managed lifecycle；全绿后由 `rccv3 start` 按 managed control -> configured listener explicit PID SIGTERM -> SIGKILL 的顺序接管 5555。不得 broad kill、不得停止 V2 aggregate。
8. 重启 managed V3，执行 V2/V3 并行 health 与真实 JSON/SSE smoke，记录 evidence。

## 8. 完成定义

- V3 有唯一 Rust managed lifecycle，顶层 CLI `start/status/restart/stop` 都消费它；`server start/status/restart/stop` 只能作为隐藏兼容 namespace。
- 5555 由 managed V3 instance 持有，不再依赖 agent exec session；V2 aggregate 继续持有 5520/10000/4444。
- restart 前后 health/models/真实 JSON/SSE 通过，进程身份与 state contract 可审计。
- 无 broad kill、非配置 listener 进程接管、secret 泄漏、fallback、第二 supervisor 或跨 worker owner 修改。
- evidence.jsonl、maps、wiki、verification gates 和 skill 经验同步完成。
