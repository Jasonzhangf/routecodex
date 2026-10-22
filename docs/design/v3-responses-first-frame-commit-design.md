# v3 Responses 首帧提交设计（issue 849ed8f）

状态：P1（Responses Direct 首帧提交 + append-only 续发 + 提交后静默断开）已实现，P2/P3 未实现。

## 1 问题与证据

客户端（DSH，Responses 端点）把响应速度显示成 148000 tok/s。测量链：

- DSH 的 decode 窗口 = `assistant/message.time - firstTokenTime`（`packages/session/session-stats/src/projection.ts:161`），
  速度 = 输出 token ÷ 窗口（`packages/client/ui-chat/src/client/chat/StatsPills.tsx:334`）。
- v3 runtime 整段缓冲 provider 尝试，客户端在完成瞬间收到全部 SSE 帧
  （`v3/crates/routecodex-v3-server/src/client_sse_transport.rs:66-70,137` 只有一个完整 outcome 的 oneshot；
  `v3/crates/routecodex-v3-runtime/src/execution_control.rs:650` 只有 `seal_after_validated_terminal` 之后才产生客户端流）。
- 实测一份真实会话：前 3 步输出 444 token，计费与缓存命中都是对的（54.8k tok、32%），
  但首帧与末帧到达相差约 3ms，444 ÷ 0.003 ≈ 148000。
- 实时复测 4444：生成期每 3s 一条 `: keepalive`，第 11.03s 一次性发出全部 42 个事件。

结论：token 计数正确，失真只来自「窗口被压平」。只要首个业务帧按真实到达时间发出，窗口就跨真实生成期，
算出来是真实平均值，不会出现瞬态高速。

## 2 目标与非目标

目标：

1. 客户端收到的首个业务帧时间 ≈ provider 首个业务事件时间。
2. 提交后按 append-only 续发，末尾不重放已发帧，内容不重复、不缺失。
3. 首帧之前保持现有可重试、可切换、可冷却的行为不变。
4. 任何上游失败都不向模型客户端返回 provider 状态、错误码或错误载荷。

非目标：

1. 不追求尾帧逐个实时（允许按完整性闸局部攒批）。
2. 不改变请求侧语义、路由、候选选择与健康策略的判定。
3. 不改 DSH 代码；修复只落在 rcc。

## 3 现状提交边界

- 客户端通道：`accept_v3_client_sse_transport` 在 runtime future 未完成时只发 keepalive，
  完成后一次性 splice 整个 body（`client_sse_transport.rs:71,203-296`）。
- runtime：`V3CommittedClientSseBuilder` 收集帧，`seal_after_validated_terminal` 产出
  `V3CommittedClientSseStream`；Direct 在 `v3_direct_core.rs:1223` 返回 `V3ClientBody::CommittedSse`。
- 投影：Relay 侧先把 provider 事件归约成最终 JSON（`provider_stream_materialization.rs:8-37`），再整段出帧；
  没有任何逐事件出帧路径，也没有保留事件到达时间。

## 4 契约变更

新规则：**提交点前移到首个可提交业务帧；提交后 append-only 续发；首帧之前仍完整缓冲。**

需要同步的文本与资源：

| 位置 | 现状 | 改为 |
| --- | --- | --- |
| `AGENTS.md:55` | Runtime 完整缓冲每个尝试，之后才投影任何 provider 载荷字节 | 首个可提交业务帧之前完整缓冲；提交后只允许 append-only 续发，禁止重放已发帧 |
| `docs/architecture/wiki/v3-direct-sse-accept-skeleton.md:48-58` | 任何业务帧不得在协议终态前越过客户端边界 | 首帧越过边界后即为提交点；提交后不得回退、替换或重发已发帧 |
| `docs/architecture/wiki/v3-client-sse-head-commit.md:86-91` | 提交通道不承载任何 provider 业务载荷，直到 outcome 存在 | 通道在首帧提交后承载续发帧；失败只静默断开 |
| `docs/architecture/v3-resource-operation-map.yml:3055-3072` | `v3.sse.direct.full_attempt_buffer` 只允许 builder 写 | 拆为 `v3.sse.attempt.prefix_buffer`（首帧前）与 `v3.sse.client_frame_ledger`（提交后续发），owner 均为 Runtime |
| `docs/design/v3-unified-operation-runner-design.md:202` | full-attempt buffering before client commit | pre-first-frame buffering before client commit |
| `docs/architecture/v3-verification-map.yml` | 绑定全缓冲 gate | 追加首帧提交 gate：到达时间分布、续发不重复、完整性闸 |

## 5 定义

- 可提交业务帧：通过该协议投影与已验证 hook 之后，客户协议上的首个可见 `output_text` 非空增量。
  DSH 以首 token 度量窗口，状态帧 `response.created` 不算。
- P1 实际提交条件只有「可见 output_text」。`reasoning` 增量保真但不授权成功，也不设置可见标记，
  因此 reasoning-only 尝试从不提前提交（见 §13.1）。带名字的 tool-call 起始帧、tool_thinking 与
  toolreason 投影属于 P2/P3 计划，P1 未实现，实际由逐帧投影承担。
- 提交点：首个可提交业务帧写入客户端通道的时刻。此刻起该尝试不可再被替换。
- 续发账本：记录每个 block 已发出的文本长度、已发出的参数长度、已发出的 item 集合。
  末尾投影只发账本未覆盖的部分。

## 6 投影形态

唯一实现是「ledger 驱动的 append-only 投影」；整段缓冲路径降级为「ledger 一次 flush」，
不允许存在两套并行投影实现，避免双路径输出分叉。

完整性闸（需要完整 payload 才能定稿的帧，延后到完整点再发）：

- tool-call 参数帧：等该 block 的参数完整且改写完成后一次发出。
- response 级字段：`usage`、`status`、`incomplete_details`、id 替换，等 terminal 后随末帧发出。

## 6.1 Direct 模式的既有逐帧形态（已核实）

Direct SSE 已经在逐帧消费 provider 流：`collect_direct_sse_attempt_after_terminal_with_hooks`
每帧 `committed.push(frame)`（`direct_runtime_helpers_stream.rs:272-340`），并且已经计算
`has_business_content`（同文件 `:333`）。所以 Direct 的 P1 不是新建投影，而是把已产生的帧
在提交点之后立即外送，并把末尾 seal 改成按账本跳过已送帧。

但 commit 之前必须处置两个整段变换，否则提前外送会泄漏未清洗或未改写的内容：

| 变换 | 位置 | 生效条件 | 处置 |
| --- | --- | --- | --- |
| agent memory 捕获与回写 | `rewrite_direct_sse_memory`，`direct_runtime_helpers_stream.rs:563-587` | `manifest.memory_raw_capture.enabled` | 不提前提交 |
| 完整尝试响应 hook（DSML 转 tool call） | `apply_complete_response_hook` → `project_complete_direct_sse`，`:446-470` | 请求命中 direct response hook | 不提前提交 |

两者都可在首帧之前按 manifest/请求判定，因此属于请求级能力开关，不是流中不确定事件。

## 7 Hook 前缀安全分类

| hook / 变换 | 位置 | 依赖 | 处置 |
| --- | --- | --- | --- |
| Relay SSE 业务改写（provider 型号擦除等） | `relay_sse_hooks.rs` 逐语义对象 | 单事件 | 可流式 |
| 文本/推理增量投影 | `responses_sse_tree.rs` / `anthropic_sse_tree.rs` | 部分前缀 | 可流式 |
| custom tool 参数改写 | `shared_custom_tool_function_sse.rs:48` | 完整参数 JSON | 完整性闸 |
| `strip_client_response_id` | `kernel.rs:1167` | 最终响应字段 | 完整性闸（末帧） |
| `tool_thinking` / `toolreason_client_projection` | `hooks.rs:338,674-701` | 最终响应载荷 | P1 未进入提交谓词；由逐帧投影承担 |
| 工具/历史配对绑定 | `find_responses_tool_output_ids` | 整段响应 | 只影响控制侧账本，不影响已发帧 |
| servertool followup | `servertool_hooks.rs` | 整段响应，且内容需丢弃 | 不提前提交 |
| web_search 结果注入 | `web_search_sidecar.rs`, `web_search_hop.rs` | 整段响应 | 不提前提交 |

P1 的提交谓词只依赖帧级内容证明（`V3DirectPrefixCommitProbe`），上表其余行的调用点复核与红测绑定
是 P2/P3 的输入，不阻塞 P1。已落地的红测见 §13.2 与提交探针的单元测试。

## 8 不提前提交的尝试

servertool 与 web_search 的内部尝试在请求级已可判定，保持全缓冲：不提交任何业务帧。
这类尝试的内容本来就不进客户端，客户端最终拿到的是重入后那次的响应，窗口仍然真实。

## 9 失败语义

- 首帧前失败：维持现状，typed error 进链，按候选策略重试或切换，按 P0 记录健康与冷却。
- 首帧后失败：不切换 candidate、不重试、不冷却其它 key；被尝试的 `provider.model.key` 仍按 post-commit
  provider stream failure 记录健康（与 Relay 提交后路径一致）。静默结束该请求的客户端传输（沿用已声明的
  `client_transport_break` 语义），由客户端重发请求。
- 两种情况下客户端都收不到 provider 状态、错误码或错误载荷。

## 10 红测与黑盒验收

红测（先失败）：

1. mock provider 分段延时发射：断言客户端帧到达时间随 provider 到达时间分布（spread 阈值），当前实现必然失败。
2. 续发不重复：断言客户端文本流与整段缓冲路径逐字节等价。
3. 完整性闸：参数被改写时，客户端看到的参数只在完整点出现一次。
4. 首帧前后失败分支：首帧后失败不产生第二候选，客户端只看到截断流且无错误载荷。

黑盒验收（真实入口）：

- 同一入口重放一次真实 Responses 请求，断言：首帧时间 ≈ provider 首包时间；同会话 tok/s 落在真实区间；
  内容、工具调用与配对历史与整段缓冲路径一致；servertool/web_search 尝试不泄漏内容。

## 11 分阶段

- P1：responses Direct 的文本/推理首帧提交 + ledger 续发。
- P2：anthropic → responses Relay 的逐事件投影。
- P3：工具参数完整性闸 + custom tool 改写。
- P4：契约文本、资源所有权、map/gate 收口。

## 12 风险与回滚

- 首帧后失败率上升：失败请求需要客户端重发。用观测记录提交点与失败点分布，异常时按开关回退到全缓冲。
- 双路径分叉：只保留 ledger 驱动一条实现。
- 回滚：本阶段只保留一条代码路径，没有运行时开关；需要回到全缓冲时用新的 revert 提交恢复，
  再重新 install 与 `rccv3 restart`。不为此增加未使用的配置开关。

## 13 实现状态（P1）

### 13.1 提交判定

请求级谓词（`kernel.rs`）只负责排除已知会整段改写的请求，满足全部条件才把 sink 交给 collector：

1. `!manifest.memory_raw_capture.enabled`（无 memory envelope 整段回写）；
2. `direct_dsml_context.has_no_declared_tools()`（DSML 声明为空）；
3. `!compat_plan.has_block(ThinkingTags)`（thinking-tags 流式改写与末帧合成已由该 profile 承担）。

该谓词不能证明 complete-attempt hook 是恒等：thinking 改写按内容无条件运行，DSML 也会在无声明时删除
analysis/label 行。因此真实提交点由帧级内容证明（`V3DirectPrefixCommitProbe`）决定，谓词只保证被排除的
请求不会进入该路径。

### 13.2 提交与续发

- 内容证明：缓冲前缀必须同时满足「已出现可见业务文本」且「没有任何 Direct 文本治理 owner 会改写的标记」
  且「最新文本不以标记前缀结尾」。标记集合由 owner 自己给出（thinking `<thinking>`/`</thinking>`，
  DSML 无声明即可删除的 standalone label），不在探针里重复硬编码。
- 标记集合带匹配范围，与 owner 的匹配方式一致：thinking 标记按整段文本内联匹配，DSML label 只按整行匹配，
  因此普通行内 ` calls>` 不会误判，而末行等于某个标记的合法前缀（标记首字符到倒数第二字符之间）时仍然挂起。
- 独占一行的 `>` 残渣无论其换行是否已经到达都算未决：owner 按整行扫描，`>\n<close>` 与 `><close>` 是同一种残渣，
  因此探针同时检查最后一行和去掉一个尾随换行后的最后一行。
- delta 是唯一增量载体，探针保留滚动文本尾部再判定，因此跨两个 provider 帧拆开的标记（例如 `<thin` 与
  `king>secret`）同样被看见并阻止提交；`response.completed`/`response.incomplete` 的终态快照也参与扫描，
  因为 complete-attempt owner 读取的正是这段文本。
- 可见文本单调为真，因此提交后 `provider_response_empty`（空/空白/不可见 final）判定不可能被跳过；
  reasoning-only 与纯空白 delta 不提交。
- `V3CommittedClientSseBuilder` 记录 `flushed_frames`；`commit_client_stream(sink)` 置提交标记并立刻冲出已有帧。
- 提交后 `push` 逐帧冲出；`seal_after_validated_terminal` 只重放 `flushed_frames` 之后的尾部，客户端字节流与
  全缓冲路径逐字节相同。
- 提交后 complete-attempt hook 仍然运行：`rewrite_complete_attempt_preserving_client_prefix` 要求所有已发帧
  字节不变，否则按无效尝试状态拒绝，不回写已发前缀。
- 提交后探针只作为挂起信号：一旦观察到治理标记或最新文本以标记前缀结尾，`hold_client_flush()` 暂停投影，
  后续帧继续留在 attempt 内；到 terminal 时由 registered owner 决定整段。owner 返回恒等（标记位于其保护范围，
  例如代码块、行内代码、引号文本）时 `release_client_flush()` 原样续发；owner 改写且已发帧不变时采用改写后的
  尾部。已发前缀永不被改写。
- 探针不知道 owner 的保护范围，因此不得单独用探针结束已提交通道：那会把包含标记字样的合法业务文本截断。

### 13.3 服务端接线

- `lib.rs` 在 SSE 请求上建立 sink/receiver 对，sink 沿 `pending_endpoint_after_responses_admission` →
  `execute_responses_direct_server_outcome` → `V3ResponsesDirectRuntimeSharedState::with_client_frame_sink` 进入 kernel。
- `client_sse_transport.rs` 在有已提交帧时先发这些帧，再 splice 运行时 outcome；outcome 快路径若已有前缀帧，先发前缀再发剩余 body，保证不丢帧。
- 一旦发过业务帧，通道不再发 keepalive，也不再投影任何错误帧。

### 13.4 提交后失败语义

- kernel 在 collector 返回错误时先查 `sink.is_committed()`；已提交则直接走
  `post_commit_client_transport_break_output`：typed 错误进 Error 链、`terminal_disposition = NoResponse`，
  不跑候选策略、不切换、不重试。
- 已提交的 provider 失败仍是 provider-health 事件：kernel 按被尝试的 `provider.model.key` 记录 post-commit
  provider stream failure 并冷却该身份（与 Relay 提交后路径一致），该记录不改变本请求的候选顺序。
- 提交后治理标记导致的 `direct_sse_post_commit_governance_break` 只在一种情况下出现：owner 无法在不改写
  已发帧的前提下投影尾部。它走同一条提交后失败语义。
- 服务端把该 terminal 投影成 200 SSE 传输中断：通道层因已有已发帧而不发错误帧、不发 keepalive，也不写正常
  分块结束符（`0\r\n\r\n`）；客户端因缺少 terminal 检测到截断并自行重试，看不到 provider 状态、错误码或
  错误载荷。

### 13.5 已知残差

- 提交后若 provider 才吐出会被 owner 改写的字面治理标记（`<thinking>`、无声明即可删除的 DSML label），
  collector 挂起尾部并交给 owner 在 terminal 决定：owner 能保留已发帧时采用改写后的尾部，不能时才有界截断
  （typed 运行时错误结束通道，不泄露标记原文）。未提交前缀内出现标记时仍走全缓冲治理，两条路径字节一致。
- 探针不知道 owner 的保护范围（代码块、行内代码、引号文本）。保护范围内的标记字样只让探针挂起尾部，
  不会单独结束通道；owner 返回恒等时原样续发，合法响应不被截断。
- P2（Relay 逐事件投影）与 P3（工具参数完整性闸）未实现：Relay 路径仍全缓冲，客户端窗口不变。
