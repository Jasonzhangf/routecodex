# REQ02 成功attempt响应候选定点消融

你是本任务GCM作者，不是reviewer。你不是独自工作：其他执行者在独占identity树修改Runtime生命周期，父编排负责集成；不得覆盖其改动。原响应作者已经真实退出0，其原始结果已保存，不是因为观察超时重启。此任务只完成同一活动候选的两处最小消融及定向验证，不重复全仓审计。

独占工作树：`/Volumes/Intel/playground/routecodex/req02-successful-response-view-20261003`；branch `codex/req02-successful-response-view-20261003`；HEAD `688f7a1c6a15ecf45dfee12cc430148ae3c03898` + 本任务dirty候选。先读本树AGENTS.md及已有 `docs/goals/req02-successful-response-correction-result-20261003.md`。每命令显式绝对workdir，apply_patch绝对文件路径。只传本任务合同，不resume/fork/使用父transcript/Collab/内置subagent；不reset/stash/restore、不语义批量替换。

允许写入仅：
- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec/projection_context.rs` 中新增 `from_successful_attempt_with_business_context` constructor的冗余legacy map回填。
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs` 中新增而无consumer的Responses-only with_context包装。
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs` 对应export。
- 本任务新增结果文档和独占日志目录。
所有其余产品、测试、maps、graph、REQ06、factory/lifecycle只读；不得削弱测试或改真实original/emitted夹具。

任务：
1. 新successful-attempt constructor已有单一 `successful_attempt_tool_identities`，其投影consumer优先使用该map；删除它重复填充的custom/namespaced/mcp三legacy map局部变量和match逻辑，初始化legacy三字段为空。保留原 `from_chat_canonical_request` factory及其真实legacy callers，不扩范围。保留业务metadata/reasoning参数、原recordId到实际emitted name的身份关联及namespace缺省/null/string区别。不加入相等校验、拒绝层或第二mapper。
2. 核对 `materialize_v3_responses_provider_sse_as_canonical_response_with_context` 无真实consumer后删除该新增包装及export。保留通用protocol `materialize_v3_provider_sse_as_canonical_response_with_context` 委托既有materializer；不改SSE reducer/协议语义。
3. 每条验证命令独立执行，直接重定向到本树 `docs/goals/req02-response-ablation-logs/` 对应日志，保留真实退出码，不用尾命令/管道掩盖：
   - `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_successful_response_cross_kind -- --nocapture`，期望exit0、2PASS。
   - 同wrapper `-p routecodex-v3-server --test req02_successful_response_view -- --nocapture`，期望exit0、6PASS，含真实provider SSE consumer。
   - 同wrapper `-p routecodex-v3-runtime --lib anthropic_codec -- --nocapture`，期望exit0、所有适用用例PASS。
   - 同wrapper `-p routecodex-v3-runtime --lib operation_runner -- --nocapture`，期望exit0、51PASS。
   - `git diff --check`，期望exit0。

完成iff：上述冗余物理删除、业务行为保持、全部指定命令实际exit0、原测试未改。落盘 `docs/goals/req02-successful-response-ablation-result-20261003.md`，包含删除项/唯一owner、每命令退出码与用例数、源码/测试/profile/日志SHA256、未接线边界，然后退出。失败先修唯一owner，保留原始错误，不伪造PASS。

禁止commit/merge/push/install/restart/触4444，禁止停止任何其他进程或改变测试锁。所有产物由父编排验收并逐文件组合；本结果不证明REQ02生产交付。
