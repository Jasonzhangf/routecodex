# P1 确定性修复执行计划（Hub）

## 1. 目标与验收标准
### 目标
在 Hub TS 层完成 P1 阶段“确定性替换不确定性”修复，清理 fallback/repair/coerce 语义残留，保证 fail-fast 与唯一真源一致性。

### 验收标准
- P1-1 ~ P1-4 全部落地，且不新增 fallback 分支。
- Hub 相关单测通过，`npm run build:min` 通过。
- 审计 grep 与门禁脚本可阻断新引入违规模式。

## 2. 范围与边界
### In Scope
- `sharedmodule/llmswitch-core/src/conversion/hub/**`
- P1 计划定义的 4 个任务：rules / heartbeat-directives / fastpath mapper / audit gate

### Out of Scope
- Provider Runtime 大规模重构
- Virtual Router 新增能力
- P2/P3 阶段迁移任务

## 3. 设计原则
1. No fallback：禁止降级、兜底、语义补偿。
2. Fail-fast：关键条件缺失显式失败/显式不可构建。
3. TS 薄壳化：TS 不再承担策略语义真源。
4. 改动最小化：仅触达 P1 指定文件与门禁脚本。

## 4. 技术方案（含文件清单）
### P1-1（已完成）
- 文件：`sharedmodule/llmswitch-core/src/conversion/hub/tool-governance/rules.ts`
- 方案：删除 `mapNativeRules(...) ?? fallbackBase` 策略 fallback；native 规则缺失显式抛错。

### P1-2（进行中）
- 文件：`sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-heartbeat-directives.ts`
- 方案：
  - 删除 `readTmuxSessionId(primary, fallback)` 双输入兜底模式。
  - 只读取结构化单一输入源（metadata）。
  - 缺字段时保持不可构建（不做语义合并补偿）。

### P1-3（待执行）
- 文件：`sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/chat-mapper-fastpath.ts`
- 方案：
  - 将 fastpath reject 的 `null/undefined` 分支结构化为 `FASTPATH_REJECT_*` reason code。
  - 上层只做分流判定，不进行语义修补。

### P1-4（待执行）
- 新增：Hub 审计门禁脚本（建议 `scripts/` 或现有 lint/check 体系内）
- 方案：阻断新增 `fallbackTo*` / `repair*` / 语义 `coerce*`，并维护 env 默认读取白名单。

## 5. 风险与规避
- 风险1：去兜底后触发历史隐式依赖。
  - 规避：按 P1 顺序逐步改动，每步跑定向测试。
- 风险2：fastpath reason code 改动引发断言不兼容。
  - 规避：保持行为等价（仅提升可观测性），同步更新测试断言。
- 风险3：门禁误报。
  - 规避：先建立最小白名单并在脚本内显式注释理由。

## 6. 测试计划
1. 定向测试
   - governance / ingress / execute-chat-process-entry
   - heartbeat 相关测试
   - fastpath / router-metadata / anthropic 兼容测试
2. 构建验证
   - `npm run build:min`
3. 审计验证
   - grep：`fallback|repair|coerce`（Hub 范围）
   - 门禁脚本本地执行

## 7. 实施步骤（顺序）
1. 完成 P1-2 heartbeat 去 fallback。
2. 跑 heartbeat + build:min。
3. 完成 P1-3 fastpath reason code。
4. 跑 fastpath/ingress/metadata/anthropic + build:min。
5. 完成 P1-4 门禁脚本与白名单。
6. 跑门禁 + 全套回归 + build:min。
7. 更新 summary（改动/验证/风险/下一步 + 唯一性论证）。

## 8. 完成定义（DoD）
- P1 四项全部完成并通过验证。
- Hub 范围无新增 fallback/repair/coerce 语义残留。
- 可重复执行门禁脚本，CI 可稳定拦截回归。
