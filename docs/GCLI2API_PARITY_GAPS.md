# gcli2api 对齐缺口（RouteCodex / llmswitch-core）

日期：2026-01-22

本文用于把 `gcli2api`（Python）里已验证过的“兼容/风控”经验点，和 RouteCodex V2 的单一路径架构做一次对齐盘点：

`HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream AI`

目标是：不在 Host/Provider 做语义修复、不绕过 Hub Pipeline，缺口优先落到 `llmswitch-core` 的 conversion/compat 层，或通过 `ProviderQuotaView`/健康度机制落到路由层。

---

## 1) gcli2api 最新关键行为（与本仓库相关）

### 1.1 thoughtSignature 的“往返保留”

`gcli2api` 在把 Gemini/Antigravity 的 `functionCall` 变成 OpenAI 工具调用时，会把 `thoughtSignature` 编码进 `tool_call_id`（分隔符 `__thought__`），随后在 OpenAI→Gemini 的方向再解码出来：

- 目的：有些客户端（尤其是工具链/SDK）会丢弃 OpenAI tool_call 上的“非标准字段”（例如 `thought_signature` 或 `extra_content`），导致二次回传时无法恢复签名，从而触发上游校验失败。
- 策略：有签名则编码到 ID；没有签名则仍能正常工作（回落到 dummy/skip 签名）。

### 1.2 thinking 块签名校验与清理

`gcli2api` 对历史消息里的 thinking 块做：

- `MIN_SIGNATURE_LENGTH = 10`
- 无效签名：有内容则降级为 text；空内容则丢弃
- 额外：移除尾部未签名 thinking

（本仓库已在 llmswitch-core 增加对应 validator，但“ID 编码保留”目前未实现。）

### 1.3 Antigravity 429 处理（倾向于“先自救、再失败”）

`gcli2api` 在 Antigravity 上游返回 429/禁用码时：

- 记录错误与冷却
- 在允许范围内重试，并在重试前预热下一凭证（不阻塞）
- 达到最大重试或不可重试才把原始错误回给客户端

此处的核心思想是：**不要把可恢复的短暂上游容量波动过早暴露给客户端**（尤其是 Codex CLI 对 429 处理会“直接中断”）。

---

## 2) 当前 RouteCodex/llmswitch-core 对应现状

### 2.1 已覆盖点

- `llmswitch-core/src/conversion/shared/thought-signature-validator.ts`：thinking 块签名校验/清理（与 gcli2api 的逻辑一致）
- Gemini ↔ OpenAI 转换中已存在 `skip_thought_signature_validator` dummy 签名兜底（用于满足上游结构要求）

### 2.2 仍缺口点（需要补齐/确认）

#### A) thoughtSignature 的“tool_call_id 编码保留”缺失

当前 llmswitch-core 在 OpenAI tool_call 上会尝试携带 `thought_signature` / `extra_content.google`，但**如果客户端丢弃这些字段**，下一轮回传后就只能回落到 dummy 签名；在部分上游/模式下可能会触发兼容问题。

建议引入与 gcli2api 相同的 **可配置** 编码策略：

- 编码：`<id>__thought__<signature>`
- 解码：按分隔符 split 一次
- 仅在“需要跨客户端往返保留签名”的协议/compat profile 下开启（默认关闭，避免污染普通 OpenAI 调用的 tool_call_id 语义）。

#### B) Antigravity 429 容量耗尽的分类冷却

日志里出现的 429 形态（`MODEL_CAPACITY_EXHAUSTED / No capacity available`）本质不是“quota 不足”，更像上游的临时容量波动。

需要补的行为（建议在路由/健康度层处理，而不是 provider 语义层）：

- 从 429 payload 中提取“容量耗尽”原因
- 对整个 model 系列施加短冷却（例如 60 秒）
- 冷却优先级 > quota（quota 视图显示有额度但仍报错时，应按错误退避走）

#### C) “同一 key 先用到底，再换 key”的 Antigravity 轮询策略

为了避免多 key 轮询导致被 server 侧识别为异常（或更容易触发拒绝），Antigravity 可采用：

- 正常阶段：保持单 key 连续命中（直到出现错误/冷却）
- 出错后：快速切到当前最健康 key
- 恢复后：再按健康权重 RR 在健康 key 间均衡

该策略必须保证 **alias 之间隔离（不误伤）**，并避免“永远命中同一个健康 key / 有 key 永远命不中”的极端情况（需要测试覆盖）。

---

## 3) 建议落地方式（不违反 V2 约束）

1. **thoughtSignature ID 编码**：实现到 `llmswitch-core` conversion/shared（工具函数）并在 Gemini/Antigravity 相关 codec/mapper 中通过 profile 开关启用。
2. **429 分类冷却**：落到 quota/health 视图（`ProviderQuotaView` 或路由健康度模块）里；Provider 只负责 transport 级错误透传与重试。
3. **Antigravity key 选择策略**：落到路由池选择/健康权重 RR；不在 provider 层“语义路由”。

---

## 4) 待确认（实现前需要你审批的点）

1. 是否默认对 `gemini-chat`/`antigravity` 开启 tool_call_id 的 thoughtSignature 编码？还是仅在 `ROUTECODEX_PRESERVE_THOUGHT_SIGNATURE=1` 时开启？
2. 分隔符是否固定为 `__thought__`（与 gcli2api 对齐），还是做成 profile 可覆盖？
3. 429 容量耗尽的“model 系列”归并规则：按 `providerKey::model` 归并，还是按 `providerId::modelFamily`（例如 `claude-sonnet-4-5-*`）归并？

