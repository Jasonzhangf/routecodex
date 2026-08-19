/goal
目标：完成 V4 请求链插件，Server Input -> SSE In -> Responses Inbound -> Request ChatProcess -> VR 路由/模型替换 -> Outbound -> Compat -> Wire，Direct 与 Relay 都真实可跑。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v4-request-plugin-task-plan.md

执行规范：
- Server Input / SSE In / Responses Inbound 不检查 model；entry model admission 和 provider model replacement 由 VR 插件负责。
- 每个大节点拆成小插件：SSE frame、protocol normalize、tool governance、continuation restore、VR route/select/model replacement、semantic projection、compat、wire boundary。
- 控制/error/debug/metadata 不进入 normal payload；无 fallback、无 silent strip、无 admission handler 旁路。
- Direct 保持 Responses 同协议；Relay 只做相邻归一化与已登记 compat，未映射 fail-fast。
- provider 差异只在 provider runtime/compat owner；Hub Pipeline 不写 provider 特例。
- P0 禁止脚本批量语义替换；逐文件核实后用 apply_patch hunk。

验证：
- standard-plugins、runtime、cordis-bridge 定向测试与红测
- standard-plugin gate、node-graph、isolation、resource/function/mainline/verification maps
- 真实 Responses JSON/SSE live replay（Direct + Relay）
- DSH review（opencode-go/deepseek-v4-flash）语义 PASS

完成标准：
- 请求链 Node 01-07 插件完整、小插件可插拔、Direct/Relay 都有真实路径。
- VR 正确分离入口 model 与 provider wire model；server input 不检查 model。
- 无 mock、无旁路、无硬编码端口；DSH 无 P0/P1。
