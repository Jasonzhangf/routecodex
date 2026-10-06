# REQ02 consumer 合同定稿 R3

独占工作树 `/Volumes/Intel/playground/routecodex/dagpipe-req02-consumer-20261002`，只允许写 `docs/goals/req02-consumer-boundary-20261002.md`。你不是独自工作，不改产品代码，不执行 Collab/身份/main/worktree audit，不声称 review PASS。

执行边界：每个command显式workdir为上面的绝对工作树，或先cd该树；apply_patch使用该树绝对路径。首次pwd必须等于该树；任务合同之外不能在cutover工作树读写。当前默认cwd不可靠。

已确认事实：REQ02旧builder输出Chat + routecodex_chat_extension；Gemini仍保留contents，Req04和标准投影读取它。新field library输出messages+extension，不能直接灌给旧consumer。V3RequestExecutionControl仅持有attempt budget；Server metadata_center只携带plan。当前响应工具context从governed payload建立，无原始请求inverse consumer。原始请求identity不在Req01 wrapper；不能以自动生成graph execution id代替真实requestId。

任务：用以上事实给出最小合法的REQ02替代合同，不再全库审计。只读下列文件以核对必要边：runtime hub_v1/{req_inbound_01_client_raw.rs,req_inbound_02_normalized.rs,relay_runtime_core.rs,responses_relay_runtime_inner.rs,req_chat_process_04_governed.rs}，execution_control.rs，kernel/v3_direct_core.rs，Server metadata_center.rs；必要时rg单一符号caller。不超过本范围。已有主设计和resource map可定位具体REQ02节，不整份重读。

产物必须明确：
1. 新canonical与旧consumer逐项schema差异、每一项唯一owner；不存在“先恢复raw再跑旧normalizer”的路径。
2. 通过registered字段配置复用现有canonical表示还是改造consumer表示，给出明确选择和最小原因；不能提出两套候选让父编排猜。Gemini不是单独旁路。
3. Runtime-owned typed request resource借Server metadata carrier和existing execution control跨attempt传递，无第二全局map；同一次请求inverse/history不可被retry/followup重建。明确公开API、实际调用点和cancel/drop终点。
4. Outbound与响应owner如何消费新映射和unknown字段；列出REQ06另任务只需提供的最小接口，绝不抢它的文件。若某项必须在本节点修改consumer，明确文件范围与依赖理由。
5. 最小成功、失败、取消、断连测试入口与命令，说明Direct保持native语义及registered hook边界，HTTP/WS均接到唯一REQ02。

立即落盘结构化结论、source anchors和下一实施任务；现有分析足够时不要继续遍历。只需完成这份明确合同，父编排负责图修订与独立review。
