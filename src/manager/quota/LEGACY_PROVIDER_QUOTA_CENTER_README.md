# Legacy provider-quota-center.ts 说明

## 状态 (X7E Phase 1)

此文件 (`provider-quota-center.ts`) 现在是 **Legacy 兼容壳 (compatibility shell)**。

### 背景

在 X7E Phase 1 之前，`provider-quota-center.ts` 是 quota 状态机的主要实现，被以下模块直接使用：
- `provider-quota-daemon.ts` (Legacy daemon)
- `antigravity-quota-manager.ts` (QuotaManagerModule)

### 当前状态

X7E Phase 1 已引入 **QuotaManagerAdapter** (`src/manager/modules/quota/quota-adapter.ts`)，它统一了 quota 操作的入口：

```
┌─────────────────────────────────────────────────────────────┐
│                    QuotaManagerAdapter                      │
│              (Phase 1: Single Source of Truth)              │
└───────────────────────┬─────────────────────────────────────┘
                        │
            ┌───────────┴───────────┐
            │                       │
    ┌───────▼────────┐      ┌───────▼────────┐
    │  Core Quota    │      │  Legacy Daemon │
    │  Manager       │      │  (deprecated)  │
    └────────────────┘      └────────────────┘
```

### 此文件的保留内容

1. **Type exports** - 供现有代码在迁移期间使用
2. **Pure functions** - `createInitialQuotaState`, `applyErrorEvent`, `applySuccessEvent`, `tickQuotaStateTime` 等（无副作用，仅用于 legacy 兼容）
3. **Constants** - cooldown schedules, error codes

### 禁止事项

- ❌ 不要在此文件添加新的状态更新入口
- ❌ 不要在此文件直接操作全局状态
- ❌ 新的 quota 逻辑请走 `QuotaManagerAdapter`

### 迁移完成后

此文件将被完全移除，其类型定义会迁移到 `provider-quota-daemon.types.ts` 或 core 模块。

---
Last updated: X7E Phase 1 (2026-02-13)
