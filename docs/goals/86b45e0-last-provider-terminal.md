# 最后候选失败终止

需求：routecodex-last-provider-failure-terminal-policy v1；取代旧五次等待策略。错误图保持 Error01→Error02→Error03→Error04→Error05→Error06 单源单汇。

Error03 先读取已捕获目标内的其他 request-eligible 未尝试候选。存在替代才允许失败身份的既有健康副作用和有限切换；没有替代时保留真实来源并终止本请求，不写失败健康、冷却、probe 或等待。Runtime 仅在图外创建下一 attempt。单候选的新业务请求不被旧自动冷却拦截，其他请求约束保持。

公开回归入口：`npm run test:v3-last-provider-policy`。稳定ID：`i86_single_stale_cooldown_bypass`、`i86_multi_next_candidate_success`、`i86_last_eligible_failure_is_terminal`、`i86_multi_last_eligible_stays_routable`、`i86_exhaustion_is_request_local`、`i86_relay_switch_and_last_terminal`。覆盖 Direct 与 Anthropic→Responses Relay。业务无效工具透传与配对后续由集成候选的既有真实工具往返回归验证，不虚构本文件不存在的测试。

本问题不实现端口 store 拆分；d9fd985 独占该责任。未安装、未交付，不以图校验代替运行行为。
