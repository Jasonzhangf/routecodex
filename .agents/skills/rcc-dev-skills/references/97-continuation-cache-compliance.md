# 续写式转换合规（Continuation-Mode Conversion Compliance）

## When To Use
任何会修改 **占位符/历史载荷** 或 **请求/响应转换链** 的功能（历史图片清理、reasoning 透传、消息归一化、wire 序列化、continuation 恢复），以及任何涉及 provider 续写缓存（ds4 / deepseek prefix cache / anthropic cache_read）的验证。

## 硬规则（Jason 2026-08-08）
所有占位修改与流水线转换修改必须符合续写式转换要求：

> 请求 N+1 渲染给 provider 的字节序列必须是 [请求 N 渲染字节] + [assistant 回复] + [新轮次] 的**精确扩展**（token 级或渲染字节级），否则 provider 续写缓存永远 miss，每轮全量 prefill。

合规三要素：
1. **确定性**：转换链（客户端 input → canonical → provider wire）必须纯函数、无状态、同输入同输出。
2. **字节稳定**：同会话同位置的占位符/历史消息必须逐字节一致（如历史图片 `[Image]` 占位符，dry-run 双请求对比验证）。
3. **回传透传**：客户端回传的 assistant `reasoning`（完整推理）必须原样透传到 wire 的 `reasoning_content`，禁止裁剪/改写；resp 侧把完整 thinking 放进客户端 reasoning item，供下轮回传。

## ds4 缓存机制事实（antirez-ds4，ds4_server.c ~L11000）
解析顺序（任一命中即止）：
- `memory-token`：token 精确前缀，要求 `common == old_pos && prompt >= old_pos`
- `thinking-visible`：visible 文本字节前缀（thinking 回传场景；client 只回传 visible+reasoning 文本）
- `memory-text`：新 prompt 渲染字节 vs 解码 checkpoint 字节前缀比较
- `disk-text`：SHA1 渲染字节前缀（跨会话/重启恢复）
- 部分前缀（common < old_pos）一律 miss（`reason=token-mismatch`）。

DSML 渲染关键事实：
- assistant 带 reasoning：`<|Assistant|><think>推理</think>文本`
- assistant 不带 reasoning：`<|Assistant|></think>文本`（立即闭合）
- live checkpoint 含生成 thinking token → 续写请求**必须回传完整推理**，否则 thinking 边界字节失配 → 全路径 miss。
- **不带 reasoning 回传的续写测试 miss 是测试构造错误，不是网关缺陷。**

## 已实证证据（2026-08-08 live + ds4 trace）
- 历史图占位符同位置渲染字节逐字节一致（dry-run 对比 A/B 请求，仅当前轮不同）。
- 真实客户端（camo 4444 会话）续写每次命中 ~114k tokens（cache_source=memory-text）。
- 带 reasoning 回传的续写请求：`cache_source=thinking-visible, cached_tokens=125`（全量复用）。
- 不带 reasoning 回传：失配点 token 34 `<think>` vs `</think>`。
- go 网关（opencode.ai/zen/go）不暴露 prefix cache（恒 0），不可作缓存验证面。
- minimax anthropic wire：`cache_read_input_tokens=128`（同历史双请求均读缓存）。

## 本网关透传链（已确认合规）
responses input `reasoning` item → canonical chat `reasoning_content`
（responses_openai_codec.rs `build_v3_openai_chat_assistant_reasoning_message`）
→ openai_chat wire `reasoning_content`
（request_outbound_format.rs `normalize_openai_chat_messages_payload` 透传）
→ ds4 `<think>` 渲染 → 续写命中。

历史图片占位清理（hub_v1/history_image_cleanup.rs）为确定性纯函数，同位置永远同字节，不破坏续写前缀。

## 验证清单
1. 占位符/转换修改：dry-run 对比两请求 wire，历史前缀必须逐字节一致。
2. 续写测试必须构造：[H + U1] → 捕获 reasoning + text → [H + U1 + reasoning + assistant(text) + U2]。
3. 命中判定：ds4 `--trace` 的 `--- cache decision ---` 块 `cache_source != none`；go 网关看 usage 缓存字段（恒 0 属上游限制）。
4. 失配定位：trace 的 `first_mismatch_token` + `token_window`（live vs prompt token 对比）。
