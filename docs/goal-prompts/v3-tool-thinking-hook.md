/goal

目标：按 [v3-tool-thinking-hook-plan.md](../goals/v3-tool-thinking-hook-plan.md) 完成 `tool_thinking_json_v2` 设计迁移后的实现；辅助字段进入非 Gemini 工具参数 schema，模型输出后由 Resp03 剥离。

执行顺序：

- 以 `docs/goals/v3-tool-thinking-hook-plan.md` 为唯一合同真源；工具参数 JSON 增加 `reason`、`goal_alignment_confidence`、`model_id`，不再把 fence 当主合同。
- 先同步 function map、mainline call map、verification map、fixtures 和本提示词，清理旧 fence 主合同；保留 fence 仅作明确的 legacy compatibility fixture。
- 设计 gate 通过后，才写 Req04 JSON guidance、共享 Resp03 JSON extractor/stripper、one-turn aggregator、reasoning_content projector。
- 原始工具名、call id 和普通 arguments/input/args 字段必须保持不变；缺失、错位、错误类型不阻断工具调用，不制造 400/502。
- Direct 和 Relay 使用同一语义 extractor；SSE/handler/provider codec 不得成为 tool-reason owner。
- 先 red fixture，再定向 Rust 测试、架构 gates、构建、全局安装、managed restart、真实 Codex samples 和 provider raw snapshots；无在线证据不得宣称完成。

验收：每个真实工具调用必须有 `JSON OK/MISSING/INVALID/MISPLACED` 之一；客户端投影单独有 `PROJECTED` 证据；每个 turn 最多一个 synthesized `reasoning_content`；客户端不见辅助字段、旧 fence、内部状态；不破坏原始工具调用。

禁止：继续新增 fence prompt/parser/metric；请求侧清洗；改变普通命令参数语义；按 console `OK` 冒充客户端已投影；在 provider 或 SSE 层补第二套解析。
