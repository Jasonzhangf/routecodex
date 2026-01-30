# Antigravity → Gemini（Cloud Code Assist）Provider + Compat 设计

本文整理 **RouteCodex / rcc** 在走 **Antigravity（OAuth 账号池）→ Gemini Cloud Code Assist（`v1internal`）** 时的设计：哪些逻辑属于 **Provider（传输层）**，哪些属于 **llmswitch-core（Hub Pipeline + compat）**，以及两者如何协作实现：

- 账号粘性（sessionId 指纹）
- `thoughtSignature` 缓存与后续注入（避免工具历史导致的上游拒绝/限流放大）
- 请求体/工具 schema 的最小清洗（不扩散到非 Antigravity 路径）

> 约束：单一路径 `HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream`，Provider 不做路由与工具修复。

---

## 1) 端到端执行路径（单一路径）

```
client (/v1/responses or /v1/chat/completions)
  → RouteCodex HTTP server
  → llmswitch-core Hub Pipeline（语义映射/工具治理/compat）
  → Provider V2: gemini-cli-http-provider（Antigravity transport）
  → Cloud Code Assist v1internal upstream
```

Cloud Code Assist 的 upstream endpoint 形态是 Google 的 `v1internal:*GenerateContent`（这是上游公开服务的路径，不是 Antigravity-Manager 的内部端点）。

---

## 2) Provider（routecodex）职责：只做“传输层整理”

实现位置：`src/providers/core/runtime/gemini-cli-http-provider.ts`

### 2.1 Antigravity runtime 识别

Provider 通过 config 或 OAuth providerId 判断当前是否为 Antigravity：
- `config.config.providerId === 'antigravity'`
- 或 `oauthProviderId === 'antigravity'`

对应代码：`src/providers/core/runtime/gemini-cli-http-provider.ts`
- `GeminiCLIHttpProvider.isAntigravityRuntime()`

### 2.2 BaseURL 候选（Sandbox → Daily → Prod）

实现位置：`src/providers/auth/antigravity-userinfo-helper.ts`
- `resolveAntigravityApiBaseCandidates()`

行为要点：
- 若显式 baseURL 或环境变量 `ROUTECODEX_ANTIGRAVITY_API_BASE` 指向本地（`http://127.0.0.1` / `http://localhost`），则**不做**公网 fallback。
- 否则按 **Sandbox → Daily → Prod** 生成候选列表（便于灰度与回退）。

### 2.3 强制 SSE（减少 generateContent / streamGenerateContent 的策略差异）

Antigravity runtime 下强制走 SSE：
- `wantsUpstreamSse()` 对 antigravity 返回 `true`
- 从而稳定走 `:streamGenerateContent?alt=sse`

对应代码：`src/providers/core/runtime/gemini-cli-http-provider.ts:wantsUpstreamSse()`

### 2.4 请求 wrapper 字段（身份信息走 JSON wrapper）

Antigravity runtime 下，Provider 会确保 JSON wrapper 上存在（或按模式移除）：
- `requestId`：默认前缀 `agent-`，`ROUTECODEX_ANTIGRAVITY_HEADER_MODE=minimal` 时改用 `req-`
- `userAgent`（值固定为 `'antigravity'`，不是 UA header）
- `requestType`：默认 `agent`，有图片附件时为 `image_gen`

对应代码：`src/providers/core/runtime/gemini-cli-http-provider.ts:preprocessRequest()`

> 注意：Provider **不根据用户 payload 推断语义**；例如图片/模态提示来自 Hub Pipeline 写入的 `metadata.hasImageAttachment`。

### 2.5 Header 最小化（对齐 Antigravity-Manager 的“少带 Google 客户端标识”）

Antigravity runtime 下，Provider 会：
- 设置 HTTP `User-Agent`：`resolveAntigravityUserAgent({ alias })`
- 删除（大小写不敏感）：
  - `x-goog-api-client`
  - `client-metadata`
  - `accept-encoding`
  - `originator`

对应代码：`src/providers/core/runtime/gemini-cli-http-provider.ts:finalizeRequestHeaders()`

并支持 `ROUTECODEX_ANTIGRAVITY_HEADER_MODE`：
- `default`：标准行为（保持 SSE Accept 等默认逻辑）
- `minimal`：更激进的 header 精简（会把 `requestId/requestType` 放到 header，wrapper 中移除）
- `standard`：显式要求标准 header 行为

### 2.6 sessionId 指纹（账号粘性输入）

Provider 不自己发明算法，而是从 llmswitch-core bridge 获取：
- `extractAntigravityGeminiSessionId(processedRequest)`

并写入：
- `processedRequest.metadata.antigravitySessionId`
- 以及 `runtimeMetadata.metadata.antigravitySessionId`

对应代码：
- `src/modules/llmswitch/bridge.ts:extractAntigravityGeminiSessionId()`
- `src/providers/core/runtime/gemini-cli-http-provider.ts:preprocessRequest()`

### 2.7 `thoughtSignature` 缓存（从上游响应中提取）

Provider 从 upstream Gemini 响应的 `candidate.content.parts[]` 里提取 `thoughtSignature` 并缓存：
- SSE：`GeminiSseNormalizer.emitCandidateParts()`
- 非 SSE：`postprocessResponse()` 中遍历 candidates

缓存入口来自 llmswitch-core（通过 bridge 暴露）：
- `cacheAntigravitySessionSignature(sessionId, signature, messageCount)`

对应代码：
- `src/providers/core/runtime/gemini-cli-http-provider.ts`
- `src/modules/llmswitch/bridge.ts`

---

## 3) UA / 指纹（routecodex）：每个 alias 绑定自己的指纹与 UA suffix

这部分是“账号与指纹一致性”的工程约束，详见：
- `docs/providers/antigravity-fingerprint-ua-warmup.md`

实现位置（可追踪）：
- UA 版本/后缀解析：`src/providers/auth/antigravity-user-agent.ts`
- warmup 检查：`src/providers/auth/antigravity-warmup.ts`
- reauth-required 状态：`src/providers/auth/antigravity-reauth-state.ts`

关键点：
- Antigravity/Gemini 路径 **禁止 `linux/*` 指纹**；修复后必须重新 OAuth。
- warmup 会在启动时打印每个 alias 的 `fp_os/fp_arch` 与 UA suffix，并可将不合格 alias 进入 blacklist，避免运行时被 ban/403。

---

## 4) Compat（llmswitch-core）职责：请求形状清洗 + signature 注入（只在 antigravity + gemini-chat）

实现位置：`sharedmodule/llmswitch-core/src/conversion/compat/actions/gemini-cli-request.ts`

### 4.1 Cloud Code Assist wrapper（`request` 节点）

`wrapGeminiCliRequest()` 会把需要发往 Cloud Code Assist 的字段收敛到：
- `root.request = { contents, tools, systemInstruction, generationConfig, ... }`

并明确移除不该上送的字段：
- `metadata / action / web_search / stream / sessionId`（包括 root 与 request 内）

### 4.2 工具列表与 schema 规范化

compat 会做“最小必要”的规范化（不修复路由、不改语义）：
- strip web_search 工具（Cloud Code Assist wrapper 不需要携带）
- normalize tool schema type（把 JSON Schema type 归一到 Gemini 兼容形式）
- normalize functionCall args（包含对 `exec_command` 的 `cmd`→`command` 兼容映射等）

对应代码：`sharedmodule/llmswitch-core/src/conversion/compat/actions/gemini-cli-request.ts`
- `stripWebSearchTools()`
- `normalizeToolDeclarations()`
- `normalizeFunctionCallArgs()`

### 4.3 `thoughtSignature` 注入（Antigravity-Manager 对齐点）

当满足 “antigravity + gemini-chat” 条件时，compat 会从 signature cache 取出 signature，并在请求中对所有 `part.functionCall` 补齐：
- `part.thoughtSignature` 缺失/空/占位时 → 写入缓存 signature

对应代码：
- `sharedmodule/llmswitch-core/src/conversion/compat/actions/gemini-cli-request.ts`
  - `injectAntigravityThoughtSignature()`
- signature cache：
  - `sharedmodule/llmswitch-core/src/conversion/compat/antigravity-session-signature.ts`

> 重要：signature 只在 antigravity + gemini-chat 的 compat 中注入，不向其它 provider 扩散。

---

## 5) Signature cache（llmswitch-core）：算法与 TTL

实现位置：`sharedmodule/llmswitch-core/src/conversion/compat/antigravity-session-signature.ts`

行为要点：
- sessionId 算法对齐 Antigravity-Manager：
  - 优先取首个 user content 的文本 parts（>10 且不含 `<system-reminder>`）做 sha256
  - 否则 fallback 为 JSON stringify 的 body（近似 `serde_json::Value::to_string()`）
  - 输出 `sid-<hash前16位>`
- cache：
  - TTL：2 小时
  - 最小 signature 长度：50
  - cache 上限：1000（超限会清理过期与最老条目）

---

## 6) 可观测性与排障入口

- 启动 warmup 日志：`[antigravity:warmup] ...`
- quota admin API/UI：`/quota/providers` 会附带 antigravity alias 的 `fpSuffix/fpOs/fpArch/...`
- codex-samples 快照：可用于对比某次请求的 provider-request/provider-response 以及各 pipeline stage

---

## 7) 变更范围边界（必须遵守）

- Provider 不负责：
  - 工具调用修复（tool args/schema 纠正）
  - 路由/策略选择（例如多 key pool、fallback 决策）
- 以上全部由 llmswitch-core Hub Pipeline / compat 承担。

