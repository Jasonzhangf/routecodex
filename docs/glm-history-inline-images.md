# GLM 4.7 历史消息中的 inline 图片兼容说明

## 背景

在 `glm-4.7` 上游接口下，历史消息（history）中携带 `data:image/...` 形式的 inline base64 图片内容，在上下文较长时会触发 HTTP 400 / 错误码 `1210`（“API 调用参数有误，请检查文档。”），即使当前轮请求本身是合法的。

本地调试（基于 snapshot 回放和 payload 二分）确认：

- 只保留首条 `system` + 当前轮最后一条 `user` 时可以正常返回 200；
- 从最早历史开始累积，当累积到某条 **带有 `type=image|image_url|input_image` 且 URL 以 `data:image` 开头** 的 `user` 历史消息时，首次出现 400 / `1210`。

## RouteCodex 侧兼容策略

为避免这类错误，RouteCodex 在 `chat:glm` 兼容配置中增加了专门的裁剪动作：

- Action：`glm_history_image_trim`
- 实现位置：`sharedmodule/llmswitch-core/src/conversion/compat/actions/glm-history-image-trim.ts`

兼容策略规则：

- 仅在以下条件同时满足时生效：
  - 请求 `protocol` 为 `openai-chat`；
  - `compatibilityProfile` 为 `chat:glm`；
  - `model` 以 `glm-4.7` 开头。
- 遍历 `messages`：
  - 找到最后一条 `role: "user"` 的消息，视为当前轮请求；
  - 对这条之前的所有 `user` 历史消息：
    - 如果 `content` 中存在 `type ∈ { "image", "image_url", "input_image" }` 且 URL/数据以 `data:image` 开头的片段：
      - 从该条 `content` 中丢弃这些 inline image 片段；
    - 如果丢弃后该条消息不再包含任何内容（即之前是“纯图片历史”）：
      - 直接移除整条历史消息。
- 当前轮最后一条 `user` 消息（通常是用户最新问题）不会被该规则修改。

## 对调用方的影响

- 对于通过 RouteCodex 调用 `glm-4.7` 的业务方：
  - 历史对话中包含 inline base64 图片时，RouteCodex 会在发送到上游之前自动裁剪掉这些历史图片内容；
  - 当前轮用户输入中携带的图片内容不会被该规则移除。
- 这样可以：
  - 避免由于历史中的 `data:image/...` 导致的 400 / `1210` 错误；
  - 保持当前轮请求的图片能力正常可用。

如果需要完整重现原始 payload（包括被裁剪掉的 inline 图片），可以使用 snapshot 调试工具直接回放 provider 前的快照，而不是依赖线上请求路径。

