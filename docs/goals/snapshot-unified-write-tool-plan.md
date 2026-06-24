# Snapshot 统一写盘工具方案（2026-06-22）

## 1. 问题陈述

当前 snapshot 写盘散在 3 处，各自独立控制参数：

| 写盘点 | owner | 问题 |
|---|---|---|
| `src/utils/snapshot-writer.ts::writeServerSnapshot` | `snapshot.stage_contract` | server 独立写盘 + hook fallback，无统一参数约束 |
| `src/providers/core/utils/snapshot-writer.ts::writeProviderSnapshot` | `snapshot.provider_error_buffer` | provider 独立写盘 + hook fallback，与 server writer 结构重复 |
| `src/debug/snapshot-store.ts::FileSnapshotStore` | `debug.unified_surface` | debug 独立 jsonl store，与 writer 不共享 path/index 语义 |

参数面散在：
- CLI: `--snap` / `--snap-stages` / `--snap-off`
- runtime: `globalThis.rccSnapshotsEnabled` / `runtimeFlags.snapshotsEnabled`
- env: `ROUTECODEX_SNAPSHOT_*` / `RCC_SNAPSHOT_*`
- hook: `writeSnapshotViaHooks(...)` — 被两个 writer 各自调用，等于没有唯一入口

**目标**：全局唯一写盘工具 + 统一命令/参数控制。

## 2. 目标架构

### 2.1 唯一写盘工具

```
src/debug/snapshot/
  writer.ts          # 唯一写盘入口（canonical builder: createSnapshotWriter）
  types.ts          # 统一 SnapshotWriteInput / SnapshotWriteOptions
  router.ts         # 统一 stage → path mapping（取代 server/provider writer 内部分片逻辑）
  queue.ts          # 统一内存队列（取代 provider snapshot-writer-buffer）
  inspect.ts        # 统一读盘（取代 scripts/snapshot-inspect.mjs）
```

**禁止**：
- `src/utils/snapshot-writer.ts` 和 `src/providers/core/utils/snapshot-writer.ts` 不得直接 `fs.writeFile`
- server/provider writer 不得各自 import `writeSnapshotViaHooks`

**迁移后**：
- `src/utils/snapshot-writer.ts` → 只剩 shell re-export 调用 `src/debug/snapshot/writer.ts`
- `src/providers/core/utils/snapshot-writer.ts` → 同上
- M9 删除旧 writer 文件

### 2.2 统一命令

新 CLI 子命令：`routecodex snapshot`

```
routecodex snapshot --rid <id> [--endpoint openai-responses|openai-chat|anthropic-messages] [--stage <stage>] [--list] [--purge]
routecodex snapshot --inspect <file> [--diff]
```

参数约束：
- `--snap` / `--snap-stages` / `--snap-off` 改为内部调用 `routecodex snapshot` API，不在 server start 直接传参
- 删除 `--snap` / `--snap-stages` / `--snap-off` 独立 CLI flag

### 2.3 统一参数合约

```typescript
// 唯一写盘输入
interface SnapshotWriteInput {
  scope: 'server' | 'provider' | 'client';   // 替换 server/provider/client 三散点
  stage: string;                               // server phase / provider phase / client phase
  requestId: string;
  groupRequestId?: string;
  providerKey?: string;
  entryEndpoint?: string;                      // 替代散在 env/env/globalThis 的 endpoint 判断
  entryPort?: number;
  data: unknown;                              // 已在 writer 内部做 redact
  verbosity?: 'default' | 'verbose';          // 统一 verbose 控制
  flush?: 'immediate' | 'queue';              // 替代 provider buffer 队列逻辑
}
```

环境变量全部收敛：
- `ROUTECODEX_SNAPSHOT_ENABLE`（替代 `ROUTECODEX_SERVER_SNAPSHOT_FORCE_DUAL_WRITE` / `rccSnapshotsEnabled` / `runtimeFlags.snapshotsEnabled`）
- `ROUTECODEX_SNAPSHOT_STAGES`（替代 `--snap-stages` 字符串解析）
- `ROUTECODEX_SNAPSHOT_SCOPE`（替代 server/provider 分别的 stage gate）
- `ROUTECODEX_SNAPSHOT_ROOT`（替代 `resolveRccSnapshotsDirFromEnv` 散在多处）

## 3. 迁移顺序（对齐 debug.unified_surface M0~M9）

| 阶段 | 目标 | 改动文件 |
|---|---|---|
| M2（已完成） | `FileSnapshotStore` roundtrip/index/clear 语义统一 | `src/debug/snapshot-store.ts` |
| M3 | server writer 收口到 debug snapshot writer shell | `src/utils/snapshot-writer.ts` → 薄壳 |
| M4 | provider writer 收口到 debug snapshot writer shell | `src/providers/core/utils/snapshot-writer.ts` → 薄壳 |
| M5 | logger surface 收口（与 snapshot 无关，并行） | `src/modules/pipeline/utils/debug-logger.ts` |
| M6 | harness/replay surface 收口 | `src/debug/harness/*` |
| M7 | provider hook surface 收口 | `src/providers/core/hooks/debug-example-hooks.ts` |
| M8 | policy violation surface 收口 | `src/debug/policy/*` |
| M9 | 删除旧 writer，删除旧 debug facade，接入总门禁 | `src/utils/snapshot-writer.ts` / `src/providers/core/utils/snapshot-writer.ts` / `src/debug/index.ts` facade 清理 |

**M3/M4 禁止事项**：
- server writer 壳层不得自行 `fs.writeFile`
- provider writer 壳层不得自行维护队列状态
- 两者都只调 `src/debug/snapshot/writer.ts`

## 4. metadata 边界

- snapshot writer 内部调用 `redactSensitiveData`（已在 `src/utils/sensitive-redaction.ts`）
- snapshot metadata 不得写入 provider wire payload 或 client response body
- `debug_snapshot` family 边界不变（`docs/architecture/metadata-center-manifest.yml`）

## 5. 完成标准

1. `src/debug/snapshot/writer.ts` 存在并持有唯一 canonical builder `createSnapshotWriter`
2. `src/utils/snapshot-writer.ts` 和 `src/providers/core/utils/snapshot-writer.ts` 全部调用 `src/debug/snapshot/writer.ts`
3. `src/debug/snapshot/writer.ts` 内部 `fs.writeFile` 路径统一（不多处散写）
4. 新 CLI `routecodex snapshot` 命令存在
5. 所有 `ROUTECODEX_SNAPSHOT_*` / `RCC_SNAPSHOT_*` env 只在 `src/debug/snapshot/writer.ts` 和 `src/config/snapshot-config.ts` 中出现
6. M3 focused test 锁 server writer 只走 debug writer，provider 同理
7. `npm run verify:function-map-compile-gate` PASS
8. M9：旧 writer 文件物理删除，git log 注明原因
