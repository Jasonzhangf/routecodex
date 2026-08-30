# V3 WebSocket / Local Continuation 移除与性能资源深度审计计划

## 1. 目标与验收标准

本计划分为两个严格有序的阶段：

1. 物理移除 V3 WebSocket 支持与 RouteCodex-owned local continuation。
2. 在删除完成、架构边界和构建验证通过后，对剩余 V3 做证据驱动的内存、文件描述符、对象生命周期与复制成本审计，并提出解决方案供 Jason 审核。

本任务只生成审计结论和解决方案，不在审计阶段直接实施性能优化。任何性能修复必须在方案审核通过后另行实现。

验收标准：

- V3 源码、配置、依赖、测试、fixture、脚本、文档、resource/function/mainline/verification map 和 manifest 中不再存在 RouteCodex WebSocket 能力入口。
- V3 不再实现、保存、恢复或投影 RouteCodex-owned local continuation；删除 local continuation flag、store、state、save/restore/release 链路及其测试/文档。
- Codex/upstream-owned remote continuation 保持原语义，不删除 provider/upstream continuation wiring，不把其纳入 RouteCodex 本地缓存优化目标。
- 删除后的 V3 请求/响应主链仍保持既定相邻节点、Rust owner、控制面/数据面隔离和 fail-fast 语义。
- 审计报告能够以源码、调用图、运行时计数、RSS/分配、FD/stream 生命周期和复制字节数证据回答：
  - 是否有真实内存泄漏、FD 泄漏或无界 retention；
  - 哪些复制是必要的，哪些是可消除的；
  - 哪些大对象应 move、Arc/shared、借用或分阶段释放；
  - 每个问题的唯一 owner、最小解决方案、验证方式和剩余风险。

## 2. 范围与边界

### In scope

- `v3/` 下所有 WebSocket provider transport、client WebSocket upgrade/frame projection、配置兼容入口及其测试和注册项。
- `v3/` 下所有 RouteCodex-owned local continuation store/state、Req04 restore、Resp04 save、server state 和桥接参数。
- 删除后的 V3 Rust runtime/server/provider/config/CLI 编译、架构门禁和定向测试。
- 剩余 HTTP JSON/SSE 主链的内存、FD、stream、缓存、registry、snapshot/debug retention 与 payload copy 审计。
- 审计方案、测量工具/测试设计、红测设计、修复候选和验证矩阵。

### Out of scope

- Codex/upstream remote continuation 的实现、存储、协议策略或上游连接管理。
- 为了让 remote continuation 工作而恢复 WebSocket 或 local continuation。
- 修改用户 live 配置、全局安装、重启、发布或 provider endpoint 猜测，除非后续实现任务明确授权。
- 在本任务内实施性能优化、重构无关模块或引入新的 Manager/Service/缓存层。
- 通过 fallback、静默 strip、请求 cleanup、handler/SSE/outbound 补偿掩盖删除后的断链。

## 3. 已确认事实与设计原则

### WebSocket

WebSocket 不是“未支持”或“仅配置未启用”；当前 V3 仍有完整实现和注册：

- Provider transport：`v3/crates/routecodex-v3-provider-responses/src/transport.rs`、`transport/websocket.rs`，包含 `send_websocket_v2`。
- Server client transport：`v3/crates/routecodex-v3-server/src/websocket.rs`、`src/lib.rs`。
- 配置入口：`transport = "websocket_v2"`、`websocket_v2_url` 及兼容映射。
- 注册项：`v3.responses_websocket_v2_transport_hardening`、`v3.responses_inbound_websocket_proxy`，以及对应 resource/function/mainline/verification 项。
- 相关旧验证和 live 记录不能被误标为当前能力仍需保留；它们应转为删除证明或历史说明。

当前 live 配置未启用 WebSocket，但这不能替代源码能力移除。实现阶段必须物理删除代码和所有可达入口。

### Local continuation

当前配置已关闭 local continuation，但源码仍保留 gate、store、state、save/restore 和测试。因此实现阶段必须物理移除，而不是继续保留 feature flag 或 disabled branch。

保留并单独核实的内容：

- Codex/upstream remote continuation 的 direct/provider-owned 语义。
- 与 remote continuation 必需的 typed owner observation、exact pin 或协议字段；只有证明属于 local store 的部分才可删除。
- Stopless/Servertool 独立控制面；不得把它误删为 local continuation，也不得把控制状态放回业务 payload。

### 不变量

- 控制面和业务 payload 物理隔离；routing、continuation、retry、health、debug、snapshot、scope 等不得进入 provider/client normal payload。
- 既定流水线顺序不变：`req_inbound -> req_chatprocess -> req_outbound -> resp_inbound -> resp_chatprocess -> resp_outbound`。
- 只允许相邻 builder/parser；不新增旁路、fallback 或重复 DTO。
- 任何删除后的缺失能力必须显式 fail-fast，不能在 handler、SSE、outbound 或 provider runtime 添加补偿。

## 4. Owner、资源与调用边审查

实现前必须按真实 map 依次读取并锁定：

- `v3-resource-operation-map.yml` / resource registry；
- `v3-function-map.yml`；
- `v3-mainline-call-map.yml` 与 mainline manifest；
- module registry；
- `v3-verification-map.yml`；
- 相关 wiki/design canonical docs。

### WebSocket 删除审查面

至少核实以下 owner 和相邻边，再逐文件删除：

- Provider WebSocket connection/resource、transport state、handshake、frame parser、cancellation/drop。
- Server client upgrade、ping/pong、frame decode、SSE-to-WebSocket projection、disconnect 传播。
- Config parser/compiler、V2 compatibility projection、model/provider capability 字段。
- Tests、red fixtures、verifiers、package scripts、resource/function/mainline/verification/map/wiki/manifest。
- 依赖项和 dead import；删除后用编译器确认无隐藏引用。

### Local continuation 删除审查面

至少核实以下 owner 和相邻边，再逐文件删除：

- `local_continuation.rs` store/state/types/builders。
- Req03/Req04 restore、Resp03/Resp04 save/commit/release 和 relay runtime wiring。
- Server response outcome、endpoint handler、bridge 参数和 session state。
- `responses_continuation_disabled_for_server`、response-id strip 与 local-only config。
- local continuation tests、fixtures、verifiers、docs/maps/gates。
- remote continuation owner files：`remote_continuation.rs`、`responses_continuation_owner.rs`、`kernel/direct_state.rs`、`kernel.rs`；仅确认边界，不擅自删除 remote 语义。

## 5. 物理删除顺序

1. 刷新 `.agent-collab` runs/claims/worktrees，确认 dirty 文件边界；为本问题使用独立、干净 owner worktree。
2. 读取 resource/function/mainline/verification map 和对应源码，建立“删除项—唯一 owner—调用者—验证 gate”表。
3. 为 WebSocket 和 local continuation 各建立最小 deletion contract 与 failing red fixture，证明当前引用确实可见且删除后必须失败/编译阻断。
4. 删除 WebSocket provider/server/config/compat/test/doc/map/gate 入口；逐文件读取后只用明确 `apply_patch` hunk。
5. 删除 local continuation store/state/save/restore/config/test/doc/map/gate；保留并验证 remote continuation 与 Stopless 独立控制面。
6. 同步 machine-readable registry、function/mainline/verification map、manifest、wiki 和 package/build gate；删除 stale entry，不保留“disabled but supported”假入口。
7. 运行 formatter、定向 Rust tests、workspace tests、架构/owner/module/Rust-only/resource/mainline gates；先解决删除导致的真实编译和注册漂移。
8. 在未实现性能优化的前提下完成删除后的基线构建和必要的在线旧样本验证；不能用源码测试冒充运行版本证据。
9. 仅在删除闭环通过后执行深度性能与资源审计。

## 6. 删除后深度性能与资源审计方案

### 6.1 内存与对象生命周期

建立请求级生命周期时间线和所有权表，覆盖 raw body、parsed `Value`、normalized payload、Hub semantic envelope、provider wire body、serialized output、SSE buffers、debug/snapshot/sample retention、route history、transport handoff registry。

测量并区分：

- 真正泄漏：请求终止后对象仍不可达但被 owner registry/任务/闭包保留；
- 无界 retention：可达但没有 TTL、scope eviction、terminal cleanup 或 byte/count cap；
- 正常峰值：请求尚未结束时多份对象暂时同时驻留；
- 正常连接池 keepalive：不可直接判为 FD leak。

场景至少包括普通 JSON、SSE、large image/history、provider error、client disconnect、provider EOF/terminal、并发请求、cancel/timeout 和 repeated session。

证据至少包括 RSS、分配字节/次数、请求阶段 payload bytes、峰值同时驻留对象、终止后的回收结果和 registry size 曲线。

### 6.2 文件描述符与 stream 生命周期

覆盖 inbound HTTP body、reqwest pool、provider SSE、client SSE、cancellation/drop、early disconnect、stream error/EOF/terminal close、restart handoff socket、debug/sample writer 和 auth file read。

每条路径必须证明：打开者、关闭/Drop owner、终止条件、异常路径、连接池保留策略、重复请求后的 FD 基线。不得使用 broad kill 或破坏性清理来“验证”泄漏。

重点审查 `transport_handoff.rs` 中 `attempts` / `next_attempt_ids` map 是否在 terminal、failed、detached 后由唯一 owner remove；若不存在运行时 remove，必须形成可复现 retention 证据后再提出修复。

### 6.3 不必要的内存复制

沿同一 requestId 记录 raw request → provider-bound request → raw response → client projection 的对象身份、Arc strong count、clone 次数和字节数。

重点审计：

- `resp_outbound_05_client_semantic.rs` 中 `Arc<Value>` 被再次 deep clone 的 Responses identity path；
- `provider_compat_shared.rs` 中 `wire.body().clone()` 的完整 payload clone；
- `frame_builders.rs` 中 request body 全量聚合加 `serde_json::Value` 解析造成的峰值叠加；
- SSE chunk stringify/materialize、snapshot/debug retention 和 `Arc::make_mut` 触发的整树复制；
- provider protocol conversion 中真正需要的新树与可 move/in-place/COW 的路径。

每处必须分类为：必要复制、可 move、可 Arc/shared、可借用、必须协议转换，不能以“优化”名义改变真实 payload 语义或裁剪字段。

### 6.4 共享传递与流水线边界

审计对象是否在阶段间通过 typed carrier/`Arc`/move 传递，还是每层重新构造 `Value`/DTO。解决方案必须保持节点边界和 owner：

- identity projection 优先共享 immutable `Arc`；
- 真正协议投影才新建 payload；
- owner 内字段变更优先 move 或受控 COW，不先 clone 整棵树；
- 不用共享可变对象绕过阶段类型或 scope 隔离；
- 不把 MetadataCenter/control/debug/error 搭进共享业务 payload；
- 不新增通用 Manager/Cache/Adapter，除非审计证明已有多个真实 owner 需要同一共享资源。

### 6.5 无界控制状态与观测 retention

审计 `route_policy.rs` histories、transport handoff attempts、debug/snapshot/sample retention、session/request maps 和 task registry：记录 key 生命周期、terminal cleanup、TTL、最大 count、最大 bytes、scope 锁和跨端口/跨 session 风险。

必须区分生产语义状态、projection、debug/metadata side-channel；不能以删除观测证据换取“内存下降”。如发现无界结构，先定位唯一 owner，再提出最小 eviction/release 方案和正反测试。

## 7. 解决方案输出格式（供审核，不直接实现）

审计报告对每个问题使用固定字段：

- `finding_id` / severity / feature/resource id；
- 证据：文件、symbol、调用边、运行数据、复现命令；
- 根因：唯一 owner 和 retention/copy/FD 机制；
- 影响：峰值内存、分配、FD、延迟、并发放大；
- 候选方案：move、Arc/shared、COW、分阶段 drop、bounded retention、显式 cleanup 等；
- 语义与架构检查：payload 等价、控制面隔离、相邻节点、无 fallback；
- 正向/反向验证；
- 最小改动范围、风险、是否需要 live 验证；
- Jason 审核结论栏：`pending / approved / rejected`。

默认优先选择最小、可证伪、可回滚且唯一 owner 清晰的方案；本轮不写性能修复代码。

## 8. 测试与验证矩阵

删除阶段：

- WebSocket/local continuation source red fixtures：旧入口和旧 owner 引用被发现时必须失败；删除后对应禁止路径保持红；
- Rust formatter、clippy、定向 crate tests、V3 workspace tests；
- resource/function/mainline/verification map compile、owner queryability、module boundary、Rust-only、payload side-channel、manifest/wiki sync gates；
- `git diff --check`；
- 删除后 HTTP JSON/SSE 正常路径、provider error、client disconnect、terminal/EOF 的正反测试；
- remote continuation 仅做不受误删影响的回归验证，不改变其 owner 或实现。

审计阶段：

- 正常与异常生命周期成对：success/failure/non-terminal/already-terminal；
- disconnect/cancel/timeout/EOF/terminal 成对；
- 单请求与并发请求；小 payload 与 large payload；JSON 与 SSE；
- copy identity/Arc count/clone budget red-green probes；
- FD baseline、峰值、终止后回收和重复运行稳定性；
- RSS/allocation/retention 结果保留原始 artifact，禁止只报告平均值；
- 所有不能在线验证的项目明确标记证据缺口，不宣称完成。

## 9. 风险与不可误删项

- “live 未启用 WebSocket”不能作为保留源码的理由；但删除 provider WebSocket 不得误删普通 HTTP/SSE transport。
- “local continuation 已关闭”不能作为保留 store/flag 的理由；但不得误删 Codex/upstream remote continuation。
- 不得把 client `previous_response_id`、provider remote response id 或必要 direct pin 一概视为 local store。
- 不得误删 Stopless/Servertool control state；其资源关系必须继续走 typed side-channel。
- 不得在 handler/SSE/outbound/provider runtime 增加删除后的 fallback 或 payload cleanup。
- 不得直接改用户 live config；实现任务若需配置迁移，必须单独声明、授权并验证。
- 当前已有 dirty 文件和其他 worker claims 必须保持原样；不得 reset、checkout、stash 或覆盖无关改动。
- 已知 copy-budget verifier 存在 root/cwd contract 漂移；必须先修复验证入口并证明 red fixture 真能失败，不能把当前失败说成 gate PASS。

## 10. 完成定义（DoD）

- WebSocket 和 local continuation 已从 V3 可执行源码、配置入口、测试、文档、registry/map/manifest/gate 中物理移除，并有删除证据。
- remote continuation 与 Stopless/control plane 边界有明确回归证据，未被误删、未进入业务 payload。
- 删除后的构建、架构门禁、定向测试和必要 live 旧样本验证完成；未验证项明确列出。
- 深度审计报告覆盖内存/FD/stream/retention/copy/shared-object 五类问题，按证据而非静态猜测定级。
- 每个确认问题都有唯一 owner、根因、最小解决方案、正反测试和审核状态；未获 Jason 审核的方案不实施。
- 本任务不包含性能优化实现；下一阶段只有在方案审核通过后才可进入代码修改。
