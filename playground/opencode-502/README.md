# opencode-go 10000 502 根因实验

状态：2026-08-12 已确认首响应 deadline 根因；Jason 已批准并已落地 120 秒 Direct/Relay deadline，完成在线复放。当前独立暴露的是上游 400 schema 兼容错误。

最小兼容清洗是预期行为，不是根因：save 时改写历史图片、restore 时做
历史清理，避免原始历史图片进入非多模态/不支持历史图片的 provider。
502 只应由“原始历史图片仍被送到 provider”触发，不应由 `[Image]`
占位符触发。

旧证据 `evidence/request-114325523-753225-4304/` 里的 `data:image`
计数包含 sed 命令文本，不是真实图片载体；不能再当作“清洗破坏 payload”
的证据。

新证据：真实样本 `openai-responses-router-gpt-5.5-20260812T135742081-755456-6535`
的 `provider-request.json` 第 1、2 次尝试均为
`https://opencode.ai/zen/go/v1/chat/completions`、model
`deepseek-v4-flash`、97 messages、14 tools、约 393KB；两次都在 V3
Responses Direct 固定 15 秒 deadline 内没有返回 headers，随后被转成 502
并切到 MiniMax。opencode-go 配置自身 request timeout 是 300000ms，实际
生效的是 runtime `kernel.rs` 的 15 秒。

唯一 owner：`v3/crates/routecodex-v3-runtime/src/kernel.rs` 的
`V3_RESPONSES_DIRECT_TRANSPORT_RESPONSE_TIMEOUT`。

当前结论：runtime header deadline 与 provider configured timeout 不一致
导致误判，不是 provider/model/key 选择错误；正式设计必须把 header deadline
变成 manifest/provider target 的通用 transport 参数，保留显式上限和错误链，
不在 handler、router 或 payload 侧补偿。
