# DAGPipe 流水线逐节点改造与接线 Goal

入口：工作树建立基线 `3a72ad81320b1c435b08c0d99343c7c22efa5197` 上已有 REQ01 capture。父候选已组合 main `688f7a1c6a15ecf45dfee12cc430148ae3c03898`，当前父 HEAD 为 `a9952cc748f417caa675025f20ae1e51323d0c79`，另有本任务未提交候选；HEAD 不是完整候选版本，须另绑定 tree/输入哈希。上游 Responses incomplete／Chat codec 终态修复已保留，后续main/集成动作边界重新 fetch；父dirty产品未作为交付提交，REQ02未接线。总目标：完成现有 request、response、error 三条独立 SESE 图的统一 operation 骨架改造与实际接线。当前阶段只交付下一节点 REQ02 normalize_request_losslessly；完成该节点整个生命周期后才推进 REQ03，不得携入未就绪下游候选。

## 可直接执行的目标提示词

```text
/goal
目标：完成 RouteCodex V3 request、response、error 流水线的 DAGPipe 改造与生产接线。沿现有项目图按依赖逐节点交付；当前从 REQ02 normalize_request_losslessly 开始，REQ01 已接入，复用其有效证据。

身份与编排：你是本目标编排者，负责架构、依赖拆分、派单、集成、最终验收和自有资源管理；Codex Desktop/TUI使用codex-orchestrator，项目具体命令与gate由rcc-dev-skills提供，共用唯一编排流程。优先向已可通信、获授权且愿意接单的peer派单；需启动worker时新建codex exec --profile gcm，Desktop只走该入口，不用内置并行入口。无人可派时独立推进。worker独占外置worktree和文件范围，禁止resume/fork旧session、传父transcript、覆盖他人改动或多人写同一范围。未注册Collab不自动注册、不寻找Master；Desktop独立child不进入Collab生命周期。代码只在最新origin/main建立的独立worktree开发，保护既有dirty候选。派单写明allowed/forbidden paths、完成iff、黑盒用例/命令/预期、证据位置，并告知还有其他执行者。

当前状态以节点笔记及绑定证据为准，本段不是实时worker状态。REQ01已接入；consumer/API/资源生命周期合同R2和结构binding/Gemini media补充合同R3已取得独立设计PASS。父候选已组合字段库、显式profile、Gemini media输出、REQ02 SDK单节点runner与typed请求资源；违规container_transform_id及protocol/path推导fallback已移除。namespace缺省/null区分和子声明显式kind修复已组合；父公开presence2、nested3、public5、tool_shapes4及runner51均PASS，实际exit0，输入hash见.execution/nested-parent-combined-inputs.sha256。该证据只证明公开归一化与开发测试。

canonical consumer与Chat历史图片处理点已组合父候选：consumer直接消费SDK canonical，图片清理只在Chat Process执行；四协议公开consumer、canonical media保留负例、既有图片19项及runtime lib 1135项通过。精确证据见docs/evidence/dagpipe/req02-chat-image-parent-result-20261003.md；这不是HTTP/WS或真实工具回合证据。GCM工具回合harness已组合并完成语法/help/参数负测，输入见.execution/harness-parent-r3-inputs.sha256；尚未在已接线候选执行gpt-5.5/5.6真实工具回合。

identity生命周期产物尚未导入父候选。最新节点笔记绑定的恢复/消融后输入：冻结五项Runtime consumer实际3PASS/2FAIL，共享Chat Relay三项实际2PASS/1FAIL，合计5PASS/3FAIL。失败为Responses Relay SSE EOF、共享Chat Relay SSE EOF、Direct provider error output Drop；其余五项已有绿证据，不重新定位。Direct error真实terminal witness是ExternalHttp(400)，临时client_payload未被Server提交，不能误报客户端502回归。error output返回时Active，消费或Drop后Released，禁止提前释放造绿。Gemini/Anthropic四项真实Server JSON/SSE测试已在作者基线和父组合输入实际4PASS/exit0；只证明协议业务入口，不证明scope或REQ02接线。作者和证据已保存，测试任务不再待收。最终identity候选须用--no-fail-fast或分别运行全部5+3，并重验四协议测试；首个失败binary后的未执行用例不能算已跑。

成功attempt响应修订与定点消融已完成作者收口并逐文件组合父候选：cross_kind两项由exit101到exit0，证明namespaced custom→flat function和无namespace改名均按原声明恢复；公开view六项包含真实Anthropic provider events贯穿既有materializer。冗余legacy三map回填与无consumer Responses-only包装已移除。组合main688f7a1c6后的父HEADa9952cc7加绑定dirty输入，cross_kind2/view6和runtime lib1139项均真实exit0，另有1项既有ignored；证据见docs/evidence/dagpipe/req02-successful-response-parent-result-20261003.md。这只证明公开consumer与开发回归，实际Runtime response caller尚未替换。REQ06公共helper仍待原owner按交接合同交付。REQ02未完成HTTP/WS与两模型三工具候选E2E、安装/restart、实现架构review、merge/push，4444未触及。完整architecture gate的终态待收；R2/R3设计PASS仅在合同未变时复用。既有HTTP/WS与两模型结果只证明基线能力。

立即动作按序完成：
1. 先读唯一节点笔记，复用已验namespace、media、profile、资源runner、canonical/图片、成功attempt响应消融、四协议Server与R2/R3设计证据。核对并收现有identity修订handle41728和architecture gate handle34928真实终态；这些是上次观察，不是当前live事实。共享Relay和四协议测试作者已结束，原文/源码/日志已保存，不重派、不再轮询；三个已结束作者HOME已有目录不存在证据，不重复清理。原identity作者因脚本批量改58个错误出口及覆盖dirty kernel止写，其退出不算作者PASS；保留违规diff、恢复及编译原错。尚在写入时不得另派重叠writer或由父同写；map/生成面修改等待当前gate结束。超时、重连和压缩提醒不算终态，不能据此重启；逐命令核对真实退出码，worker exit0不能代替测试结果。goal/notes属于admission输入，最终gate须绑定最终文档输入。
2. 验收现有identity GCM单一owner修订，不重复全路径审计。所有真实入口在首次归一化/规划前创建真实requestId scope，同一opaque handle沿Direct/Relay/handoff传递。实际entry/future薄wrapper独占非Clone guard，调用既有inner流程，在唯一输出处理点移动到JSON/error、committed stream或typed handoff；禁止为几十个error出口逐个扩guard参数。SSE复用V3CommittedClientSseStream::observe的FnOnce terminal处理EOF/Drop，各协议只做typed body适配。保留observer clone时SSE EOF、cancel/future Drop仍释放；JSON/error返回时Active，消费或Drop后Released；handoff保持同一scope与guard，先释放attempt再request。去除.ok()吞错和缺guard静默return，由既有Runtime/Error owner处理，不改Error政策。三份冻结测试req02_scope_runtime_consumer.rs、req02_shared_relay_scope.rs、req02_protocol_relay_consumers.rs不可削弱；完成iff为八项scope全部PASS、四项Server全部PASS、相关execution_control/operation_runner/lifecycle开发回归与全量Server tests编译exit0、冻结hash不变、作者结果及输入hash落盘。禁止语义批量替换、HEAD覆盖dirty文件、手工drop guard自证、提前释放、第二MetadataCenter、default identity、每协议复制释放政策或handoff重建scope。合格后逐文件组合父候选，保护已验响应切片及最新main终态修复，只重验受影响边，保留entryProtocol/invocationSource/transportIntent与当前轮图片。
3. 收取REQ06原owner的project_canonical_request(canonical, compiled_profile, inverse, history, attempt_identity) -> ProjectedRequest，验收标准投影唯一owner、当前公共类型及数据/控制分离。上次观察外部树已引入typed context但缺helper，并在RequestContextSlots.direct_native_request保存完整原始请求Value、capture_client_json增加control写入、Direct从平行raw读取；该候选违反R2数据/控制隔离、REQ01无control effect和Direct registered view合同，不能导入。由原owner按交接合同修正，不争抢文件、不从raw重跑旧normalizer、不建立第二投影路径。业务payload在canonical数据面，Direct经registered view hook消费，control只存typed引用和身份关联。依赖待收期间推进互不重叠的consumer及验证准备；符合合同后逐文件组合父候选，保存输入hash，只重跑受影响公开测试与gate。
4. 复用已落盘响应作者原文、最终输入和父消融验收，不重新执行已完成的消融。ResponseProjectionView::from_successful_attempt按原声明recordId关联成功attempt实际发出的identity，恢复namespace/name/function或custom/call_id，完整保留参数与自由文本；禁止断言provider发出的kind/namespace必须等于原声明，禁止改夹具伪造两侧相等。下一工作是闭合实际成功attempt producer和Runtime response consumer；真实JSON/SSE输出都必须消费该view，不只增加accessor、另写第二映射器或从governed payload猜身份。补齐Relay/Gemini与registered Direct hook对canonical的实际消费；RawEntry/AlreadyCanonical均经SDK单节点，原pair仅发布一次。候选算子及公开consumer验证通过后才替换隔离候选实际caller，并物理删除被替代的旧归一化/重复调用；旧响应factory只在未迁移caller仍有用途时暂留，实际接线后删除被替代的猜测路径。逐文件组合identity等合格产物，禁止整份复制mod.rs/maps/大runtime文件覆盖父响应改动或最新main终态修复。保持下游owner，不提前迁移其完整职责。
5. 保护父dirty候选，先fetch并组合最新origin/main，保留其他worker已交付修复；形成可追溯精确候选，重跑受影响测试与gate，从该候选重建隔离入口，运行HTTP/WS、JSON/SSE、Direct/Relay和成功/错误/取消/Drop/断连的黑盒对比。运行已组合harness的gpt-5.5与gpt-5.6两次完整回合：exec完整多行命令、绝对cwd、实际exit0和尾输出sentinel精确匹配；原生apply_patch的file_change Add→Update与文件内容匹配；MCP server/tool/arguments精确匹配、完整结果保存且显式RFC6901 pointer值被follow-up消费。绑定candidate SHA/tree、配置、binary/hash、真实endpoint、child与requestId/sample；禁止用模型自述、exit0、200或requires_action代替工具结果。未有已接线candidate不得默认请求4444或宣称E2E。样本不存在时明确证据缺口，不伪造配对。
6. 上述作者验证全部通过后才安装候选到实际位置、对4444执行restart并核对binary/PID/health、同入口回放及样本；之后独立实现架构review PASS，再执行最新main边界重验、clean-main merge/push、候选等价/远端回执、合并版live确认与自有资源回收。完整完成REQ02才推进REQ03；准备任务可以并发，生产接线与节点交付按依赖顺序。

当前必需合同：canonical唯一使用既有messages与routecodex_chat_extension，字段库直接产出一致的carrier及provenance/opaque引用，不增事后改名适配器。REQ02只运行client_request_to_chat；其他方向由既有owner通过必要typed接口消费，不等待完整下游节点迁移。所有真实入口消费新归一化结果；Relay按Chat Process边界治理，Direct只能通过registered Direct hook生成native工作视图，禁止恢复raw后重跑旧normalizer。Gemini消费者必须读取canonical，不向旧contents消费者硬塞messages。标准投影复用REQ06 owner的最小helper，响应owner实际消费原始inverse/history与成功attempt声明映射，恢复原请求的工具语义。

资源合同：Runtime在首次规划/归一化前，以真实requestId创建请求级固定typed slots，Server只搬运同一opaque handle；复用唯一MetadataCenter/control owner，不建跨请求全局HashMap、第二MetadataCenter或payload镜像。requestId、graph invocationId和attemptId分离；首次归一化成对发布不可变原始inverse/history，retry/followup读取原pair且显式AlreadyCanonical。每attempt记录实际投影及发出的工具声明typed引用，业务值留在canonical数据面；失败尝试先释放，成功尝试保持到响应消费完成。ResponseProjectionView::from_successful_attempt只结合原pair和本次成功attempt，不借失败attempt映射。唯一非Clone finalizer guard随实际输出/stream移动，覆盖成功、error、cancel、future drop、HTTP/WS断连及SSE EOF/Drop；先释放attempt，再释放request，禁止每个clone的Drop提前终结会话或poison时静默跳过清理。

节点顺序：请求链 REQ02 normalize_request_losslessly → REQ03 resolve_target → REQ04 plan_execution → REQ05 govern_chat_request → REQ06 project_standard_provider_request → REQ07 adjust_provider_private_request → REQ08 encode_provider_wire → REQ09 construct_transport_request；之后响应链 adjust_provider_private_response → normalize_provider_response → govern_chat_response → inverse_project_client_response → frame_committed_client_response；错误链 ERR01 source_raised → ERR02 host_captured → ERR03 runtime_classified → ERR04 router_policy_applied → ERR05 execution_decision → ERR06 client_projected。精确operator/边/终点以现有三图为准。并发准备允许，节点生产接线及交付严格按依赖顺序。REQ06由用户另派任务负责，本任务按公共helper合同验收并在前置节点完成后集成，不争抢其文件。

架构硬约束：唯一固定骨架，算子集中于operation_runner算子库；协议差异只由注册operator@version与typed参数/profile表达；每节点只完成自己职责，真正替换旧caller并消费输出，物理删除被替代的重复实现，禁止shadow检查、双路径、第二归一化、跨节点shortcut。数据与控制物理隔离，工具声明/namespace/类型映射绑定同一请求与本attempt实际发出的工具列表，响应按动态typed请求资源反向恢复，不按模型名猜、不解析或截断工具参数来猜工具身份。完整保留exec命令、apply_patch自由文本、MCP参数/结果及调用配对。只做remote continuation，不引入local continuation或拒绝现有remote契约。默认行为对齐现有真实设计，无法判断的契约冲突先落盘并澄清。删除旧Inbound分支时，将既有图片历史占位清理移动到唯一Chat Process处理点，保证只执行一次并保留当前轮图片；不能等未来REQ05再补行为。错误走独立Error链和provider管理，不将provider失败直接提交到客户端、不静默失败或伪造成功；真实终止由Error/SSE唯一owner处理。

每节点完成条件：审计该节点算子与唯一owner/真实caller/上下游/资源终点 → 必要设计修订及独立准入 → 最小实现与红绿测试 → 组合最新main并通过适用gate → 从该候选重建 → 候选算子及公开consumer验证通过 → 替换候选实际caller并通过隔离真实Server入口的改造前后黑盒与完整工具回合 → 适用安装/restart、运行产物身份核对、真实入口回放和样本审计 → 作者完成debug/E2E后独立架构review PASS → merge前main复核与失效证据重验/复审 → 合并clean main并push、核对remote回执与候选等价 → 核对合并版运行产物并按需重建/restart/live验收 → 清理本节点自有worktree/任务目录/临时资源并保留持久证据 → 下一个节点。黑盒用例必须可重复执行，从真实用户入口或公开接口输入，断言外部可观察结果与成功/失败/副作用；mock内部调用、私有状态或源码结构断言仅辅助开发，不能代替交付回归。精确候选上的HTTP/WebSocket与exec_command、apply_patch、MCP均须有实际执行回执、结果回传和follow-up，GCM profile覆盖gpt-5.5和gpt-5.6；200/requires_action或只生成工具调用不算工具成功。候选运行验证必须在最终review/merge前；未通过隔离入口验证的接线候选不得安装到共享runtime，三类工具任一不通过都不能交付。milestone架构review使用oauth profile与gpt-6.1-sol，作者和reviewer独立。

运行与证据：4444只能restart，禁止stop/kill；保护共享dirty树、其他worker资源和现有样本。出现502/400/598/599先查样本与日志、最小probe并复现对比后归因；无样本不猜，记录后继续不依赖该样本的主线。每阶段读写唯一节点笔记，绑定SHA/tree、配置、产物、入口、requestId及结果；只重跑失效证据。常规commit/merge/push/目标runtime重建重启已授权，按门禁自动交付。阶段结束明确实现/测试/review/接线/main/remote/runtime/cleanup分别到哪层。

依据：本文件；docs/goals/dagpipe-req02-cutover-notes-20261002.md（阶段状态唯一载体）；docs/design/v3-req02-cutover-consumer-contract.md及docs/evidence/dagpipe/req02-consumer-design-review-receipt-20261003.md（R2）；docs/design/v3-req02-field-profile-admission.md及docs/evidence/dagpipe/req02-profile-design-review-receipt-20261003.md（R3精确补充设计）；docs/architecture/dagpipe/三条graph；四张V3架构map；docs/design/v3-unified-operation-runner-design.md；docs/goals/dagpipe-req06-projection-handoff-20261002.md；最新用户提供AGENTS.md、codex-orchestrator与rcc-dev-skills。设计准入不代替作者黑盒或实现架构review。

直接执行本任务，不再为它生成一层提示词；完成一个节点整个生命周期后继续下一个，直到三条流水线交付收口。
```

编排/集成工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-cutover-20261002`，分支 `codex/dagpipe-req02-cutover-20261002`。
REQ02算子工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-operators-20261002`。
consumer分析工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-consumer-20261002`。
黑盒验收工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-blackbox-20261002`。

请求profile工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-profile-20261002`。
资源runner工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-resources-20261003`。
配置gate工作树：`/Volumes/Intel/playground/routecodex/dagpipe-req02-config-gate-20261003`。

本轮另建四个任务自有工作树：`/Volumes/Intel/playground/routecodex/req02-namespace-presence-20261003`、`/Volumes/Intel/playground/routecodex/req02-tool-public-cases-20261003`、`/Volumes/Intel/playground/routecodex/req02-nested-declarations-20261003`、`/Volumes/Intel/playground/routecodex/req02-gcm-roundtrip-harness-20261003`。上述七个与新增四个工作树由本任务创建，归父编排；完成后回收，活动时保留。只清理本任务创建且已确认不再需要的worktree、child、CODEX_HOME、临时链接与产物，先保留持久证据。旧候选和共享主树不属于本任务清理范围。建立时main基线3a72ad813不能当作后续集成边界的最新main。遇到合并冲突、push拒绝或CI失败，停止受影响集成并向本目标编排者报告；只有已注册Collab且有live master才按其协议升级，不寻找虚构Master，不绕过hook或强推。

另有本任务请求身份搬运树`/Volumes/Intel/playground/routecodex/req02-identity-plumbing-20261003`与Chat图片consumer树`/Volumes/Intel/playground/routecodex/req02-chat-image-owner-20261003`；两者及各自child、独立CODEX_HOME、依赖链接由父编排负责验收和收口。运行状态从真实回执刷新，不能用本清单判断活动或完成。

REUSE：已并入main的REQ01，既有graph/profile设计；旧候选REQ02仅是可参考实现，不是生产验收。
NEXT：读笔记→核对并收identity41728与architecture34928真实终态→最终identity候选八项scope全绿、四项Server全绿、开发回归及Server tests编译通过→逐文件组合合格产物→验收REQ06公共helper及数据/控制隔离修订→闭合成功attempt producer→候选实际REQ02/response caller消费与重复路径消融→补准确测试map绑定并重验受影响gate→最新main组合的精确候选隔离HTTP/WS、两模型exec/apply_patch/MCP实际执行与follow-up黑盒→候选build/install/restart及回放→独立实现架构PASS→merge前main复核与失效证据重验→merge/push/live回执→自有资源清理→REQ03。已结束测试作者及已核对HOME清理不是待办；已验响应消融和父公开回归复用绑定证据，不能当作实际caller接线或最终工具/runtime验收。

并发只覆盖互不重叠的实现/验证准备；接线按依赖串行。既有gpt-5.5/gpt-5.6工具及HTTP/WS结果只证明基线能力，不证明REQ02改造或安装验收。下一步复用已确认的caller边界与能力证据，收敛必需合同后推进产品实现，不重复启动全路径审计。产品代码在边界明确/适用设计准入后才写。

禁止shadow双路径、sidecar只检查、不消费输出、第二归一化、下游协议绕过、不完整工具回执。Direct仍遵守已有hook边界；响应逆向映射必须有对应请求资源传递，不能在REQ02引入旧响应owner不能消费的语义。真实错误进入Error链；不静默失败。

完成定义：REQ02产物接入唯一真实caller，成功/失败/取消/断连资源终点可验，三类工具黑盒通过，候选与main等价、remote回执、运行产物身份、restart与live样本以及review PASS齐备。每阶段立即写独占节点笔记，只重查失效证据。
