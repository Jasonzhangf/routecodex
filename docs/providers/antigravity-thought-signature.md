# Antigravity Gemini `thoughtSignature`：缓存/注入机制与常见“缺签名”问题

本页描述 RouteCodex / llmswitch-core 在 **Antigravity（Gemini Cloud Code Assist v1internal）** 下对
Gemini 原生请求 `thoughtSignature` 的对齐策略、缓存键选择、以及在「多 Provider 切换」/「历史压缩」场景下
可能出现的缺签名原因与修复点。

> 说明：`thoughtSignature` **不是我们生成的**。它来自上游在响应里返回的签名（通常出现在 `functionCall`
> 的 part 上），我们只做“捕获→缓存→回填注入”。

## 1. 什么时候必须注入 `thoughtSignature`

在 Gemini Cloud Code Assist 的 tool-loop 里，后续请求会把上一次的 `functionCall` 和本次的
`functionResponse` 都带上（Gemini 原生格式的 `contents[].parts[]`）。

当上一次响应产生了有效 `thoughtSignature`，后续请求的 `functionCall` part 通常需要携带同一个
`thoughtSignature`，否则上游可能会在某些模型/负载情况下返回签名相关错误（不同于 429）。

## 2. llmswitch-core 的实现概览

兼容 Profile：`sharedmodule/llmswitch-core/src/conversion/compat/profiles/chat-gemini.json`

- 请求侧：
  - `antigravity_thought_signature_prepare`
    - 计算 session fingerprint（见下文）
    - 将 `requestId` / `clientRequestId` / `groupRequestId` 绑定到 session fingerprint
    - 如果已有缓存签名：把签名注入到所有缺失签名的 `functionCall` parts
- 响应侧：
  - `antigravity_thought_signature_cache`
    - 从响应中提取 `thoughtSignature` 并缓存到对应 session fingerprint

核心文件：
- `sharedmodule/llmswitch-core/src/conversion/compat/antigravity-session-signature.ts`
- `sharedmodule/llmswitch-core/src/conversion/compat/actions/antigravity-thought-signature-prepare.ts`
- `sharedmodule/llmswitch-core/src/conversion/compat/actions/antigravity-thought-signature-cache.ts`

缓存特性（当前实现）：
- **内存缓存**（进程重启会丢失）
- TTL：2 小时（对齐 Antigravity-Manager 的 Node Proxy 行为）

## 3. 为什么有些请求会出现 “functionCall 没有 thoughtSignature”

### 3.1 正常情况：第一次 tool-call loop 还没有可用签名

在一个全新的会话里，**首次**进入 tool-loop 前，我们没有任何可缓存的 `thoughtSignature`，因此不会注入。
一旦上游在响应里返回签名，后续请求就会开始回填。

### 3.2 易踩坑：历史压缩 / provider 切换导致 session fingerprint 漂移（cache miss）

过去的实现中，Gemini 会话指纹默认从 **第一条 user message 的文本**生成（与 Antigravity-Manager 的
`SessionManager::extract_gemini_session_id` 对齐）：

- `sha256(first_user_text)`（长度 > 10 且不含 `<system-reminder>`）
- 否则 fallback：`sha256(JSON body)`
- `sid = "sid-" + hash[0..16]`

当路由发生「历史压缩（compaction）」或「前序上下文被裁剪」时，**第一条 user message 可能变化**，
导致 `sid-xxxx` 变化 → 找不到已缓存签名 → 当轮请求的 `functionCall` parts 就会缺签名。

这类缺签名通常会表现为：
- `functionCall` 和 `functionResponse` 都存在（说明正在 tool-loop）
- 但 `functionCall` 的 `thoughtSignature` 为缺失（0/全部）

## 4. 修复：优先使用稳定的 metadata sessionId/conversationId 作为缓存键

为避免 sid 漂移，llmswitch-core 现在优先使用来自 Host 的稳定会话标识（如果存在）：

- `adapterContext.sessionId` 或 `adapterContext.conversationId`
- 通过 `sha256(value)` 归一化到 `sid-xxxxxxxxxxxxxxxx` 形式
- 仅作为 **缓存键**（不发送给上游）

这样即使 history trimming 导致第一条 user message 发生变化，也不会影响 signature cache 命中率。

相关测试：
- `tests/compat/antigravity-thought-signature.spec.ts`
  - `uses stable sessionId from metadata ...`

## 4.1 变更：跨会话复用签名时，临时“切换到签名所属 sessionId”

当同一个 antigravity alias 已经缓存过有效签名后，如果出现**新的 sessionId**（例如客户端重启或新会话 ID）
继续请求同一 alias，llmswitch-core 会做一个“签名会话绑定”：

- 仍然按 alias 维度复用已缓存的 `thoughtSignature`（和之前一致）
- 但会将本次请求的 `requestId → session fingerprint` 绑定到**签名来源的 sessionId**（而不是新 sessionId）
  - 目的：让后续响应缓存与 SSE 侧的签名捕获始终落到“签名所属 sessionId”，避免跨会话漂移导致的拒绝/放大
- 该切换仅影响本地缓存键，不会把 sessionId 下发到上游

## 5. 安全性：rewind（回滚历史）时避免注入“未来签名”

如果用户回滚历史（例如删除若干轮对话后重发），会出现 “当前 messageCount < 缓存 messageCount” 的情况。
此时把旧签名注入到新历史会导致上游拒绝（签名属于“未来”上下文）。

现在在注入阶段会做 rewind 检测：
- 如果检测到 messageCount 下降：**清除该 session 的缓存签名**，本轮不注入，等待上游返回新签名。

相关测试：
- `tests/compat/antigravity-thought-signature.spec.ts`
  - `skips injection on rewind ...`

## 6. 与 429 的关系（澄清）

`HTTP 429 RESOURCE_EXHAUSTED` 是上游明确的资源/配额耗尽信号，不是签名机制本身的错误。
在一些 429 的样本里确实会出现 `functionCall` 缺签名，但这并不构成因果关系：

- 缺签名不一定失败（同样无签名的请求也可能成功）
- 429 的根因是上游对该账号/资源返回 `RESOURCE_EXHAUSTED`

因此稳定性策略需要在虚拟路由/重试层单独处理（例如将 Antigravity 429 视作账号级耗尽，不在同一账号下 high/low 互切）。
