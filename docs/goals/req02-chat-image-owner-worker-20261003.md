# REQ02图片历史清理迁到唯一Chat Process处理点

独占树：/Volumes/Intel/playground/routecodex/req02-chat-image-owner-20261003，fresh origin/main75cab8267，父提供已审归一化依赖。你不是独自工作，另一worker改request factory、Server和Runtime orchestration；不得覆盖其文件。全新GCM、无resume/fork/父transcript、不用内置subagent/Collab。

设计已准入docs/design/v3-req02-cutover-consumer-contract.md明确图片政策从Inbound迁到Chat Process，当前任务只完成这一条已审行为边，不迁整个REQ05。唯一可写：hub_v1/req_inbound_02_normalized.rs只移除历史图片清理调用，不改现有协议归一化分支；hub_v1/req_chat_process_04_governed.rs在唯一实际Chat治理入口调用既有normalize_v3_history_image_placeholders；新增server/tests/req02_chat_history_images.rs；本树结果和节点笔记。history_image_cleanup.rs、field库/profile、nodes.rs、Runtime/kernel/Server、REQ06、maps/graph只读。

当前helper已处理messages历史图片、工具结果JSON字符串和input/contents原生形状。复用唯一helper，不复制规则、不新增按协议/model猜测分支。Inbound必须保持原始payload意义和图片，不清理；Chat Process按当前政策只清历史、保留最后user当前图片及无关siblings、完整exec/apply_patch/MCP参数和普通结果，控制资源inverse/history不变。不按工具参数猜身份、不改工具arguments或自由文本、不引入local continuation。

公开黑盒：实际REQ02 SDK归一化四协议client JSON→公开Hub ReqInbound→公开Chat Process→公开data-plane输出。归一化后图片原值仍在；Chat Process输出历史图片占位、当前图片完整、工具参数/非图片结果不变、source request不变。同一输入再过历史清理输出稳定；不以mock/helper直接调用代替公开consumer。若公开payload accessor缺少可用边界，使用现有公开Outbound consumer输出，不为了测试开放私有状态。先写测试并记录真实红，分别运行CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_chat_history_images -- --nocapture；-p routecodex-v3-runtime --lib history_image -- --nocapture；-p routecodex-v3-runtime --lib req_inbound_02 -- --nocapture；git diff --check，独立日志与真实退出码。

若helper不能处理已审canonical media形状，记录唯一实际偏差与最小拟改，不偷偷改只读helper/伪造expected；父负责协调其已有owner和必要binding。nodes.rs里的旧Direct清理调用由父后续切换registered Direct hook时删除，不由你并发写。完成iff：本范围Inbound清理删除、Chat处理点实际消费一次、公开四协议及成功/保留行为红绿、源/test/hash/结果落盘docs/goals/req02-chat-image-owner-result-20261003.md。只能报告该行为切片，不声称REQ02整体接线；不commit/merge/push/install/restart，完成后退出。
