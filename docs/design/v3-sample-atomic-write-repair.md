# S21 sample evidence atomic replacement

Issue121134d；唯一owner routecodex-v3-debug::V3CodexSampleStore::persist in sample_store.rs。资源v3.debug.codex_sample_filesystem；复用现有graph docs/architecture/dags/v3.codex_sample_persistence.graph.json，不新建同义sample持久化图。保留现有admit→drain→persist单源单汇，修persist内部原地截断的缺口。

公开persist已存在，先锁filesystem并完成provider attempt merge，再以本owner独有0600同目录temp写完整JSON，以BufWriter批量写入；显式flush完成后rename替换目标，保持原有持久化契约。原契约只要求flush，不新增sync_all、断电持久化或其他未声明保证。旧完整文件在rename前不变。错误显式返回原有Result<String>，temp通过唯一cleanup回收，cleanup失败明确包含路径及原因，不当空对象覆盖损坏JSON。并发继续复用filesystem lock，不新增业务锁或并行writer。

状态：持锁合并→写自有temp→完成原子替换或明确失败并清temp→返回persist结果。成功/输入损坏/序列化/写/rename失败/取消或进程退出分别有证据终点；崩溃遗留temp的清理只在本sample owner锁及已证明stale temp身份下处理，不能扫删除未知文件。现有100请求retention和snapshot授权保持。内部保存失败不能变成模型客户端错误响应或伪造成功。

公开consumer：debug/tests/sample_store_atomic_persistence.rs，通过公开persist与真实filesystem读取验证；连续同request providerattempt merge、普通完整JSON、损坏旧输入明确失败、replacement失败旧文件完整与ownedtemp回收。部分写故障能力已确认：独占sh helper设置`ulimit -f 1`并忽略XFSZ，真实dd写4096bytes在1024bytes后返回File too large/exit1；证据s21-fsize-capability.log，测试tmp已移除。新公开test child在该OS限制下调用公开persist，注入大JSON，断言明确失败且旧完整文件字节不变；不能用写前权限失败冒充部分写，也不加产品fault flag或新libc依赖。命令：CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=2 node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-debug --test sample_store_atomic_persistence -- --test-threads=1 --nocapture。新产品回归尚未写/执行，先红再改产品。

除sample_store.rs和该公开consumer，本项不改debug sink S15、snapshot预算 S05、configrevision S20、observability S22。所需map/gate仅本feature。父负责独立设计及实现后架构review、主链组合、适用live证据与逐项PR集成。
