# 66301e2：Servertool 移除与 Chat Process 有界续杯整合方案

状态：整合设计已落盘，未实施产品代码、配置或活动图。日期：2026-10-21（America/Los_Angeles）。工作项：66301e2。工作树：`/Volumes/Intel/playground/routecodex/66301e2`，当前分支 `codex/66301e2-bounded-refill`。

本轮只新增整合方案、整合 DAG、整合实施提示词及其派生图片。不覆盖原有三份 bounded-refill 设计，不修改 canonical dirty 树，不新建工作树，不操作其他任务资源。

## 1. 权威输入与替代关系

已先读并复用本树中的三份原设计：

- [原续杯实施提示词](66301e2-bounded-refill-implementation-prompt.md)
- [原续杯实施计划](66301e2-bounded-refill-plan.md)
- [原续杯业务 DAG](66301e2-bounded-refill-dag.md)

本次用户明确指定以上续杯设计，并要求整合整个 servertool 移除方案。续杯合同以用户这次指令和原 bounded-refill 计划为准。整合 DAG 见 [66301e2-servertool-refill-integrated-dag.md](66301e2-servertool-refill-integrated-dag.md)，完整实施合同见 [66301e2-servertool-refill-integrated-implementation-prompt.md](66301e2-servertool-refill-integrated-implementation-prompt.md)。

| 旧 servertool 移除方案中的内容 | 本整合方案处理 |
|---|---|
| 生成 echo shell tool call、改 finish reason、客户端执行后续轮 | 撤销。不生成工具，不要求 shell 执行器。续杯是 Runtime 受 typed 决策驱动的新执行。 |
| 新增 server feature `auto_continue`、按 listener 开关 | 撤销。只有 config crate 的 internal.toml 一处配置，上限0关闭。 |
| 删除全部 follow-up/disposition/internal-origin/中间暂存 | 缩小删除范围。只删搜索专用控制；保留并补齐有界续杯所需的通用处置、正常请求重入、暂存与最终提交。 |
| 用 `servertool_followup` 承载新续杯 | 禁止。删除旧搜索语义；新增明确的 typed refill origin/action，不能沿用 servertool 名称隐藏另一种行为。 |
| 只有 Node01 已接入 DAGPipe | 过时。采用指定树当前 README 的 scoped candidate 状态，不复用 canonical 旧结论。 |
| root 旧需求版本9、旧 request 图9条边 | 不复用。指定树需求文件当前版本20，request 图当前9节点8边。 |
| 删除 servertool-core、CLI projection、内部搜索执行 | 保留删除目标。普通工具、原生搜索和多模态的透明代理支持保留。 |

旧 canonical 方案与图保留为历史，不是本整合任务的执行合同。原 bounded-refill 三文件也保留；本文件只补合并后的范围、删除边界、依赖与验收，不反向改写其历史内容。

## 2. 总目标、范围与非目标

一次完整 milestone 同时交付：

1. RCC 内部 servertool 注册、CLI descriptor projection、搜索 Center/sidecar 执行和搜索专用跨轮状态已物理移除。
2. Chat Process 对完整治理结果统一判断；无工具、无真实错误、无源显式非空 summary 且未到上限时，执行有限续杯。默认最多新增一次，0关闭，N最多新增N次。
3. Direct 与 Relay 复用相同策略。真实工具、模型无效参数、历史配对、原生搜索结果与引用、多模态、可表达未知字段、真实 finish reason 都保持合同。
4. 中间轮不提前完成客户端响应。前序业务内容进入续请求历史，也进入最终标准业务结果。错误沿原 Error 链，取消与计数按请求隔离。

不恢复广义 Stopless、reasoningStop、MetadataCenter 续杯状态机，不实现完成度分类器，不建立搜索服务或新 hook 框架，不重构全部 DAGPipe SDK，不操作独立 AppSDK/Collab daemon，不扩到 V4。

## 3. 指定树观察、需求与已知缺口

### 3.1 本轮已核实的事实

- 当前树只有三份原 bounded-refill 设计为未跟踪文件；本轮开始时未见产品代码改动。此状态只描述本次观察，不保证后续 agent 启动时不变。
- `internal.rs` 使用 `include_str!("internal.toml")`；该配置是编译期资产。目前本树 config/runtime 两个 crate 都有 internal.toml，本功能只能写 config crate 的文件，不能写错 runtime 的同名文件。
- 原配置尚未声明 `[chat_process.refill]`。`InternalConfig` 目前没有该结构，不能把设计字段称为已生效配置。
- `servertool-core` 仍识别 `servertool_fixture`、`web_search`、`vision_auto`。CLI 仍输出 descriptor；Runtime 中仍有 `V3HubServertoolResponseAction::FollowupRequired`。
- response 图仍写 `v3.operation_runner.execution_disposition` 和 `v3.operation_runner.servertool_sidecar_plan`。现有 disposition 的设计合法值仍含 `servertool_followup`；这不证明通用续杯执行器已接线。
- 指定树 DAGPipe README 记录 M2 candidate scoped acceptance 为13/20：9个请求节点与4个响应节点，frame binding 仅限现有 Responses JSON；hosted inverse 和部分 Error/Direct/disconnect 接线仍有 pending。此处引用文档状态，未重跑旧测试，也不推断完整 runtime、Review 或 main 交付。
- 原续杯计划建议的 `no_response_adjudication_blackbox` 实际位于 `routecodex-v3-server/tests/`，不是 runtime crate。整合提示词和命令改用真实 target 所属 crate，原文件不改。

### 3.2 需求约束

指定树 `.appsdk/requirements.json` 当前文件版本20，内容是 changes 事件记录。按 requirement_id 取最新 result，不按不存在的空 requirements 数组跳过。

| 适用条目 | 当前版本 | 对本方案的约束 |
|---|---:|---|
| `routecodex-client-provider-error-decoupling` | 6 | 真实错误和响应处理失败走 typed Error；模型无效参数仍属业务内容；不得产生客户端错误响应或假成功。 |
| `routecodex-no-implicit-fallback-bypass-payload-tunneling` | 1 | 续杯是显式产品分支，不是错误兜底；控制不写业务 metadata；不能绕过固定主线。 |
| `routecodex-post-filter-attempt-deliverability` | 1 | 先完成声明治理与工具收割，再判断本次完整 attempt 可交付性；真正空结果先走原错误链，不能用续杯救成成功。 |
| `routecodex-last-provider-failure-terminal-policy` | 1 | 续杯不改变末候选失败和耗尽的终止策略；前轮文本不授权把后轮失败包装为正常完成。 |
| `routecodex-port-local-provider-health` | 1 | 续杯不跨端口污染 provider health；续杯次数与 provider retry/健康计数分别归属。 |
| `routecodex-managed-restart-live-continuity` | 1 | 采用当前正式生命周期合同和有效证据；health 不能替代重启连续性证明。 |
| `routecodex-protocol-compatibility-normalization` | 1 | 遵守当前透明代理及 Direct/Relay owner。历史字段丢弃文字与当前 AGENTS 有差异时，明确范围和依据，不借本任务更改字段政策。 |

用户指定 bounded refill 是本次明确的新需求。实施阶段按原计划的现有需求流程追加对应条目；不重写或放宽已有错误、工具、可交付性条目。本轮不修改 requirements。

### 3.3 事实不足的边界

实施前只补实际缺口：当前 origin/main 与 PR433/依赖分支状态、原 issue 的当前记录、外部旧 CLI/control 消费者、实际 native-search provider 能力、本地客户端搜索执行器，以及源 summary 的具体映射。

这些缺口各自约束对应动作。缺本地搜索执行器只阻断其 live case；不阻断策略实现或受控工具往返。summary 源映射和最终内容投影属于关键数据正确性前置，未绑定时不能实施其判断或宣称完整交付。不得因缺辅助材料就停全部任务。

## 4. 唯一配置与策略真值

唯一产品配置文件：

`v3/crates/routecodex-v3-config/src/internal.toml`

```toml
[chat_process.refill]
max_consecutive_refills = 1
```

由同 crate `internal.rs` 现有解析 owner 产生只读 typed policy。消费处不再写第二个默认1；不增加用户 config、server override、环境变量、动态写 API 或 runtime crate 同名配置。

- 0合法且关闭。非负整数N表示最多新增N次，不含原始请求。
- 负数、浮点数、字符串按现有内部配置解析模式显式报错，不新增配置框架。
- 改值须重建并按正式通道加载，不承诺热更新。
- 策略值是编译期配置；`used`、执行身份、取消、内容和错误是当前请求运行事实，不能写回配置。

### 4.1 唯一决策顺序

Runtime 先处理取消和未恢复的 typed 来源失败。对本次完整治理且通过当前可交付性边界的成功结果，Chat Process 共享判断按以下顺序处置：

| 条件 | 处置 |
|---|---|
| 客户端已取消/断开 | Runtime 取消，禁止后续执行；不构造客户端完成响应。 |
| 本次执行存在真实错误 | 交既有 Error 链；未恢复前不进入 summary/额度判断。 |
| 治理后有完整真实工具调用，包括已合法收割的调用 | 正常交付真实工具及保留内容，结束本连续续杯链。 |
| 有源显式非空 summary | 正常交付，结束连续链。 |
| 配置0或 used已达上限 | 正常交付取得的真实结果和终态。额度耗尽不是错误。 |
| 以上均不满足 | RequestRefill：构造标准续请求，由 Runtime 正常执行。 |

不加 task/goal 完成度、正文关键词、长度、措辞或“像计划”分类器。不得从 finish reason 推断错误。合法非stop终态如 length/content_filter/refusal 按本次明确三条件及当前独立业务结果合同处理，不额外添加旧 echo 方案的特殊终态禁续杯清单；原值始终保留。真正空响应或已确认的治理失败先走 Error，不能变成无 summary 的正常续杯。

工具事实来自完整治理后的标准工具项，不靠工具名称白名单或finish_reason文本：function/custom/MCP、各协议tool_use/functionCall、合法收割项以及已识别的原生hosted工具调用均保留各自kind。原生搜索由Provider执行，不要求客户端再执行一次；普通本地工具才由客户端执行。模型生成的无效arguments仍是工具业务内容，不因参数校验失败掉进refill。

### 4.2 summary 的源事实

只用标准归一化后可追溯至本次 Provider 的显式非空 summary。不是从正文猜测“有没有总结”。

| 来源 | 判断规则 |
|---|---|
| Provider 原生响应中已映射的 summary 字符串/summary text 列表 | 合法文本去空白后非空才置 true；通过 typed provenance 保留源字段关联。 |
| Provider 原生 reasoning item 的显式 summary | 只有源映射证明来自 Provider 时按 summary 文本事实处理；不把它另解释为“任务完成证明”。 |
| 空数组、空字符串、纯空白、缺失/null | false，不抹掉原字段。 |
| 请求中的 reasoning.summary/generate_summary 策略声明 | 是请求策略，不是响应 summary，不用于压制续杯。 |
| RCC 从 reasoning/toolreason/正文合成的 summary | 不作为源 summary；无论文字多像总结都不置 true。 |
| 未登记或不能确认来源的字段 | 不猜完成度；先明确源映射缺口，保留业务内容，不引入额外 admission。 |

实现前在现有 operation/function/resource map 中登记各协议实际字段、提取 owner 和 source-vs-synthesized 区别，并先给原生与合成同文本反例。Inbound 只做无损归一化/来源关联，策略判断仍由 Chat Process 持有。不能在 payload 塞 `has_summary` 控制标记。

源关联必须在会合成summary的治理之前建立：Relay由标准响应归一化owner、Direct由其注册响应适配owner读取当前原生响应的已映射字段并保留typed来源。完整治理后共享判断只消费仍保留内容的源关联，不能事后对一个已被RCC合成或覆盖的同名字段猜来源，也不能把前轮summary残留当作本轮事实。

### 4.3 不伪造工具与真实终态

不生成 echo、虚构 call ID 或 `requires_action`，不把 stop 改为 tool_calls，也不将 length/content_filter 改为 stop。保留模型实际工具及正常协议投影。已有真实工具收割按原合同输出合法工具终态，不受禁止伪造工具的约束误伤；续杯本身不能伪装成工具。

## 5. Runtime、请求历史与最终交付

### 5.1 typed 状态与所有权

下列名称是责任示意，落代码前优先复用已声明 typed owner，不建立第二个状态中心。

| 对象 | owner / 生命周期 | 关键合同 |
|---|---|---|
| RefillPolicy | config internal.rs / 编译期只读 | 只有上限，无会话状态。 |
| GovernedResponseFacts | 对应响应治理 owner / 当前完整执行 | 真实工具、源 summary、业务结果与终态；不缓存成下一次成功事实。 |
| RefillDecision | Chat Process / 当前响应执行 | Deliver 或 RequestRefill；不承担 provider 健康与 Error05 重试决策。 |
| RefillExecutionControl | Runtime / 当前客户端请求 | used、取消与执行身份；并发、会话、端口均不共享 used。 |
| BusinessAccumulator | Runtime持有业务序列 / 请求作用域 | 每个成功执行的业务内容按序保存；内容本身是业务数据，相关执行/来源引用是独立 typed 控制，不混到 metadata。 |
| Request construction | 请求 Chat Process | 原始请求、真实工具声明、配对历史、之前 assistant 结果及显式续杯指令。 |
| ErrorDecision | 既有 Error01–06 / 当前失败 attempt | 保留原原因、实际上游状态、内部599/502、候选恢复及耗尽。 |
| Staged response outcome | 正常响应/帧 staging 与 Runtime commit | DeliverableCandidate 或 DeferredRefill；延期不表示空成功，也不向客户端发送语义终态。 |

原始执行 `used=0`。只有准备真正启动下一次 refill execution 时，Runtime 在同一请求 owner 下检查取消和额度并加1；候选切换、重试、探针不多扣、不重置。新 execution 内可以有多个 provider attempts；执行成功后重新产生本执行事实，不读取上一次失败标记。

### 5.2 正常主线重入

续杯不能复用 web-search 专用执行器，也不能只设置 `FollowupRequired`。

声明边必须完整：

`完整治理结果 → 共享续杯决策 → typed refill 处置 → 请求 Chat Process 构造 → Runtime 新执行 → 正常 Request 主线 → 完整结果 → 内容保留/最终交付`。

保留原始客户端 inverse/history pairing 的请求作用域。新 execution 带明确 typed `refill` 来源，normalization 不从内部 payload 重建原客户端 inverse。普通客户端工具执行后的请求是新的客户端请求，used重新为0。

构造时加入显式产品续杯指令：“继续执行尚未完成的任务；需要工具时直接调用工具；如果任务已完成，请给出完成总结。”这是实际的新请求内容；次数、取消、routing、summary源与内部状态不能通过该指令或 metadata 携带。

路由仍走当前 Router/Target/Provider 契约，保留显式 provider pin 和候选规则。续杯本身不切 provider、不惩罚健康；真实失败由 Error owner 决定恢复。新执行的请求形状和首次接受仍需公开入口证据。

### 5.3 内容累积与两种耗尽

- 每轮完整业务内容按原顺序保留，既进入后续 assistant 历史，也进入最终标准业务结果。不能仅记日志、只保留最后轮或把前轮正文搬进 reasoning/summary。
- Responses 使用标准 output items 保留前序 message/media 与最终工具；Chat/Anthropic/Gemini 使用已声明的标准投影保留文本段、结构化内容和真实工具。item identity 的协议要求由既有 typed provenance/identity owner处理，真实工具 call ID不改，不能用自建 metadata 包裹补内容。
- 各轮真实终态保留在标准 canonical 结果与 typed 来源记录；单个客户端响应的顶层终态使用最后交付执行的真实终态，前轮终态不能通过非标准 finish_reason 数组外泄。前轮内容仍在最终业务内容中。
- 成功执行的 usage 沿现有可组合 usage 合同累计；缺失项保持缺失，不用0伪造。失败 attempt 消耗留在既有诊断/计费观测，不伪装成成功业务 usage。投影前用有不同数值的用例绑定准确规则。
- “续杯额度耗尽”意味着交付现有真实结果，不是 provider 错误；“Error 候选耗尽”遵守原请求传输中止合同，不能从已存前轮文本拼一个假正常完成。
- 中间轮不发 completed、DONE、tool终态或其他正常完成事件。transport-only keepalive继续按已有边界工作。最终提交前仍全 attempt 缓冲。
- 内存/体积/超时沿现有请求资源约束；不能为便于累积静默截断。真实资源失败走其 typed 错误，不自行添加无条件补偿路径。

### 5.4 清理

refill与Error恢复在下一次执行/attempt前释放已消费的 attempt 投影、transport和临时处置，但保留请求级 origin、inverse、配对历史、used及业务累积。最终交付、取消、断开或错误耗尽才执行请求 finalizer。取消后二次检查必须挡住尚未启动的续杯，且不能影响其他会话。

## 6. DAG 影响审计与正确删除边界

本轮只读结构检查如下；不是项目 DAGPipe gate PASS，也不是 runtime 接入验收。

| 指定树现图 | 节点/边 | 输入/输出 | 结构结论 | 整合变化 |
|---|---|---|---|---|
| request | 9/8 | 1/1 | 无环、唯一根 capture_client_json、唯一汇 construct_transport_request | 不画回边；补 typed refill origin、请求构造输入与原始 inverse 保留。 |
| response | 5/4 | 1/1 | 无环、唯一汇 frame_committed_client_response | 删除搜索 sidecar plan；新增有界决策/延期处置与内容累积；保持固定节点次序。 |
| error | 6/5 | 1/1 | 无环、唯一汇 error_err06_client_projected | 只删搜索专用来源；Error05仍是候选恢复 owner，无续杯额度惩罚。 |
| DSH function-call terminal | 3/2 | 1/1 | 无环、单源单汇 | 真工具照常终结自动链；不出现伪造 echo/工具终态。 |

### 6.1 保留并改造，不再一刀切

- `execution_disposition` 仍有 Deliver 与 Refill 两种独立行为，不能按旧方案作为单值资源删掉。具体 legal values更新为业务明确的 client_commit/refill_requested；不能保留 servertool 别名。
- `servertool_sidecar_plan` 及搜索 executor 无消费者后删除。refill 请求计划归请求 Chat Process 构造，不把旧 sidecar plan 改名冒充通用计划。
- 中间 frame staging 仍有必要，但必须是显式 DeferredRefill typed 结果。不能用正常空 frame candidate 表示“本轮成功完成”。响应图的 ARC/schema、reader/writer与Runtime消费边必须一起绑定。
- 每个既有响应节点仍按固定次序处理一次；处置只决定候选暂存/提交，不让 Operator自行重入或跳骨架节点。Error和取消的对象源仍各自独立。
- Runtime图外发起下一次execution；每次Request/Response/Error图内部仍是DAG，不画回边，也不把多个对象源塞进同一张业务图。
- 先绑定这些资源与清理边再改 gate/红测。不能凭旧 `FollowupRequired`、静态设计或 README 的局部验收声称通用执行链已存在。

### 6.2 四张 map、图与接线动作

| surface | 动作 |
|---|---|
| `v3-resource-operation-map.yml` | 退休搜索 Center、hook_request/outcome/backend/sidecar；绑定 policy、facts/provenance、refill decision/control、accumulator、deferred outcome 的真实 producer/consumer/release。 |
| `v3-function-map.yml` | 退休 `v3.servertool_center_skeleton`、搜索状态机专用 owner；保留普通 ToolThinking/custom owner，新增有界策略与重入的单一职责绑定。 |
| `v3-mainline-call-map.yml` | 删 Req04/Resp03/Direct 搜索 dispatch；补 Direct/Relay到共享策略、请求 Chat Process、Runtime执行、累积及最终提交边。 |
| `v3-verification-map.yml` | 保留普通工具/错误/多模态保障，退休旧存在性锁，绑定本方案公开入口 ID/准确命令。 |
| 三张 operation graph 与 DSH扩展 | 仅更新受影响 typed读写、ARC和处置合同；不顺便进行未完成节点全面SDK接入。 |
| manifests、unified runner design、wiki与SOP | 同步请求来源、延期提交、资源释放和 retired搜索合同；生成面从既有源生成。 |
| `modules.json` / README | 不夸大本轮接线和候选验收。只有实际SDK和真实入口证据变化时更新对应状态。 |

锁定图边按当前已有用户授权记录实际范围，不伪造批准、不计算额外fingerprint；若确实超出授权只停该边。保留正式Git保护。

## 7. Servertool 删除与保留清单

| 模块 | 删除或改造 | 保留 |
|---|---|---|
| `servertool-core` 与 workspace/runtime/CLI/hooks依赖 | 专用消费者清零后删除crate、member/dependency及无效打包材料 | 无关真实协议合同先归回其现有owner。 |
| CLI main | 删除 servertool run 与 descriptor输出 | 正常 config/status/restart等命令。 |
| `hub_v1/servertool_hooks.rs` | 先拆普通工具，再删名字拦截、CLI投影与搜索治理 | ToolThinking、custom wrapping、namespace、apply_patch与实际工具配对。 |
| `hub_v1/common.rs` 与 direct/relay状态 | 删 ServerToolName/Center/phase与搜索scope | 本次独立refill typed控制和原 MetadataCenter其他消费者。 |
| `web_search_hop/sidecar/hook_request.rs`、`kernel/direct_web_search.rs` | 删除内部搜索派发、合成hosted结果、搜索跨轮状态 | 原生搜索机械投影helper若有独立消费者先拆出。 |
| Req04/Resp03、kernel、relay runtime | 删除搜索专用边；补共享有界策略和正常重入 | 真实工具治理、Error、取消、普通continuation和正常transport。 |
| hooks control/lib/adapter/handler | 核实外部消费者后删除 ExecuteWebSearch及专用adapter | 独立daemon、调度、AppServer与其他control协议。 |
| config types/validate/defaults/provider_config | 拒绝退休local-center/legacy-backend，删内部backend和servertool origin | none/native tool-mix/native search-only的真实标准投影及独立路由。 |
| config internal.toml/internal.rs | 新增唯一refill上限与typed读取 | 不在用户config或runtime同名文件再建入口。 |

仅普通工具名恰叫 web_search/vision_auto/servertool_fixture 时，不得继续按名字截获。原生 hosted工具的kind保持原生，不混同普通function。

搜索选择：支持原生的目标接受标准 hosted声明并自行执行；不使用原生时，客户端声明并执行真实本地工具。普通客户端工具不要求主模型具备hosted search能力。不在Provider失败后偷偷执行本地命令。多模态保留标准media/MIME/内容/引用与必要映射，只删vision_auto包装。

旧配置必须有字段级迁移和明确诊断，不能接受后无效果。active配置只输出字段路径、用途、动作及结果，不输出凭据。保留独立搜索/多模态路由，证明仅服务退役搜索执行后才可删。0关闭续杯不等于关闭原生搜索或普通工具。

## 8. 最小充分测试与公开入口

沿用原续杯8个拟议ID，并新增整合边界。用例是计划，尚未实现/运行。每个新用例先有当前行为红证据或能抓错的反例，不为造红而改需求。

| ID | 断言和反例 |
|---|---|
| `refill_limit_zero_public` | 0只执行原请求；原工具/业务/终态不变。抓消费侧第二默认值。 |
| `refill_default_one_tool_roundtrip_public` | 默认1续请求包含原历史与assistant内容；上游返回真实工具；客户端实际执行、同call ID回传后可继续。抓只置标记、伪造工具及丢历史。 |
| `refill_default_exactly_two_public` | 两次均无工具/summary则只原始+1，无第三次，前后内容均交付。抓无限续杯和最后轮覆盖。 |
| `refill_limit_three_public` | 3最多新增3次；各轮provider重选不多扣/重置。抓按attempt计数。 |
| `refill_summary_tool_suppression_public` | 原生/合法收割工具和源非空summary止链；空白/合成summary不止链。抓字段同名但来源混淆。 |
| `refill_error_chain_public` | 第一轮/续杯轮的真实错误走原链；切候选不额外续杯；候选耗尽不能退回前轮文本假成功。抓错误当无summary续杯。 |
| `refill_concurrent_cancel_public` | 同端口并发和跨端口used隔离；取消不再启动下一轮，其他请求可用。抓共享计数与发起竞态。 |
| `refill_direct_relay_content_parity_public` | 两路径共享策略，保留前轮内容/真实工具/参数/身份/终态；JSON/SSE不提前完成。抓复制策略、只保最后轮。 |
| `STREM-NATIVE-SEARCH-FIRST-ACCEPT` | hosted声明+普通工具+配对历史组合被首选目标首次接受，结果/citations保留；严格upstream拒错误shape，不用无条件200。 |
| `STREM-LOCAL-TOOL-ROUNDTRIP` | 无hosted能力主模型能返回普通本地搜索工具，客户端真实执行与后续结果匹配；0和默认1分别验证工具立即止链。 |
| `STREM-ORDINARY-TOOLS` | function/custom/MCP/apply_patch及同名普通web_search不被专用注册拦截；真实安全工具执行并配对。 |
| `STREM-INVALID-ARGS-PASS` | 无效模型参数原样交客户端，客户端错误结果下轮配对；不触发provider失败或续杯代工具。 |
| `STREM-MULTIMODAL-PRESERVE` | 当前轮适用image/audio/document、MIME、顺序和opaque字段保留；续请求与最终结果都不丢。 |
| `STREM-NO-CLIENT-ERROR` | provider错误恢复/耗尽及治理后空attempt遵循当前Error合同，无错误泄漏、假空完成或前轮成功包装。 |
| `STREM-NO-SERVERTOOL-EXEC` | 全程无ExecuteWebSearch、servertool CLI、echo伪工具或搜索sidecar；允许且只允许used对应的正常refill执行和Error尝试。 |
| `STREM-CLI-CONFIG-HOOKS` | 旧CLI不再输出ok descriptor；退役配置明确失败；非搜索hooks功能保留。 |

风险来自直接被删的注册/sidecar、混合工具文件和新增计数/累积边。受控HTTP反例成本低且可复现；复用已有普通工具、Error、field-parity测试。真实consumer只跑受影响组合，不做所有协议/模型笛卡尔积。缺执行器、模型或目标能力时对应case未验收，不伪造PASS。

Config经现有internal解析owner验证0/1/3及非法类型；测试注入typed policy仅供测试，不成为生产覆盖口。summary源/合成同文本、不同usage、item身份和中间终态必须有数据正确性反例。

### 8.1 准确入口与命令

现有公开listener测试target实际属于 **server crate**。以下filter拟新增，实施须确认运行测试数非零：

```sh
node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test no_response_adjudication_blackbox refill_ -- --test-threads=1 --nocapture
```

如果整合用例放同一target，则其拟议命令：

```sh
node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test no_response_adjudication_blackbox servertool_refill_ -- --test-threads=1 --nocapture
```

稳定ID与实际Rust测试名/filter一一绑定进verification map，不用0tests的成功退出作验收。现有辅助入口已核对存在：

```sh
npm run verify:v3-dagpipe-governance
npm run verify:v3-operation-runner-dagpipe
npm run verify:v3-resource-map
npm run verify:v3-mainline-caller-flow
npm run test:v3-relay-request-semantics
npm run test:v3-relay-response-semantics
npm run test:v3-relay-tool-servertool-multiturn-parity-closeout
```

混合parity target先保留普通工具用例再退休servertool用例/名字。`verify:v3-servertool-center-skeleton`和其存在性断言只在必要行为保障迁出后退休，不能留空壳PASS。正式整合按当前映射要求运行适用CI/架构检查；不要因文档编辑或每个内部节点自动全跑umbrella。

## 9. 实施任务、单一 owner 与依赖

沿用66301e2的T1–T8总框架，下面细化其内部包，不新建第二份issue或同域工作树。本整合milestone的产品实施与行为验收当前为0/8；既有设计不是实现验收。

| 包 | owner / 产物 | 依赖与验收 |
|---|---|---|
| T1 恢复与范围 | 编排者；当前issue/依赖/需求与唯一树记录 | 复用原登记，在66301e2记录本次明确的servertool移除整合范围；查当前origin/main和PR433，不把旧base状态当事实。不改其他树。 |
| T2 图与合同 | 图owner；四maps、typed资源、summary源表、累积投影、deferred处置及gate绑定 | T1；先图校验再gate与红测，区分静态和实际接线。 |
| T3 红测与保留基线 | 验证owner；refill实际第二请求红测，CLI/搜索拦截反例与普通工具基线 | T2；公开入口红测，不以缺类型编译失败代替行为红。 |
| T4 策略与分离 | Config/Chat Process唯一owner；internal上限、source facts、共享策略、混合工具分离 | T3；0/1/3解析、summary来源、工具止链、不伪造终态。 |
| T5 整合主线 | Runtime/请求Chat Process与接口owner按文件分工；正常重入、计数、累积、取消；删除搜索/CLI/adapter依赖 | T4；首轮+续轮闭合，无sidecar/echo，无提前完成，不误删通用处置和普通工具。 |
| T6 作者与候选验收 | 集成owner；受影响测试、真实consumer、构建安装、正式加载、同入口与样本 | T5；全部必需行为可用，失败先作者排障。 |
| T7 一次整体Review | 独立Reviewer；覆盖整个servertool移除+refill架构与证据 | T6；按当前宿主模型规则，finding修复只补受影响验证。 |
| T8 main交付与收口 | 交付owner；CI/集成/push/远端、main后运行、issue disposition和资源 | T7及适用CI；不能以分支提交或review代替交付。 |

可并行准备：T2合同确定且T3各包红测就绪后，独立CLI/hooks专用删除、Config解析与独立黑盒测试可按文件分工并行。Runtime响应策略、common.rs、kernel、共享maps、workspace Cargo和package脚本各有唯一编辑owner；共享Git index仅集成owner提交。策略与通用执行之间有真依赖，不为并发拆出两个策略owner。

同域只有现有树。禁止另开r1/r2、从其他树手工抄文件或删除未提交原设计。依赖更新用标准Git合流；最新main只使受影响证据失效。不为省事重置、stash、覆盖或清理他人状态。

## 10. 交付、停止与记录

按当前项目和宿主合同：图/资源 → gate/红测 → 唯一owner实现 → 作者测试与真实入口 → 适用候选build/install/restart/样本审计 → 一次整体Review → 适用CI与正式main集成/push → 合并后运行验证与issue/resource收口。

正式restart前说明预计中断，每次新构建只一次正式 `rccv3 restart`，失败先调查，不以stop/start或自行接管代替。保留每次managed restart后的同入口与Codex sample审计；非2xx除已确认transport失败外仍须判断request shape致因，成功切provider不关闭原错。

现有66301e2已登记，不重复intake。测试ID与准确命令写入canonical issue并保存真实回执。原提示词要求read-back；本树当前rcc-dev-skills明确不加例行读回门禁，正常写回用命令回执，失败/不确定时才定向核对；不扩成身份包装。

源码、图、测试、build、install、restart、health、真实入口、Review、merge、remote与cleanup分开记录。只清理本任务自有且已终结资源；原设计若仍需保留先按交付合同归档到集成结果。本轮不清任何工作树。未知/活动/其他owner资源保持不动。

summary映射、内容投影、权限或需求冲突只停真实下游。push拒绝、CI失败或Review finding须保留原错，由编排者解阻。不能因为worker一句blocked停止全目标。禁止跨聊天发送、无关daemon维护、tmux生命周期、私有日志/凭据外传、绕过Git hook或额外SHA/冻结检查。

## 11. 本轮交付与后续入口

本轮提供整合方案、整合DAG和完整agent提示词。没有新增产品配置、没有执行续杯、没有删除servertool，没有运行产品测试或重启。原三份设计和其他任务状态保留。

本方案通过现有文件与只读源码审计形成。六张新展示图是设计视图，不是活动DAGPipe接线；派生图的检查结果和访问位置在整合DAG文末维护。

后续执行者读取整合提示词后，从T1恢复；复用原独立Plan，只对本次合并造成的summary、通用处置/延期提交和删除边界补正。若关键方案确需改变再按宿主合同独立规划，不重复为已明确的配置位置和三条件询问许可。
