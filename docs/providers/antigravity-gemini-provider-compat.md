# Antigravity → Gemini（Cloud Code Assist）Provider + Compat 设计（含 UA/指纹/多账号经验）

本文整理 **RouteCodex / rcc** 在走 **Antigravity（OAuth 账号池）→ Cloud Code Assist（`v1internal:*`）** 时的设计：哪些逻辑属于 **Provider（传输层）**，哪些属于 **llmswitch-core（Hub Pipeline + compat）**，以及两者如何协作实现：

- 账号粘性（sessionId 指纹）
- `thoughtSignature` 缓存与后续注入（避免工具历史导致的上游拒绝/限流放大）
- 请求体/工具 schema 的最小清洗（不扩散到非 Antigravity 路径）
- `User-Agent`（版本号可更新，但 OS/arch 必须与 OAuth 指纹一致）
- 多账号隔离（alias → profile → UA suffix）

> 约束：单一路径 `HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream`，Provider 不做路由与工具修复。

---

## 0) 关键不变量（必须牢记）

1. **Provider = transport**：只负责 auth、HTTP、重试、SSE 传输与少量“协议/上游 contract”整理；不能根据用户 payload 修工具/改路由。
2. **“UA 版本可变，但指纹不可漂移”**：对 Cloud Code Assist，OAuth 账号与“浏览器平台指纹”强绑定。UA 的 `<os>/<arch>` 必须稳定绑定到该 alias 的 OAuth 指纹。
3. **禁用 Linux 指纹（Antigravity/Gemini 路径）**：我们遇到过 `linux/*` 指纹触发 re-verify/风控；因此在这条路径上明确禁止。
4. **signature 不扩散**：`thoughtSignature` 缓存/注入只在 `antigravity + gemini-chat` 的 compat 生效，不影响其它 provider。
5. **profile 必须选对**：Antigravity 走 Cloud Code Assist wrapper 时必须用 `compatibilityProfile: "chat:gemini-cli"`；用错 profile（例如 `chat:gemini`）会导致 request wrap / 历史 `thoughtSignature` 注入缺失，从而出现“第一次 OK、第二次 429”的假象。

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

## 2) Upstream BaseURL + endpoints（Cloud Code Assist）

实现位置：`src/providers/auth/antigravity-userinfo-helper.ts`

### 2.1 BaseURL 候选（Sandbox → Daily → Prod）

`resolveAntigravityApiBaseCandidates()` 的行为要点：
- 若显式 baseURL 或环境变量 `ROUTECODEX_ANTIGRAVITY_API_BASE` / `RCC_ANTIGRAVITY_API_BASE` 指向本地（`http://127.0.0.1` / `http://localhost`），则**不做**公网 fallback（避免把本地调试误导到公网）。
- 否则按 **Sandbox → Daily → Prod** 生成候选列表（便于灰度与回退）。

### 2.2 userinfo / onboarding 相关端点

初始化/探测阶段会用到（是否触发取决于运行流程）：
- `POST /v1internal:loadCodeAssist`
- `POST /v1internal:onboardUser`

### 2.3 生成内容端点（请求主路径）

Antigravity runtime 下我们**强制 SSE**（见下文），因此请求通常落到：
- `POST /v1internal:streamGenerateContent?alt=sse`

> 备注：RouteCodex 不引入 Antigravity-Manager 的“内部转发端点”概念；这里的 `v1internal:*` 是 Cloud Code Assist 的 upstream contract。

---

## 3) Provider（routecodex）职责：只做“传输层整理”

实现位置：`src/providers/core/runtime/gemini-cli-http-provider.ts`

### 3.1 Antigravity runtime 识别

Provider 通过 config 或 OAuth providerId 判断当前是否为 Antigravity：
- `config.config.providerId === 'antigravity'`
- 或 `oauthProviderId === 'antigravity'`

对应代码：`src/providers/core/runtime/gemini-cli-http-provider.ts`
- `GeminiCLIHttpProvider.isAntigravityRuntime()`

### 3.2 强制 SSE（减少 generateContent / streamGenerateContent 的策略差异）

Antigravity runtime 下强制走 SSE：
- `wantsUpstreamSse()` 对 antigravity 返回 `true`
- 从而稳定走 `:streamGenerateContent?alt=sse`

对应代码：`src/providers/core/runtime/gemini-cli-http-provider.ts:wantsUpstreamSse()`

### 3.3 请求 wrapper 字段（身份信息走 JSON wrapper）

Antigravity runtime 下，Provider 会确保 JSON wrapper 上存在（或按模式移除）：
- `requestId`：默认前缀 `agent-`，`ROUTECODEX_ANTIGRAVITY_HEADER_MODE=minimal` 时改用 `req-`
- `userAgent`（值固定为 `'antigravity'`，不是 UA header）
- `requestType`：默认 `agent`，有图片附件时为 `image_gen`

对应代码：`src/providers/core/runtime/gemini-cli-http-provider.ts:preprocessRequest()`

> 注意：Provider **不根据用户 payload 推断语义**；例如图片/模态提示来自 Hub Pipeline 写入的 `metadata.hasImageAttachment`。

### 3.4 Header 最小化（减少 Google 客户端标识）

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

### 3.5 sessionId 指纹（账号粘性输入）

Provider 不自己发明算法，而是从 llmswitch-core bridge 获取：
- `extractAntigravityGeminiSessionId(processedRequest)`

并写入：
- `processedRequest.metadata.antigravitySessionId`
- 以及 `runtimeMetadata.metadata.antigravitySessionId`

对应代码：
- `src/modules/llmswitch/bridge.ts:extractAntigravityGeminiSessionId()`
- `src/providers/core/runtime/gemini-cli-http-provider.ts:preprocessRequest()`

### 3.6 `thoughtSignature` 缓存（从上游响应中提取）

Provider 从 upstream Gemini 响应的 `candidate.content.parts[]` 里提取 `thoughtSignature` 并缓存：
- SSE：`GeminiSseNormalizer.emitCandidateParts()`
- 非 SSE：`postprocessResponse()` 中遍历 candidates

缓存入口来自 llmswitch-core（通过 bridge 暴露）：
- `cacheAntigravitySessionSignature(sessionId, signature, messageCount)`

对应代码：
- `src/providers/core/runtime/gemini-cli-http-provider.ts`
- `src/modules/llmswitch/bridge.ts`

---

## 4) UA / 指纹（routecodex）：每个 alias 绑定自己的指纹与 UA suffix（防止“账号互相污染”）

这部分是“账号与指纹一致性”的工程约束：**同一个 OAuth alias 的平台指纹必须稳定**。版本号允许更新以规避“版本过旧不支持”，但 OS/arch 的 UA suffix 不能漂移。

详细排障见：
- `docs/providers/antigravity-fingerprint-ua-warmup.md`

实现位置（可追踪）：
- UA 版本/后缀解析：`src/providers/auth/antigravity-user-agent.ts`
- 指纹读取与 suffix 推断：`src/providers/auth/antigravity-fingerprint.ts`
- warmup 检查与黑名单：`src/providers/auth/antigravity-warmup.ts`
- reauth-required 状态：`src/providers/auth/antigravity-reauth-state.ts`
- Camoufox 指纹生成策略：`src/providers/core/config/camoufox-launcher.ts`

### 4.1 UA header 格式（对齐 Antigravity-Manager）

RouteCodex 发往 Antigravity/Cloud Code Assist 的 `User-Agent` header 形态是：

```
antigravity/<version> <os>/<arch>
```

其中：
- `<os>/<arch>`：来源于 alias 的 Camoufox OAuth 指纹（稳定绑定）。
- `<version>`：允许刷新（避免 “This version of Antigravity is no longer supported.”）。

> 实践经验：**绝对不要为了“更新 UA”去改 `<os>/<arch>`**。那是“账号指纹”，一改就等价于换设备/换浏览器平台，极易触发 403 re-verify。

### 4.2 版本号如何“动态获取 + 多级回退”

实现位置：`src/providers/auth/antigravity-user-agent.ts`

版本解析顺序（从高到低）：
1. 显式 UA：`ROUTECODEX_ANTIGRAVITY_USER_AGENT` / `RCC_ANTIGRAVITY_USER_AGENT`（完全覆盖）
2. 显式版本号：`ROUTECODEX_ANTIGRAVITY_UA_VERSION` / `RCC_ANTIGRAVITY_UA_VERSION`
3. 远程拉取：`VERSION_URL`，失败时回退 `CHANGELOG_URL`（可用 `ROUTECODEX_ANTIGRAVITY_UA_DISABLE_REMOTE=1` 禁用）
4. 本地磁盘 cache：`~/.routecodex/state/antigravity-ua-version.json`
5. 最后兜底：`KNOWN_STABLE_VERSION`（当前 `4.1.24`，对齐 Antigravity-Manager）

### 4.3 `<os>/<arch>` suffix 如何从指纹推断（并且为何禁 linux）

实现位置：`src/providers/auth/antigravity-fingerprint.ts`

- 指纹文件：`~/.routecodex/camoufox-fp/<profileId>.json`
- 从 `CAMOU_CONFIG_1` 的 `navigator.*` 字段推断：
  - `windows|macos|linux`
  - `amd64|aarch64`

RouteCodex 约束：
- Antigravity/Gemini 路径 **禁止 `linux/*`**（风险更高）；发现即要求 `repair` + `reauth`。

### 4.4 alias → profile 的绑定与“多账号隔离”

实现位置：`src/providers/core/config/camoufox-launcher.ts`

- 每个 alias 都对应一个稳定 profileId（目录在 `~/.routecodex/camoufox-profiles/`）。
- `gemini-cli` 与 `antigravity` 共享同一“指纹家族（gemini）”，因此同 alias 在两者之间共享 profileId（避免一个账号跑出两套指纹）。
- OS policy：对 `(providerFamily, alias)` 做稳定 hash，把不同 alias 分布到 `windows/macos`，并**严格禁止 linux**。

---

## 5) Compat（llmswitch-core）职责：请求形状清洗 + signature 注入（只在 antigravity + gemini-chat）

实现位置：`sharedmodule/llmswitch-core/src/conversion/compat/actions/gemini-cli-request.ts`

### 5.1 Cloud Code Assist wrapper（`request` 节点）

`wrapGeminiCliRequest()` 会把需要发往 Cloud Code Assist 的字段收敛到：
- `root.request = { contents, tools, systemInstruction, generationConfig, ... }`

并明确移除不该上送的字段：
- `metadata / action / web_search / stream / sessionId`（包括 root 与 request 内）

### 5.2 工具列表与 schema 规范化

compat 会做“最小必要”的规范化（不修复路由、不改语义）：
- strip web_search 工具（Cloud Code Assist wrapper 不需要携带）
- normalize tool schema type（把 JSON Schema type 归一到 Gemini 兼容形式）
- normalize functionCall args（包含对 `exec_command` 的 `cmd`→`command` 兼容映射等）
- normalize tool declaration（对 `exec_command` / `write_stdin` / `apply_patch` 做参数白名单收敛）

对应代码：`sharedmodule/llmswitch-core/src/conversion/compat/actions/gemini-cli-request.ts`
- `stripWebSearchTools()`
- `normalizeToolDeclarations()`
- `normalizeFunctionCallArgs()`

### 5.3 `thoughtSignature` 注入（Antigravity-Manager 对齐点）

当满足 “antigravity + gemini-chat” 条件时，compat 会从 signature cache 取出 signature，并在请求中对所有 `part.functionCall` 补齐：
- `part.thoughtSignature` 缺失/空/占位时 → 写入缓存 signature
- 如果本次请求属于“新会话”，但 alias 已有可用签名：会将本次请求的 session fingerprint 临时绑定到**签名所属 sessionId**，确保响应侧继续落在同一签名会话里（不向上游透传 sessionId）。

对应代码：
- `sharedmodule/llmswitch-core/src/conversion/compat/actions/gemini-cli-request.ts`
  - `injectAntigravityThoughtSignature()`
- signature cache：
  - `sharedmodule/llmswitch-core/src/conversion/compat/antigravity-session-signature.ts`

> 重要：signature 只在 antigravity + gemini-chat 的 compat 中注入，不向其它 provider 扩散。

### 5.4 为什么一定要用 `chat:gemini-cli`（而不是 `chat:gemini`）
本次排障中我们确认过一个“高频误配”：
- **`chat:gemini`**：面向 Generative Language API 的常规 Gemini 形状（不会跑 Cloud Code Assist wrapper），因此不会执行 `gemini_cli_request_wrap`，也不会把缓存的 `thoughtSignature` 回填进历史 `functionCall`。
- **`chat:gemini-cli`**：面向 Cloud Code Assist / Antigravity 的 wrapper 形状（会把 root 字段收敛到 `request` 节点，并对工具 schema 与历史签名做对齐）。

当 profile 配错时，典型症状是：
- 第一跳（无工具历史）可能 OK
- 第二跳（带 `functionCall` 历史但缺 `thoughtSignature`）开始出现 429 / 被策略性拒绝放大

所以，Antigravity provider 的 `compatibilityProfile` 必须显式设置为：

```jsonc
{
  "virtualrouter": {
    "providers": {
      "antigravity": {
        "compatibilityProfile": "chat:gemini-cli"
      }
    }
  }
}
```

---

## 6) Signature cache（llmswitch-core）：算法与 TTL

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

## 7) Gemini vs Claude（经 Antigravity / `gemini-chat`）差异点

我们在 Antigravity 下同时跑过 “Gemini 系列模型” 与 “Claude 系列模型”（注意：两者都可能通过 `providerProtocol=gemini-chat` 走 Cloud Code Assist）。差异点主要体现在：

1. **工具历史敏感度**  
   长上下文 + 多工具历史时，上游对 `functionCall` part 的形状要求更严格。缺失/占位的 `thoughtSignature` 往往会放大拒绝/限流概率（尤其是连续多次请求）。
2. **requestType / wrapper 字段**  
   RouteCodex 在 Antigravity wrapper 中仅使用 `agent` / `image_gen` 两类 `requestType`。Hub/compat 会移除与 Cloud Code Assist schema 无关字段，避免 wrapper 漂移导致错误。
3. **SSE**  
   Antigravity runtime 强制 SSE，以降低不同模型/端点在非流式策略上的不稳定差异。

结论：**Gemini/Claude 的差异不应该靠 Provider 分支硬编码**；把“对齐/清洗/注入”的差异限定在 `compat`，才能保持 hub 架构一致性。

---

## 8) 可观测性与排障入口

- 启动 warmup 日志：`[antigravity:warmup] ...`
- quota admin API/UI：`/quota/providers` 会附带 antigravity alias 的 `fpSuffix/fpOs/fpArch/...`
- codex-samples 快照：可用于对比某次请求的 provider-request/provider-response 以及各 pipeline stage

---

## 9) 经验总结（403 / 429 的高概率根因与处理顺序）

1. 先处理 **403（verify your account / reauth）**：基本都是“UA suffix 与 OAuth 指纹不一致”或“linux 指纹”导致。  
   触发 403 后继续重试通常只会更糟；应先 `repair` 指纹并完成 OAuth reauth。
2. 再看 **429（RESOURCE_EXHAUSTED）**：它可能是真实配额/容量，但在 Antigravity/Gemini 路径上，**signature/工具历史形状不一致会显著放大 429**。  
   排查优先级通常是：`thoughtSignature` 注入是否生效 → 工具 schema 是否被 compat 规范化 → header 最小化是否生效（少带 google client 标识）。
3. 多账号/多 alias 强烈建议启用 warmup：让“会触发 reauth/指纹不一致”的 alias 在启动阶段就被隔离，不要进入运行期 pool。

---

## 10) 变更范围边界（必须遵守）

- Provider 不负责：
  - 工具调用修复（tool args/schema 纠正）
  - 路由/策略选择（例如多 key pool、fallback 决策）
- 以上全部由 llmswitch-core Hub Pipeline / compat 承担。
