# Windsurf Cascade 多轮调用对齐执行计划

依赖文档：

- `docs/design/windsurf-cascade-reentry-account-strategy.md`
- `docs/providers/windsurf-chat-provider-design.md`
- `docs/design/windsurf-cascade-tool-protocol.md`

本文是实施顺序文档，不是设计真源。

## Phase 0: Probe 基线固化

### 目标

可重复的真实 LS gRPC probe，作为后续所有改动的回归锚点。

### 已有资产

- `scripts/windsurf-provider-private-probe.ts`

### 行动

1. 将 probe 脚本命名为 `scripts/windsurf-cascade-continuation-probe.ts`，固化多轮调用与 session isolation 场景。
2. 将 settle 时间分布测试追加到 probe。
3. 将 probe 脚本纳入 `package.json` script，便于 `npm run probe:windsurf-continuation`。
4. 记录最新 probe 结果到 `note.md`。

### 验收

- `npm run probe:windsurf-continuation` 可一键复跑。
- probe 结果可追溯、可对比。

---

## Phase 1: 单账号多轮调用对齐 Windsurf.app

### 目标

一个账号、一个 LS runtime、一个 session，稳定完成 Windsurf.app 风格多轮调用：同 session 复用同 cascade，不每轮重建。

### 1.1 Unit Tests（先红）

**新增文件**：`tests/providers/core/runtime/windsurf-cascade-continuation.spec.ts`

| # | 测试名 | 验证什么 |
|---|---|---|
| 1 | same-session-reuses-cascade | 同 sessionKey 连续两轮复用同一 cascadeId |
| 2 | running-error-triggers-bounded-retry | sendCascadeMessage 返回 RUNNING 时 bounded retry |
| 3 | retry-uses-same-cascade-id | retry 过程中 cascadeId 不变 |
| 4 | retry-success-preserves-stepOffset | retry 成功后 stepOffset 正确推进 |
| 5 | retry-timeout-returns-explicit-busy | 超过最大等待返回 WINDSURF_CASCADE_BUSY |
| 6 | busy-does-not-call-account-failure | RUNNING 错误不调 markQuotaExhausted/markAuthInvalid |
| 7 | running-does-not-trigger-rebuild | RUNNING 错误不调 StartCascade |

### 1.2 Provider 改动

**改动文件**：`src/providers/core/runtime/windsurf-chat-provider.ts`

改动点：

1. 新增 `resolveWindsurfCascadeBusyError(error)` 识别 `CASCADE_RUN_STATUS_RUNNING`。
2. 在 `sendRequestInternal` 的 try 块中，`sendCascadeMessage` 失败时：
   - 若识别为 busy → 保留当前 `cascadeId`，不 `resetWindsurfCascadeTransportState`，不重新 `StartCascade`。
   - bounded retry：sleep backoff（1s → 2s → 4s → 8s，最多 4 次，总计 ≤ 40s）。
   - retry 成功后继续正常 poll。
   - retry 全部失败返回 `WINDSURF_CASCADE_BUSY`。
3. busy 错误不写入 account pool 状态（不调 markSuccess/markQuotaExhausted/markAuthInvalid）。
4. 新增错误码 `WINDSURF_CASCADE_BUSY` 到 provider error catalog。

### 1.3 单账号集成验证

1. 跑 `npm run probe:windsurf-continuation`，确认同 cascade 多轮调用成功。
2. 跑 `npx jest --config jest.config.js tests/providers/core/runtime/windsurf-cascade-continuation.spec.ts`，确认全绿。
3. 跑 `npm run build:min && npm run install:global`，确认编译安装通过。

### 1.4 验收门槛

- 同 session 连续两轮不重建 cascade。
- `CASCADE_RUN_STATUS_RUNNING` 触发 bounded retry，不 rebuild。
- retry 成功后返回完整 assistant response。
- 超时 fail-fast，错误可观测。
- 不把 cascade busy 写入 account failure state。

---

## Phase 2: 多账号 session 绑定

**前置条件**：Phase 1 完成。

### 目标

多账号只为并发，session→account binding stable，busy 不漂移。

### 2.1 Unit Tests（先红）

**新增文件**：`tests/providers/core/runtime/windsurf-account-affinity.spec.ts`

| # | 测试名 | 验证什么 |
|---|---|---|
| 1 | session-binds-to-account | sessionA 首次选 account1，后续仍选 account1 |
| 2 | different-session-can-use-different-account | sessionB 选 account2 |
| 3 | busy-does-not-shift-to-other-account | sessionA 的 account1 busy 时不切 account2 |
| 4 | fatal-unbinds-session | account1 auth invalid 时 sessionA 解绑 |
| 5 | quota-exhausted-unbinds-session | account1 quota exhausted 时 sessionA 解绑 |
| 6 | busy-not-credited-as-failure | running busy 不写 quota/auth/runtime failure |

### 2.2 Provider 改动

**改动文件**：

- `src/providers/core/runtime/windsurf/windsurf-account-pool.ts`
- `src/providers/core/runtime/windsurf-chat-provider.ts`

改动点：

1. `WindsurfAccountPool.selectAccount` 增加 `sessionAccountBinding: Map<sessionKey, accountAlias>`。
2. 绑定规则：
   - 首次选中 → 建立 binding。
   - 后续同 sessionKey 优先选 binding 中的 account。
   - binding 中 account 不可用（fatal）→ 清除 binding，重新 select。
   - binding 中 account busy → 不切号，返回 busy。
3. 在 provider `sendRequestInternal` 中：
   - cascade busy → 同 Phase 1 bounded retry。
   - 不切账号。
   - 不触发 account pool reselect。
4. 新增 `clearSessionAccountBinding(sessionKey, reason)`，仅在 fatal error 时调用。
5. 在 account pool 中新增 `isAccountFatal(accountAlias)` 判定函数：
   - fatal = auth invalid / quota exhausted / runtime unavailable
   - 非 fatal = running busy / transient error / timeout

### 2.3 多账号集成验证

1. 用两份 probe 脚本并发跑不同 sessionKey，验证 session isolation + account affinity。
2. 跑 `npx jest --config jest.config.js tests/providers/core/runtime/windsurf-account-affinity.spec.ts`，确认全绿。
3. 跑 `npm run build:min && npm run install:global`，确认编译安装通过。
4. 跑 `routecodex restart --port 5520`，真实多账号 smoke。

### 2.4 验收门槛

- session affinity 稳定，连续请求不漂移。
- cascade busy 不切号、不重建、不记失败。
- fatal 才解绑。
- 不同 session 可并发命中不同账号。
- busy 在 Virtual Router 与 error catalog 中可观测。

---

## 风险与回滚

| 风险 | 影响 | 回滚 |
|---|---|---|
| 多轮调用 retry 超时仍 429 | 用户体验差 | 记录为未对齐 App 的缺口，禁止自动 StartCascade fallback |
| executor settle 时间不稳定 | retry 次数不确定 | 增大 maxRetry 或缩短 retry window |
| session binding 过于严格 | 单点故障扩散 | 引入 TTL 强制重绑定 |
| account fatal 误判 | 误清 binding | 扩大 fatal 判定范围 |

回滚原则：每个 phase 独立可回滚，不影响其他 phase。

---

## 测试总览

```text
Phase 0: probe 基线固化
  ↓
Phase 1: 单账号多轮调用对齐 Windsurf.app
  1.1 unit tests (先红)
  1.2 provider 改动
  1.3 probe 验证
  1.4 验收
  ↓
Phase 2: 多账号 session 绑定
  2.1 unit tests (先红)
  2.2 provider 改动
  2.3 probe 验证
  2.4 验收
```

每个 phase 的验收门槛必须全部通过后才进入下一个 phase。
