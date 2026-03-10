# SSE 模块路线图（不接入主链路阶段）

近期目标（最小修复）
1) 修复已知 bug：chat-json-to-sse-converter.ts 中 completeStream/abortStream 对 stream 的作用域引用错误（传参或存入 context）。
2) 提供事件→SSE 文本的序列化适配器（Chat/Responses 各一套），解耦内部事件与 wire 帧。
3) 实现 Responses JSON→SSE：严格生成 response.*（含 required_action 与 response.done）。
4) 实现 Responses SSE→JSON：状态机聚合 response.*，校验 sequence_number 单调与生命周期合法。
5) 增加回环测试脚本与黄金样例对拍（install verify 第二关）。

中期目标（对齐 v2 行为）
- 参数化粒度/时序/心跳，达到与 v2 行为一致；
- 错误模型/快照序列化统一，避免循环引用；
- 聚合器内存/背压优化。

远期目标（扩展）
- 支持更多协议适配器（anthropic/gemini 等）；
- 与主流水线集成（SSEOutputNode 改用新模块 + feature flag 切换）。

验收门槛
- 回环测试全绿；
- 对拍黄金样例弱等价；
- 基准性能与资源占用在阈值内。
