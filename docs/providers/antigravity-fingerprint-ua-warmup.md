# Antigravity (Gemini via Cloud Code Assist): UA / 指纹 / Warmup 排障

这份文档总结 **RouteCodex / rcc** 在对接 Antigravity（Cloud Code Assist / `gemini-chat` 协议）时，避免出现 **403**（账号需要重新验证）与一类常见 **429**（Resource exhausted / 配额/容量错误）所需的关键约束与检查点。

> 目标：行为尽量对齐 Antigravity-Manager 的“指纹粘性 + 请求清洗 + thoughtSignature 注入”策略，但不把 Antigravity 的实现细节扩散到非 Antigravity 路径（最多落在 compat + gemini-cli provider）。

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

> 上述行为有黑盒回归：同一 payload 跑“mock upstream”验证 signature 缓存与注入是否生效。

---

## 3) Warmup：启动时提前发现“指纹/UA 不可用”的 alias

### 目的
- 在 server 初始化阶段就检查 Antigravity alias 是否满足：
  - 指纹可读且平台识别正确（禁止 linux）
  - UA 的 `<os>/<arch>` 与指纹期望一致
  - 若修过指纹，需要完成 OAuth reauth

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

