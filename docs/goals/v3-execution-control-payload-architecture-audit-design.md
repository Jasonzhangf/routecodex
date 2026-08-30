# V3 执行生命周期、控制/负载与持久化隔离：目标设计

状态：目标架构设计；runtime 落地前必须完成 map/claim admission

问题合同：`docs/goals/v3-execution-control-payload-architecture-audit-problem.md`

执行方案：`docs/goals/v3-execution-control-payload-architecture-audit-plan.md`

## 1. 设计决策

### D1：保留完整 attempt 原子提交

当前 V3 合同选择：客户端可先收到 HTTP/SSE transport accept 与 keepalive，但 provider 业务字节只在一个 attempt 到达协议成功终态、封存完成后提交。

本次不改为增量业务流。理由：透明丢弃失败 attempt 与替代 provider 输出不混流，是现有 Direct/Relay failure recovery 的核心承诺。keepalive 只维持连接，不代表业务首 token 已提交。

### D2：一个 request lifecycle owner

统一 owner 位于 `routecodex-v3-runtime`。复用现有 Direct/Relay 执行主线，不新增 Manager/Service crate。

每个请求只创建一份 request-local context：

```rust
struct V3RequestExecutionContext {
    request_id: V3RequestId,
    execution_id: V3ExecutionId,
    target_plan: Arc<V3ImmutableTargetPlan>,
    budget: V3RequestAttemptBudget,
    cancellation: V3CancellationHandle,
    payload: V3ImmutablePayloadHandle,
    compiled_plan: Arc<V3CompiledExecutionProjection>,
}
```

字段名为设计合同，不要求机械照抄；实现必须满足相同所有权：控制对象只含 identity/handle/budget/cancellation，不含完整 payload clone、raw SSE、debug snapshot 或 provider 特例。

### D3：handoff 是状态迁移，不是 executor 重入

```text
Resident Tokio Runtime
  RequestExecutionContext
    -> Attempt N send/collect
    -> Error01..05 decision
    -> same TargetPlan reselect / typed Direct↔Relay transition
    -> Attempt N+1 send/collect
    -> terminal seal
    -> success receipt
    -> client replay
```

禁止：

- `spawn_blocking` + `Builder::new_current_thread()` 承载 provider network request/stream；
- SSE wrapper 调用完整 Direct/Relay executor；
- handoff 重新 classify/命中 VR；
- wrapper 自建 retry counter；
- `Option<Stream>` 表达替代执行结果。

### D4：Direct/Relay 共用 bounded attempt store

优先复用/提炼现有 `V3CommittedClientSseBuilder`，不保留第二套 `VecDeque<Vec<u8>>`。

目标接口：

```rust
trait V3AttemptPayloadStore {
    fn append(&mut self, frame: Bytes) -> Result<(), V3LocalResourceError>;
    fn mark_terminal(&mut self, receipt: V3ProtocolTerminalReceipt)
        -> Result<V3SealedAttempt, V3AttemptSealError>;
    fn discard(self);
}
```

硬约束：

- copy/append 前执行 byte/frame admission；
- Direct/Relay 同一实现、同一限制、同一 failure classification；
- initial slice 只做有界内存，不做磁盘 spill；容量超限显式进入内部 Error lane，禁止丢 frame 后假装完整；
- 后续若证明需要 spill，必须独立设计有界磁盘、租约、清理、加密/权限、crash recovery；不得作为本批次 fallback。

### D5：四维预算

必须同时存在：

| 预算 | 语义 | 超限行为 |
| --- | --- | --- |
| per-attempt bytes/frames | 单 provider attempt 最大驻留 | append 前 fail-fast，discard attempt |
| per-request resident bytes | 请求全部活动/封存 attempt 总驻留 | Error05 不可通过换 provider逃避本地额度 |
| process-global resident bytes | 全进程 attempt cache 总额 | admission 拒绝；不惩罚 provider |
| residence/deadline | attempt/request 最大驻留时间与总 deadline | typed timeout；释放全部 reservation |

现有 64 MiB / 262,144 frames 可作为 per-attempt 上限基线，但不得直接推导 global 值。执行 Phase 1 必须根据 listener 并发、现有 config、真实负载与压测先锁默认值，再写 compiled manifest/control resource。精确值未锁前 resource 保持 `design/pending`。

### D6：一个 Error05 recovery 入口

失败不新建平行枚举链；扩展现有 `V3Error01SourceRaised` / `V3ErrorSourceKind` 和 Error01→06 typed chain，保留真实归属：

| 来源 | Error01 归属 | provider health | client lane |
| --- | --- | --- | --- |
| upstream HTTP/body/network | ProviderFailure | 按 Error05 action | 外部状态码/已登记 provider 投影 |
| provider protocol malformed/incomplete | ProviderFailure 或明确 Protocol owner | 仅 Error05 授权 | provider error contract |
| local attempt budget exhausted | RuntimeFailure/LocalResource | 禁止 | 599（响应阶段） |
| observation lock/codec diagnostic failure | RuntimeFailure/Observation | 禁止 | 599；debug artifact 可记录 |
| persistence writer failure | RuntimeFailure/Persistence | 禁止 | 按资源 criticality；不得伪装 502 |
| client cancel/disconnect | ClientDisconnect | health-neutral | 499/closeout contract |

每个 recovery 必须消费同一 request context 中的 `V3Error05ExecutionDecision`；没有 Error05 witness 不得 retry/reselect/handoff。

### D7：不可伪造成功凭证

成功阶段必须拆开：

```text
TransportAccepted
  != ProtocolTerminal
  != AttemptSealed
  != ClientDeliveryCompleted
```

`V3AttemptSuccessReceipt` 只能由协议成功终态 + attempt seal 共同创建，包含 request/attempt/target identity 与 generation，不能由 HTTP 200、headers、stream handle 或观察快照重建。

消费者：

- provider health success：消费 `AttemptSuccessReceipt`；
- 需要成功前提的 route policy commit：消费同一 receipt；
- continuation commit：消费同一 receipt 和 Resp03/Resp04 合法输出；
- observability terminal success：消费 receipt projection；
- client delivery completed/aborted：独立 receipt，仅供 delivery/diagnostic，不反向改 provider success。

### D8：完整 AttemptOutcome

handoff/attempt 不再返回 `Option<Stream>`。所有 body 与 failure 都必须显式：

```rust
enum V3AttemptOutcome {
    Sealed(V3SealedAttempt),
    Recoverable(V3Error05ExecutionDecision),
    Terminal(V3Error06ClientProjected),
}

enum V3SealedAttemptBody {
    Sse(V3SealedSseFrames),
    Json(Value),
    Bytes(Bytes),
}
```

`CommittedSse` 若保留，必须是 `SealedSseFrames` 的 client projection，不得表示未完成 provider stream。

### D9：payload/config handle 与控制对象分离

- `raw` / normalized request / provider semantic payload 使用 immutable shared handle；
- write-capable hook 仅在登记节点执行 copy-on-write；
- compiled manifest 使用 `Arc<V3Config05ManifestPublished>` 或更窄 immutable projection；
- executor/handoff 只携带 plan handle，不 clone 完整 manifest；
- provider compat owner在 manifest/target plan 阶段解析 profile，execution skeleton 只消费 typed `CompatPlan`，禁止判断 `responses:deepseek-console-go` 等具体字符串。

控制 handle 绝不进入 provider/client normal payload，也不从 payload `metadata` 重建。

## 2. 控制状态与诊断状态拆分

当前 `V3RuntimeStreamObservationSnapshot` 同时承载 terminal control 和大诊断数据。目标拆分：

```rust
struct V3AttemptControlState {
    generation: u64,
    terminal: Option<V3RuntimeSemanticTerminal>,
    failure: Option<V3TypedFailureRef>,
    commit: V3AttemptCommitState,
    cancellation: V3CancellationState,
}

struct V3StreamDiagnostics {
    usage: Option<V3RuntimeUsageSummary>,
    timing: Option<V3RuntimeTimingSummary>,
    typed_object_types: BoundedSet,
    sampled_raw_sse: V3DebugBoundedTextCapture,
    artifact_ref: Option<V3DebugArtifactRef>,
    observation_error: Option<V3ObservationError>,
}
```

要求：

- `semantic_terminal()` 只读 small control state，不调用 full snapshot；
- control lock 与 diagnostics lock 分离；
- per-frame terminal check 不 clone String/Vec/usage/timing；
- snapshot 仅在明确 debug/console/export 边界创建；
- diagnostics failure 记录到 typed debug/error resource，不改变 attempt truth；
- raw SSE 继续有界，必要时只存采样/引用，不进入 control state。

## 3. 持久化隔离

### 3.1 Provider health

```text
request hot path
  -> short health lock: apply mutation + increment generation
  -> immutable persistence delta/snapshot handle
  -> unlock
  -> single writer coalesces and fsync/rename
```

要求：

- 磁盘 I/O 绝不发生在 provider health state lock 内；
- 相同内容/generation 不重复写；
- writer 单 owner、有界队列、coalescing；
- queue full/persistence failure 显式暴露，不得 silent drop；
- 强持久化操作若需要确认，等待 writer receipt 时也不得持有 health lock；
- in-memory routing truth 与 persistence truth 分开，restart recovery 合同明确。

### 3.2 WebUI/observability ledger

Config 只拥有路径与策略 materialization，不拥有运行时 JSONL I/O。

目标 ownership：

- Server：生成 typed lifecycle event、维护 active requests + bounded recent terminal cache；
- Debug/Observability storage owner：单 writer、bounded read、bounded queue 与显式 file-byte admission；
- Admin：分页查询 projection；
- Config：只发布 retention、file budget、path、queue capacity 的 compiled config。

硬边界：

- 内存只保留 active + 有界 recent terminal；
- JSONL 文件有 max bytes，append 前 fail-fast；本批次不自动删除或轮转历史；
- startup 只加载必要索引/近期窗口，不 fold 全历史进 map；
- request hot path 不 open/flush 文件；
- observability queue full/写盘失败不得改变 request outcome、provider health 或 route decision；必须产生独立可观测 internal error/alarm。

## 4. 模块所有权

| 模块 | 应拥有 | 禁止拥有 |
| --- | --- | --- |
| `v3.runtime` | request context、attempt state machine、budget、Error05 decision execution、success receipt | provider-specific profile 字符串、磁盘 persistence、完整 payload clone |
| `v3.target` / `v3.virtual_router` | immutable plan、plan 内 candidate selection；VR 只初始命中 | network I/O、stream、attempt store、payload repair |
| `v3.provider_compat_core` / adjacent codecs | typed compat plan、协议 parse/project/validate | Runtime 创建、retry/reselect、health mutation |
| `v3.provider_responses` | transport/auth、provider health state mutation与其 persistence writer owner | VR classify、client projection、控制状态进 payload |
| `v3.sse` | opaque framing、limits、backpressure、closeout | provider semantic terminal、retry、health、continuation |
| `v3.server` | HTTP/SSE transport accept、keepalive、client delivery、typed event projection | provider attempt retry、协议语义、同步账本 I/O |
| `v3.debug` | bounded diagnostics、runtime observability JSONL schema/append/bounded read、artifact/ledger writer | request success、commit、provider health decision |
| `v3.config` | authoring→validated manifest；storage path/policy | runtime request ledger I/O |

不得先移动文件再补 owner。resource/function/mainline/module/verification maps 必须先激活目标关系。

## 5. 目标主线

```text
V3Server03HttpRequestRaw
  -> V3 immutable payload handle + RequestExecutionContext
  -> VR initial immutable TargetPlan
  -> AttemptController selects target within plan
  -> ProviderTransport returns raw body/stream on resident Runtime
  -> adjacent provider codec consumes stream
  -> bounded AttemptPayloadStore append
       local capacity failure -> Error01 RuntimeFailure -> Error05 terminal/internal
       provider/protocol failure -> Error01 ProviderFailure -> Error05 recovery
  -> protocol terminal receipt
  -> sealed attempt
  -> AttemptSuccessReceipt
       -> provider health success
       -> route policy commit
       -> continuation commit
  -> client projection/replay
  -> ClientDeliveryReceipt
```

Direct↔Relay 只改变下一个 attempt 的 execution mode/codec plan；不创建新 request context，不重命中 VR，不重置 budget，不复制 payload。

## 6. 反向不变量

门禁必须证明以下代码形态不可复活：

- Direct/Relay stream wrapper 内出现 `Builder::new_current_thread`、`Runtime::new`、完整 executor symbol；
- handoff closure持有/clone `V3Server03HttpRequestRaw` 或完整 manifest；
- attempt buffer 使用无 admission 的 `VecDeque<Vec<u8>>`；
- terminal read 调用 full `snapshot()`；
- local resource/observation error构造 `V3ProviderError::ResponseBody`；
- health lock 临界区出现 `fs::write`/`rename`/persistence call；
- WebUI record mutex 临界区出现 open/write/flush；
- Config crate继续拥有 runtime observability append/read；
- HTTP 200/stream handle直接调用 provider success或 route commit；
- Error05 缺席时发生 retry/reselect/handoff；
- compat profile字符串分支出现在通用 execution skeleton；
- business/control fields互相重建。

## 7. 迁移原则

1. 先合同和红测，后实现。
2. 先统一 lifecycle owner，再处理性能优化；否则只是让第二套 executor 更快。
3. 先让 Direct 使用同一 bounded attempt store，再物理删除旧 buffer。
4. 先让 handoff消费同一 context/Error05，再删除临时 Runtime/递归 executor。
5. success receipt 接线完成后，物理删除所有提前 success/commit 分支。
6. control/diagnostics split 完成后，物理删除 terminal→snapshot 热路径。
7. persistence writer 接线后，物理删除锁内同步 I/O 与 Config runtime store owner。
8. 禁止双路径、feature flag fallback、silent strip、兼容旧语义。

## 8. 当前落地绑定

- runtime observability store 唯一 owner：`routecodex-v3-debug::observability_store`；Config 只发布 path 与 byte policy。
- Server writer 在 listener mutex 外 enqueue；Debug append 在写入前执行 record/file byte admission。
- Admin 只通过 Debug owner 读取 raw/bounded rows，不直接打开 Config-owned runtime store。
- history 达到 hard cap 时显式失败并保持 in-memory request projection truth；不以自动删除、rotation 或 silent drop 伪装成功。
- Target `available=false` 是显式 exhaustion；缺少 scope label 不得恢复候选。
