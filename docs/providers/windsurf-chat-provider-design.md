# Windsurf Chat Provider 设计

## 唯一真相
- request：`chat -> windsurf-chat-provider -> cascade`
- response：`cascade -> windsurf-chat-provider(chat) -> hubpipeline`
- 本地只允许一个实现文件：`src/providers/core/runtime/windsurf-chat-provider.ts`
- 参考锚点只允许：`/Volumes/extension/code/WindsurfAPI`
- 2026-05-22 最黑盒结论已确认：`GetChatCompletions` 不是当前 Windsurf 真发送主链；必须物理移除，只保留 `StartCascade -> SendUserCascadeMessage -> GetCascadeTrajectorySteps/poll`

## 职责边界
### Provider 负责
- 接收 OpenAI chat 语义输入
- 映射为 cascade 的消息、工具、工具结果、历史连续性
- 发送 cascade 请求（唯一允许：`StartCascade -> SendUserCascadeMessage`）
- 解析 cascade assistant / tool call / tool result
- 收口为 OpenAI chat 输出

### Provider 不负责
- 不重建 hubpipeline 语义
- 不引入第二套本地实现
- 不引入 fallback / 双路径 / 假挡板
- 不保留任何与 Windsurf 旧链路相关的实现或文档叙事
- 不保留 `GetChatCompletions` / `chatMessagePrompts` / `completionsRequest` 旧 JSON 主链

## 真源文件
- `src/providers/core/runtime/windsurf-chat-provider.ts`
- `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`
- `tests/providers/core/runtime/windsurf-chat-provider.live-probe-api.spec.ts`

## 测试锚点
1. 先补红测，再改实现，再转绿。
2. 工具、工具结果、多轮历史只对齐 `/Volumes/extension/code/WindsurfAPI`。
3. 必测：
   - auth 成功
   - assistant tool call
   - tool result
   - 多轮 continuity
   - 空内容 / 重复 tool call / orphan tool result fail-fast

## 当前原则
- 只继续推进 pure cascade 主线。
- 文档、测试、实现都必须围绕 `chat -> provider -> cascade` 收敛。
- 旧 `GetChatCompletions` 主链只允许作为删除前取证材料出现，不允许继续作为“待修主链”存在。
