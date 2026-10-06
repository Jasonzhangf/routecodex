# 图片处理点与已审canonical consumer窄闭环

全新GCM在本任务独占树/Volumes/Intel/playground/routecodex/req02-chat-image-owner-20261003继续；前53949的父核实PID19838后TERM，当前尚无本切片产品/test diff，不称已完成。你不是独自工作，不改其他worker路径。父R2合同已准入：旧builder仅封装新Operator结果、Inbound不改图片，Chat Process是唯一Relay治理点。

前任务卡在真实API缺口：SDK归一化已输出canonical，但现有Hub Req02没有公开canonical consumer；Anthropic路径还会重跑旧codec。不要重复审计、把Hub旧归一化冒称SDK、假写entryProtocol=Chat绕过、开放私有字段仅供测试，或让测试恢复raw再重跑旧normalizer。

可写只限：hub_v1/req_inbound_02_normalized.rs、req_chat_process_04_governed.rs、新server/tests/req02_chat_history_images.rs、本树结果/笔记。允许在Req02文件增加已审真正canonical consumer：build_v3_hub_req_inbound_02_from_canonical(input: V3HubReqInbound01ClientRaw, canonical: Value) -> V3HubReqInbound02Normalized。直接将当前canonical交给previous.payload，不运行任何codec/字段walker，不根据messages/contents或model猜分支、不校验拒绝payload；保持input中的原entryProtocol、invocationSource和transportIntent。semantic_protocol为统一Chat；原有canonicalized_from_responses是旧消费flag，仅在这个统一canonical入口置true，表示下游按canonical Chat处理工具结果，不能依协议猜。此flag当前只在relay_request.rs选择Chat工具结果治理；该调用点后续父统一切换。新constructor是真实生产consumer边界，父后续实际Relay caller将调用，不是test accessor。

移除旧ReqInbound02里的历史图片清理调用，保持旧协议normalization分支暂由父后续caller切换时删除；在唯一ReqChatProcess04入口调用已有normalize_v3_history_image_placeholders一次。其余重复实现不新增；不改只读history_image_cleanup/helper、field库/profile、nodes、Runtime orchestration、Server、REQ06或maps。

直接写公开测试：四原协议原始请求进入execute_v3_operation_runner_request_normalize_losslessly，取得canonical和同handle原pair；构造保留原entryProtocol的Hub输入，交新canonical constructor，再经公开Chat Process和现有公开数据consumer读取外部payload。证明constructor不清历史图片/不二次归一；Chat Process历史图片占位、当前轮完整、exec/apply_patch/MCP参数/普通工具结果及未知siblings不变，原请求和typed pair不变。先运行新test取得真实行为红，然后实现小diff；新API缺失编译红单独记录，不称行为红。

分别执行CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_chat_history_images -- --nocapture；-p routecodex-v3-runtime --lib history_image -- --nocapture；-p routecodex-v3-runtime --lib req_inbound_02 -- --nocapture；git diff --check。每command显式workdir，独立.execution日志与actual exit。若确切canonical media不被只读helper支持，立即写首个失败与最小拟改到本树docs/goals/req02-chat-image-owner-blocker-20261003.md，不多轮重复找相同代码；父协调其唯一owner。

完成iff：canonical constructor实际消费SDK输出、唯一Chat清理接入/Inbound清理删除、四协议公开consumer及受影响测试实回执、源/test/profile哈希与结果写docs/goals/req02-chat-image-owner-result-20261003.md。完成立即退出；未证明HTTP/WS或工具全回合，不claim节点交付。无commit/merge/push/install/restart。不联网、不读全样本树、不清他人资源。
