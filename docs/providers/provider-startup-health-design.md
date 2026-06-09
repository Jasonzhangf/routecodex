# Provider Startup Health Design

**状态**: 待审批 → 红测 → 实现
**日期**: 2026-06-01
**Auditor**: Codex

---

## 一、问题

### 1.1 现状（Startup Reprobe）

```
routecodex start --snap
  → 对每个 provider 跑 checkHealth()  // GET baseURL/v1/models
  → 成功 → handleProviderSuccess() → 清 cooldown
  → 失败 → console.warn + return（不写 cooldown，也不清旧 cooldown）
```

**核心缺陷**：startup reprobe 失败 → 不清旧 cooldown → provider 永远被挡。

### 1.2 实际案例

sdfv.cn 网络完全可达（curl/node fetch 都 200），但 startup reprobe 在进程冷启动时 fetch failed（`TypeError: fetch failed`），导致：
- `sdfv.key1.gpt-5.5` 旧 `__http_503_daily_cooldown__` 永远不被清除
- 5555 default 首选 sdfv 但永远不会命中

### 1.3 根因

| 因素 | 说明 |
|---|---|
| 启动期冷态 | DNS/TLS/socket pool 未预热，fetch 失败概率高 |
| reprobe 失败不清旧 cooldown | 代码只 `return`，不调 `handleProviderSuccess()` |
| reprobe 也不写新 cooldown | 不是 reprobe 的错，但旧 cooldown 永不清除 |
| `/v1/models` ≠ 可用性 | 模型列表成功不等于 responses 真正可用 |

---

## 二、方案：启动不做 reprobe，由真实请求决定 health

### 2.1 核心原则

> **不做启动探测，每个 provider 冷启动后第一次请求无条件允许命中。命中后由真实结果决定 health。**

### 2.2 生命周期

```
启动
  → provider-health.json 导入旧 cooldown
  → 每个 provider 标记 persisted_503_reprobe_available = true
  → 不做 checkHealth()

首次真实请求
  → 选路时检查 persisted_503_reprobe_available
  → = true → 允许命中（无视 cooldown）
  → 命中后：
      成功 → record_success → 清 cooldown + state=healthy
      失败 → handle_provider_failure → trip_provider → 冷却

后续请求
  → 正常 health 梯队（cooldown 未过期 → 跳过，过期 → 允许重试）
```

### 2.3 与现有机制的关系

现有 `consume_persisted_503_reprobe_if_available()` 已实现"启动清 cooldown 一次性机会"，但**只在单 candidate 时触发**：

```rust
// selection.rs:159
if available.is_empty() && route_candidates.len() == 1 {
    let provider_key = &route_candidates[0];
    if self.is_singleton_provider_soft_available_from_rust_quota(env, provider_key)
        || self.health_manager.consume_persisted_503_reprobe_if_available(provider_key, now)
    {
        available.push(provider_key.clone());
    }
}
```

**本次改动**：放宽条件，多 candidate 时也允许 cooldown provider 被 `persisted_503_reprobe_available` 放行。

---

## 三、改动范围

### 3.1 删除 TS startup reprobe

| 文件 | 操作 |
|---|---|
| `src/server/runtime/http-server/provider-startup-reprobe.ts` | **删除** |
| `src/server/runtime/http-server/http-server-runtime-providers.ts:449` | 删除 `runStartupProviderReprobe` 调用 |
| `tests/server/http-server/provider-startup-reprobe.spec.ts` | **删除** |

### 3.2 放宽 Rust 选路过滤

| 文件 | 操作 |
|---|---|
| `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/selection.rs` | `collect_available_candidates()` 改为：多 candidate 时也调 `consume_persisted_503_reprobe_if_available` |

### 3.3 不改动

| 文件 | 保留原因 |
|---|---|
| `events.rs` handle_provider_success/failure/error | 运行时 health 驱动，正确 |
| `health.rs` consume_persisted_503_reprobe_if_available | 一次性清 cooldown 逻辑正确 |
| `provider-health.json` 持久化 | 冷却持久化正确 |
| `provider-startup-reprobe.ts` 调用方的 reprobe 逻辑 | 整个删除 |

---

## 四、选路过滤改动详解

### 4.1 当前 collect_available_candidates

```rust
fn collect_available_candidates(&mut self, env: Env, candidates: &[String]) -> Vec<String> {
    let mut available: Vec<String> = Vec::new();
    for key in candidates {
        if self.is_provider_available(env, key)
            || self.health_manager.consume_persisted_503_reprobe_if_available(key, now)
        {
            available.push(key.clone());
        }
    }
    // 单 candidate fallback：仅在 available 为空 && 只有 1 个 candidate 时
    if available.is_empty() && candidates.len() == 1 {
        if self.consume_persisted_503_reprobe_if_available(...) {
            available.push(...);
        }
    }
    available
}
```

**问题**：`consume_persisted_503_reprobe_if_available` 已在 for 循环内，但多 candidate 时如果所有 candidate 都在 cooldown 且 reprobe_available = true，for 循环会全部放行。**实际多 candidate 场景不阻塞。**

但单 candidate fallback 的 `route_candidates.len() == 1` 是多余的（for 循环已覆盖）。

### 4.2 改动

保持 for 循环内 `consume_persisted_503_reprobe_if_available` 调用（已有）。删除单 candidate fallback 中对 `consume_persisted_503_reprobe_if_available` 的重复调用（因为 for 循环已覆盖）。

**最小改动**：实际不需要改 `collect_available_candidates` 的核心逻辑，只需要确保 startup reprobe 被删除后 `persisted_503_reprobe_available` 仍由 `refresh_provider_health_from_store(true)` 初始化为 `true`。

---

## 五、验证标准

### 5.1 红测试门禁（必须先写，代码改动前跑红）

**Rust red tests**（必须 FAIL before fix，PASS after fix）：

1. `persisted_503_cooldown_provider_allowed_on_startup_first_request`
   - setup: 创建 provider + 导入 persisted cooldown
   - assert: `collect_available_candidates()` 返回该 provider（不为空）

2. `first_request_success_clears_cooldown`
   - setup: provider 在 cooldown，首次请求成功
   - assert: cooldown 被清，state=healthy

3. `first_request_failure_reapplies_cooldown`
   - setup: provider 在 cooldown，首次请求失败 503
   - assert: cooldown 被重新写入

**TS red tests**（必须 FAIL before fix，PASS after fix）：

4. `startup reprobe is not called`
   - setup: mock provider instance + hubPipeline
   - assert: `runStartupProviderReprobe` 不再被调用

### 5.2 回归（代码改动后全绿）

- `cargo test -p router-hotpath-napi --lib virtual_router_engine` 全绿
- `npm test -- tests/providers/forwarder-selection.test.ts --runInBand`
- `node scripts/build-core.mjs && npx tsc --noEmit`

---

## 六、风险

| 风险 | 缓解 |
|---|---|
| 冷启动首次请求 503 后 provider 被冷却到午夜 | 与现有一致（`__http_503_daily_cooldown__`） |
| 首次请求慢（冷 TLS 握手） | 与 startup reprobe 同等时间，但发生在真实请求路径 |
| 多 provider 同时冷启动 | 每个 provider 独立 `persisted_503_reprobe_available`，不影响其他 |
