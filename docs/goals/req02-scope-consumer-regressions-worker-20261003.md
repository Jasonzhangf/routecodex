# REQ02 真实Runtime资源生命周期公开回归

任务：只编写真实public Runtime/Server consumer的生命周期回归与结果，不改产品。现有8项control/手动guard测试不能证明实际caller。你不是独自工作；实现worker独占identity tree，另一worker写成功attempt响应view。独占树/branch：/Volumes/Intel/playground/routecodex/req02-scope-consumer-regressions-20261003，codex/req02-scope-consumer-regressions-20261003，fresh origin/main688f7a1c6加父提供的identity候选只读snapshot。

允许：新增v3/crates/routecodex-v3-server/tests/req02_scope_runtime_consumer.rs、任务自己的结果/日志。全部产品源码、其他tests/profile/maps/graph及其他worktree只读。全新codex exec --profile gcm，不resume/fork/Collab，不改4444。

依据consumer R2已审合同：首次归一化/规划前创建真实requestId资源，普通control clone不负责生命周期释放。实际Runtime未来/输出持有唯一guard到success/error/cancel/drop/EOF/断连；handoff保持同scope；provider完整缓冲后才提交客户端。现有typed slot API的active/released结果可作为公开资源副作用，但必须由真实Runtime执行触发，不手动drop guard或自造observer充当Runtime成功。

具体已定位入口，不重新全库审计：runtime/src/kernel/direct_kernel_entrypoints.rs公开execute_v3_responses_direct_runtime_kernel_with_shared_state_default_transport_debug_and_initial_target允许传初始control；runtime/src/hub_v1/responses_relay_runtime.rs公开execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state允许传初始control。原始manifest/controlled peer初始化可复用runtime/tests/hub_relay_runtime_closeout.rs与server/tests/multi_listener_server现有方法；优先用本地真实HTTP upstream peer，禁止mock Runtime私有调用或源码断言。初始control的真实requestId与entryProtocol绑定输入，保留一个control clone检查不应延长已取消请求。

至少用例：
1. 真实纯Relay SSE成功返回output，保留control clone；取scope在output返回后且drain前应active，drain至EOF或drop应released。control clone仍存活不影响释放。
2. 真实Runtime在挂起upstream请求中被取消/future drop；保留control clone与handle，scope应released。不能仅drop所有control来造绿。
3. 真实Direct成功JSON/error输出的资源终点；有guard时不手动从control抢guard，按公开output消费/Drop触发，验证scope释放。
4. 可复用已声明公开路径做Direct→Relay/Relay→Direct交接，同scope不重建；接口不可达则记确切限制，不冒称已有覆盖。

本任务预期暴露现候选真实失败：Relay路径没有guard输出搬运，cancel靠last control clone释放，Server handoff.take_request_finalizer().ok吞错，live SSE wrapper只Drop不EOF。只以真实运行结果确认，不把源码猜测当因果证明。缺公共入口先记录能力限制及最小拟改，继续可执行案例，不跳到私有API/mock或宽松断言。

测试命令：CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_scope_runtime_consumer -- --nocapture，独立日志和实际退出码。编译红与行为红分开，必须使测试能编译后报告真实行为红/绿。git diff --check exit0。不需要产品修复、review、commit/merge/push/install/restart；结果落盘docs/goals/req02-scope-runtime-consumer-result-20261003.md，列每用例真实入口/结论/输入source hashes/日志hash/原始退出码，然后退出。
