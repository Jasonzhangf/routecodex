# ToolThinking / Toolreason 投影差异

仅在真实工具参数中的 reason 与客户端 reasoning/正文不一致时读取。普通工具治理仍保留；它不依赖已退役的 RCC servertool、CLI descriptor、搜索 sidecar 或 Stopless。当前边界见[工具路由](../../../../docs/agent-routing/30-servertool-lifecycle-routing.md)。

## 先判断偏离位置

复用 [Pipe debug](10-pipedebug-flow.md) 的同请求四件套，不另建采证流程。

| 已有证据 | 下一步 |
|---|---|
| Provider raw 没有 reason | 检查请求声明或 Provider 行为；不能在响应端猜测或补值 |
| raw 有 reason，治理后缺失或工具损坏 | 对照当前注册的工具治理 owner、字段合同和完整响应消费证据 |
| 治理结果正确，客户端不可见 | 检查对应协议投影与事件生命周期 |

## 必要边界

- 按当前注册字段处理，不因可选辅助字段缺失拒绝合法工具，也不强制所有工具声明 reason 或 goal_alignment_confidence。
- 保留原工具身份、完整参数与 call/result 配对。缺 reason 不伪造 reasoning，不删除原工具调用。
- Relay 的改写归 Chat Process；Direct 的改写归注册 Direct hook。不得在 handler、SSE transport、Provider 或普通 Outbound 新建 parser/projector。
- 响应 dry-run 使用捕获的完整 raw JSON/SSE，证明已消费并生成客户端结果。node trace、请求 dry-run 或未消费的 lazy stream 不替代响应证据；具体入口沿 Pipe debug。
- Responses 文本投影须具有合法 message/content/delta/done 生命周期；Anthropic 使用标准 text block。只验证受影响协议；Direct 与 Relay 同时受影响时分别取证。
- RCC 合成的 reasoning/toolreason 文本不能冒充 Provider 源显式 summary，不能据此结束 bounded refill。来源判断沿当前整合设计，不在本参考另设策略。

## 验收

覆盖本次变化中的 reason 存在/缺失、工具可执行性和客户端投影；复用稳定反例。间歇问题按任务计划采样，保留用户明确轮次，不默认固定五轮。真实入口验收、运行加载和 Review 沿主 Skill，只执行一次适用流程。
