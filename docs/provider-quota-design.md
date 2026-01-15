# Provider Quota / Health 管理（文件落盘设计草案）

> 目标：把 provider 健康与流控统一抽象为 quota，通过 daemon 维护一份落盘快照；virtual-router 只读快照决定是否进入路由池与调度优先级。

## 1. 文件结构

- 根目录：`~/.routecodex/quota/`
  - `provider-quota.json`：当前生效的 quota 快照（virtual-router 只读）。
  - `provider-errors.ndjson`：错误事件流水（daemon 可选使用，用于恢复 / 调试）。

### 1.1 `provider-quota.json`

```jsonc
{
  "version": 1,
  "updatedAt": "2026-01-15T09:30:12.345Z",
  "providers": {
    "antigravity.alias1.gemini-3-pro-high": {
      "providerKey": "antigravity.alias1.gemini-3-pro-high",
      "providerId": "antigravity.alias1",
      "inPool": false,
      "reason": "cooldown",          // ok|cooldown|blacklist|quotaDepleted|fatal
      "priorityTier": 100,
      "rateLimitPerMinute": null,    // null = 不限制
      "tokenLimitPerMinute": null,
      "totalTokenLimit": null,
      "windowStartMs": 1768439400000,
      "requestsThisWindow": 12,
      "tokensThisWindow": 8200,
      "totalTokensUsed": 120000,
      "cooldownUntil": 1768439700000,   // ms since epoch，null 表示无
      "blacklistUntil": null,
      "lastErrorSeries": "E429",
      "consecutiveErrorCount": 2
    }
  }
}
```

- 静态 quota：
  - `priorityTier`：优先级，未配置统一为 `100`。
  - `rateLimitPerMinute`：每分钟请求数，默认不限制。
  - `tokenLimitPerMinute` / `totalTokenLimit`：默认不限制。
- 动态状态：
  - `inPool` + `reason`：是否参与路由池以及原因。
  - `cooldownUntil` / `blacklistUntil`：冷却与锁定窗口。
  - `consecutiveErrorCount` / `lastErrorSeries`：用于“连续三次同类错误”的判定。

### 1.2 `provider-errors.ndjson`

每行一条错误事件，供 daemon 消费或调试：

```json
{"ts":"2026-01-15T09:14:20.123Z","providerKey":"antigravity.alias1.gemini-3-pro-high","errorCode":"429","series":"E429","route":"thinking","requestId":"...","httpStatus":429,"retryable":true}
```

## 2. 逻辑规则摘要

### 2.1 错误到 quota 的映射

- 错误 series：`seriesKey = providerKey + ':' + normalizedErrorCode`
  - `E429`：HTTP 429 / rate-limit。
  - `E5xx`：稳定性问题（5xx）。
  - `ENET`：网络 / 超时。
  - `EFATAL`：不可恢复（配置错误、认证失败、非法模型等）。

#### 429 与其它可恢复错误

- 单一 series 内，连续错误次数 `n`：
  - 第 1 次：`cooldownUntil = now + 1min`，`inPool=false`。
  - 第 2 次：`cooldownUntil = now + 3min`。
  - 第 3 次：`cooldownUntil = now + 5min`。
- 同一 series 连续 3 次错误：
  - `blacklistUntil = now + 6h`，`inPool=false`，`reason='blacklist'`。
- 任意成功事件：
  - 清零该 provider 的所有 `consecutiveErrorCount`；
  - 若无有效 `blacklistUntil` 且 `cooldownUntil` 已过期，则恢复 `inPool=true, reason='ok'`。

#### 不可恢复错误（EFATAL）

- 直接：
  - `blacklistUntil = now + 6h`；
  - `inPool=false, reason='fatal'`。
- 恢复依赖时间到期或管理操作，成功事件不会自动解除。

### 2.2 静态 quota（apikey provider）

- 优先级：
  - 由配置文件提供 `priorityTier`，未配置统一为 `100`。
  - virtual-router 构建池时按 tier 从小到大分组，同一 tier 内做轮询或加权轮询。
- 时间流控：
  - `rateLimitPerMinute`：按 1 分钟窗口统计 `requestsThisWindow`，超过则标记 `reason='quotaDepleted'`，直到窗口翻转。
- token 控制：
  - `tokenLimitPerMinute`：按 1 分钟窗口统计 `tokensThisWindow`。
  - `totalTokenLimit`：累加 `totalTokensUsed`，超过后可直接锁定或标记 `quotaDepleted`。

## 3. 分阶段落地路线（先测试再接线）

### Phase 1：纯逻辑（无 I/O）

- 新增 `provider-quota-center`（纯函数，不依赖文件）：
  - `applyErrorEvent` / `applySuccessEvent` / `applyUsageEvent` / `tickWindow`。
- 在 tests 中为上述规则写完整单元测试：
  - 429 / 其它错误的 1/3/5 分钟与三连错 6 小时；
  - 成功会清零“连续”错误计数；
  - 静态 `priorityTier` 默认 100，quota 默认无限制。

### Phase 2：文件存储层

- 实现 `provider-quota-store`：
  - `loadSnapshot` / `saveSnapshot` 基于 `provider-quota.json`，原子写入。
  - `appendErrorEvent` 追加写 `provider-errors.ndjson`。
- 提供一个 `scripts/quota-dryrun.mjs`：
  - 从事件 fixture 读入，驱动 quota center，输出 `provider-quota.json` 供人工检查。

### Phase 3：Quota Daemon（独立运行）

- 在 daemon 进程中集成 quota center 与 store：
  - 从错误 / 成功 / usage 事件源消费消息；
  - 周期性更新内存状态并写回 `provider-quota.json`。
- 提供 `--dry-run` / `--once` 模式，仅读取 `provider-errors.ndjson` 和 config，生成一次快照后退出，用于验证逻辑。

### Phase 4：virtual-router 接线（可通过 feature flag 控制）

- 在 virtual-router 构建 provider 池时：
  - 可选读取 `~/.routecodex/quota/provider-quota.json`：
    - 过滤 `inPool !== true` 或 `cooldownUntil/blacklistUntil > now` 的 provider。
    - 按 `priorityTier` 做 tier 调度。
- 初期通过环境变量开启（例如 `ROUTECODEX_QUOTA_ENABLED=1`），待稳定后再作为默认路径。

