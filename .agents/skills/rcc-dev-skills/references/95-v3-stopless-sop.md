# 95 V3 Stopless SOP

## 权威标准

本文件是 RouteCodex V3 stopless 的权威标准。任何涉及 stopless / reasoningStop / natural stop / stopless continuation / provider-visible tools / client-visible no-op CLI / StoplessCenter 的设计、实现、调试、验证、汇报，必须先读本文件并按本文件闭环。

如果实现、测试、routing 文档、lesson、聊天结论与本文件冲突，以本文件为准；确需改变标准时，必须同一变更集同步更新本文件、`docs/agent-routing/30-servertool-lifecycle-routing.md`、相关 gate/fixture 与 MEMORY/lesson。

## 触发

- V3 `/v1/responses` stopless、`reasoningStop`、`finish_reason=stop`、client `exec_command`、续轮丢 history/tools、provider wire 工具缺失、stopless 循环、过早 stop、或 stopless 状态机/MetadataCenter 生命周期问题。
- 任何声称修复 stopless 的代码、测试、文档、gate、旧样本 replay、live replay。

## 设计目标

stopless 只解决一个问题：模型在目标未完成、也未真实阻塞前，用 `finish_reason=stop` 提前停下；但它仍能继续推理和调用工具。stopless 必须让模型继续推进，直到它能给出真实完成证据、真实阻塞证据，或触发明确的安全 guard。

所有实现都服务于这个目标：

1. 不让提前 stop 变成客户端终态。
2. 不隐藏模型 stop 时已经输出的文本/summary/reasoning。
3. 不让 stopless 自建一条生命周期；它只能嵌入 V3 固定节点 + hook。
4. 不把 stopless 控制状态塞进 CLI、provider payload、client payload、continuation store、SSE、handler、debug/snapshot。

## 两条历史路径与当前选择

### 已废弃：server-side short-circuit / reenter

服务器直接把 response 和新 request 串起来，客户端无感继续。这条路径的问题是：模型本轮 stop 时输出的可见文本无法稳定展示给用户。因此 V3 stopless 不得恢复 server-side followup/reenter。

### 当前：client-visible CLI no-op display bridge

服务器在 Resp03 拦截提前 stop，并把本轮可见文本保留下来，再追加一个客户端可执行的公共工具调用：

```bash
routecodex hook run reasoningStop
```

客户端执行这个 no-op CLI，只是为了闭合客户端工具轮并让客户端显示上一轮模型文本。下一轮请求回来后，Req04 在 continuation restore 之后消费这对 no-op call/output，并根据 MetadataCenter 的 stopless 状态机生成下一轮 provider-facing 继续指导。

续轮提示不是长期历史，也不是新的用户目标；它是当前 provider turn 的运行时 guideline。因为它不会作为长期任务历史保留，允许比旧 `继续。` 更完整，但必须对模型保持 no-op/CLI/client bridge 透明：只写任务导向的继续推理方式、工具使用、完成/阻塞证据要求，避免模型猜测内部机制。

## 表面与真源

| 表面 | 角色 | 是否是真源 |
| --- | --- | --- |
| provider/model-visible `reasoningStop` tool | 让模型报告完成、阻塞、需要继续等 stop 事件；其输出只作为 Resp03 输入事件被评估 | 不是长期状态真源 |
| client-visible `exec_command` | 对客户端投影公共 CLI 命令，让用户看到本轮 stop 文本 | 不是状态真源 |
| `routecodex hook run reasoningStop` | no-input no-op，只完成客户端工具轮 | 不是状态真源 |
| `MetadataCenter.runtime_control.stopless` / V3 等价 control resource | StoplessCenter 状态机唯一控制真源 | 是 |
| `/v1/responses` continuation store | 保存/恢复 canonical response/request context | 不是 stopless 状态真源 |
| SSE / handler / outbound / inbound | 传输、投影、协议等价归一化 | 不是 stopless 语义 owner |

## CLI no-op 合同

`reasoningStop` CLI 是 no-input no-op。

必须投影：

```bash
routecodex hook run reasoningStop
```

禁止投影：

```bash
routecodex hook run reasoningStop --input-json '{}'
routecodex hook run reasoningStop --input-json '{"repeatCount":1}'
routecodex hook run reasoningStop --input-json '{"sessionId":"..."}'
```

约束：

- CLI 不接收参数；没有 `input-json` envelope。
- CLI 不携带 session、conversation、request、response、port、routing group、repeat count、blocked、need_continue、schema feedback、next step。
- CLI stdout/stderr 不参与 stopless 状态恢复，不允许被解析成下一轮 prompt 或状态。
- 若当前已安装 CLI 要求 `--input-json <json>`，这是 CLI no-input-hook contract bug，不能把 fake empty JSON 保留下来当 stopless 设计。
- `exec_command.arguments` 只能包含公共命令本身，例如 `{"cmd":"routecodex hook run reasoningStop"}`；不得把 stopless control 写入 arguments。

## MetadataCenter StoplessCenter 状态机

StoplessCenter 是 Metadata Center 中的控制状态机，不是计数器。状态 key 至少绑定：

```text
entryEndpoint + sessionId + conversationId? + port/serverId + routingGroup
```

其中 `sessionId` 是隔离不同请求 session 的硬边界；缺失或空白时不得拦截 stop、不得写状态，必须自然放行并记录诊断。

### 最小状态字段

```text
phase:
  Idle
  ProviderTurnInFlight
  RespStopObserved
  CliNoopProjected
  CliNoopObserved
  ContinuationGuidancePrepared
  TerminalCompleted
  TerminalBlocked
  GuardTerminal

consecutive_stop_count
max_stop_budget
last_stop_kind:
  natural_stop
  no_schema
  invalid_schema
  reasoning_continue
  reasoning_needs_evidence
  reasoning_finished
  reasoning_blocked
  non_stop_progress

need_continue: bool
blocked: bool
terminal: bool
guard_exhausted: bool
next_request_policy:
  continue_default
  continue_with_stronger_instruction
  ask_for_completion_evidence
  ask_for_blocked_evidence
  stop_for_user_block
  stop_for_guard

last_request_id
last_response_id
last_transition_reason
updated_at
```

说明：

- `consecutive_stop_count` 只是状态机字段之一，不能代替状态机。
- `need_continue` / `blocked` / `terminal` 必须显式闭环；不能只靠 prompt 字符串推断。
- provider/model 响应中的 text/schema/tool arguments 属于本轮 response data；Resp03 评估后只把控制结论写入 MetadataCenter。不要把整段文本、payload、tool history 镜像进 MetadataCenter。
- Req04 只能从 MetadataCenter 读取控制状态，并用当前已恢复的 continuation/data 面构造下一轮 provider 请求。

### 标准状态迁移

```text
Idle
  -- Req04 managed relay inject guidance/tool -->
ProviderTurnInFlight

ProviderTurnInFlight
  -- Resp03 non-stop progress / normal tool call -->
Idle(reset)

ProviderTurnInFlight
  -- Resp03 valid finished with evidence -->
TerminalCompleted(clear)

ProviderTurnInFlight
  -- Resp03 valid blocked with evidence -->
TerminalBlocked(clear or wait-user state)

ProviderTurnInFlight
  -- Resp03 natural/no_schema/invalid/need_continue and budget remains -->
RespStopObserved -> CliNoopProjected(store state)

CliNoopProjected
  -- next request after continuation restore sees current no-op output -->
CliNoopObserved

CliNoopObserved
  -- Req04 rewrites provider-visible next turn according to next_request_policy -->
ContinuationGuidancePrepared -> ProviderTurnInFlight

RespStopObserved
  -- budget exhausted -->
GuardTerminal(stop intercepting the current provider stop; clear after normal pass-through without client-visible diagnostic)
```

Reset 边界：

- 真实 non-stop progress。
- 普通工具调用/工具进展。
- valid finished/blocked terminal。
- 最新真实 user turn 在 stopless pair 之后出现。
- session/scope 改变。
- profile disabled / direct/provider-direct。

## `/v1/responses` continuation 不可变区顺序

必须固定为：

```text
Resp03 Chat Process:
  stopless 拦截 / schema or tool event 评估 / MetadataCenter transition / CLI no-op 投影或透明放行

Resp04 continuation save:
  保存已经 finalized 的 canonical response context

immutable interval:
  resp_outbound / SSE / server handler / adapter / store transport
  只能传输、投影、scope 校验和释放；不得做 stopless/servertool 语义

Req04 Chat Process:
  continuation/local context restore 已完成
  stopless request hook 读取 MetadataCenter 状态 + 当前 no-op output evidence
  删除 no-op shell pair
  生成普通 provider-facing user continuation/guideline
  重新注入 stopless system guidance + exactly-one internal reasoningStop tool
```

若 save 发生在 stopless 投影前，下一轮 restore 会丢掉投影后的工具轮。若 request hook 发生在 restore 前，本轮 no-op output 和历史上下文会被后续 restore 覆盖。两者都是架构违规。

## 轮次合同

### Round 1 request：provider-facing

- Managed relay 必须注入 stopless guidance。
- 原 client tool surface 必须保留：顶层 `tools` 仍顶层，Responses `input[].type=additional_tools.tools` 仍嵌入原路径。
- 只允许追加 exactly-one 内部/model-visible `reasoningStop` tool。
- Direct / provider-direct 必须零注入、零 stopless hook。

### Round 1 response：client-visible

- Resp03 内拦截提前 stop 或 provider/model-visible `reasoningStop` event。
- 先保留模型本轮可见文本，再投影 client-visible `exec_command` no-op。
- CLI 命令必须是 no-input：`routecodex hook run reasoningStop`。
- 投影结果不得泄漏 raw internal `reasoningStop`、StoplessCenter state、repeat counter、schema feedback、metadata/debug 字段。
- 投影完成后才允许进入 continuation save。

### Round 2 request：state-machine guideline

- 先完成 `/v1/responses` continuation/local context restore。
- 当前 `exec_command` call/output 只是 no-op 完成证据。
- Req04 只能删除 RouteCodex 自己注入的 stopless shell pair 和旧 stopless artifacts；所有非注入的真实 user/assistant/tool history 和原工具声明必须原样保留。
- 普通工具失败也是客户端对模型的真实反馈。即使 output 是 `failed to parse function arguments`、`unsupported call:`、未知工具、参数校验失败或执行失败，也必须与对应 call 成对进入 provider history，让模型知道错误并自我修正；禁止按错误文本删除 call、output 或 pair。
- Req04 必须同时删除之前由 stopless 生成的 continuation/guideline user message；该 guideline 只是当前轮 provider-facing 临时提示，不属于会话历史，下一轮只能重新生成一条。
- Req04 根据 StoplessCenter 状态机输出普通 provider-facing continuation/guideline：
  - 所有 no-op 续轮都必须是完整 guideline，不再使用单独的 `继续。` 作为全部提示。
  - 基础 guideline 必须对模型透明：不得提 no-op、CLI、`routecodex hook run reasoningStop`、客户端工具轮、`finish_reason=stop` 或桥接机制；只说明基于已恢复完整上下文继续推理，先复核目标、已有结论、未完成事项和停下位置，缺事实或需要执行时继续调用可用工具，只有完成/阻塞且有证据时才调用 `reasoningStop`，既未完成也未阻塞时继续工作。
  - 连续提前 stop 增加：只增强任务推进要求，不显式暴露第几次、预算或续轮上限等内部状态。
  - `need_continue=true` / evidence 不足：明确不要把它当 terminal；若现在判断完成或阻塞，必须给具体证据，否则继续推进。
  - `blocked=true` 且证据足够：应转 terminal/wait-user，不再继续 loop。
  - guard 达到：不再拦截当前 `finish_reason=stop` 响应，不追加 no-op，不合成终止/诊断文本。
- Provider request 不得含 `call_stopless_reasoning`、`routecodex hook run reasoningStop`、CLI stdout、`--input-json`、`repeatCount`、`schemaFeedback`、`triggerHint`、`missingFields`、`runtime_control`、`metadata_center`。
- Provider request 中由 stopless 生成的 continuation/guideline 最多只能有一条；重复 dry-run 或多轮真实续杯都不得让旧 generated guideline 累积。
- Req04 重新注入 guidance + exactly-one `reasoningStop` 后，才能进入 VR/provider wire。

### Provider prompt preservation audit

- stopless 续轮的 provider request 必须保留原始 Codex/system/developer/user/tool 语义；stopless 只能增加当前轮 delta：完整 action-first guidance + exactly-one `reasoningStop` tool。
- stopless managed turn 必须把 auto/missing/none tool choice 提升为 provider-visible required/any 工具决策；否则模型可以合法忽略 `reasoningStop` schema 并连续自然 stop。OpenAI/Responses provider wire 应看到 `tool_choice:"required"`，Anthropic provider wire 应由协议 codec 投影为 `{"type":"any"}`。
- 不要只看单个 `instructions` 字段判断“系统提示词被替换”。Responses 入口经 Chat canonicalization 后，原 `instructions` 可能已经成为 canonical `system` message，stopless guidance 可能在新的 runtime guidance 字段；最终 provider wire 要看所有 system/developer 语义是否仍在。
- 真证据只认 `provider-request.json` 或 provider-request dry-run 的最终 provider body：原系统提示词长度/开头、开发者/permission 系统消息、原工具列表、stopless guidance、exactly-one `reasoningStop` 必须同时存在。
- 如果原系统提示词完整、工具列表完整但模型仍 text-only natural stop，根因优先落在 action-first guidance/schema/guard 策略或 provider/model compliance；不要误判为工具列表被清理或系统提示词被清空。

### Provider-request dry-run

- provider-request dry-run 是观测面，不是生命周期推进面。
- dry-run 可以读取当前 scoped StoplessCenter 和 local continuation 来构造 provider request，证明 Req04/VR/provider wire 形状；但不得写入、清空或推进 live StoplessCenter。
- 同一 live StoplessCenter 状态 + 同一 local continuation，对同一 submit_tool_outputs payload 连续 dry-run 应产出相同 provider request；若第二次 dry-run 改变 prompt policy、计数或 provider request，说明 dry-run 泄漏成状态转移。
- dry-run 不得 commit Resp04 continuation effects；也不得用 fake provider response 触发 live StoplessCenter transition。

### Live 样本审计

- 查 `~/.rcc/codex-samples/openai-responses/ports/<port>/<requestId>/` 时，必须同时比较 `request.json`、`provider-request.json`、`provider-response.json`、`response.json`；不能只看 raw client request 里有/没有 stopless artifacts。
- `request.json` 可能保留客户端回传的历史 `call_stopless_reasoning` no-op call/output；这只能说明客户端历史里有桥接轮，不等于 provider 看到这些 artifacts。
- 判断工具列表是否被清理，真证据是 `provider-request.json`：原始工具必须保留，且 managed relay 只追加 exactly-one `reasoningStop`。若 provider wire 仍有 `call_stopless_reasoning`、CLI stdout、`routecodex hook run reasoningStop` 历史消息，才是 Req04 清理失败。
- 判断 stopless 是否失效，必须按轮次看：provider 原始 `finish_reason`、Resp03 是否投影 `call_stopless_reasoning`、下一轮 provider request 是否注入完整 guideline + tools、以及 guard 是否达到。默认预算 3 表示第 1、2、3 次连续自然 stop 都应投影 no-op，第 4 次才是 guard pass-through；guard 不是“工具列表丢失”，也不能当完成证据。
- 最新真实样本出现“工具列表存在但模型连续自然 stop”时，优先区分三类：模型未按 guidance 调工具、guard 预算/重置策略不适合当前任务、或 Req04 没把 active no-op state 转成 provider-visible guideline。不要先改 SSE/handler/outbound。

### Guard

- guard 是防无限循环的安全终止，不是“任务完成”证明。
- 到达 guard 时只停止继续拦截/续轮；不得投影新的 CLI，不得合成“续轮上限/guard/内部状态”诊断文本。
- GuardTerminal 仍必须在 Resp03 使用 cleaned visible payload 投影：普通可见文本保留，但 raw stop schema/control marker（如 `stopreason/current_goal/next_step`）不得穿透到 client visible payload；禁止直接返回未清理的 input payload。
- 非 stop 进展、普通 tool call、真实 user turn、terminal schema、session/scope change 必须 reset。

## 节点审计表

| Node / edge | 必查输入 | 必查输出 | 审计断言 |
| --- | --- | --- | --- |
| `V3HubReqContinuation03Classified -> V3HubReqChatProcess04Governed` | req_inbound normalized request + continuation lookup | restored canonical context | req_inbound 不恢复 stopless，不注入 guidance |
| `V3StoplessReq01RuntimeControlLoaded` | MetadataCenter scoped StoplessCenter | typed state machine snapshot | CLI/stdout/continuation store 不是状态来源 |
| `V3StoplessReq02NoopCliConsumed` | restored context + current no-op output | shell pair removed | 不解析 CLI stdout；不保留 stopless tool history |
| `V3StoplessReq03GuidanceToolInjected` | state machine phase/policy + cleaned request | ordinary user guideline + exactly-one internal tool | prompt 是完整非持久 guideline 且随 state 变化；旧 generated guideline 必须清除；不硬编码单一 `继续。` 作为全部策略 |
| `V3HubRespChatProcess03Governed -> V3StoplessResp01ReasoningStopInspected` | provider parsed response | stop event classification | SSE/handler/outbound 不判 stop |
| `V3StoplessResp02RuntimeControlUpdated` | stop classification + previous state | next StoplessCenter state / clear | state 有 phase、need_continue、blocked、guard 闭环 |
| `V3StoplessResp03NoopCliOrTerminalProjected` | state transition + visible text | client-visible message + no-input CLI or unmodified guard pass-through | 命令无 `--input-json`；可见文本保留；达到 guard 时不合成内部状态诊断 |
| `V3HubRespContinuation04Committed` | finalized response | canonical continuation context | 保存发生在投影后；store 不写 StoplessCenter |

## 测试与 gate 设计

先按 SOP 改测试，不先补实现。

必有红测：

1. CLI binary：`routecodex hook run reasoningStop` 必须 exit 0；任何 `--input-json` 要求必须红。
2. Client projection：response JSON/SSE 中 stopless `exec_command.arguments.cmd` 必须等于 `routecodex hook run reasoningStop`，且不含 `--input-json` 或 JSON state。
3. MetadataCenter state machine：phase / need_continue / blocked / guard / consecutive count 转移必须可断言；只剩 counter 必须红。
4. Req04 guidance：同一 no-op output 在不同 StoplessCenter state 下输出不同 provider-facing guideline/policy；提示必须是完整但透明的任务导向 guideline，包含上下文复核、继续推理、工具推进、完成/阻塞证据要求，且不得暴露 no-op/CLI/client bridge/`finish_reason=stop` 机制；单一硬编码 `继续。` 覆盖全部状态必须红。
5. Continuation boundary：Resp03 投影先于 Resp04 save，Req04 hook 晚于 restore；反向顺序必须红。
6. Provider blackbox：Round2 provider request 无 shell/control artifacts，保留原工具声明面，追加 exactly-one `reasoningStop`，OpenAI Chat wire 不能只比 name，必须比 description/schema/strict/custom format。
7. Direct negative：direct/provider-direct 无 stopless guidance/tool/CLI。
8. Guard/terminal：完成、阻塞、guard、non-stop progress、already-terminal 均有正反测试。
9. Generated guideline history：多轮 no-op/guard 前 provider request 中 generated continuation guideline 必须 exactly-one；旧 generated guideline 累积必须红。
10. Dry-run read-only：带 StoplessCenter 的 provider-request dry-run 不得改变 live StoplessCenter，连续 dry-run 产物必须 identical；dry-run 推进 count/phase 或 clear state 必须红。

验证升级：

```text
SOP/docs/gate 红锁
  -> focused Rust state-machine tests
  -> provider/client blackbox dry-run
  -> build/global install
  -> managed 5555 restart
  -> exact old sample or same-entry live replay
```

局部测试、dry-run、build、health 都不能单独证明 runtime 闭环。

## 禁止反模式

- 用 `--input-json '{}'` 保留一个无意义输入 envelope。
- 在 CLI args/stdout 中携带 stopless 状态。
- 把 `repeatCount`、`schemaFeedback`、`triggerHint`、`next_step` 当 CLI 状态。
- 用 continuation store 保存 StoplessCenter。
- 在 SSE、server handler、provider transport、req_inbound、resp_outbound、immutable interval 补 stopless 语义。
- 只看第一轮 `requires_action` 就说 stopless 正常；必须看下一轮 provider request。
- 只断言工具 name；必须断言工具声明语义等价。
- 为了“续上”collapse 全 history；只能删除匹配 stopless shell pair，保留真实历史。
- 把客户端拒绝普通工具后的错误 output 当作“无进展噪音”清理；这会留下 orphan call、破坏会话对称性，并让模型失去修正依据。
- 把 stopless generated continuation/guideline 当真实用户历史保存并逐轮累积。
- provider-request dry-run 推进/清空 live StoplessCenter，或用 fake provider response 触发真实状态迁移。
- 把 guard 终止说成任务完成。
- 到达 guard 时合成“续轮上限/连续 stop 次数/内部状态”诊断文本；正确行为是停止拦截当前 `finish_reason=stop` 响应。
- 把续轮提示压成一句 `继续。` 让模型猜后续动作；续轮提示必须是完整但非持久的当前轮 guideline。

### Stop schema vs natural stop 判定补充

- 如果 provider-facing system guidance 和 `reasoningStop` schema 已完整存在，模型真要完成/阻塞时应调用 `reasoningStop`，不能把自然 `finish_reason=stop` 当合法终态证据。
- 如果自然 stop 是偶发早停，下一轮 managed stopless provider request 必须仍保留完整原系统/工具语义，并把工具决策提升为 required/any：有真实工具可推进就调用真实工具；无完成/阻塞证据不得连续 text-only stop。
- Live stopless probe 必须带真实可隔离 `client_metadata.session_id/thread_id`（或 Codex 等价 session scope）。缺失 session scope 的轻量 curl 会按合同不写 StoplessCenter/不注入 stopless，不能作为 stopless 生效或失效证据。

### GLM OpenAI Chat schema compatibility check

- 如果 GLM/OpenAI Chat 返回 `Invalid schema for function 'exec_command': '[REDACTED]' is not of type 'object', 'boolean'`，先检查最终 `provider-request.json` 或 provider-request dry-run body。这是 provider-wire JSON Schema 问题，不是 stopless 清空工具/提示词，也不是 SSE stream mode 问题。
- `tools[].function.parameters`、`properties.*`、`items`、`oneOf`/`anyOf`/`allOf` members 等 JSON Schema 位置里的 redacted placeholder 必须在 provider send 前归一为 boolean schema `true`。不得归一普通 tool description/text，不得删除工具。
- 该类修复的 stopless live closeout 必须包含第二轮 submit 路径：client-visible `routecodex hook run reasoningStop` output -> provider-request dry-run -> live provider response，且 live 结果必须是真实工具调用或合法 terminal `reasoningStop`。

## Resp03 split-hook closeout rule (2026-07-24)

Response-side stopless/servertool governance must stay split after Resp03 tool-frame repair:

```text
Resp03 text harvest
  -> complete/repair tool frames and finish_reason
  -> inspect corrected finish_reason
  -> tool_call branch: apply_v3_tool_call_servertool_hook_at_resp03
       -> if not intercepted, ordinary tool governance may run
  -> stop branch: apply_v3_stop_servertool_hook_at_resp03
  -> Resp04 continuation save only
```

Rules:
- Do not revive a merged `apply_v3_stopless_response_hook_at_resp03` in the Resp03 orchestrator.
- Do not run ordinary apply_patch/client-tool governance before the tool_call servertool hook gets first pass.
- Do not repair `status`, `finish_reason`, `stop_reason`, tool frames, history, or guidance in Resp04; Resp04 only saves/releases already-governed Resp03 truth.
- If map/SOP edges mention the old merged response hook, update them to the split hook symbols and refresh the architecture lock with a manual authorization record.

## Stopless live closeout review rule (2026-07-24)

- `verify:v3-stopless-state-machine-docs` green is not enough. Always run `test:v3-stopless-state-machine-docs-red-fixtures`; if the red fixture fails with `ERR_MODULE_NOT_FOUND`, fix the fixture temp-copy dependencies first because mutation diagnostics are masked. Known required deps include `v3-mainline-caller-flow-lib.mjs` and `v3-req04-tool-governance-review-lib.mjs`.
- Live closeout must include `scripts/tests/stopless-5555-live-probe.mjs` after global install and managed `routecodex restart --port 5555`.
- `invalid_stopless_continuation_loop` with visible raw stop schema JSON is a Chat Process stopless lifecycle gap. First inspect Resp03 stopless terminal/projection handling, especially GuardTerminal cleaned visible payload projection, Req04 restored no-op consumption, current-turn guidance, and stop schema visible-text stripping.
- Do not fix this class in SSE framing, server handler, RespOutbound, continuation store transport, or error projection.

## Reasoning mapping precheck for Stopless summary issues

When a V3 `/v1/responses` stop/end_turn unexpectedly triggers Stopless despite the client requesting reasoning, first verify protocol reasoning mapping before changing Stopless:

1. Check client request `reasoning` config in the canonical sample request.
2. Check provider-request, not client response only:
   - Anthropic provider wire must contain top-level `thinking`; raw top-level Responses `reasoning` must be absent.
   - OpenAI Chat provider wire must contain top-level `reasoning_effort`; raw top-level Responses `reasoning` must be absent.
3. Check provider response normalization before Resp03:
   - Anthropic `thinking` / `thinking_delta` / `redacted_thinking` / signature must become Responses `output[].type="reasoning"` with `summary[].text` and/or `encrypted_content`.
   - OpenAI Chat `reasoning_content` / structured `message.reasoning` must become the same canonical Responses reasoning item and must not leak private `reasoning.content`.
4. Stopless summary gate only reads canonical Responses reasoning summary. Do not infer reasoning from visible `<think>` text or from request `reasoning.summary` config; `summary` is a carrier/config request, while `thinking` maps to canonical `reasoning`.

Required focused gates: `hub_anthropic_codec_characterization`, `responses_relay_anthropic_provider_wire_integration`, `responses_openai_chat_field_parity_request_matrix`, OpenAI Chat provider reasoning response tests, `verify:v3-protocol-conversion-field-parity`, and red fixtures.
