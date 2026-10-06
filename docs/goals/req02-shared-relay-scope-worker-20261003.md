# REQ02 共享Relay实际消费者生命周期回归

你是GCM测试作者，不是reviewer，只执行本窄任务。你不是独自工作：identity作者在另一独占树写Runtime/carrier，父编排负责组合；不得覆盖任何产品或既有五项scope断言。

独占活动测试树：`/Volumes/Intel/playground/routecodex/req02-scope-consumer-regressions-20261003`，branch `codex/req02-scope-consumer-regressions-20261003`，HEAD `688f7a1c6a15ecf45dfee12cc430148ae3c03898` + 父提供并已有公开编译/行为结果的只读identity初版snapshot。这是同一未收口REQ02候选的下一测试切片，不新建第二产品实现。先核对真实pwd/HEAD、读AGENTS.md和本合同，不重做全库审计。所有命令显式绝对workdir，apply_patch绝对文件路径，不resume/fork/Collab/内置subagent、不reset/stash/restore、不语义批量替换。

可写只限新增 `v3/crates/routecodex-v3-server/tests/req02_shared_relay_scope.rs`、本任务结果和 `docs/goals/req02-shared-relay-scope-logs/`。已有 `req02_scope_runtime_consumer.rs` 全部只读，原五项断言不得改；所有产品、maps、graph、profile及其他worktree只读。无需更改生产接线、config或4444。

真实公开入口已定位：
`execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_execution_mode_and_request_control(manifest, input, health, V3HubExecutionMode::Relay, control)`。
control用现有public `V3RequestExecutionControl::new(manifest, server_id, actual_request_id, "openai_chat")` 创建并保留普通observer clone；entryProtocol字符串请从本树公开入口/测试真实契约核对，不凭名字猜。`V3OpenAiChatRelayRuntimeInput`、健康隔离factory、failure_session_scope及合法配置从已定位openai_chat测试复用。公开资源副作用可用 `control.request_context().original_pair()` 的Active/Released结果，但必须由真实Runtime执行触发，不手动取得/drop/finalize guard或自造成功。

用本地Axum真实HTTP upstream peer，合法Responses provider JSON/SSE终态可复用只读 `req02_scope_runtime_consumer.rs` 的已编译fixture；客户端输入是真实Chat请求messages，配置entry/endpoints为Chat且显式Relay。不要用mock内部调用或源码字符串断言。至少实现：
1. OpenAI Chat共享Relay SSE：实际upstream到达并返回合法成功events，真实public output返回后且drain前scope Active；drain到EOF、stream对象及observer clone仍存活时scope Released。断言client SSE合法Chat内容/终态，不能只看200。
2. OpenAI Chat共享Relay cancel：Runtime确实到达挂起的本地upstream后取消实际future，等join取消完成；observer clone仍存活时scope Released。不能仅drop全部control造绿。
3. OpenAI Chat共享Relay JSON：实际peer成功，返回后scope Active；消费/Drop公开output后scope Released，observer clone仍存活；检查实际响应内容。

若已公开入口不能验证某一终点，记录确切接口/失败和最小必要owner改动，继续可执行用例；不得跳私有接口、写产品或放宽断言。现snapshot预期可能行为红，行为红是有效测试产物，不伪造PASS；必须先消除fixture/编译错误再区分真正产品行为红。每个peer都通过自有graceful shutdown显式收口；不停止他人进程。

分别执行：
- `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_shared_relay_scope -- --nocapture`，直接重定向独占日志，保留实际exit0/101及每项结果，不用echo/tail/rg/tee掩盖退出码。
- `git diff --check`，期望exit0。
- 原五项只读测试SHA256仍为 `db8e027ff2c1e355f6ab238780197c41b62070ff2ee75414f328d5c701261730`；如输入冲突先报告，不能改原测试。

完成iff：三项测试可编译且真实公开Runtime/HTTP upstream运行得到行为结论，原五项和全部产品只读，原始退出码/日志/source/test/profile hashes齐全，结果写 `docs/goals/req02-shared-relay-scope-result-20261003.md` 后退出。每项稳定test ID、实际入口、success/failed副作用及未覆盖Gemini/Anthropic边界明确。产品行为红可以完成这个测试作者任务，但不能称REQ02修复或交付。

不commit/merge/push/install/restart，不做架构review，不碰4444。父编排收测试并在最终identity组合候选执行；你不接管产品修复或REQ06。
