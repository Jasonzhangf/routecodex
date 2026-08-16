# V3 SSE 响应增量归一化状态机审计

## 审计范围

本审计只分析 Relay 响应链：provider SSE 进入协议事件 codec，经过 Hub 响应治理，
再按客户端入口协议投影为 JSON 或 SSE。Direct 同协议直通不应被本方案强制物化；
SSE transport 仍只负责 framing、backpressure 与 closeout，不拥有协议或治理语义。

## 当前实现结论

当前 V3 并不是一条统一的 Relay SSE 主链。Responses 入口仍是“先读完整 provider
stream，再处理并重新生成客户端 SSE”，OpenAI Chat / Gemini 入口则已经存在逐事件
JSON 转换路径：

1. provider stream 被 `build_v3_hub_resp_inbound_02_from_*_provider_stream_events`
   消费到 EOF，并聚合成一个 terminal `Value`；缺 terminal event 会失败。
2. 聚合后的 JSON 才进入 `run_json_response_hooks`，随后完成 Resp03 治理、Resp04
   continuation commit。
3. 客户端要求 SSE 时，再由 finalized JSON 构建一条新的 SSE stream。

Responses 入口的链保证了“治理完成后才进入客户端历史”，但它不是实时 SSE 转换，
而是 **全量物化 + 终态重放**。另一方面，OpenAI Chat 的 same-protocol SSE 已逐事件
调用 JSON response pipeline；历史 cross-protocol transducer 却曾把转换结果直接编码
回 SSE，没有再次进入 Resp01→Resp06。真正缺少的是所有 Relay 协议共同遵守的镜像
合同：`provider SSE -> provider event JSON -> inbound canonical -> Chat Process -> outbound
entry event JSON -> client SSE`。

## 主要设计缺陷

### P0：传输意图与归一化形态混在同一个状态字段

`V3HubRespInbound02Normalized.normalized_kind` 会继续标记 `Sse`，但该节点实际持有的
payload 已经是完整 JSON。后续代码很容易把“来源是 SSE”误当成“当前仍是可流式
事件”，形成类型层面的假流式。状态机应分别表达：

- provider transport kind；
- 当前 semantic carrier kind（event / snapshot）；
- client transport intent。

三者不能复用一个枚举或靠嵌套 `previous` 反查。

### P0：首帧延迟等于完整 provider 响应时长

运行时在返回 `V3ResponsesRelayRuntimeOutput` 前等待 provider SSE 完整结束，然后才
调用 client SSE projector。真实 backpressure 只存在于“重放 finalized JSON”的
下半段；provider→Hub 上半段已经全部被 drain。长输出会失去首 token 延迟优势，
也无法把 client disconnect 及时反压到 provider stream。

### P0：流式错误策略没有显式 commit point

当前因为任何客户端帧都尚未发出，codec/semantic failure 可以安全进入 provider
reselect。改成真正 streaming 后，一旦客户端已观察到业务 delta，就不能再切 provider
并拼接第二条响应。现有 Error01→06 链缺少响应流 `Uncommitted / Committed` 的 typed
事实；如果直接把 projector 改成边读边发，会产生跨 provider 混流或在已发送 200
headers 后尝试投影 JSON error 的风险。

### P1：event codec 同时承担 reducer 和 terminal snapshot builder

当前 provider event codec 一边校验事件顺序，一边累积 text/tool/reasoning/usage，最终
产出协议整体 JSON。这让“事件是否合法”“事件对应哪个 canonical delta”“最终快照是
什么”三个职责耦合，难以复用同一语义真源同时支持 SSE client 和 JSON client。

### P1：Resp03 只有 whole-response hook 合同

`run_json_response_hooks` 接收完整 provider JSON。stopless、servertool、tool repair 和
terminality 只有终态入口，因此无法判断某个 canonical delta 是否可以立即向客户端
commit。简单地把普通文本提前透传，会绕开 Resp03；简单地全部缓存，则维持现状。

### P1：客户端 SSE 是由 snapshot 再合成，不能保持事件级语义

最终 JSON→SSE 的 projector 可以生成协议合法事件，但无法保证 provider 原事件的
时序、细粒度 usage/reasoning/tool delta、事件 id/sequence 或首帧时刻。对于不同入口
协议，它还会迫使 Resp05 从聚合结果重新推导 event lifecycle，而不是静态投影已经治理
过的 canonical events。

### P2：架构合同存在互相矛盾的历史表述

部分 map/gate 仍写“without materializing an SSE stream”，而当前 Runtime 明确把 SSE
消费为 terminal JSON；另一些验证条目又声称首 client frame 在 provider terminal 前
可见。改造前应先用受控慢流测试确定当前事实，并把 map、verification 和测试名称统一，
避免以 synthetic prebuilt stream 测试替代真实 Runtime 时序证据。

## 推荐目标状态机

不要采用“raw SSE 直接穿过 Chat Process”，也不要在 Server/SSE handler 增加业务
逻辑。建议在 Rust Runtime 的相邻 codec 与 Resp03 owner 中引入 **canonical semantic
event + terminal snapshot 双视图**：

```text
Provider raw bytes
  -> SSE transport decoder (opaque frames)
  -> provider protocol event codec
  -> CanonicalRespEvent
  -> Resp03 incremental governor
  -> GovernedRespEvent --commit gate--> Resp05 entry-protocol event projector
  -> SSE transport encoder -> client

                    CanonicalRespEvent
                           |
                           v
                  CanonicalRespReducer
                           |
                           v
             terminal CanonicalRespSnapshot
                           |
                 Resp03 terminal finalize
                           |
                 Resp04 continuation commit
```

同一批 `CanonicalRespEvent` 是唯一事件语义真源；reducer 只构造 terminal snapshot，
不能成为第二套协议解析器。JSON 客户端只消费 terminal snapshot；SSE 客户端消费经过
Resp03 的 governed events，并在 terminal finalize/Resp04 成功后收到 terminal event。

### 建议 typed 状态

1. `RespStreamUncommitted`：尚未向客户端发送业务帧，可以因 provider/codec 错误走
   Error05 reselect。
2. `RespStreamCommitted`：至少一个 governed 业务帧已被客户端出口接受；provider
   reselection 被禁止，后续错误只能沿带相同 request scope 的 Error05 决策投影为入口
   协议允许的 SSE error/closeout。
3. `RespStreamTerminalPending`：provider terminal 已到达，但 Resp03 terminal governance
   和 Resp04 commit 尚未完成；不得先发 client terminal。
4. `RespStreamTerminalCommitted`：Resp03、Resp04 成功，Resp05 投影唯一 terminal event。
5. `RespStreamAborted`：client disconnect 或 typed error closeout；释放 provider stream、
   observation、continuation transaction，禁止保存半响应。

状态只能由 Runtime typed carrier 持有，不能写进 response payload、协议 `metadata`、
SSE 注释或 debug snapshot。

### 事件放行策略

不是所有 delta 都可以立即 commit。Resp03 应提供显式 verdict：

- `Emit(event)`：当前事件已完成治理且未来状态不会撤销它；
- `Hold(key, event)`：tool/reasoning/internal action 等需等待完整 item 或 terminal 判断；
- `Replace(events)`：只允许登记的当前轮治理投影，例如 internal stopless action 被替换
  为客户端合法事件；
- `DropRegisteredInternal(provenance)`：只允许 Resp03 按同轮 provenance 剥离已登记内部
  action，不能成为通用 silent strip；
- `Fail(error01)`：进入统一 Error 链。

在证明“未来 terminal governance 不会改写已发内容”之前，默认 `Hold`，不得以低延迟
为理由扩大 speculative emit。尤其是 tool arguments、tool identity、reasoning/tool 边界、
stopless/servertool action 与 terminal status 必须在 owning hook 给出稳定性证明后才放行。

## 分阶段改造方向

### Phase 0：先修合同与可观测测试，不改 runtime 行为

- 增加受控 upstream 慢流：首 delta 与 terminal 之间设置可观测 barrier。
- 同时记录 provider first-frame、Runtime first-governed-event、client first-frame、terminal、
  Resp04 commit 时间，证明当前确实是 terminal 后才发首 client frame。
- 清理 function/verification/map 中“未物化”和“首帧早于 terminal”的矛盾声明。
- 增加负测：删除 incremental Resp03 gate、从 raw frame 直达 Resp05、Server 重解析
  semantic data、committed 后 provider reselect，均必须失败。

### Phase 1：拆 event codec 与 reducer，外部行为保持全量缓存

- provider codec 输出 typed `CanonicalRespEvent`，不直接输出最终 Responses JSON。
- 独立 reducer 从 canonical events 构造 `CanonicalRespSnapshot`。
- 先保持所有事件 `Hold`，让 JSON/SSE 外部结果与当前实现完全一致。
- 对 JSON、SSE、任意 chunk boundary、malformed/unknown/duplicate terminal、tool delta index
  复用同一 reducer 测试。

### Phase 2：引入 incremental Resp03 与 stream commit gate

- 在 Resp03 增加事件级 hook，但 terminal snapshot hook 仍是最终裁决真源。
- 只开放经证明不可撤销的文本/reasoning delta；内部 tool/action 保持缓冲。
- client disconnect 从 Server typed signal 反向取消 Runtime/provider read，不把取消状态写入
  payload；保持 health-neutral。
- 明确 committed 后 Error05 的唯一决策，禁止 retry/reselect 与 JSON fallback。

### Phase 3：入口协议 event projector

- Resp05 按 entry protocol 将 `GovernedRespEvent` 静态映射为 client protocol event；无精确
  或已登记 compatible mapping 时 fail-fast。
- Server06 和 SSE crate 只接收已编码 frame，负责 backpressure、keepalive、closeout。
- JSON client 继续等待 terminal snapshot；SSE client 才走 incremental event path。

### Phase 4：continuation 与治理闭环

- terminal event 必须等待 Resp03 terminal finalize 和 Resp04 transaction commit 成功。
- continuation 只保存 finalized canonical snapshot/context，不保存 raw frames、部分 reducer
  或 client-projected events。
- stopless/servertool 的 `Hold/Replace/DropRegisteredInternal` 必须具备同 request/scope
  provenance，Resp05/SSE/Server 不做补偿。

## 不建议的方案

- **边转发 raw provider SSE，末尾再补治理结果**：绕过 Resp02/Resp03，且已发内容不可撤销。
- **tee 一份给客户端、一份异步物化**：客户端分支领先治理分支，continuation/错误状态
  与客户端历史可能不一致。
- **在 SSE crate 或 Server handler 识别 tool/terminal/error**：把业务 owner 下沉到 transport。
- **每个入口协议维护一套聚合器**：会产生多套 semantic reducer，协议间继续漂移。
- **committed 后静默换 provider**：会把两个 provider 的事件拼成一个响应。
- **把 reducer/commit 状态写入 metadata 或 payload**：违反控制面与数据面物理隔离。

## 验收标准

1. SSE client 首个可安全放行的 governed event 在 provider terminal 前可见；JSON client
   仍只收到一个 terminal JSON。
2. 每个 client SSE event 都能追溯到 `provider event -> canonical event -> Resp03 verdict
   -> entry projector`，不存在 raw/Resp01 到 Resp05/Server 的 shortcut。
3. terminal client event 只在 Resp04 commit 成功后发送；commit 失败不产生伪 terminal。
4. client disconnect 能停止 provider read 且 health-neutral；不保存 continuation。
5. uncommitted provider failure 可按 Error05 reselect；committed failure 绝不 reselect、
   不投影 JSON fallback。
6. raw SSE 仅作为 debug transport evidence；materialized snapshot 才是 continuation/audit
   semantic truth，两者都不携带 RouteCodex 控制状态。
7. Direct 同协议流式路径不被 Relay reducer 强制物化，Relay 各协议只通过登记的相邻
   codec/projector 转换。

## 建议优先级

明确边界：本改造只适用于 Relay。Same-protocol Direct 继续 passthrough，并只执行其
已登记 hook；禁止为了统一外观把 Direct 强制接入 Hub response conversion。

最先做 Phase 0，而不是直接优化 streaming。当前最大的风险不是少一个流式 wrapper，
而是缺少“事件治理稳定性”和“客户端已提交后错误策略”两个合同。先锁这两个合同，
再拆 codec/reducer，最后逐类开放安全事件；这样可以在不牺牲“不让未治理响应进入历史”
原则的前提下恢复真实 SSE 延迟与反压。

## DSH Review Round 1 FAIL 修复闭环（2026-08-15/16，commit c7192b3a9 后修复轮）

DSH review（taskId=v3-sse-usage-delivery-20260815）对 commit c7192b3a9 给出
`VERDICT: FAIL`，三条 P1 + 三条 P2。修复内容：

1. P1 `response.incomplete` 在 Responses→Chat SSE relay 缺 `[DONE]` 收口：
   `openai_chat_relay_runtime.rs::project_responses_sse_as_openai_chat_stream` 把
   `response.incomplete` 与 `response.completed` 一并视为合法终态，补发 `[DONE]`
   并置 done_seen；截断响应（max_output_tokens/content_filter）不再以
   IncompleteRead/Connection reset 形式中断客户端连接。
2. P1 Responses SSE outbound 把 `status=incomplete` 误投影为 `response.failed` 并
   丢部分输出：`build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05`
   只把 `status=failed` 判为失败；incomplete 按协议投影 response.created +
   output_item.done + response.incomplete + response.done + [DONE]，保留部分输出
   与 `incomplete_details.reason`。
3. P1 流中段 ClientDisconnect 经 relay 流转换器误写 provider 级冷却：
   `project_responses_sse_as_openai_chat_stream` 与
   `project_anthropic_sse_as_openai_chat_stream` 对 `V3ProviderError::ClientDisconnect`
   直接返回流错误且不调用 record_failure（health-neutral），与
   project_sse_stream / gemini / direct 路径一致。
4. P2 死代码：物理删除 `V3RuntimeStreamObservation::record_response_status`
   （responses_relay_types.rs）与
   `V3ProviderFailureRuntimeHealth::global_subscription_store()`
   （provider_failure_runtime_policy.rs）。
5. P2 reason-less `response.incomplete` 语义不一致：relay event codec 与
   openai_chat_codec / provider_sse_json_codec 同口径 fail-fast（缺
   incomplete_details.reason 或未知 reason 显式报错，禁止静默 200）。
6. P2 测试缺口：新增 relay 级红/绿锁——Responses→Chat SSE incomplete 终态带
   [DONE]、Responses SSE outbound incomplete 保留部分输出且不投影 failed、
   流中段 ClientDisconnect 不写 provider cooldown、畸形 incomplete 终帧 fail-fast。

验证：`cargo test --workspace` 全绿（含四个新测试）；`npm run build` +
`npm run install:v3` 安装 0.90.4558+；聚合 restart 一次；4444/5555/5520/10000
health=ok 且 build_version 与安装产物一致；真实 SSE replay（5555/5520/10000
responses + 10000 chat + 10000 messages）全部 200 且 usage 有值；DSH round 2
review 结论见 `~/.dsh/reviews/`。
