# Fix Design Report: opencode-go 502（2026-08-12 confirmed）

## Status

旧“删除历史图片清洗”方案作废。`[REDACTED] -> JSON Schema true` 方案同样
作废。按 Jason 约束，历史图片最小兼容改写是预期行为，不是根因。

当前 design id：`fix:v3.responses_direct_provider_header_deadline`
状态：首响应 deadline 根因已确认；Jason 已批准延长 deadline，正式实现已落地并完成在线复放。

## Root cause direction

502 触发点是原始历史图片仍进入 provider-bound request，不是 `[Image]`
占位符。当前缺少的是 save/restore 的闭环不变量：

- Resp04 save：continuation 中不得保存任何原始 image carrier，只允许
  确定性占位符。
- Req04 restore：恢复上下文必须先做历史清理，tool-only / 无 user carrier
  的纯工具轮也必须全量清理。
- provider outbound：非多模态或不支持历史图片的目标在发送前若仍存在
  原始 image carrier，必须 fail-fast，不能在 outbound 再补清理。

之前反复修复是在每个已观察漏网形态上继续加清洗覆盖；缺少一个
“provider-bound 无原始历史图片”的红测/门禁，所以新形态仍会漏。

## Evidence status

原始 502 sample（`...102147963-751892-2971`）已被 retention 轮出。
playground 现有样本中的 `data:image` 字符串是 sed 命令文本，不是真实
图片载体，不能作为“改写导致 502”的证据。正式定位前必须重新采集真实
502 样本，比较 `request.json` 与 `provider-request.json`。

## Next step

1. 保留一个新的 opencode-go 502 样本，不等到 retention 轮出。
2. 用结构化扫描找出 provider request 中第一个真实 image carrier。
3. 回链到 save/restore/standardized owner，写最小红测后再改唯一真源。
4. 正式修复仍需 Jason 批准 design 后执行。

## 2026-08-12 根因纠偏（覆盖上文旧方向）

当前 design id：`fix:v3.responses_direct_provider_header_deadline`。

真实样本 `openai-responses-router-gpt-5.5-20260812T135742081-755456-6535`
证明：opencode-go key1、key2 都实际请求了
`https://opencode.ai/zen/go/v1/chat/completions`，model
`deepseek-v4-flash`，97 messages、14 tools、约 393KB；两次都在 V3
Responses Direct 固定 15 秒 deadline 内没有返回 headers，随后被转成 502
并切到 MiniMax。

`/Volumes/extension/.rcc/provider/opencode-go/config.v2.toml` 的 provider
timeout 是 `300000ms`。`transport.rs` 已消费该 target timeout，但
`kernel.rs` 又用 `V3_RESPONSES_DIRECT_TRANSPORT_RESPONSE_TIMEOUT=15s`
包住 `transport.send`，形成更短的实际 deadline。唯一 owner 是
`v3/crates/routecodex-v3-runtime/src/kernel.rs`；不是 provider/model/key
选择错误。

正式设计：把 response-header deadline 改为已编译 manifest/provider target
的通用 transport 参数；错误继续进入 Error 链、health、reselection；不改
payload，不在 handler/SSE/router 补偿，不新增 provider-specific runtime
分支。先红后绿：fake transport 延迟超过 15 秒但低于声明 deadline 应成功；
超过声明 deadline 应进入既有 transport error。

Jason 已批准当前 design id。正式实现将 Direct 与 Relay 两条 provider transport wrapper 的固定 15 秒首响应 deadline 同步调整为 120 秒；provider request 自身仍保留 300 秒总 timeout。

## Jason Decision

Jason 已批准拉长判断窗口。当前实现值：Direct 与 Relay response-header
deadline 均由 15 秒改为 120 秒；provider target 的 300 秒总 timeout 保持不变。
