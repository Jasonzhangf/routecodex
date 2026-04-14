# Reasoning Stop / Stopless Lifecycle

## 1. Scope

本文定义 `reasoning.stop` / `stopless:on` / `stopless:endless` 的真实需求与唯一停止条件。

目标：

1. `stopless` 只影响“模型准备停止时”的自检与续轮。
2. `reasoning.stop` 是停止前的结构化闸门，不是普通业务工具。
3. `endless` 语义必须与实现一致，禁止出现“文档允许、代码禁止”或“提示词允许、validator 拦截”的矛盾。

## 2. 指令语义

### 2.1 `<**stopless:on**>`

- 默认继续执行，不要直接 stop。
- 停止前必须先调用 `reasoning.stop` 做结构化自检。
- 允许停止的情况：
  1. **任务已完成**；
  2. **已穷尽可行尝试且遇到不可抗阻塞**。

### 2.2 `<**stopless:endless**>`

- 比 `on` 更强调“只要还有 next_step 就继续执行”。
- 但 **不是绝对禁止停止**。
- 允许停止的情况同样只有两类：
  1. **任务已完成**；
  2. **已穷尽可行尝试且遇到不可抗阻塞**。

> 结论：`endless` 的真实需求是“默认强制继续”，不是“永不停止”。

## 3. Canonical stop conditions

### 3.1 完成态停止

当且仅当：

- `is_completed = true`
- `completion_evidence` 非空

才允许按“已完成”停止。

### 3.2 不可抗阻塞停止

当且仅当以下条件同时满足，才允许按“不可抗阻塞”停止：

- `is_completed = false`
- `next_step` 为空
- `attempts_exhausted = true`
- `cannot_complete_reason` 非空
- `blocking_evidence` 非空

如果还需要用户参与，则再额外要求：

- `user_input_required = true`
- `user_question` 非空

## 4. 非法停止

以下情况都不应直接 finalize stop：

1. 还有 `next_step`
2. 只有“做不到”的口头描述，没有 `blocking_evidence`
3. 没写 `attempts_exhausted=true`
4. 标记了 `user_input_required=true`，但没有 `user_question`

这些情况应继续执行，或回到 guard 提示模型补齐结构化信息。

## 5. Runtime anchors

- request-side tool injection:
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-request-utils.ts`
- stop payload normalization:
  - `sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop.ts`
- stop/finalize/continue guard:
  - `sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop-guard.ts`
- sticky state:
  - `sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop-state.ts`

## 6. Verification checklist

最少需要覆盖：

1. `stopless:on` 完成态可停止
2. `stopless:on` 不可抗阻塞可停止
3. `stopless:endless` 完成态可停止
4. `stopless:endless` 不可抗阻塞可停止
5. 有 `next_step` 时两种模式都必须继续
6. `reasoning.stop` schema / validator / finalize 三处语义一致
