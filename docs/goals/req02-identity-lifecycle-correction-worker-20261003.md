# REQ02 identity 生命周期作者修订

目标：继续修订本任务保留的identity候选，完成已审R2生命周期合同及作者纠正条件；不是review，不重复全库审计。你不是独自工作：scope测试worker只写另树的server/tests/req02_scope_runtime_consumer.rs，响应worker只写request_context_store成功view/anthropic projection context，父负责maps与集成。禁止覆盖他人改动。

独占worktree：/Volumes/Intel/playground/routecodex/req02-identity-plumbing-20261003，分支codex/req02-identity-plumbing-20261003。这是同一REQ02未收口候选的下一作者修订，保留现有dirty产品及父只读依赖；不要reset/stash/restore，不编辑共享main。父最终组合最新origin/main并验证，不声称当前候选已包含最新main。全新codex exec --profile gcm，禁止resume/fork、父transcript、Collab及内置subagent。

输入：已审docs/design/v3-req02-cutover-consumer-contract.md，父补足的具体输出carrier绑定；docs/goals/req02-identity-plumbing-author-corrections-20261003.md；原作者结果保存到父docs/evidence/dagpipe/req02-identity-plumbing-author-result-20261003.md。不要接受原作者“只剩一个缺口”的结论：五个已确认缺口逐项修。

所有权：允许继续修改原合同的execution_control.rs、nodes.rs、kernel.rs、kernel/{direct_execution_control.rs,v3_direct_core.rs,direct_state.rs,direct_runtime_helpers_stream.rs}、hub_v1/{relay_runtime_core.rs,responses_relay_runtime_inner.rs,anthropic_relay_runtime.rs}及server/responses_direct_server_outcome.rs。新增必要carrier仅限hub_v1/{responses_relay_types.rs,openai_chat_relay_runtime.rs,anthropic_relay_runtime_helpers.rs,gemini_relay_runtime.rs}和server/{live_snapshot.rs,executors.rs,endpoint_handlers.rs,websocket.rs}。上述只改factory、guard传递、输出字段及终点，不改归一化、Chat治理、投影、Provider、retry政策或SSE协议语义。现有test/support initializer可最小迁移，逐文件说明；不要写另一worker的scope test。产品operation_runner、REQ06、codec/profile/maps/graph全部只读。每个文件用apply_patch，不做语义批量替换。

首先落盘docs/goals/req02-identity-lifecycle-carrier-route-20261003.md：列真实入口factory提前位置、future持有guard、成功/错误输出及handoff搬运、共享终点owner和实际文件/符号；这是已审合同的具体实现路线，不重新设计生命周期。随后实现，不因本路线文档等待父确认；若确需改变R2语义或额外产品路径，先记录具体缺口而不扩写。

必须修：
1. 所有真实Relay/Direct入口在首次归一化/规划前建真实requestId scope，同一control/handle随handoff保留；原pair不重建。
2. 实际Runtime future取得并独占非Clone guard，成功交给真实输出，handoff移动同一guard；cancel/future Drop时即使普通control clone存活也释放。禁止靠last clone、每clone Drop、第二guard或Server另建scope。
3. 纯Responses/shared/Anthropic/Gemini Relay成功和错误也搬运guard；不能只有Direct→Relay补丁。不同协议只做typed carrier适配，终点清理政策只有一个Runtime owner。
4. SSE EOF与Drop都释放；JSON/error消费终点真实可达；先attempt后request。ordinary handles只观察，不决定终止。
5. 移除.take_request_finalizer().ok()吞错误、缺guard静默return；内部失败显式进既有Runtime/Error边界，不增加passable业务拒绝、不伪造成功。

验证：先保留真实consumer行为红，再修唯一owner。另一测试任务完成后父会提供只读scope test；此时先运行现有req02_request_scope_lifecycle及execution_control/operation_runner开发测试，新增源需全量server test编译检查。收到真实scope test后必须运行：CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_scope_runtime_consumer -- --nocapture。开发用相同wrapper分别运行-p routecodex-v3-server --test req02_request_scope_lifecycle -- --nocapture、-p routecodex-v3-runtime --lib execution_control -- --nocapture、-p routecodex-v3-runtime --lib operation_runner -- --nocapture。每命令直接重定向自有日志，保存原始退出码；禁止使用echo/tail/rg/tee管道后的exit0冒充测试通过。git diff --check必须exit0。

完成iff：真实Runtime consumer证明纯Relay SSE返回后drain前active、EOF/Drop后released且clone仍存活；pending upstream取消且clone仍存活也released；真实Direct成功/error输出终点释放；可达handoff保持同scope；所有开发测试实际exit0，caller与cleanup无双路径、无吞错。缺消费者测试时只报INCOMPLETE，不以手动drop guard的8项测试自证完成。结果落盘docs/goals/req02-identity-lifecycle-correction-result-20261003.md，分别列行为红/绿、源码/测试hash、每命令退出码、carrier路线和剩余限制，然后退出。不commit/merge/push/install/restart，不碰4444。
