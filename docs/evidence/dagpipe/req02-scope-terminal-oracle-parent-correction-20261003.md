# REQ02真实Runtime scope作者验收：终态oracle纠正

原scope作者任务29228真实exit0/turn.completed；其编译exit0、行为exit101，2PASS/3FAIL。作者原文与原日志保留：`req02-scope-runtime-consumer-author-result-20261003.md`、`.execution/scope-real-consumer-author-final-r1.log`，原测试保留`.execution/req02_scope_runtime_consumer-author-r1.rs`。原文中“客户端400被投影502”的结论不能由其测试证明。

父核对实际consumer边：`server/src/responses_direct_server_outcome.rs::execute_responses_direct_server_outcome`先取`output.terminal_disposition`，返回ProviderTerminal；此路径不提交临时`client_payload`。对应`kernel/direct_runtime_helpers_stream.rs::target_exhausted_output_with_observability`已保留真实ExternalHttp witness。原公开Runtime输出同样记录`Some(ExternalHttp(400))`。因此scope边界正确oracle是typed witness及资源终点；真正客户端状态另由实际Server入口验收。

父只修改已结束测试任务的Direct error oracle：保留HTTP peer真实400，检查ExternalHttp witness.status()==400，并仍断言output消费/Drop后scope Released，control clone仍存活。没有改产品、释放断言或Error政策。其他四个用例不变。

命令：`CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_scope_runtime_consumer -- --nocapture`，workdir=`/Volumes/Intel/playground/routecodex/req02-scope-consumer-regressions-20261003`，HEAD688f7a1c6+identity只读snapshot。

父实际原始退出码101，2PASS/3FAIL：

- Direct JSON output Drop：PASS。
- 可达Relay→Direct handoff同scope：PASS。
- Relay SSE EOF保持control clone：Active，预期Released，FAIL。
- Relay pending upstream取消保持control clone：Active，预期Released，FAIL。
- Direct error真实ExternalHttp witness400：已保留；output Drop后Active，预期Released，FAIL。

日志：`.execution/scope-real-consumer-parent-terminal-oracle-red.log`。测试最终快照已交identity作者修订worker，只读，不得修改测试造绿。以上证明的是候选Runtime生命周期缺口；不证明共享runtime有新400/502回归，不是HTTP/WS端到端验收。
