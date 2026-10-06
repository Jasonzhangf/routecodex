# REQ02 成功attempt响应consumer定向作者修订

执行本树原独占任务的下一作者修订，先读docs/goals/req02-successful-response-author-corrections-20261003.md及原worker合同。原child已因父公开回归证明其相等检查违约而终止，代码/日志保留，未接线。不是观察超时重启，不是review。你不是独自工作，其他GCM负责Runtime生命周期和scope测试，禁止覆盖其文件。

独占worktree/branch：/Volumes/Intel/playground/routecodex/req02-successful-response-view-20261003，codex/req02-successful-response-view-20261003，HEAD688f7a1c6加原任务dirty候选/父只读依赖。全新codex exec --profile gcm，禁止resume/fork/父transcript/Collab/内置subagent。每命令显式workdir，apply_patch绝对路径，不批量语义替换，不reset/stash/restore。

允许产品写入：operation_runner/request_context_store.rs仅成功view及必要typed读取、operation_runner/mod.rs最小export；hub_v1/anthropic_codec/projection_context.rs、anthropic_codec_tool_projection.rs仅成功view消费及原身份恢复；responses_relay_runtime/provider_stream_materialization.rs和responses_relay_runtime.rs仅公共with_context薄委托与export，不改变SSE reducer或协议语义。自己的server/tests/req02_successful_response_view.rs可修夹具/补行为断言，不把真实emitted字段伪造为original；父server/tests/req02_successful_response_cross_kind.rs只读。其他产品尤其Runtime实际caller、REQ06、Provider、factory/lifecycle、field/profile/maps/graph全部只读。

完成原合同全部真实用例，重点修已确认的custom→flat function被错误拒绝，以及无namespace function改名未逆向恢复。响应身份必须由原声明与成功attempt真实映射驱动，不扫描参数/schema、不按模型/分隔符猜测、不只检查然后拒绝。两请求相同provider名称、原kind/namespace不同必须隔离；同请求失败attempt不可成为映射源；namespace缺省/null/string分别保持；call_id、完整exec/MCP对象及apply_patch自由文本保持。无映射未触及工具按既有合同透传。业务metadata/reasoning有明确数据面参数供既有codec使用，不静默丢失、不复制控制slots。不新增第二response mapper。

先运行父两项公开红以确认源输入，然后修根因；再JSON及真实Anthropic provider SSE events经同一materializer/context的公开绿。保留旧factory仅用于未迁移caller，不算完成接线；新业务context不能调用旧factory从governed tools重建映射。

测试命令分别直接重定向本树docs/goals/req02-response-correction-logs/日志，并让命令返回原始退出码，不用echo/tail/rg/tee掩盖退出：CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_successful_response_cross_kind -- --nocapture；同wrapper --test req02_successful_response_view -- --nocapture；-p routecodex-v3-runtime --lib operation_runner -- --nocapture；-p routecodex-v3-runtime --lib anthropic_codec -- --nocapture；git diff --check。若合法表示缺口超出以上路径，列确切接口和拟改并继续可做部分，不猜修复或伪造PASS。

完成iff：两父公开红→绿、原合同5类用例全绿、真实provider SSE而非client reframe消费typed成功映射、业务context保留且唯一owner、每命令原始退出码为0。docs/goals/req02-successful-response-correction-result-20261003.md写明源码/测试/profile hash、红绿/日志hash和未接线边界后退出。无commit/merge/push/install/restart，不碰4444，不停止他人测试或修改测试锁。
