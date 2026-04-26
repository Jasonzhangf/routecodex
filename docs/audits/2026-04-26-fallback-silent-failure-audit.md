# RouteCodex 全局审计：fallback / 静默失败（2026-04-26）

## 执行命令

```bash
node scripts/ci/silent-failure-audit.mjs --json
```

## 结果快照（本轮修复后）

- 扫描文件数：`1295`
- 风险 catch 块：`533`
- 风险 promise.catch：`17`

## 本轮已顺手修复（最小切片）

1. `src/server/runtime/http-server/request-executor.ts`
   - 修复：`previous.catch(() => undefined)` -> 记录节流 non-blocking 日志。
   - 目标：避免 backoff gate 前序失败被静默吞掉。

2. `src/server/runtime/http-server/daemon-admin/quota-handler.ts`
   - 修复：`getRawSnapshot` 读取失败补 non-blocking 日志。
   - 修复：两处 `.catch(() => null)` 改为显式 `try/catch + 日志 + null`。
   - 目标：保留 best-effort 语义同时提升可观测性。

3. `src/utils/snapshot-request-retention.ts`
   - 修复：`readdir/stat/rm` 失败补节流 non-blocking 日志（ENOENT 仅按边界放过）。
   - 目标：快照保留/清理失败可定位，不再静默丢线索。

4. `src/server/runtime/http-server/session-scope-resolution.ts`
   - 修复：decode/base64/json/url-params/isAlive 失败补节流 non-blocking 日志。
   - 目标：兼容解析路径维持非阻断，但异常不再静默。

## 全局趋势（本轮前后）

- 风险 catch：`538 -> 533`（-5）
- 风险 promise.catch：`22 -> 17`（-5）

## 剩余热点（按当前风险计数 Top）

1. `src/providers/core/runtime/qwenchat-http-provider-helpers.ts`（7）
2. `src/providers/core/config/camoufox-launcher.ts`（6）
3. `src/server/runtime/http-server/request-executor.ts`（5）
4. `src/modules/llmswitch/bridge/antigravity-signature.ts`（4）
5. `src/providers/auth/antigravity-user-agent.ts`（4）

> 说明：上述计数来自 `silent-failure-audit` 的规则匹配，需按“主链功能 fallback / 纯观测 best-effort”分层判定后继续分批清理。
