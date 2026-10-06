# REQ02 namespace presence 最小纠正

工作树：/Volumes/Intel/playground/routecodex/req02-namespace-presence-20261003，fresh origin/main 75cab8267，父提供已验候选依赖。你不是独自工作；其他worker独占公开测试，禁止回滚、覆盖其他人的修改。只使用全新GCM，不resume/fork。

已复现：父公开consumer exit101，1pass/4fail，四协议未声明namespace被读成Some(Null)。首次偏差在字段库push_tool_declaration与record_history_pairing把Option None序列化为JSON null；typed parser随后get().cloned()。原合同要求字段presence无损，不能把“未声明”和“显式null”混淆，也不能仅filter null丢掉原始显式null。

唯一写入范围：runtime/src/operation_runner/operators/field_operator_library.rs（仅push_tool_declaration记录构造）、field_operator_records.rs（仅record_history_pairing记录构造）、新server/tests/req02_namespace_presence.rs、本树docs/goals/req02-namespace-presence-result-20261003.md。路径均在v3/crates/routecodex-v3-runtime或routecodex-v3-server下。typed资源/profile/graph/maps/注册表/其他产品与测试只读。不得扩大为命名转换或工具schema重写。

先以外部crate公开capture与normalize测试证明absent/null/string namespace在declaration和对应history的公开typed资源分别None/Some(Null)/Some(String)，原业务值/声明opaque精确保留；记录真实红退出。最小修记录构造：缺少值不插入namespace键，显式null照常插入。不要加补偿parser、fallback或语义拒绝，不解析工具参数。

验证命令：CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_namespace_presence -- --nocapture；同wrapper --test req02_public_normalization；同wrapper -p routecodex-v3-runtime --lib operation_runner -- --nocapture；git diff --check。每条单独执行并检查真实exit，无tail管道掩盖。日志在本树.execution，保持所有红失败。

完成iff：最小源码纠正、absence/null/string的公开外部consumer红绿、原5用例实际PASS与开发测试结果、精确source/test/profile hashes、结果文档落盘。遇见其他失败先报原错和首次偏差，不改外范围、不反复审计。没有HTTP/WS与实际工具执行不得称runtime或节点交付。不commit/merge/push/install/restart，完成窄任务后退出，父验收集成。
