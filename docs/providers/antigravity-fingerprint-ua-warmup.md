# Antigravity (Gemini via Cloud Code Assist): UA / 指纹 / Warmup 排障

这份文档总结 **RouteCodex / rcc** 在对接 Antigravity（Cloud Code Assist / `gemini-chat` 协议）时，避免出现 **403**（账号需要重新验证）与一类常见 **429**（Resource exhausted / 配额/容量错误）所需的关键约束与检查点。

> 目标：行为尽量对齐 Antigravity-Manager 的“指纹粘性 + 请求清洗 + thoughtSignature 注入”策略，但不把 Antigravity 的实现细节扩散到非 Antigravity 路径（最多落在 compat + gemini-cli provider）。

---

## 0) 你需要知道的文件/目录/入口

### 关键目录（默认都在 `~/.routecodex/`）

- OAuth token：`auth/antigravity-oauth-*.json`
- Camoufox profile：`camoufox-profiles/rc-gemini.<alias>/...`
- Camoufox 指纹 env：`camoufox-fp/rc-gemini.<alias>.json`
- reauth-required 标记：`state/antigravity-reauth-required.json`
- UA 版本缓存：`state/antigravity-ua-version.json`

> 为什么 profileId 是 `rc-gemini.<alias>`：`gemini-cli` 与 `antigravity` 共享同一“指纹家族（gemini）”，同 alias 共用同一套 profile/指纹，避免一个账号跑出两套平台指纹。

### 关键日志/接口

- 启动 warmup：`[antigravity:warmup] ...`
- Quota / pool UI 数据：`GET /quota/providers`（包含 `fpOs/fpArch/fpSuffix/...`）
- OAuth 本地 portal：OAuth 前会展示 token + 指纹摘要（Camoufox profile + OS/Arch）

---

## 1) 403：`verify your account`（UA/指纹不匹配导致的重新验证）

### 现象
- 上游返回 `HTTP 403`，提示去 Google 账号页面完成验证（`accounts.google.com/signin/continue ...`）。

### 根因（我们确认过的）
- **本机 OAuth 登录时绑定的“浏览器指纹”与请求头中的 UA/平台指纹不一致**（最常见：把 UA 的 `windows/amd64` 改成了 `macos/*` 或 `linux/*`）。
- Cloud Code Assist 对同一 OAuth 账号的指纹变化非常敏感：一旦“平台指纹突变”，往往会触发重新验证。

### RouteCodex 的约束（安全策略）
- Antigravity/Gemini **禁止使用 Linux 指纹**（`linux/*`），发现即要求修复并重新 OAuth。
- 每个 alias 使用自己对应的 Camoufox profile 指纹（避免“多个账号互相污染”）。

### UA 的原则：版本可更新，OS/arch 不可漂移

`User-Agent` header 形态：

```
antigravity/<version> <os>/<arch>
```

- `<os>/<arch>` 来自 alias 的 OAuth 指纹（Camoufox）；**不能随意改**。
- `<version>` 允许更新（避免 “This version of Antigravity is no longer supported.”）。

RouteCodex 的版本号来源（从高到低）：
1. `ROUTECODEX_ANTIGRAVITY_USER_AGENT` / `RCC_ANTIGRAVITY_USER_AGENT`（完全覆盖）
2. `ROUTECODEX_ANTIGRAVITY_UA_VERSION` / `RCC_ANTIGRAVITY_UA_VERSION`
3. 远程拉取（可通过 `ROUTECODEX_ANTIGRAVITY_UA_DISABLE_REMOTE=1` 禁用）
4. `~/.routecodex/state/antigravity-ua-version.json`
5. 兜底版本（仅保证“有值”，不保证不过期）

### 修复步骤
1. 修复指纹（把 linux 修回 windows/macos）：
   - `routecodex camoufox-fp repair --provider antigravity --all`
2. 对被标记需要 reauth 的 alias 重新 OAuth：
   - `routecodex oauth antigravity-auto <token-selector-or-path>`
   - 或批量：`routecodex oauth reauth-required`

---

## 2) 429：`RESOURCE_EXHAUSTED`（配额/容量类 429 与 Antigravity 路径一致性）

### 现象
- 上游返回 `HTTP 429`，错误体含 `RESOURCE_EXHAUSTED`。

### 说明
- 这类 429 可能是“真实配额/容量”或上游策略性拒绝，**不能假设一定是本地形状问题**。
- 但在 Antigravity/Gemini 路径上，如果请求形状/历史/工具 schema/签名注入不对齐，也会显著放大 429 的出现概率（尤其是长上下文 + 多工具历史）。

### 我们做的对齐点（与 Antigravity-Manager 的关键行为一致）
- **Session 粘性（stable sessionId）**：对 Gemini 原生请求从 `contents` 生成 `sid-xxxxxxxxxxxxxxxx` 风格指纹，作为账号粘性选择的输入。
- **thoughtSignature 缓存 → 注入**
  - 当 mock/upstream 返回带 `thoughtSignature` 的 functionCall part 时，RouteCodex 会缓存 signature。
  - 后续请求若出现 functionCall part 且缺失 `thoughtSignature`，将把缓存签名注入到该 part（只在 antigravity + gemini-chat 启用）。
- **请求清洗与工具 schema**
  - deep clean（移除 `undefined` 注入/无效字段）
  - tool 声明字段对齐（例如 Gemini 最新规范要求 `parameters`）
  - Antigravity wrapper 语义要求：不把内部调试字段带到上游（版本/buildTime 等只留在本地快照）

### 如何确认签名注入真的生效（不是“占位”）

建议用 codex-samples 快照做证据链（不看日志猜测）：

1. 找到一次成功返回且包含 `thoughtSignature` 的响应快照（`provider-response.json` / SSE 片段中 `candidate.content.parts[].thoughtSignature`）。
2. 紧接着找下一次“带工具历史”的请求快照，检查 request body 的 `contents[].parts[].functionCall` 是否带同一个 `thoughtSignature`。

> 这个验证不依赖“你是否真的有 quota”；只要 upstream 在某次响应里下发过 signature，后续注入就应当可见。

---

## 3) Warmup：启动时提前发现“指纹/UA 不可用”的 alias

### 目的
- 在 server 初始化阶段就检查 Antigravity alias 是否满足：
  - 指纹可读且平台识别正确（禁止 linux）
  - UA 的 `<os>/<arch>` 与指纹期望一致
  - 若修过指纹，需要完成 OAuth reauth

### Warmup 实际做了什么

实现位置：
- 检查逻辑：`src/providers/auth/antigravity-warmup.ts:warmupCheckAntigravityAlias()`
- 启动触发：`src/server/runtime/http-server/index.ts`（初始化阶段遍历 `antigravity.<alias>.*` providerKey）

行为（高层）：
1. 读取 alias 的 Camoufox 指纹 → 推断期望 suffix（`windows|macos` + `amd64|aarch64`）。
2. 解析/生成 `User-Agent`（会强制刷新版本号，避免过旧）。
3. 校验 `ua_suffix === expected_suffix`。
4. 若检测到 alias 处于 `reauth_required` 状态，则提示 OAuth，并在满足条件时自动清理“陈旧标记”（通过 token 文件 mtime 判断）。
5. 如果 warmup 失败且 quota 模块可用，会把该 alias 下的所有 providerKey **blacklist** 一段时间（默认很长，避免运行时误用被 ban）。

可控开关：
- 禁用 warmup：`ROUTECODEX_ANTIGRAVITY_WARMUP=0` / `RCC_ANTIGRAVITY_WARMUP=0`
- blacklist 时长：`ROUTECODEX_ANTIGRAVITY_WARMUP_BLACKLIST_MS=<ms>`

### 日志格式
- 启动后会看到：
  - `[antigravity:warmup] OK ... fp_os=... fp_arch=... expected=... actual=...`
  - 或 `[antigravity:warmup] FAIL ... reason=... hint="run: ..."`

### Admin UI / WebUI
- `/quota/providers` 现在会附带 Antigravity alias 的 `fpSuffix/fpOs/fpArch/...`，方便在 WebUI 里直接定位哪个 alias 的指纹不一致。

---

## 4) 变更范围约束（架构要求）
- Hub Pipeline 仍是唯一执行路径；Provider 层只做传输（auth/http/retry/compat hook）。
- Antigravity 的 session/signature 逻辑 **不扩散**：最多位于 compat 与 gemini-cli provider 路径。
