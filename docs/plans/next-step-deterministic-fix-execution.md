# 下一步修复方案（执行版）

## 范围
仅执行 Hub P1：`docs/plans/p1-deterministic-fix-plan.md`

## 当前状态
- P1-1：已完成（移除 tool-governance 策略 fallback）
- P1-2：进行中（heartbeat directives 去泛型 fallback）
- P1-3：待执行（fastpath reject reason 可观测化）
- P1-4：待执行（fallback/repair/coerce 门禁脚本）

## 下一步执行顺序（严格）
1. 完成 P1-2
   - 文件：`sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-heartbeat-directives.ts`
   - 动作：
     - 移除 `readTmuxSessionId(primary, fallback)` 双输入语义
     - 只接受结构化单一输入源（metadata）
     - 关键字段缺失保持显式不可构建（不引入兜底合并）
2. 执行 P1-2 验证
   - heartbeat 相关测试
   - `npm run build:min`
3. 执行 P1-3
   - 文件：`sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/chat-mapper-fastpath.ts`
   - 动作：
     - 将 `null/undefined` 的拒绝点映射为结构化 reason code（`FASTPATH_REJECT_*`）
     - 上层仅判断是否走主路径，不做语义修补
4. 执行 P1-3 验证
   - fastpath / ingress / router-metadata / anthropic 相关测试
5. 执行 P1-4
   - 新增轻量门禁脚本（Hub 范围）
   - 禁止新增：`fallbackTo*` / `repair*` / 语义 `coerce*`
   - 仅允许 env 默认读取白名单
6. 执行 P1-4 验证
   - grep 审计 + CI 脚本本地跑通
   - `npm run build:min`

## 通过标准
- 不新增任何 fallback/降级/兜底路径
- 测试与构建通过
- summary 必须给出：改动、验证证据、剩余风险、下一步
