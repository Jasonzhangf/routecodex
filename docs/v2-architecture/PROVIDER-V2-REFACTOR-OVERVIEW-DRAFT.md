# Provider V2 重构总览（Draft）

- Status: Draft
- Date: 2026-02-09
- Epic: routecodex-113
- Working Mode: 先实现、不连线；连线时采用“新主旧影子”，通过 gate 后移除旧实现

## 1) 已冻结决策

1. 分层固定为：`Kernel -> 4 Protocol -> Family Profile`
2. 四协议固定为：
   - openai-chat
   - openai-responses
   - anthropic-messages
   - gemini-chat（Gemini CLI 作为 Gemini 协议变体长期保留）
3. 配置显式字段 `providerProtocol + providerId + compatibilityProfile` 决定：
   - Protocol Adapter
   - Family Profile
   - Compat Profile
4. `providerId/providerFamily` 的单一事实来源：配置文件 + provider 目录映射。

## 2) 子任务产出总览

- `routecodex-113.1`：分层 ADR 草案
  - `docs/v2-architecture/PROVIDER-V2-LAYERING-ADR-DRAFT.md`
- `routecodex-113.2`：特判盘点与迁移矩阵
  - `docs/v2-architecture/PROVIDER-V2-MIGRATION-MATRIX-DRAFT.md`
- `routecodex-113.3`：Profile API 与 Registry 机制
  - `docs/v2-architecture/PROVIDER-V2-PROFILE-API-REGISTRY-DRAFT.md`
- `routecodex-113.4`：分阶段迁移与回滚
  - `docs/v2-architecture/PROVIDER-V2-PHASED-MIGRATION-ROLLBACK-DRAFT.md`
- `routecodex-113.5`：验证矩阵与 Replay 模板
  - `docs/v2-architecture/PROVIDER-V2-VERIFICATION-MATRIX-DRAFT.md`

## 3) 执行顺序（建议）

## Phase A：实现不连线

- 新建 profile contracts / registry / provider-directory
- 新建 family profiles（iflow、antigravity、qwen、gemini）
- 新建 protocol adapters（4 协议）
- 只加单测，不改主路径

## Phase B：分 wave 连线（新主旧影子）

- Wave-1：iflow
- Wave-2：antigravity / gemini-cli
- Wave-3：protocol/factory/service-profile/provider-type 清理

## Phase C：旧实现移除

- 每个 wave 连续达标后删除对应 legacy 路径
- 删除后重新跑 build/install/tsc/replay

## 4) Gate（摘要）

每个 wave 的退出 gate 必须包含：

- `npm run build:dev`
- `npm run install:global`
- `npx tsc --noEmit`
- wave 目标测试集
- same-shape replay（目标 provider）
- control replay（未受影响 provider）
- shadow diff 指标达标（P0/P1 diff=0）

## 5) 回滚规则（摘要）

触发条件（任一）：

- P0/P1 功能偏差
- 错误率异常升高
- same-shape/control replay 失败

回滚动作：

- 回切到旧主路径
- 新实现保留影子继续对比
- 修复后重走该 wave gate

## 6) 当前建议提交范围（仅架构草案）

可提交：

- `.beads/issues.jsonl`
- `docs/v2-architecture/PROVIDER-V2-REFACTOR-OVERVIEW-DRAFT.md`
- `docs/v2-architecture/PROVIDER-V2-LAYERING-ADR-DRAFT.md`
- `docs/v2-architecture/PROVIDER-V2-MIGRATION-MATRIX-DRAFT.md`
- `docs/v2-architecture/PROVIDER-V2-PROFILE-API-REGISTRY-DRAFT.md`
- `docs/v2-architecture/PROVIDER-V2-PHASED-MIGRATION-ROLLBACK-DRAFT.md`
- `docs/v2-architecture/PROVIDER-V2-VERIFICATION-MATRIX-DRAFT.md`

建议暂不纳入本次（与架构草案无关/另案处理）：

- `AGENTS.md`
- `package.json`
- `package-lock.json`
- `src/build-info.ts`
- `src/commands/validate.ts`
- `src/providers/core/runtime/http-transport-provider.ts`
- `tests/providers/core/runtime/http-transport-provider.headers.test.ts`

