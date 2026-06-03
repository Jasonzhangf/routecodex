/goal
目标：为 RouteCodex stopless / stop_message followup 增加 Rust-only stop schema gate，形成允许停止、继续执行、预算耗尽 fail-fast 的简单闭环。

实现文档：
docs/goals/stopless-schema-gate-plan.md

执行规范：
- 唯一路径：HubRespChatProcess03Governed -> stop-message-core -> chat_servertool_orchestration -> normal Hub reenter。
- /goal active 与 plan mode 不激活：不 parse schema、不 followup、不计预算。
- 只解析当前 assistant stop 文本；禁止扫历史、改历史、清工具列表、provider 特例、TS 语义判断。
- 只校验数字字段 stopreason/has_evidence；文本字段只判空。
- budget 只统计连续 stop；任何非 stop 响应或工具调用/正常进展必须 reset budget。
- no fallback：预算耗尽或闭环失败必须显式 fail-fast。

验证：
- stop-message-core Rust 单元测试。
- router-hotpath-napi stop_message_auto 定向测试。
- npm run build:min。
- npm run install:global + routecodex restart --port 5555 + health。

完成标准：
- stopreason=0/1 + reason 可停止并 prefix summary。
- 缺 schema/缺 reason/缺 next_step/非数字 stopreason 都按错误生成 followup 或 fail-fast。
- 5555 运行新版本且工作区提交干净，未 push。
