# Provider V2 分阶段迁移与回滚方案（Draft）

- Status: Draft
- Date: 2026-02-09
- Owner: routecodex-113.4
- Strategy: 新实现主路径 + 旧实现影子路径；验证通过后移除旧实现

## 1. 迁移总原则（已确认）

本次 Provider 重构采用以下固定策略：

1. 对每个替换点，**新实现先成为主路径**。
2. 原实现保留为影子路径（shadow），并行执行只用于比对，不参与主响应。
3. 当测试与 replay 指标达标后，移除原实现。

> 该策略与“先实现、不连线”并不冲突：先完成可调用实现；进入连线阶段时采用“新主旧影子”的切换方式。

## 2. 影子模式定义

### 2.1 主路径（new-primary）

- 用户请求只返回新实现结果。
- 失败直接按 fail-fast 上报，不静默回落旧实现。

### 2.2 影子路径（legacy-shadow）

- 同 shape 输入驱动旧实现并记录输出。
- 不影响主请求响应。
- 仅记录：关键字段、错误类型、耗时、shape diff。

### 2.3 比对维度

- Request shape：endpoint、headers 关键字段、body 关键字段。
- Response shape：status、error envelope、核心 data path。
- Error classification：`statusCode / code / upstreamCode`。
- 性能：P50/P95 latency 增量。

## 3. 分阶段与 Gate

## Phase 0（设计冻结）

- 输入：`113.1/113.2/113.3` 草案已通过。
- 产出：替换点清单 + 每点 shadow 观测字段。

### Entry Gate

- ADR 决策冻结。
- 迁移矩阵完整（Mxx 对应关系清晰）。

### Exit Gate

- 每个 Mxx 指定 owner、wave、回滚键。

## Phase 1（实现不连线）

- 新增 kernel/protocol/profile 模块，但不接入主执行流。
- 增加模块级单测与样本对比。

### Entry Gate

- 模块接口与 registry 契约稳定。

### Exit Gate

- 单测通过。
- `npx tsc --noEmit` 通过。
- 不影响现网路径（零行为变化）。

## Phase 2（新主旧影子切换）

- 按 wave 逐批连线（Wave-1 iflow -> Wave-2 antigravity/gemini-cli -> Wave-3 清理层）。
- 连线后新实现主路径生效，旧实现影子并行观测。

### Entry Gate

- 该 wave 对应实现与测试准备完成。
- shadow 观测点已接入日志/快照。

### Exit Gate（每个 wave 必须全部满足）

1. 构建验证通过：
   - `npm run build:dev`
   - `npm run install:global`
2. 类型与单测通过：
   - `npx tsc --noEmit`
   - 该 wave 相关测试集全绿
3. 回放验证通过：
   - 至少一组 same-shape replay（目标 provider）
   - 至少一组 control replay（不受影响 provider）
4. shadow 比对达标：
   - 无 P0/P1 shape diff
   - 关键错误分类一致率达标（建议 >= 99%）

## Phase 3（移除旧实现）

- 在 wave exit gate 连续达标后，删除对应 legacy 代码路径。
- 删除后执行全量回归与 replay。

### Entry Gate

- 连续 N 次（建议 3 次）回放稳定。
- 无新增高优先级缺陷。

### Exit Gate

- 旧实现路径删除完成。
- 文档与测试更新完成。
- `bd` 任务附证据后关闭。

## 4. 回滚策略

## 4.1 回滚触发条件

任一条件满足即回滚该 wave：

- 新主路径出现 P0/P1 功能偏差。
- 关键 provider 出现不可接受错误激增（例如 4xx/5xx 激增）。
- same-shape 或 control replay 失败。

## 4.2 回滚动作

1. 停止该 wave 的继续连线。
2. 切回旧实现主路径（保留新实现为影子，定位差异）。
3. 保留失败证据（requestId/providerKey/route/model/before-after diff）。
4. 修复后重新走该 wave gate，不跨级推进。

## 4.3 回滚粒度

- 以 wave 为最小回滚单位。
- wave 内可按 provider family 子单元回滚（例如仅回滚 iflow）。

## 5. Wave 拆分建议

### Wave-1（iflow）

- 包含 M01~M07 + M18(iflow)。
- 核心目标：iflowWebSearch 去重、UA/signature、business envelope 归一。

### Wave-2（antigravity/gemini-cli）

- 包含 M09/M10/M12/M14/M17。
- 核心目标：fallback/error wrapping/header policy 下沉。

### Wave-3（协议/工厂/目录清理）

- 包含 M11/M13/M15/M16。
- 核心目标：protocol adapter 定型、factory 仅装配、目录映射单一事实源。

## 6. 证据模板（任务关闭必填）

每个 wave 的 BD 关闭 notes 至少包含：

- 构建/类型/测试命令与结果。
- same-shape replay 证据（requestId、providerKey、model、route）。
- control replay 证据（不受影响 provider）。
- shadow 比对摘要（diff 数、严重级别、结论）。
- 回滚演练结果（如有）。

## 7. 执行纪律

- 不允许同时连线多个高风险 family。
- 不允许在未达 gate 时删除旧实现。
- 不允许把 compat 逻辑迁入 provider transport。

