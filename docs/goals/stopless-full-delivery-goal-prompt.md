/goal
目标：交付可 review、可 commit、可 push 的完整 stopless 功能提交；停止设定、resume、budget/reset、用户可见输出都必须以 5555 线上验证闭环为完成标准。

实现文档：
docs/goals/stopless-full-delivery-plan.md
docs/goals/stopless-stop-condition-verification-plan.md

执行规范：
- 唯一路径：`HubRespChatProcess03Governed -> stop-message-core -> stop_message_auto CLI projection -> client exec_command -> submit_tool_outputs -> normal request chain`，禁止旧 followup/reenter 语义回流。
- 停止判定唯一 owner 只能在 Rust stop gate；TS 只保留薄壳和用户可见投影，删除错误早退和重复判定。
- `submit_tool_outputs` 恢复链必须保持完整 tool output / `function_call_output` 历史；禁止退化成“首轮 user-only 请求重放”。
- 禁止 fallback、schema sanitizer 假修复、provider 特例、历史 tool identity 恢复；错误必须落到唯一功能块物理修正。
- 用户可见输出只允许正文/markdown summary，不允许暴露 stop schema JSON；没有内容字段就不显示。

验证：
- stop-message-core Rust 定向测试。
- stopless TS/native/HTTP 黑盒定向测试，包含多轮 `submit_tool_outputs` 恢复历史完整性。
- rebuild + `routecodex restart --port 5555`。
- 5555 live probe：首轮 continue、恢复轮次再次 continue、第三轮历史不丢失、allow-stop、provided-schema budget exhausted、missing-schema 第 3 次 exhausted、reset、`needs_user_input=true`、`stream=true/false` 对照。

完成标准：
- `/v1/responses` 与 `/v1/responses.submit_tool_outputs` 都能正确重复触发或结束 stopless。
- 多轮 `submit_tool_outputs` 恢复时 provider request 保留完整历史，不再出现“第三轮回到第一轮 stop schema”。
- schema 不再泄漏到任何用户可见 text/reasoning/summary。
- 停止预算与 reset 语义在线上和测试一致。
- 产出 review 完成的 stopless 提交并 push。
