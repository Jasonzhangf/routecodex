# stopless -> 原始 `/goal` 增强合同设计

## 索引概要
- L1-L8 `purpose`：本设计文档定义“兼容原始 `/goal`，并把 stopless 强约束迁入 `/goal`”的唯一方向。
- L10-L24 `ssot`：`/goal` 真源、当前 stopless 真源、为什么不能做第二套协议。
- L26-L54 `architecture`：唯一入口、唯一状态真相、续轮 owner、host 校验 owner。
- L56-L129 `transition-contract`：`update_goal` 增强字段、各状态迁移必填项、拒绝策略。
- L131-L170 `error-convergence`：连续不可逆错误、连续校验失败、无进展循环的收敛规则。
- L172-L207 `routing-impact`：当前代码链上的落点与已完成/待完成收口。
- L209-L236 `verification`：验证矩阵。
- L238-L252 `goal-prompt-shape`：面向 `/goal` 提示词的约束摘要。
- L254-L264 `uniqueness`：为什么这是唯一正确方向。

## 目标

把 RouteCodex 当前 stopless 从“`reasoning.stop` 注入 + finalized marker 合同”收口到**原始 `/goal` 生命周期**上，同时保留旧 stopless 最有价值的强约束：

1. **停止必须给理由**
2. **完成必须给证据**
3. **无法继续必须给阻塞证据**
4. **连续不可逆错误/连续治理失败必须停机，而不是死循环**

本设计明确拒绝两种错误方向：

- **错误方向 A：** 另造第二套 goal 协议，和原始 `/goal` 并行。
- **错误方向 B：** 让模型可以随便把 goal 状态写成 `completed/stopped`，弱化 stopless 的证明强度。

## 唯一真源

### 原始 `/goal`

`/goal` 的 thread lifecycle 真源在 `~/code/codex`：

- `codex-rs/tui/src/chatwidget/slash_dispatch.rs`
- `codex-rs/core/src/tools/handlers/goal_spec.rs`
- `codex-rs/core/src/goals.rs`
- `codex-rs/core/templates/goals/continuation.md`

结论：

- `/goal` 已经是**唯一生命周期入口**
- RouteCodex 不应该再发明一套“像 `/goal` 但不是 `/goal`”的控制面

### 当前 stopless 的强约束价值

旧 stopless 真正有价值的不是名字 `reasoning.stop`，而是它强制模型在停机前交出结构化理由：

- completed 时给 `completion_evidence`
- 继续时给 `next_step`
- 无法继续时给 `cannot_complete_reason / blocking_evidence`
- 用户输入时给 `user_question`

结论：

> 要删除的是 legacy tool surface，  
> 不是 stopless 的强治理能力。

## 架构结论

### 1. `/goal` 仍是唯一入口

生命周期动作仍然只认：

- `get_goal`
- `create_goal`
- `update_goal`
- `request_user_input`

不再新增第二套“专用 stopless goal tool”。

### 2. `update_goal` 变成增强版 transition contract

`update_goal` 不再只是“把状态写成某个值”，而是：

- **状态跃迁动作**
- **必须附带 stopless 风格的证明字段**

也就是：

> `/goal` 负责 lifecycle shell  
> stopless proof 负责 transition validation kernel

### 3. response 侧只读“校验后的状态”

续轮/停机不看模型口头说法，只看 host 接受后的状态：

- `active` -> 允许续轮
- `paused` -> 等用户输入
- `stopped` -> 终止
- `completed` -> 收口完成

### 4. host 必须维护治理计数

host 维护的 runtime 真相至少包括：

- `consecutive_irrecoverable_errors`
- `consecutive_validation_failures`
- `repeated_no_progress_count`

这些是 **host owner**，不是模型 owner。

## `update_goal` 增强合同

### 推荐字段结构

```ts
type GoalStatus = 'active' | 'paused' | 'stopped' | 'completed';

type SsotAssessment = {
  work_type: 'bug_fix' | 'feature_dev' | 'analysis_only' | 'ops' | 'refactor';
  rationale: string;
  is_best_fix_point?: boolean;
};

type GoalErrorClass =
  | 'irrecoverable_tool_error'
  | 'irrecoverable_env_error'
  | 'irrecoverable_dependency_error'
  | 'irrecoverable_contract_failure'
  | 'repeated_no_progress'
  | 'user_input_required'
  | 'completed';

type UpdateGoalPayload = {
  status: GoalStatus;
  next_step?: string;
  progress_summary?: string;
  user_question?: string;
  cannot_continue_reason?: string;
  blocking_evidence?: string;
  attempts_exhausted?: boolean;
  error_class?: GoalErrorClass;
  completion_evidence?: string;
  completion_summary?: string;
  ssot_assessment?: SsotAssessment;
};
```

### 迁移规则 A：`active -> active`

表示继续下一轮。

必填：

- `status = "active"`
- `next_step`

推荐：

- `progress_summary`

host 最低校验：

- `next_step` 非空

校验失败：

- 拒绝状态更新
- 增加一次 `validation_failure`
- 保持 active，要求补足 next_step

### 迁移规则 B：`active -> paused`

表示需要用户输入，不是完成，也不是失败。

必填：

- `status = "paused"`
- `user_question`
- `cannot_continue_reason`

host 最低校验：

- 两字段都非空

校验失败：

- 拒绝 pause
- 增加一次 `validation_failure`

### 迁移规则 C：`active -> stopped`

表示无法继续，或必须 fail-fast 收敛。

必填：

- `status = "stopped"`
- `blocking_evidence`
- `attempts_exhausted = true`
- `error_class`

host 最低校验：

- `blocking_evidence` 非空
- `attempts_exhausted === true`
- `error_class` 非空

校验失败：

- 拒绝 stop
- 增加一次 `validation_failure`

### 迁移规则 D：`active -> completed`

表示真正完成。

必填：

- `status = "completed"`
- `completion_evidence`
- `completion_summary`
- `ssot_assessment`

host 最低校验：

- `completion_evidence` 非空
- `completion_summary` 非空
- `ssot_assessment` 非空

说明：

- host 可以不做深语义判断
- 但必须拒绝“已完成 / done / fixed”这种无证据口头完成

校验失败：

- 拒绝 completed
- 增加一次 `validation_failure`

### 禁止的状态迁移

若未显式设计 reopen 语义，默认禁止：

- `completed -> active`
- `stopped -> active`
- `completed -> paused`
- `stopped -> completed`

## 错误收敛规则

### 1. 连续不可逆错误 >= 2

host 强制 stop。

适用：

- 不可恢复工具错误
- 不可恢复环境错误
- 缺关键前提且当前无解
- 连续 contract 严重失败

强制 stop 结果建议写成：

```ts
{
  status: 'stopped',
  error_class: 'irrecoverable_contract_failure' | 'irrecoverable_tool_error' | 'irrecoverable_env_error',
  attempts_exhausted: true,
  blocking_evidence: '...host synthesized evidence...'
}
```

### 2. 连续校验失败 >= 2

host 强制 stop。

适用：

- completed 但不给 evidence
- paused 但不给 question
- stopped 但不给 blocking evidence

这是治理失败，不是业务失败。

### 3. 重复无进展 >= 3

host 强制 stop 或 pause，默认优先 stop。

适用：

- 连续三轮 `next_step / progress_summary` 实质重复
- active goal 连续 plain-stop，且没有任何合法 `create_goal/update_goal` 迁移
- 没有新增证据
- 没有状态推进

默认 error class：

- `repeated_no_progress`

## 路由与实现影响

### 已经收口的部分

当前代码已开始向这个方向靠拢：

- `src/server/runtime/http-server/executor/servertool-request-normalizer.ts`
  - 从原始 request / captured request 中同步 goal state
- `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
  - goal-capable request / managed goal followup 保留真实 tool surface
- `sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-state.ts`
  - RCC fence 解析出的 goal directive 已能写入 sticky `stoplessGoalState`
- `sharedmodule/llmswitch-core/src/servertool/handlers/stopless-goal-guard.ts`
  - `status === active` 时自动 followup
  - 连续 3 次 plain-stop / 口头完成但无合法 goal transition 时强制 `stopped`

### 仍需补齐的关键缺口

本轮已经落地的关键收口：

1. `provider-response-tool-validation-blocks.ts`
   - `create_goal/update_goal` 保留 **shape-only** 最小结构校验
   - 不再在 validator 层做审计式强阻断
2. `provider-response-converter.ts`
   - 只把**校验后的** goal tool call 投影进 `stoplessGoalState`
   - host 侧承担 transition proof enforcement 与 error ledger
   - `update_goal` 缺证明字段 -> host 拒绝迁移，并累计 validation ledger
   - `CLIENT_TOOL_ARGS_INVALID` 连续 2 次 -> 强制 `stopped`
   - `provider.followup` 不可逆失败连续 2 次 -> 强制 `stopped`
   - 不做 `next_step` 文本语义比对；active 合法续轮只看 control block

仍未完成的缺口已经收窄为：

1. live 验证
2. legacy `reasoning.stop` 残余面继续物理删除
3. 文档/提示词与最终 owner 的再收口

### 关于 legacy `reasoning.stop`

旧链路的处理原则：

- 删除 `reasoning.stop` 的 request-side 注入 owner
- 删除 prepass/host contract owner
- 若短期保留部分 handler，只能作为待删兼容壳，不能继续作为 stopless 真相

## 验证矩阵

### 单测

1. `/goal` transition validator：
   - active -> active 缺 `next_step` 拒绝
   - active -> paused 缺 `user_question` 拒绝
   - active -> stopped 缺 `blocking_evidence` 拒绝
   - active -> completed 缺 `completion_evidence` 拒绝

2. error ledger：
   - 连续 2 次 irrecoverable error 强制 stopped
   - 连续 2 次 validation failure 强制 stopped
   - 连续 3 次 plain-stop / 缺 goal control block 强制 stopped

3. lifecycle / followup：
   - active 续轮
   - paused/stopped/completed 不续轮

### 回归

- goal tools 透明传输
- `request_user_input` 透明传输
- 非 goal 普通请求无回归

### 构建

- `cd sharedmodule/llmswitch-core && npx tsc -p tsconfig.json --noEmit`
- `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
- `npm run build:min`

### live

至少验证：

1. `/goal create_goal`
2. `/goal update active` 携带 `next_step`
3. `/goal update paused` 携带 `user_question`
4. `/goal update completed` 携带 `completion_evidence`
5. 连续错误触发 stopped 收敛

未做 live，不得宣称完成。

## `/goal` 提示词约束摘要

提示词必须明确要求模型：

- 若继续（active），必须给 `next_step`
- 若暂停（paused），必须给 `user_question` 与 `cannot_continue_reason`
- 若停止（stopped），必须给 `blocking_evidence`、`attempts_exhausted=true`、`error_class`
- 若完成（completed），必须给 `completion_evidence`、`completion_summary`、`ssot_assessment`
- 连续两次非法状态更新会被强制停止

可直接复用的精简 `/goal` 提示词：

```text
/goal
目标：把 RouteCodex 当前 stopless 收口到原始 /goal 生命周期；删除 legacy reasoning.stop 注入 / stop contract owner，同时保留 stopless 的强证明治理。

设计文档：
- docs/design/stopless-to-goal-mode.md
- docs/design/stopless-goal-runtime-refactor-plan.md
- docs/design/rcc-unified-fence-marker-spec.md

执行规范：
- /goal 是唯一生命周期入口，禁止新增第二套 stopless goal tool。
- 禁止 fallback / 静默降级 / 伪造工具面；goal mode 下不得再注入 reasoning.stop。
- validator 只做 shape-only 最小校验；transition proof enforcement 与 error ledger 由 host goal state owner 承担。
- response / followup 只能读取校验后的 goal state，不相信模型口头 completed / stopped。

状态合同：
- active -> active：必须给 next_step
- active -> paused：必须给 user_question + cannot_continue_reason
- active -> stopped：必须给 blocking_evidence + attempts_exhausted=true + error_class
- active -> completed：必须给 completion_evidence + completion_summary + ssot_assessment

收敛规则：
- 连续不可逆错误 >= 2 强制 stopped
- 连续校验失败 >= 2 强制 stopped
- 连续无进展 >= 3 强制 stopped

验证：
- 定向单测：goal transition / error ledger / followup lifecycle
- 构建：sharedmodule tsc、native build、npm run build:min
- live：create_goal / active / paused / completed / 连续错误 stopped

完成标准：
- goal mode 下不再 seed / inject / enforce legacy reasoning.stop 主合同
- /goal 生命周期与 stopless 强证明约束收敛到同一 state owner
- live 未做不得宣称完成
```

## 为什么这是唯一正确方向

1. 用户明确要求**兼容原始 `/goal`**，因此不能再造第二套协议。
2. 用户明确要求保留旧 stopless 的“停机必须给理由”强度，因此不能退化成自由写状态。
3. 只有“原始 `/goal` 生命周期 + stopless 证明合同 + host 收敛阈值”三者同时成立，才能既兼容 Codex，又不弱化治理能力。
