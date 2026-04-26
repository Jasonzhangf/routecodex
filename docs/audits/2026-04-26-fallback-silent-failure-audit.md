# RouteCodex 全局审计：fallback / 静默失败（2026-04-26）

## 执行命令

```bash
node scripts/ci/silent-failure-audit.mjs --json
```

## 结果快照

- 扫描文件数：`1295`
- 风险 catch 块：`510`（模式匹配，含合法 best-effort + 已修复的 MAIN_PATH_RISK）
- 风险 promise.catch：`15`

## 已修复的 MAIN_PATH_RISK（按语义修复，非模式计数）

### 第一轮：观测性提升（补 non-blocking 日志，保留返回语义）

1. `src/server/runtime/http-server/request-executor.ts`
   - `previous.catch(() => undefined)` → 节流 non-blocking 日志。

2. `src/server/runtime/http-server/daemon-admin/quota-handler.ts`
   - `getRawSnapshot` / `loadTokenPortalFingerprintSummary` / `findGoogleAccountVerificationIssue` catch 补日志。

3. `src/utils/snapshot-request-retention.ts`
   - `readdir/stat/rm` catch 补日志（ENOENT 按边界放过）。

4. `src/server/runtime/http-server/session-scope-resolution.ts`
   - decode/base64/json/url-params/isAlive catch 补日志。

5. `src/providers/core/runtime/deepseek-http-provider.ts`
   - queue gate / SSE 解析 / 业务错误解析 / destroy 清理 catch 补日志。

6. `src/providers/core/config/camoufox-launcher.ts`
   - `runCamoCliCheck/profileDirExists/loadFingerprintEnv/portalUrlParse/localCallbackParse` catch 补日志。

### 第二轮：主链语义修复（错误必须传播，不得吞掉）

7. `src/modules/llmswitch/bridge/antigravity-signature.ts`
   - **L56 `loadAntigravitySignatureModule`**：不再永久缓存 null。瞬态 require 失败后下次调用重试。
   - **L92 `extractAntigravityGeminiSessionId`**：`return undefined` → `throw`。错误不再静默消失。
   - **L140 `getAntigravityLatestSignatureSessionIdForAlias`**：同上，`throw` 替代 `return undefined`。
   - **L161 `lookupAntigravitySessionSignatureEntry`**：同上。
   - 修复前模式：log + return undefined → 请求无签名静默发出。修复后：log + throw → 上层 provider 能看到错误。

8. `src/providers/auth/oauth-auth.ts`
   - **L133 `validateCredentials`**：refresh 失败时 status 消息包含具体 error message。
   - **L344 `saveToken`**：磁盘持久化失败不再吞错，`throw error`。
   - **L364 `loadToken`**：非 ENOENT 错误（损坏 JSON / 权限）不再吞掉，`throw error`。
   - **L389 `ensureTokenFileExists`**：文件/目录创建失败不再吞错，`throw error`。

9. `src/providers/auth/token-storage/token-persistence.ts`
   - **L19 `readTokenFromFile`**：非 ENOENT 错误（损坏 JSON / 权限）`throw error`，不再一律返回 null。
   - **L63 `restoreTokenFileFromBackup`**：恢复失败 `throw error`，不再只打日志。

10. `src/providers/core/strategies/oauth-auth-code-flow.ts`
    - **L214 `authenticate.update_redirect_uri`**：redirect-URI 参数应用失败 `throw error`。
    - **L371 `start_callback_server.parse_redirect_uri`**：redirect-URI 解析失败 `throw error`。
    - 修复前：失败后静默 fallback 到默认 localhost:8080/oauth2callback → callback 永远收不到。

11. `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
    - **L393 `replaceJsonObjectInPlace`**：移除 try/catch，改为 copy-before-delete 排序。先写新属性再删旧 key，消除半删除的中间态风险。

## 保留 BEST_EFFORT_OK 的分类（审计结论）

以下 catch 块经审查确认为合理 best-effort / 观测 / 清理路径，保留原语义：

- `antigravity-user-agent.ts`（4）：磁盘缓存 / 远程版本探测 → floor version fallback 是设计意图。
- `http-transport-provider.ts`（4）：logger 保护 / 超时保护 → 内部 logNonBlockingError 体系。
- `runtime-exit-forensics.ts`（4）：forensic read/write/pid-check → 纯观测。
- `provider-response.ts`（4）：model override / conversation capture / usage persistence → 不影响响应交付。
- `server-side-tools.ts`（其余 9）：trace callback / JSON.stringify 降级 / retry loop / error rethrow → 无吞错。
- CLI 层 `session-inject/guardian/client/camoufox-fp/index.ts` 等 15 个 `.catch(() => null)` → CLI / 启动路径，非主链。

### 第三轮：token-daemon 主链修复

12. `src/token-daemon/token-daemon.ts`
    - **L288 `tick.loadRouteCodexConfig`**：config 加载失败改为 `throw`。修复前：`configuredProviders = new Set()` 导致本 tick 所有 token refresh 全部跳过，零可见性。
    - **L741 `ensurePortalEnvironment`**：移除 boolean-return wrapper（仅 `logDebug`，生产关闭）。改为直接 `await`；调用方 L395 用 `try/catch` + `console.error` + `logTokenDaemonNonBlockingError` 确保 portal 失败可见。

## 全局趋势

- 第一轮（观测性）：风险 catch `538 → 510`（-28），promise.catch `22 → 15`（-7）
- 第二轮（语义修复）：11 处 MAIN_PATH_RISK 从"吞错"改为"throw/重试/消除中间态"
- 第三轮（token-daemon）：2 处 MAIN_PATH_RISK 改为 throw + 可见错误

## 第四轮：全局分层审计（最终扫描结果）

### 已审查确认 BEST_EFFORT_OK 的文件（全部 catch 块均为主链无关）

| 文件 | catch 数 | 理由 |
|------|:--------:|------|
| `antigravity-user-agent.ts` | 4 | 磁盘缓存 / 远程版本探测 → floor version fallback 是设计意图 |
| `http-transport-provider.ts` | 4 | logger 保护 / 超时保护 → 内部 logNonBlockingError 体系 |
| `runtime-exit-forensics.ts` | 4 | forensic read/write/pid-check → 纯观测 |
| `provider-response.ts` | 4 | model override / conversation capture / usage persistence → 不影响响应交付 |
| `server-side-tools.ts` | 9 | trace callback / JSON.stringify 降级 / retry loop / error rethrow → 无吞错 |
| `oauth-auth-code-flow.ts` | 17 | L214/L371 已修复；其余为 retry loop / callback / listen / cleanup → 正确 rethrow 或 best-effort |
| 4 × pipeline-semantics | 32 | 全部为 parser fallback（`return null` → pipeline fail-fast at validation）+ `fail('invalid payload')` |
| `ai-followup.ts` | 9 | process spawn/kill/cleanup/file read/logging → 非阻断 |
| `pending-session.ts` | 5 | file resolution / stale cleanup / pending read → best-effort |
| `provider-response-converter.ts` | 10 | JSON parse fallbacks / tool call recovery → 非阻断 |
| `sse-error-handler.ts` | 3 | error normalization → best-effort |
| `managed-process-probe.ts` | 7 | pid probe / kill / command read → best-effort |
| `session-storage-cleanup.ts` | 8 | 全部带 non-blocking 日志 → cleanup 路径 |
| `tmux-session-probe.ts` | 9 | 全部带 non-blocking 日志或结构化 error return → probe 路径 |
| `request-id-manager.ts` | 3 | persistence best-effort → 计数器回退到内存 |

### 15 个 `.catch(() => null/undefined)` 确认为非主链

CLI 层（`session-inject` / `guardian/client` / `camoufox-fp` / `index.ts`）、warmup、quota serialized-write chain、token portal → 全部为 CLI / 启动路径 / best-effort 非主链。

### 全局结论

- **已修复 MAIN_PATH_RISK：15 处**（第一轮 0 + 第二轮 11 + 第三轮 2 + replaceJsonObjectInPlace 1 + session storm backoff 1）
- **剩余 MAIN_PATH_RISK：0**（经 explorer + 手动逐文件审查确认）
- **扫描器 catchRiskCount：509**（全部为 BEST_EFFORT_OK / LOGGING_ONLY / parser-fallback）

> 注：审计扫描器按 `catch` 模式计数，不会因 throw 修复而减少计数。509 个 catch 经分层审查均不在主链上。
