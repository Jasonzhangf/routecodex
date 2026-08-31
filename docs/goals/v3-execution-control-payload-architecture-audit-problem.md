# V3 执行生命周期、控制/负载与持久化隔离：问题基线

状态：审计问题合同；隔离 worktree 内整改执行中

审计基线：`main@db0715925cdb7cd5c3d8e09b1d6b8f20f3738ca0`

专用工作树：`/Users/fanzhang/Documents/github/routecodex/playground/v3-arch-audit`

分支：`codex/v3-execution-control-audit`

## 1. 结论

V3 已有 crate 划分、请求/响应/Error 类型链、Direct/Relay 协议边界和部分共享负载，但尚未形成可靠的执行生命周期唯一性、控制读取定成本、负载存储有界性与热路径持久化隔离。

首要根因不是文件数量，而是三项执行权仍分散：

1. Direct SSE wrapper 可以启动第二个完整执行器与临时 Tokio Runtime。
2. Direct 与 Relay 各自拥有 attempt 缓冲、失败恢复和成功提交语义。
3. 健康、路由、continuation、观测分别从不同阶段推断“成功”，没有共享不可伪造的终态凭证。

因此当前实现不能证明：谁拥有请求、谁拥有流、谁能重试、谁能宣布成功、谁能修改健康状态。

## 2. 已成立边界

以下能力应保留，不应因整改退化：

| 边界 | 当前证据 | 结论 |
| --- | --- | --- |
| Provider 网络 I/O | `routecodex-v3-provider-responses` Transport | 基本成立；网络发送继续归 Provider Transport |
| Relay 大 JSON 共享 | `V3HubOpaquePayload` / `V3HubResponsePayload` 使用 `Arc<Value>` | 保留 immutable payload handle 方向 |
| 控制类型存在 | continuation owner、execution mode、target resolution 有独立类型 | 类型应成为统一控制器输入，不得回写 payload |
| Relay attempt 有局部上限 | `V3CommittedClientSseBuilder`：64 MiB、262,144 frames | 可作为统一 attempt store 的现有实现基础 |
| 原始 SSE 诊断捕获有局部上限 | `provider_raw_sse` 最多 2 MiB | 问题是热路径复制与共锁，不是单对象无界 |
| 原子完整 attempt 是已登记合同 | `v3.direct_sse_accept_skeleton` manifest 与 full-attempt docs | 整改继续采用终态后提交，不改成增量业务流 |

## 3. 现存重大问题

### A1 — P0：Direct 生产 attempt buffer 无字节/frame 上限

证据：

- `v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs`
- `V3DirectSseAttemptBuffer { frames: VecDeque<Result<Vec<u8>, ...>> }`
- `push()` 直接 `push_back`，无累计字节、frame、request 或 global admission。
- `v3.sse.direct.full_attempt_buffer` 在 resource map 中仍为 `binding_status: design`。

影响：

- 非终态长输出可持续扩大驻留内存。
- 并发乘以单 attempt 负载后没有进程总量边界。
- Transport timeout 仅限制时间，不限制已分配字节。
- 当前 Direct buffer 绕开 Relay 已有 `V3CommittedClientSseBuilder` 限制。

首次偏离：`19a122ba8 fix(v3): buffer direct SSE attempts` 引入完整 attempt 缓冲，但没有容量 admission，也没有复用 Relay bounded builder。

### A2 — P0：handoff 返回 lazy 网络流后销毁创建流的临时 Runtime

证据：

- `v3/crates/routecodex-v3-runtime/src/kernel.rs`
- `v3/crates/routecodex-v3-runtime/src/kernel/v3_direct_core.rs`
- SSE handoff 使用 `spawn_blocking`，内部创建 `Builder::new_current_thread()`；通用 Direct 还额外创建 OS thread。
- 临时 Runtime `block_on` 完整 Direct executor；返回值可含 `V3ClientBody::Sse(stream)`。
- Provider Transport 返回 lazy `response.bytes_stream()`，不是已完全 materialize 的 body。

影响：

替代请求收到响应头后返回 lazy stream，临时 Runtime 随 closure 结束销毁，上层随后才消费 stream。真实 TCP I/O driver 生命周期不再由一个常驻 owner 保证。

首次偏离：`205ca8337 fix(v3): hand off direct SSE provider failures` 引入完整执行器重入、深 clone 和临时 Runtime。

### A3 — P1：SSE handoff 是第二个重试控制器

证据：

- wrapper 在流失败后自行调用完整 Direct executor。
- 完整 executor 重新 classify、route policy、pool resolve、Target hit，并新建局部 `failed_candidates` / `same_candidate_retries`。
- wrapper 持有 `handoff_budget`；被重入 executor 同时拥有自己的 retry/reselect 生命周期。
- handoff 返回 `Result<Option<V3ClientSseStream>, Error01>`；Json/Bytes/CommittedSse 被压成 `Ok(None)`。

影响：

- Target 内部 reselect 可能重新进入 VR，偏离 immutable Target plan 合同。
- Error05 不再是唯一 recovery 授权入口。
- “8 次”不是可证明的 request 总 attempt 数。
- 替代执行成功但 body 非 SSE 时丢失完整结果语义。
- Request/manifest/raw 被 closure 深 clone，控制成本随负载增长。

### A4 — P1：SSE 真正终态前写 provider success 与 route commit

证据：

- `kernel.rs` 与 `kernel/v3_direct_core.rs` 在构造 `V3ClientBody::Sse` 后、流消费完成前调用 provider success / route policy commit。
- `record_provider_success_in_session` 会清除该 provider/key/model 的 cooldown 与连续失败状态。

影响：

- Transport accepted、HTTP headers accepted、stream handle built、protocol terminal、client delivery 被混成一个“成功”。
- 同一 attempt 可先恢复健康、后因 SSE 失败再记录失败。
- health、route policy 和 continuation 没有消费同一成功凭证。

### B1 — P1：终态控制读取复制完整诊断快照

证据：

- `V3RuntimeStreamObservation::semantic_terminal()` 调用 `snapshot()`。
- `snapshot()` 在 Mutex 内 clone 整个 `V3RuntimeStreamObservationSnapshot`。
- snapshot 含 `provider_raw_sse: String`，上限 2 MiB，以及 typed object、usage、timing、toolreason。
- Relay 收集循环每 frame 调用 `has_semantic_terminal()`。

影响：控制读取复杂度随累计诊断负载增长。2 MiB 历史被查询 10,000 次，对应约 19.5 GiB 累计字符串复制操作量；该数字是代码操作量估算，不是 RSS/耗时实测。

### B2 — P1：本地资源/观测错误被包装成 provider ResponseBody

证据：

- Relay attempt 收集把 buffer push、terminal observation、mark terminal、codec/stream 错误汇总为字符串。
- 后续多数路径统一构造 `V3ProviderError::ResponseBody` 并进入 provider failure policy。

影响：

- 本地容量超限可能错误惩罚多个 provider。
- observation lock/persistence 失败可能被投影成 provider 502。
- 违反 598/599 内部错误与外部 provider 错误分流。

### B3 — P1：重试控制 closure 深携带请求与完整 manifest

证据：

- Direct 入口为 handoff 保存 `raw.clone()`、`manifest.clone()`、`control.clone()`。
- handoff closure 每轮继续 clone。
- `raw` 含业务 `Value`；manifest 不是窄 route/provider projection handle。

影响：长上下文、图片与 tool schema 使控制切换成本随 payload 放大；与 Relay `Arc<Value>` 方向不一致。

### C1 — P1：provider health 全局写锁内同步持久化

证据：

- health mutation 获取 `state.write()` 后调用 `persist_cooldown_state(&mut state)`。
- persistence `replace_entries()` 每次替换后 `persist()`。
- `persist()` 在调用线程执行 serialize、`fs::write`、`fs::rename`。

影响：磁盘抖动扩大 provider health 全局锁临界区，阻塞 availability、success/failure、probe 状态读写。

### C2 — P1：WebUI request ledger 同步 I/O 与无总量内存/文件边界

证据：

- `V3WebuiObservability::record_observed()` 持有 listener Mutex。
- 锁内调用 JSONL append；每行 open、serialize、write、flush。
- `requests: BTreeMap<String, V3ObsRequestRow>` 没有 TTL/数量上限。
- 启动时读取并 fold 整个文件后加载到 map。
- 单行大小限制不能约束 request 数量、文件大小或启动加载量。
- JSONL runtime I/O owner 当前在 `routecodex-v3-config`。

影响：观测写盘与主请求热路径/锁耦合；运行时间增长导致内存、历史文件和启动时间无可验证边界；Config crate 承担运行期观测存储职责。

## 4. 门禁缺口

### G1：full-attempt gate 只证明 marker 存在

`verify-v3-direct-sse-full-attempt-commit.mjs` 检查名称、注释、测试 symbol 和 map marker。它不证明：

- `push()` 在 copy/append 前检查 byte/frame budget；
- request/global budget 存在；
- commit receipt 只能由 terminal seal 创建；
- handoff 不创建 Runtime、不重入 VR/完整 executor；
- 非 SSE outcome 不丢失。

### G2：module gate 会截掉测试模块后的生产实现

`verify-v3-module-boundaries.mjs` 使用：

```text
text.replace(/#\[cfg\(test\)\][\s\S]*/, '')
```

作为部分 production scan 输入。Rust 文件中第一个 `#[cfg(test)]` 后仍可出现生产 trait/impl；这些内容被整个截掉。正确 gate 必须解析 Rust item 或至少只移除明确 test module span，不能截断余下文件。

修复该盲区后的反向发现：`routecodex-v3-target` 曾在 scheduling projection 明确 `available=false`、但 `blocked_scopes=[]` 时继续选择 unavailable Direct candidate。该分支属于真实 fallback，不是注释误报；唯一 owner 是 Target candidate selection。当前整改已物理删除该选择分支，并用 `direct_provider_model_never_selects_an_unavailable_candidate_without_a_scope_label` 锁定反向合同。

### G3：现存合同自相矛盾

- canonical Direct SSE manifest：完整 attempt 到协议终态后才提交业务字节。
- `v3-sse-transient-no-provider-cooldown-test-design.md`：描述“genuine output/tool frame authorizes incremental client streaming”。

执行前必须以 manifest + current full-attempt resource contract 为真源，修正文档/测试；禁止两种模式并存或用兼容分支维持双语义。

## 5. Map/registry 现状与边界

| 面 | 当前状态 | 对执行的约束 |
| --- | --- | --- |
| `v3.sse.direct.full_attempt_buffer` | `design` | 不能声称已锁定；先激活资源、owner 与 gate |
| `v3.responses_direct_full_attempt_commit` function map | `design` | 允许路径偏 Direct，尚未覆盖共享 Direct/Relay store 与 request controller |
| full-attempt mainline edges | `binding_pending` | 禁止直接把目标图当 runtime 真相 |
| verification map | source-controlled pending live | 静态 marker 绿不等于生命周期闭环 |
| runtime module registry | crate 级 active | 只能证明 crate path owner，不能证明内部执行权唯一 |
| WebUI persistence | Config resource owner | 与目标 runtime observability storage owner 不一致，需先改 map 再迁移 |

## 6. 审计范围与非结论

本轮完成源码、map、registry、gate 与 git 历史核对；未运行完整 Cargo、CI、真实 TCP、install/restart、在线压测。因此：

- 已确认的是源码结构、调用关系、类型/资源状态和门禁覆盖缺口。
- A2 尚需真实 TCP 集成红测完成正反干预，才能作为运行时复现结案。
- 所有性能影响均为代码路径与容量推导，不是 benchmark 数据。
- 本文不授权 runtime 修改、global install、restart、live 配置或 claim takeover。

## 6.1 隔离整改后的动态证据更新

以下证据已在专用 worktree 取得，不回写审计基线事实：

- 真实 `TcpListener + ReqwestResponsesTransport` 证明 provider A 流中失败后，provider B 仍由 resident Runtime 驱动到协议终态；临时 Runtime 与完整 executor 重入 symbol 已物理删除。
- Direct/Relay 已复用 `V3CommittedClientSseBuilder` 与同一 `V3RequestExecutionControl`；双向 handoff 不重置 request attempt budget。
- `V3AttemptSuccessReceipt` 已成为 provider health、route policy 与 continuation success side effect 的共同前置凭证。
- terminal control 已从 diagnostics snapshot 分离；local resource/observation failure 不再进入 provider failure policy。
- health persistence 已退出 health lock；WebUI append 已退出 listener mutex；runtime JSONL append/read owner 已从 Config 迁到 Debug。
- module gate 已改为 test-item span aware，并因此发现、删除 unavailable Direct candidate fallback。
- Provider Action Gate 已对齐 resident executor 与 pre-commit failure recording；旧 handoff-budget executor/SSE wrapper 由 55 个 mutation 中的专门反向样本锁定。

仍未形成最终运行时结论：global install、唯一聚合 restart、在线旧样本 replay 与 AGY review 尚未完成；`v3.codex_sample_retention_snap_scope` 另有不属于本 change set 的既有 audit-lock 漂移。

## 7. 必须解决的三个总目标

1. 生命周期唯一：一个 request controller、一份 immutable target plan、一份 attempt/deadline budget、一个 Error05 recovery 入口；wrapper 不再启动 executor/Runtime。
2. 控制成本独立：terminal、budget、route、cancel、commit 只访问小型 typed control state；诊断与 payload 不参与控制查询。
3. 负载存储有界：Direct/Relay 共用一个 attempt payload store；per-attempt、per-request、global、residency 全部有 admission 与成对测试。
