# Error Policy Center Audit Fix Plan

## 目标
修复错误处理中心审计发现的 3 个 gap，使错误链行为与规则 3a-3e 对齐。

## 审计发现（2026-06-07）

| 规则 | 状态 | 差异 |
|---|---|---|
| 3a VR pool 有候选不上报 | 已修复 | executor 之前会继续上报 health impact；现在 pool 有替代候选时 `affectsHealth=false` |
| 3b default 保底池 | 已确认 | default 池仍由 Rust Virtual Router selection 作为最后保底；本目标不改 selection |
| 3c 切候选不上报 | 已修复 | 同 3a，切候选时不 mutate VR health |
| 3d 瞬态/非瞬态 cooldown | 已修复 | 429 ladder 从 `10m -> 30m -> 5h` 改为 `30m -> 3h -> 3h` |
| 3e 重启 reprobe 后直接 3h | 已修复 | persisted 503 reprobe 消费后预置 recoverable ladder；首次失败直接 3h |

## 验收标准
- 3a/3c：pool 有替代候选时，error 不 mutate VR health state。
- 3d：429 cooldown ladder 统一为 `30m -> 3h -> 3h`。
- 3e：重启 reprobe 失败后，provider 直接进入 3h cooldown。
- 定向 TS/Rust 测试通过。
- `npm run build:min` 通过。
- `pnpm test` 通过，或明确证明失败与本目标无关。

## 范围与边界

### In Scope
- executor 层 `affectsHealth` 覆盖。
- Rust `health.rs` 429 ladder 统一。
- Rust `health.rs` persisted 503 reprobe cooldown 预置。

### Out of Scope
- provider-failure-policy-impl.ts 分类逻辑。
- ErrorHandlingCenter 投影层。
- VR selection / default 池选择逻辑。
- auto-retry 机制。
- 按 fingerprint 重新定义瞬态/非瞬态策略。
- 扩展所有 cooldown 类型的 persisted reprobe。

## Phase 1：pool 有候选 -> 不 mutate health

### 唯一修改点
- `src/server/runtime/http-server/executor/request-executor-provider-failure.ts`
- `src/server/runtime/http-server/executor/request-executor-provider-failure-plan.ts`
- `src/server/runtime/http-server/executor/request-executor-error-types.ts`
- `tests/server/runtime/http-server/executor/request-executor-provider-health-impact.spec.ts`

### 方案
在 provider failure report 进入 `emitProviderErrorAndWait` 前，根据当前 route pool 判断是否仍有严格替代候选：

```typescript
const hasPoolAlternative = hasStrictAlternativeRouteCandidate({
  providerKey: args.providerKey,
  routePool: args.routePool,
  excludedProviderKeys: args.excludedProviderKeys
});

await emitProviderErrorAndWait({
  ...existingArgs,
  affectsHealth: hasPoolAlternative ? false : outcome.affectsHealth
});
```

### 红测
- pool 中有 `provider.b` 可切：`affectsHealth=false`。
- singleton pool：`affectsHealth=true`。

## Phase 2：统一 429 cooldown ladder

### 唯一修改点
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/health.rs`

### 方案
将 `next_ladder_cooldown_ms` 从 `10m -> 30m -> 5h` 改为 `30m -> 3h -> 3h`，并物理删除不再使用的 `10m` / `5h` ladder 常量。

```rust
fn next_ladder_cooldown_ms(cycles: i64) -> i64 {
    match cycles {
        i64::MIN..=0 => LADDER_COOLDOWN_30M_MS,
        _ => LADDER_COOLDOWN_3H_MS,
    }
}
```

### 红测
- HTTP 429 cycle 0 -> cooldown 30m。
- HTTP 429 cycle 1 -> cooldown 3h。
- HTTP 429 cycle 2+ -> cooldown 3h。

## Phase 3：重启 reprobe 失败 -> 直接 3h

### 唯一修改点
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/health.rs`

### 方案
`consume_persisted_503_reprobe_if_available` 消费 reprobe 时预置：

```rust
state.consecutive_recoverable_failures = self.config.failure_threshold - 1;
state.recoverable_cooldown_cycles = 1;
```

reprobe 后首次 recoverable failure 会立即 trip，并使用 cycle 1 的 3h cooldown。

### 红测
- persisted 503 reprobe 成功：provider 保持 healthy。
- persisted 503 reprobe 失败：单次 recoverable failure 直接 3h cooldown。

## 验证矩阵

| 验证 | 命令 |
|---|---|
| Phase 1 health impact | `npm run jest:run -- --runTestsByPath tests/server/runtime/http-server/executor/request-executor-provider-health-impact.spec.ts --forceExit` |
| executor failure plan | `npm run jest:run -- --runTestsByPath tests/server/runtime/http-server/executor/request-executor-provider-failure-plan.spec.ts --runInBand --forceExit` |
| Rust health | `cargo test --manifest-path sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/Cargo.toml -- virtual_router_engine::health` |
| build | `npm run build:min` |
| full gate | `pnpm test` |

## 完成定义
- 3 个 gap 全部修复。
- 红测已转绿。
- `npm run build:min` 通过。
- `pnpm test` 通过，或确认失败不由本目标引入并记录证据。
