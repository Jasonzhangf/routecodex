# stopless 目标生命周期重构清单

## 索引概要
- L1-L8 `purpose`：本清单定义 stopless 从 legacy marker 模式改造成 goal lifecycle 模式的唯一方向。
- L10-L22 `current-gap`：当前 stopless 真相与目标差异。
- L24-L53 `target-model`：目标状态机与持久化状态。
- L55-L86 `architecture`：统一 parser、runtime owner、调度与 followup owner。
- L88-L156 `change-list`：代码改造切片与文件级清单。
- L158-L190 `deletions`：必须物理删除的旧语义与旧文件责任。
- L192-L230 `verification`：验证矩阵。
- L232-L247 `risks`：风险与边界。
- L249-L259 `uniqueness`：为什么这是唯一正确改造方向。

## 目标

把 RouteCodex 当前 stopless 从“`reasoning.stop` 自检闸门 + `on/off/endless` marker”重构成**类似 Codex `/goal` 的目标生命周期模式**。

本次重构不是“换个 marker 名字”，而是三个动作同时完成：

1. **统一 marker parser**：所有私有控制指令统一进入 RCC fence。
2. **重写 stopless 语义**：从单轮 stop 合同改成线程/会话级目标生命周期。
3. **物理删除旧合同**：删除 `on/off/endless` 与 `reasoning.stop finalized` 依赖。

## 当前差异（Gap）

### 当前 stopless 真相

当前代码真源：

- `sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop-stopless-directive.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop-state.ts`
- `sharedmodule/llmswitch-core/src/servertool/handlers/reasoning-stop.ts`
- `src/server/runtime/http-server/executor/request-executor-response-contract.ts`

当前合同：

- marker 只有 `<**stopless:on**> / <**stopless:off**> / <**stopless:endless**>`
- 状态只有 `on | off | endless`
- 是否继续依赖 `reasoning.stop` 工具与 finalized marker
- 语义本质是“本轮响应是否允许 stop”

### 目标差异

用户要的不是“更聪明的 stop marker”，而是类似 Codex `/goal` 的生命周期：

- `start`
- `pause`
- `resume`
- `stop`
- `done`

这要求 owner 从“响应结束自检”改成“目标状态推进”。

## 目标模型

### 状态机

建议唯一状态机：

```text
idle -> active -> paused -> active
   \-> stopped
active -> completed
paused -> stopped
paused -> completed
```

状态定义：

- `idle`：无激活目标
- `active`：目标持续推进中
- `paused`：人工暂停，等待恢复
- `stopped`：人工终止，不再继续
- `completed`：完成并收口

### 命令到状态转移

| 指令 | 前置状态 | 后置状态 | 说明 |
|---|---|---|---|
| `stopless start` | `idle/stopped/completed` | `active` | 创建新目标并清空旧 stopless 状态 |
| `stopless pause` | `active` | `paused` | 挂起目标 |
| `stopless resume` | `paused/active` | `active` | 恢复推进 |
| `stopless stop` | `active/paused` | `stopped` | 明确终止 |
| `stopless done` | `active/paused` | `completed` | 明确完成并附证据 |

### 持久化状态建议

禁止继续复用 `reasoningStopMode` 表示新语义；应独立新字段：

```ts
export type StoplessGoalState = {
  status: 'idle' | 'active' | 'paused' | 'stopped' | 'completed';
  objective: string;
  latestNote?: string;
  completionEvidence?: string;
  updatedAt: number;
  createdAt: number;
};
```

说明：

- `objective` 只在 `start` 时写入
- `latestNote` 用于 pause/resume/stop 的原因说明
- `completionEvidence` 只在 `done` 时写入
- `reasoningStopMode/reasoningStopArmed/reasoningStopSummary` 不得再承担新 stopless 真相

## 架构与 Ownership

### 1. 统一 parser owner

**唯一 parser 真源**应放在 Rust hotpath，而不是继续在 TS 各处正则扫描。

建议落点：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`
  - 新增 `rcc_fence_parser.rs`
  - 新增 `rcc_directive_semantics.rs`

TS 只允许做薄壳：

- 调 native parser
- 拿已解析 AST / directive
- 不再重建第二份 regex/parser 逻辑

### 2. stopless runtime owner

新的 stopless owner 应是**目标生命周期 runtime**，不是 `reasoning.stop` 工具。

最小落点：

- 状态推进函数：Rust native
- sticky state 读写：沿现有 store 边界接入，但只存储 native 产出的标准状态结构
- followup/自动续轮：servertool lifecycle 层根据 `StoplessGoalState.status` 决定，而不是看 `reasoning.stop finalized`

### 3. followup owner

目标续轮要改成：

- `active`：允许继续推进
- `paused/stopped/completed`：禁止自动续轮
- 继续条件由 runtime 决定，而不是要求模型补一个 `reasoning.stop`

## 改造清单

### Slice 1：统一 fence parser

新增/修改：

- `docs/design/rcc-unified-fence-marker-spec.md`（本次已完成文档）
- Rust hotpath 新增 RCC fence parser 与 directive resolver
- TS wrapper 改为只调用 native parser

完成标准：

- `stopless / clock / stop_message / route / precommand` 全部进入同一 parser
- 不再允许各 feature 自己扫 `<**...**>` 私有 regex

### Slice 2：定义新 stopless state 与 transition

新增/修改：

- `sharedmodule/llmswitch-core/src/router/virtual-router/sticky-session-store.ts` 相关 state schema 接入
- `sharedmodule/llmswitch-core/src/servertool/handlers/` 中 stopless 相关 owner 改为目标状态推进
- 必要时新增 `stopless-goal-state.ts` / `stopless-goal-runtime.ts`，但语义判定必须优先 native 化
- `/goal` transition validator：把旧 stopless 的完成/阻塞/继续证明字段迁入 `update_goal` 合同
- host runtime error ledger：维护 `consecutive_irrecoverable_errors / consecutive_validation_failures / repeated_no_progress_count`

完成标准：

- 代码中不再把 `on/off/endless` 当 stopless 真相
- `start/pause/resume/stop/done` 成为唯一合法 lifecycle 指令
- `/goal` 仍是唯一生命周期入口，不新增第二套 stopless goal tool
- `completed/stopped/paused/active` 的状态迁移都必须经过 host 结构校验

### Slice 3：request inbound 改造

当前 stopless seed 真源：

- `src/server/runtime/http-server/executor/servertool-request-normalizer.ts`

改造要求：

- 不再从 `<**stopless:on|off|endless**>` seed 状态
- 改为从 RCC fence directive 写入 `StoplessGoalState`
- `stopless start` 的 body 既写入状态，也保留为本轮真实用户目标

### Slice 4：response contract 改造

当前 stop 合同真源：

- `src/server/runtime/http-server/executor/request-executor-response-contract.ts`

改造要求：

- 删除 `STOPLESS_FINALIZATION_MISSING` 这类基于 finalized marker 的 stopless 合同
- 继续/停止判断改由 stopless goal runtime + lifecycle 状态驱动
- 不允许“模型没调 reasoning.stop 就判错”继续作为新 stopless 规则

### Slice 5：provider request tooling 改造

当前注入真源：

- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-reasoning-stop-request-tooling.ts`

改造要求：

- stopless goal mode 不再注入 `reasoning.stop`
- provider tools 保持真实，不补伪工具
- 非 goal 场景若仍暂存旧链路，也必须与新 stopless 解耦

### Slice 6：servertool guard / followup 改造

当前 owner：

- `sharedmodule/llmswitch-core/src/servertool/engine-selection-block.ts`
- `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`

改造要求：

- guard prepass 不再依赖 `reasoning_stop_guard`
- followup 继续条件改看 `StoplessGoalState.status === active`
- pause/stop/done 后必须立即阻断后续自动续轮
- response 侧只能读取“校验后的 goal state”；模型口头声称完成不得直接终止

### Slice 6.5：`/goal` 强制证明合同

新增/修改：

- `update_goal` payload validator
- host-side transition apply 函数
- 非法状态跃迁拒绝路径
- 当前落点已收敛到：
  - `src/server/runtime/http-server/executor/provider-response-tool-validation-blocks.ts`：shape-only 最小结构校验
  - `src/server/runtime/http-server/executor/provider-response-converter.ts`：host-side transition proof enforcement

最小合同：

- `active -> active` 必须有 `next_step`
- `active -> paused` 必须有 `user_question + cannot_continue_reason`
- `active -> stopped` 必须有 `blocking_evidence + attempts_exhausted=true + error_class`
- `active -> completed` 必须有 `completion_evidence + completion_summary + ssot_assessment`

完成标准：

- host 不做深语义理解也能拒绝空洞 completed/stopped
- 非法 transition 连续两次触发后强制停机
- validator 不承担审计式阻断；真正的合同 owner 在 host goal state projection

### Slice 6.6：错误收敛 owner

新增/修改：

- goal runtime ledger
- irrecoverable / validation / no-progress 收敛阈值
- 当前落点：`src/server/runtime/http-server/executor/provider-response-converter.ts`

完成标准：

- 连续不可逆错误 >= 2 时强制 `stopped`
- 连续校验失败 >= 2 时强制 `stopped`
- 连续无进展 >= 3 时强制 `stopped` 或 `paused`（默认 `stopped`）

### Slice 7：文档与指令面收敛

必须同步修改：

- `docs/routing-instructions.md`
- `docs/design/reasoning-stop-lifecycle.md`
- `docs/stop-message-auto.md`（如引用旧 marker 体系）
- 其他出现 `<**stopless:*`、`<**sm:`、`<**clock:{`、`<**precommand:` 的文档

完成标准：

- repo 内文档真源统一只写 RCC fence 语法
- 不再把 legacy inline marker 当现行规范

## 必须物理删除的旧语义

以下内容不能只“废弃不用”，必须在新方案完成后删除：

1. `ReasoningStopMode = 'on' | 'off' | 'endless'`
2. `STOPLESS_DIRECTIVE_PATTERN = /<\*\*stopless:.../` 这类 stopless 专用 regex
3. `reasoning.stop` 注入逻辑作为 stopless 必选合同
4. `STOPLESS_FINALIZATION_MISSING` 基于 finalized marker 的 stopless 终止检查
5. 文档中对 `<**stopless:on/off/endless**>` 的现行说明
6. stopless 旧测试样例与旧 snapshot

删除原则：

- 不允许新旧双状态机长期并存
- 不允许 `start -> on`、`done -> finalized marker` 这种“换皮兼容”常驻
- 不允许保留一整套旧 parser 只是“暂时不接线”

## 验证矩阵

### 单测

1. RCC fence parser：
   - 完整 block
   - 多 block 顺序
   - body-forward / private-only / state-only
   - unclosed / nested / unknown domain / missing body

2. stopless state machine：
   - start -> active
   - active -> pause -> resume
   - active -> stop
   - active -> done
   - paused -> done
   - invalid transition fail-fast
   - completed 缺 `completion_evidence` 被拒绝
   - stopped 缺 `blocking_evidence` 被拒绝
   - active 缺 `next_step` 被拒绝

3. lifecycle / followup：
   - active 时允许继续
   - pause/stop/done 时禁止自动续轮
   - 不再依赖 reasoning.stop finalized
   - 非法状态更新累计达阈值时强制 stop
   - 连续不可逆错误达阈值时强制 stop

### 回归

- route / stop_message / clock / precommand 旧能力改写到 RCC fence 后的回归
- 非 stopless 普通请求无回归
- provider tool 透明传输无回归
- 原始 `/goal` tool 面保持兼容，无第二套 stopless goal tool

### 构建

- native rust build
- `npm run build:min`
- CLI 安装态 smoke

### live

至少验证：

1. `stopless start` 后能持续推进目标
2. `stopless pause` 后不会继续自动续轮
3. `stopless resume` 后恢复推进
4. `stopless stop` 后永久停止
5. `stopless done` 后完成收口

未做 live，不得宣称 stopless 改造完成。

## 风险与边界

1. **不能把本次改造降格为“只换 marker 外壳”**；如果核心仍依赖 reasoning.stop，就是假重构。
2. **不能保留多 parser 并行常驻**；否则语法真源继续分裂。
3. **不能保留双状态机**；否则 `reasoningStopMode` 与 `StoplessGoalState.status` 会互相打架。
4. **不能偷偷兼容旧语法而不报错**；这会继续制造静默行为差异。
5. **不能把新 goal state 做成弱化版自由写状态**；若 completed/stopped 不需要证明字段，就比旧 stopless 更弱，违反本次设计目标。

## 为什么这是唯一正确方向

1. 用户目标是“RCC 自己的 stopless 改造成 `/goal` 式生命周期”，不是“Codex `/goal` 透传”。因此只修 transport 已不满足目标。
2. 旧 stopless 的真问题不在名字，而在**owner 错了**：它是 stop gate，不是 goal runtime。只换文案毫无意义。
3. 用户明确要求保留旧 stopless 的“停止必须给理由、连续不可逆错误必须停机”的强度，因此新方案必须在原始 `/goal` 上叠加强制证明合同，而不是退化成自由状态机。
4. 只有同时完成**统一 parser + 原始 `/goal` 生命周期兼容 + 强制状态迁移合同 + 删除旧合同**，stopless 才真正从 marker 自检模式升级为目标生命周期模式。
