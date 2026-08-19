/goal
目标：完成 V4 响应链插件，Provider SSE In -> Response Inbound -> Response ChatProcess -> Client Semantic -> SSE Out -> Client Frame，并收口 continuation 控制面，Direct 与 Relay 都真实可跑。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v4-response-plugin-task-plan.md

执行规范：
- 响应链每个大节点拆成小插件：frame parse、protocol decode、response governance、tool harvest、continuation commit、client semantic projection、SSE frame、client frame。
- continuation save 只在 RespChatProcess，restore 只在下一轮 ReqChatProcess；不可变区禁止 handler/SSE/outbound/transport 补偿。
- 控制/error/debug/metadata 不进入 normal payload；无 fallback、无 silent strip。
- 禁止 provider SSE 直接 pipe 到 client SSE；SSE 已提交后错误显式 `event:error`，禁止 silent EOF。
- Direct 保持 Responses 同协议；Relay 从目标 provider 原始响应相邻归一化后投影到客户端入口协议。
- P0 禁止脚本批量语义替换；逐文件核实后用 apply_patch hunk。

验证：
- standard-plugins、runtime、cordis-bridge 定向测试与红测
- response inbound/outbound、response chat-process、continuation control L2
- standard-plugin gate、node-graph、plane/capability isolation、relay continuation、responses direct compat
- 真实 Responses JSON/SSE、continuation、错误响应 live replay（Direct + Relay）
- DSH review（opencode-go/deepseek-v4-flash）语义 PASS

完成标准：
- 响应链 Node 01-06 插件完整、小插件可插拔、Direct/Relay 都有真实路径。
- continuation 生命周期只在响应/请求 ChatProcess 保存恢复；不可变区无语义修改。
- 无 mock、无旁路、无 silent EOF、无控制面入 payload；DSH 无 P0/P1。
