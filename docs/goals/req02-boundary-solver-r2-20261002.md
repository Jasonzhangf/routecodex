# REQ02 切换边界攻关

只读作者侧架构攻关，不是review，不输出PASS。你不是独自工作；不执行Collab、不写产品、不改Git/runtime。只通过最终stdout答复，父编排落盘并修合同。

已经确定且无需再次审计的事实：REQ01已生产接线；REQ02待实现。旧builder把Responses/Anthropic归一为messages + routecodex_chat_extension，Gemini仍留contents；Gemini Req04/旧投影读contents。Direct在kernel/v3_direct_core.rs的C::build_standardized(raw)保留native合同。Server metadata_center仅带plan；ExecutionControl仅带attempt budget。field库参考commit768a9565c归一输出messages+extension及inverse/history；已在隔离树实际编译，32个operation_runner tests中21pass/11fail，缺main尚未包含的direction_bindings/transform_id。另一个GCM任务正在补请求方向配置，不需你调查它。

阅读输入：`/Volumes/Intel/playground/routecodex/dagpipe-req02-consumer-20261002/docs/goals/req02-consumer-boundary-20261002.md`。这份GCM草稿选择复用routecodex_chat_extension，但未闭合具体consumer：说不改consumer，却将Gemini contents改成messages；要求全部四方向REQ06/response新walker才能交付REQ02；说Direct不调用REQ02，又说所有HTTP/WS模式进入同一个REQ02。这些冲突需要作者先解决，不交给reviewerdebug。

任务：明确一个最小合法方案，使REQ02实际替换并接线，同时其他节点暂用既有实现。不能“只有Relay接新REQ02/Direct旁路”、输出不用、影子检查、把raw恢复后重新调用旧normalizer，也不能等待全图新算子才能交付一个节点。Direct改写只能注册Direct hook，Relay改写只能Chat Process；Outbound/response仍由各自owner消费。协议差异只能配置。

只按需要定位下列真实接口：runtime/hub_v1/req_inbound_02_normalized.rs、relay_runtime_core.rs、responses_relay_runtime_inner.rs、gemini_codec.rs；runtime/kernel/v3_direct_core.rs；runtime/execution_control.rs；Server/metadata_center.rs。若必须确认某一Outbound/response符号，单一rg后读该函数；不要全库或历史扫描。

最终答复必须具体：
1. 选定的canonical表示与如何配置field库；列出与旧consumer真正不同的字段/形状，不要笼统说复用即可。
2. 一个节点交付所必需的consumer接口/helper/registered hook，具体source symbol与调用顺序；为什么不构成第二归一化/旁路/旧链复活。REQ06由外部任务独占operator文件，可要求最小helper API，不能抢它。
3. typed请求资源首次创建、真实requestId关联、原始inverse/history一次写入、retry/followup保持、响应消费及成功/error/cancel/drop释放的实际顺序。Server搬运opaque handle，Runtime拥有状态，不新建全局map。
4. 下一个GCM实现任务的精确文件和API，能直接写代码，不再给另一个审计任务。
5. 如果当前硬约束之间确实存在无法同时满足的依赖，指出具体边和最小必须调整的任务依赖，不能用虚假闭环或通用图代替。

输出是作者侧明确设计结论，不是review证据。直接回答上述决策；既有事实可复用，禁止重复全路径审计。
