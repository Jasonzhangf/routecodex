# REQ06 标准 Provider 请求投影改造任务

## REQ02 当前公共依赖交接（2026-10-03）

### 本轮新增依赖观察（当前候选未准入）

目标树HEAD仍为`405e0c70a98e525562362c7d5637d9b1c78a7443`，但已出现8个tracked源码修改，不能再把下面上次“tracked clean”当实时状态。typed request/attempt公共类型正在引入，公共`project_canonical_request`仍未找到；父不争抢其文件，也不把活动源码当作者完成结果。

当前三个准确的合同偏离，需原owner在交付前解决：

- `operation_runner/request_context_store.rs:353`新增`RequestContextSlots.direct_native_request: Option<Value>`；`:424`的`publish_direct_native_request`克隆完整native request到control slot，`:437`从该slot读回。这是业务payload镜像，不是typed identity/path/encoding引用。
- `operators/capture_client_json.rs:51`调用`publish_direct_native_request(output.clone())`，使已交付的REQ01 capture新增跨节点control写入。既有REQ01合同禁止其读写metadata/origin等control effect，REQ06任务也不应改变其职责。
- `operators/project_standard_provider_request.rs:152`的Direct分支从上述control slot读取native request。REQ02已审合同要求Direct以当前canonical与数据面opaque引用经registered Direct view hook生成native工作视图，不能用control中的平行raw-request真源绕过该consumer。

修订方向沿既有R2：保持REQ01无control effect；完整业务值只在canonical数据面，请求资源只存typed关联；公共helper消费canonical、compiled profile、原inverse/history与真实attempt identity，返回彼此物理分离的payload和typed attempt context。不得把原始request或schema/参数/结果写入control slots来恢复Direct，也不得恢复raw再跑旧Inbound。不在父分支建立第二投影实现。这是依赖合同核对，尚未启动该外部候选的实现架构review。

本节更新依赖事实，保留下面的节点范围。本轮只读核对目标树HEAD为`405e0c70a98e525562362c7d5637d9b1c78a7443`，tracked clean、仅`.gcm-blackbox/`未跟踪；`project_standard_provider_request.rs`仍使用旧`RequestScopedContextStore`，未发现`project_canonical_request`公共helper。下面早期HEAD不是当前验收结论；本文件落盘不证明另任务已收到或承诺交付。

REQ02父组合树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-cutover-20261002`，HEAD`a9952cc748f417caa675025f20ae1e51323d0c79`加绑定dirty候选，已正式组合origin/main`688f7a1c6a15ecf45dfee12cc430148ae3c03898`。namespace presence/nested修复已完成；成功attempt响应typed view与既有codec/materializer消融已组合，最新main输入公开cross_kind2/view6及runtime lib1139项通过，另有1项既有ignored。实际caller、identity最终生命周期、HTTP/WS及完整工具E2E仍待完成，未安装/restart或交付。精确状态与证据见父节点笔记及`docs/evidence/dagpipe/req02-successful-response-parent-result-20261003.md`，HEAD不代表完整候选内容。

公共类型唯一源为父树`v3/crates/routecodex-v3-runtime/src/operation_runner/request_context_store.rs`与`operation_runner/mod.rs`，不能继续使用旧`RequestScopedContextStore`及任意`Option<Value>`attempt容器：

- `V3RequestContextHandle`只持有请求级typed资源；原始`RequestScopedContextPair`包含不可变`RequestInverseContext`与`ExplicitHistoryPairing`。
- 原工具声明由`ToolDeclarationReference`指向canonical数据面的opaque原声明；namespace缺省为None，显式null保留为Some(Null)。schema、参数、结果与完整请求体不能进入控制资源。
- `AttemptContext`包含`AttemptProjectionContext`与`AttemptDeclarationMap`，显式绑定attemptId、providerProtocol及providerModel。
- `ToolMappingReference`包含`declaration_record_id`、source/destination路径、实际`emitted_kind`/`emitted_name`/`emitted_namespace`及encoding。从本attempt真实投影的工具声明生成，不能从模型名、原schema内容或响应名称猜测。
- `V3RequestFinalizerGuard::finalize()`返回`Result<(), String>`；唯一guard由真实输出owner搬运，不能复制或替换资源owner。
- `ResponseProjectionView::from_successful_attempt(request, attempt_context)`消费该request存储的原pair与成功attempt；原声明与实际emitted身份按`declaration_record_id`关联。kind/namespace可以因投影而不同，不能要求两侧相等。该consumer已完成公开JSON和真实provider SSE验证，helper产出的attempt必须能由它直接消费，不能再另设映射器或遗留容器。

所需最小交付仍是标准投影唯一owner的`project_canonical_request(canonical, compiled_profile, inverse, history, attempt_identity) -> ProjectedRequest`。`ProjectedRequest`的数据面payload与typed attempt关联必须物理分离；直接使用上面公共类型。compiled_profile的具体类型复用本节点已有typed配置owner，不再建立第二字段配置真源。该helper供既有Outbound及registered Direct view hook消费，不执行完整REQ06迁移，也不得恢复raw再跑旧Inbound。

请先交付该公共接口的确切路径/签名、针对真实工具声明的公开consumer测试与结果、源/profile/test哈希和可集成diff。实际caller/生产接线仍由父编排在REQ02前置验收后按序完成。父编排当前没有Desktop native线程通信能力，本文件是可转交的落盘合同；文件存在不等于另任务已收到或已开始实施。

## 目标与归属

只完成 `project_standard_provider_request` 的标准投影行为及其必需配置、回归测试，不再把 Node02 解释为整条请求链。

任务对象：`codex/dagpipe-node02-runtime-20260930`，工作树 `/Volumes/Intel/playground/routecodex/dagpipe-node02-runtime-gcm-20260930`。已核对 HEAD `768a9565c9d8f6b9c9e231fd1eb8e8f1edc24eb4`；它有既有未提交设计、源码、测试修改。接手先读节点笔记和 diff，保留全部他人改动。若依项目规定新建实施 worktree，从当时最新 origin/main 建立，仅携入本节点所需、归属已核实的候选内容，不整批合入旧分支。

你负责 REQ06；父编排负责 REQ02 起的按序接线。不得修改父编排工作树。实现人员使用新建 `codex exec --profile gcm`，按文件所有权拆分；实现与 review 分离。

## 输入依据

- 本工作树 `AGENTS.md`、`.agents/skills/rcc-dev-skills/SKILL.md`。
- `docs/design/v3-unified-operation-runner-design.md` 及其未提交 execution-mode / inverse-association 修订。
- request graph、field_profiles、lifecycle manifest，以及四张 V3 owner/caller/resource/verification map。
- `.gcm-blackbox/node02-r6-design-gap-20261002.md`。
- `.agent-collab/review/node02-arch-review-20261002-r5/review.final.md`。该 review 不是当前候选 PASS。

## 唯一处理点与顺序

输入：govern_chat_request 的 canonical request；typed selected target、execution mode、请求 inverse context/history pairing。输出：standard-provider-request ARC；typed provider semantic、attempt projection context、attempt declaration map。

固定次序：读取 typed resource → 按已审 mode/profile 选择标准投影操作 → 在标准投影边界恢复可表示原始字段 → 检查实际控制/数据隔离 → 发布本 attempt 的投影与工具声明关联 → 输出给 REQ07 Compat。Provider-private 调整、wire/auth/网络发送、选路、健康、客户端帧均不属于本节点。

### A. 执行模式必须成为真正的操作输入

1. `same_protocol_direct` 保留原生协议形状，使用已声明的 Direct owner/hook 边界；不能把 canonical Chat 强行交给 Relay builder。
2. `hub_relay` 使用唯一标准 Outbound owner，将 canonical Chat + extensions 投影到目标标准协议。
3. mode 必须来自 typed `execution_mode`；禁止根据 messages/contents 的存在猜模式，禁止新的协议私有分支、fallback、去字段再补字段绕过拒绝。
4. 明确原生请求来源与生命周期：已有 typed inverse context 或已声明数据 ARC；控制状态不进入 payload，不能加一个平行 raw-request 真源。
5. 不实现 local continuation。对 remote continuation 字段先核对当前真实入口和协议契约。现有文档与可达行为若冲突，落盘并交父编排裁决；不得自行扩大退休声明、静默丢字段或新增拒绝。

### B. 嵌套扩展字段必须到最终 transport body

1. 建立 source parent → canonical element → projected destination 的 typed provenance 关联，适配数组展开、合并、重排；不能假定原数组 index 就等于最终 index。
2. 使用已注册 operator@version + typed params/profile 描述处理；统一遍历骨架不依协议名、字段路径硬编码语义表。
3. `thoughtSignature`、`vendorPartMetadata`、`vendorPart`、`vendorMessageMetadata` 等可表示字段恢复到对应元素旁；没有可表示目标时按显式协议契约保留关联，不能静默跳过后宣称无损。
4. 顶层字段与 tools 不得继续成为第二套独立恢复语义；在本节点收敛为相同关联机制，删除确定失效的重复实现。

### C. 请求与响应工具身份配对

1. attempt declaration map 以这个 attempt 实际发出的工具列表为依据；关联请求声明中的 namespace、原始名称、function/custom 类型和 provider 名称。
2. 不枚举或解析工具参数业务语义；参数、自由文本、工具结果和完整命令按原合同完整传递。
3. 不凭 gpt-5.5/gpt-5.6/gpt-6-luna 名称猜映射，依据实际请求工具声明。响应侧由请求 metadata 反向恢复；本节点只产出其唯一需要的关联，不抢占响应处理 owner。

## 允许路径

- `v3/crates/routecodex-v3-runtime/src/operation_runner/operators/project_standard_provider_request.rs`。
- 该节点确需的独立 helper、field profile 参数、版本绑定、graph/map，以及独立测试文件。
- 对共享 tests/mod.rs、registry/mod.rs 只提出最小接入 diff 给本任务集成人员；并行实现者不同时写这些文件。

禁止修改 Server、SSE、Router、Provider transport、其他节点语义，禁止整批修 unrelated main 问题。扩大路径须先落盘唯一 owner 与依赖证据，并与本任务集成人员协调。

## 验证与完成条件

先修订设计/profile并完成独立设计准入；已有 PASS 只在输入未变时复用。红测必须贯穿完整 request consumer 到 transport.body，再实现使其转绿。

- Direct 同协议 Chat / Responses / Anthropic / Gemini：最终原生请求保留可表示字段，仅已声明的 selected model/hook 行为改变。
- Relay 各受影响协议组合：最终标准协议正确，嵌套未知字段、文本、图片、工具历史完整；Direct 与 Relay 正向/反向因果对比。
- 同名不同 schema、namespace function/custom、内建 Gemini tools、不同模型实际工具声明：关联正确、不猜工具类型、不拒绝 passable 形状。
- 本节点 errors 到既有 typed Error chain；无 success-wrapped error、控制字段泄漏、跨请求/attempt 映射污染。
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --lib operation_runner -- --nocapture`。
- `dagpipe graph validate docs/architecture/dagpipe/v3.operation_runner.request.graph.json`。
- `node v3/scripts/architecture/verify-v3-operation-runner-dagpipe.mjs`；`node v3/scripts/tests/v3-operation-runner-red-fixtures.mjs`；`npm run verify:v3-architecture-ci`。
- `cargo fmt --manifest-path v3/Cargo.toml --all -- --check`；`git diff --check`。
- 精确候选版本上的真实 HTTP/WebSocket consumer与完整工具回合，含实际 exec_command、apply_patch、MCP 执行回执、follow-up；GCM profile 的 gpt-5.5 与 gpt-5.6 实际工具声明均覆盖。HTTP200/requires_action不算工具执行成功。

作者完成 debug、测试和 E2E 后，再做独立架构 review；遇见行为缺陷退回作者，不让 review 代替调试。完成 iff：上述证据与候选身份绑定、独立架构 PASS、范围内重复实现已消融、节点笔记完整。返回可集成的本节点 diff/commit与证据路径。

REQ06 生产接线依赖 REQ02→REQ05 按序完成。你不能提前接线，也不能整批 merge/push 该旧分支。父编排推进到 REQ06 时，组合最新 main 与本节点，重验受影响证据后完成集成、安装、restart、live replay和清理；4444只允许restart。

## 节点笔记与交接

在本任务独占笔记记录 `时间/节点 | 状态与结论 | 证据路径 | 输入版本/环境 | 下一步`，先读后推进。未知写未知，原错保留，缺样本不编造。回报设计/实现/测试/E2E/review/接线/merge/runtime/cleanup分别到哪层；不要将版本改为@2当成修复完成。
