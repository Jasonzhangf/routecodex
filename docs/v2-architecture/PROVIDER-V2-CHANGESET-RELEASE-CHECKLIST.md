# Provider V2 变更集发布检查清单

- Date: 2026-02-09
- Source branch: `main`
- Scope: 最近 4 个提交（架构草案 + validate 进程清理）

## 1) Changeset 映射

| Commit | 主题 | Wave/任务对应 | 风险级别 | 备注 |
|---|---|---|---|---|
| `167400e0b` | Provider V2 架构草案全集（113.1~113.5） | 113 规划阶段 | Low | 文档与 `.beads/issues.jsonl` |
| `8ea3ab778` | 文档约束增强（M10/M13/M16 + 验证门槛） | 113.5 审阅收敛 | Low | 文档与 `.beads/issues.jsonl` |
| `3857b25e6` | validate 启动/清理避免孤儿进程 | 运维/CLI 稳定性 | Medium | 运行时代码变更 |

## 2) 推荐 cherry-pick 顺序

## A. 生产热修（仅功能）

适用于先上修复，不带规划文档：

1. `ecf3dbe70`
2. `3857b25e6`

## B. 完整同步（功能 + 规划）

适用于将规划与执行基线一并对齐：

1. `167400e0b`
2. `8ea3ab778`
3. `ecf3dbe70`
4. `3857b25e6`

> 说明：两个 docs 提交都改了 `.beads/issues.jsonl`，建议按上述顺序连续 pick，避免 BD 冲突。

## 3) Mandatory Gate（功能提交必须）

对包含 `ecf3dbe70` / `3857b25e6` 的发布，至少执行：

1. 目标测试
   - `npm run jest:run -- --runTestsByPath tests/providers/core/runtime/http-transport-provider.headers.test.ts`
   - `npm run test:cli`
2. 类型与构建
   - `npx tsc --noEmit`
   - `npm run build:dev`
   - `npm run install:global`



```bash
npm run replay:codex-sample -- \
```

## Control（非受影响 provider）

```bash
npm run replay:codex-sample -- \
  --sample <control-sample-client-request.json> \
```

## 5) 风险与回滚点

- `ecf3dbe70`（High）
  - 回滚：直接回退该 commit；不影响其它文档提交。
- `3857b25e6`（Medium）
  - 关注：validate 自启 server 后停止逻辑、异常分支 cleanup。
  - 回滚：直接回退该 commit；不影响 provider 主链路。

## 6) 发布后观察建议

- 观察 validate 后是否仍残留 `routecodex`/`rcc start` 进程。
- 若异常，按单 commit 回滚并保留 same-shape/control 证据。

