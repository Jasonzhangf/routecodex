# Servertool Rust-only 重构设计（唯一真源方案）

## 目标

本文定义 servertool 的 **Rust-only 目标架构**、模块边界、JSON skeleton 契约、迁移顺序与验证门禁。

目标不是“把 TS 文件搬成 Rust”这么简单，而是一次性解决四个根问题：

1. **servertool 运行时真源统一到 Rust**
2. **模块严格按 Shared Functions + Blocks + Orchestration 分层**
3. **所有能力按 skeleton + JSON config 驱动**
4. **全局每个模块只有一个实现真源，不再 TS/Rust 双份漂移**

## 背景结论

基于当前仓内审计，现状是：

- Rust 已具备部分 servertool 热路径语义与 plan/export 能力；
- 但真实 servertool 执行主链仍在 TS：
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
  - `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
- handler 注册仍是代码 side-effect 注册，不是 JSON skeleton 驱动；
- `reasoning.stop / clock / stop_message_auto / continue_execution / web_search` 仍有 TS 业务真相残留；
- `.bak` 与历史过渡逻辑仍在主路径附近，说明尚未完成真正收敛。

因此本文的设计目标不是“Rust 增量增强”，而是 **把 servertool 定义为 router-hotpath-napi 内的一个完整原生子系统**，TS 仅保留 transport shell。

## 硬约束

1. **唯一入口链路不变**
   - `HTTP server -> llmswitch-core Hub Pipeline -> Provider -> Hub Pipeline -> client`
2. **tool governance 唯一结构化入口**
   - 文本 wrapper / XML / RCC harvest 仍只在 Rust chat-process/tool-governance 发生
3. **servertool orchestration 唯一 internal tool 消费入口**
4. **Host / Provider 不得重写 servertool 语义**
5. **无 fallback**
   - 任何 servertool 失败必须显式暴露为结构化错误或结构化 execution result
6. **真实 payload 不可裁剪改写**
   - 仅允许内部派生 followup payload 按显式规则构造
7. **TS 不再新增 servertool 功能实现**
   - TS 仅允许保留 native loader、JSON 编解码、调用壳、日志桥接

## 设计原则

### 1. Shared Functions + Blocks + Orchestration

servertool 全部模块统一按三层落地：

1. **Shared Functions**
   - 纯函数、解析、规则判断、shape normalize、state merge、plan build
   - 不碰 I/O、不碰文件、不碰 provider 调用

2. **Blocks**
   - 稳定数据块与契约对象
   - request context、response semantics、tool calls、state snapshot、followup plan、execution outcome、diagnostic bundle

3. **Orchestration**
   - 只负责把 shared functions 串起来，推进状态机
   - 不内联重复解析逻辑，不直接拼魔法字段，不偷藏第二份语义

### 2. Operation + Event + Projection

每个 servertool 子模块统一遵守：

```text
operation -> event -> projection
```

- `operation`：tool_call / auto hook / request-side inject op
- `event`：detected / planned / executed / failed / stripped / dispatched
- `projection`：debug view、delivery evidence、runtime log、admin view

日志不是事实真源；**event block 才是事实真源**。

### 3. Skeleton first

servertool 先定义统一 skeleton，再挂具体 tool block：

- skeleton 决定：
  - 哪个阶段能做什么
  - 哪些 tool 是 internal
  - 哪些 tool 可 client-visible
  - 哪些 outcome 合法
- tool handler 只是填充 skeleton 规定的 slots，不得自行扩展第二套流程。

## 目标总架构

### 总体分层

```text
Host HTTP shell
  -> native hub pipeline entry
    -> req stage: metadata/state inject
    -> resp stage1: canonical response + tool governance
    -> resp stage2: servertool skeleton orchestration
    -> resp stage3: finalize + strip + client remap
  -> Host transport shell
```

### Rust / TS 职责边界

#### Rust 必须负责

- request-side servertool metadata prepare
- response-side internal tool detect
- internal tool dispatch planning
- stop_message / reasoning.stop / clock / continue_execution / web_search / review 的语义判断
- mixed tools / reenter / clientInjectOnly / backendInvoke 的 outcome 判定
- followup payload / injection plan 构造
- strip executed internal tool calls
- finalize 相关 invariants
- state codec / state transition / stale cleanup policy
- tool registry / skeleton registry / config schema normalize

#### TS 仅可保留

- native module loader
- JSON stringify/parse guard
- providerInvoker transport bridge
- clientInjectDispatch transport bridge
- file/tmux/HTTP 等外部 I/O 适配层
- 非语义型 observability shell

> 结论：TS 最终不能再有 `servertool engine`、`server-side-tools`、`handler business logic`。

## Rust-only 模块树

建议在 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/servertool/` 下建立独立树；当前散落在 crate 根下的相关文件逐步迁入该树。

### 1. shared/

放纯函数与通用 schema：

- `servertool/shared/tool_name.rs`
- `servertool/shared/tool_call.rs`
- `servertool/shared/metadata.rs`
- `servertool/shared/errors.rs`
- `servertool/shared/tool_call_id.rs`
- `servertool/shared/json_ops.rs`
- `servertool/shared/diagnostics.rs`

责任：

- tool name normalize
- internal/client tool 分类
- canonical tool call 结构
- 通用错误码
- tool_call_id 合约
- 结构化诊断块

### 2. blocks/

放稳定数据块，不放流程：

- `servertool/blocks/request_context.rs`
- `servertool/blocks/response_context.rs`
- `servertool/blocks/runtime_state.rs`
- `servertool/blocks/tool_inventory.rs`
- `servertool/blocks/followup_plan.rs`
- `servertool/blocks/execution_outcome.rs`
- `servertool/blocks/governance_summary.rs`
- `servertool/blocks/event.rs`

关键 block：

- `ServertoolRequestContext`
- `ServertoolResponseContext`
- `ServertoolToolCall`
- `ServertoolExecutionOutcome`
- `ServertoolFollowupPlan`
- `ServertoolStateSnapshot`
- `ServertoolEvent`

### 3. config/

放 skeleton + JSON config：

- `servertool/config/schema.rs`
- `servertool/config/normalize.rs`
- `servertool/config/registry.rs`
- `servertool/config/tool_specs.rs`

责任：

- 读取 host/bootstrap 传入 JSON
- 归一化 servertool config
- 校验 skeleton/tool spec
- 产出 runtime-ready config block

### 4. state/

放状态 codec 与状态机：

- `servertool/state/stop_message.rs`
- `servertool/state/reasoning_stop.rs`
- `servertool/state/clock.rs`
- `servertool/state/session_scope.rs`
- `servertool/state/pending_injection.rs`
- `servertool/state/rebind.rs`

责任：

- 状态 serialize/deserialize
- 状态迁移
- stale 清理
- rebind 规则
- pending injection 合约

### 5. handlers/

每个 tool 独立目录，内部再拆 shared/block/orchestrator，而不是一个大文件：

- `servertool/handlers/reasoning_stop/`
- `servertool/handlers/stop_message_auto/`
- `servertool/handlers/clock/`
- `servertool/handlers/continue_execution/`
- `servertool/handlers/web_search/`
- `servertool/handlers/review/`

每个 handler 目录统一结构：

```text
mod.rs
spec.rs
parse.rs
state.rs
plan.rs
finalize.rs
tests.rs
```

约束：

- `parse.rs`：只解析 input/tool args
- `state.rs`：只做状态读写/迁移规则
- `plan.rs`：构造 followup/backend/client-inject plan
- `finalize.rs`：执行后结果归一
- `mod.rs`：仅 orchestration

### 6. skeleton/

servertool 的真正骨架层：

- `servertool/skeleton/request_prepare.rs`
- `servertool/skeleton/response_detect.rs`
- `servertool/skeleton/internal_dispatch.rs`
- `servertool/skeleton/outcome_resolve.rs`
- `servertool/skeleton/finalize.rs`
- `servertool/skeleton/strip.rs`
- `servertool/skeleton/registry.rs`

责任：

1. 接收 canonical response
2. 识别 internal tools / auto hooks
3. 生成执行队列
4. 跑 handler orchestrator
5. 统一产生命运分支
6. strip internal tool calls
7. 产出 finalize contract

### 7. runtime/

对外暴露 NAPI callable orchestrator：

- `servertool/runtime/entry.rs`
- `servertool/runtime/request_stage.rs`
- `servertool/runtime/response_stage.rs`
- `servertool/runtime/transport_bridge.rs`

只负责把外部 JSON 与内部 block 对接。

## 统一 skeleton 设计

### Skeleton 阶段

#### Stage 0: Request Prepare

输入：

- client request payload
- adapter metadata
- bootstrap config

输出：

- `ServertoolRequestContext`
- `ServertoolStateSnapshot`
- `RequestInjectOps`

责任：

- 提取 session/conversation/tmux scope
- 注入 stopless / clock / websearch / review 等 request-side tool schema
- 同步 runtime metadata

禁止：

- 不做 response 级推断
- 不做 tool_call harvest

#### Stage 1: Tool Governance Consume

输入：

- provider canonical response
- governance summary

输出：

- `ServertoolResponseContext`
- canonical `tool_calls`

责任：

- 只消费 governance 后结果
- 不重复 harvest

#### Stage 2: Internal Dispatch Plan

输入：

- response context
- tool inventory
- current state snapshot
- normalized config

输出：

- `Vec<ServertoolExecutionUnit>`

每个 unit 明确：

- trigger kind
- tool kind
- execution mode
- required capabilities
- strip policy

#### Stage 3: Execute + Outcome Resolve

输入：

- execution units
- provider bridge capability
- client inject capability

输出：

- `ServertoolExecutionOutcome`

合法 outcome 仅允许：

1. `Passthrough`
2. `ReenterPipeline`
3. `BackendInvoke`
4. `ClientInjectOnly`
5. `MixedToolsPendingInjection`
6. `ExplicitFailure`

> 不允许 handler 私自发请求、私自写 session、私自拼 wrapper。所有命运都必须回到 skeleton outcome。

#### Stage 4: Finalize + Strip

输入：

- original response
- execution outcome
- executed internal tool ids

输出：

- final response payload
- client-visible diagnostics
- internal event bundle

责任：

- strip executed internal tools
- 修正 finish_reason / wrapper invariant
- 输出 finalized marker

禁止：

- 不得吞 malformed tool_call
- 不得把 internal failure 伪装成正常 stop

## JSON Skeleton 设计

### 核心原则

不是“代码注册 + JSON 补几项配置”，而是 **skeleton 本身可 JSON 化声明**。

### 顶层结构

```json
{
  "version": 1,
  "servertool": {
    "enabled": true,
    "internalTools": {
      "reasoning.stop": { "enabled": true, "mode": "guarded" },
      "clock": { "enabled": true, "mode": "client_inject" },
      "continue_execution": { "enabled": true, "mode": "client_inject" },
      "stop_message_auto": { "enabled": true, "mode": "auto_hook" },
      "review": { "enabled": true, "mode": "reenter" },
      "web_search": { "enabled": true, "mode": "backend" }
    },
    "skeleton": {
      "requestPrepare": { "enabled": true },
      "internalDispatch": { "enabled": true },
      "finalizeStrip": { "enabled": true, "requireFinalizedMarker": true }
    },
    "state": {
      "scopePriority": ["tmux", "session", "conversation"],
      "pendingInjection": { "enabled": true, "strictContract": true }
    }
  }
}
```

### 配置层级

#### Layer A: Global skeleton config

控制骨架行为：

- 阶段是否启用
- 允许的 outcome
- strictness
- diagnostics level

#### Layer B: Tool spec config

每个 tool 一个 spec：

- name
- enabled
- trigger type
- execution mode
- state scope
- request inject policy
- response strip policy
- followup policy

#### Layer C: Backend profile config

例如 `web_search` / `review` 的 provider route profile：

- route id
- provider key selection mode
- model hint
- timeout
- result caps

### Tool spec 标准形状

```json
{
  "name": "clock",
  "enabled": true,
  "kind": "internal",
  "trigger": {
    "type": "tool_call",
    "canonicalName": "clock"
  },
  "execution": {
    "mode": "client_inject_only",
    "requires": ["clientInjectDispatch"],
    "stripAfterExecute": true
  },
  "state": {
    "scope": "tmux",
    "codec": "clock_v1"
  }
}
```

### 为什么必须 JSON skeleton

因为只有这样才能保证：

1. skeleton 是 declarative truth，不是 scattered side-effect
2. 新增 tool 不会复制第二份骨架
3. 测试可直接对 config matrix 做 contract 验证
4. TS shell 无需知道具体 handler 内幕

## 全局唯一实现规则

### 1. 每个能力一个 authoritative module

- stop_message state codec：只能有 Rust 一处
- reasoning.stop validator：只能有 Rust 一处
- clock request inject semantics：只能有 Rust 一处
- internal tool strip policy：只能有 Rust 一处
- pending injection contract：只能有 Rust 一处

### 2. TS 只允许 wrapper，不允许 duplicate semantics

允许存在：

- `prepareRuntimeMetadataForServertoolsJson(...)` 的 TS 调用壳
- `planChatServertoolOrchestrationBundleJson(...)` 的 TS 调用壳

不允许存在：

- TS 自己再算一次 `clientInjectOnly`
- TS 自己再 strip 一次 internal tool calls
- TS 自己再 parse 一次 stopMessage state

### 3. 历史文件必须出主路径

以下都不允许留在 active path：

- `*.bak`
- `*.legacy.ts` 被 import
- side-effect handler 注册链
- TS 与 Rust 双份 normalize/helper

规则：

- 若需要过渡文件，必须挪到 archive 或不在编译入口里
- active runtime 搜索不得再出现第二份同职责实现

## 对现有 TS 资产的处理策略

### 删除目标

最终删除：

- `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts`
- 大部分 `sharedmodule/llmswitch-core/src/servertool/handlers/*.ts`

### 保留为薄壳的目标

可临时保留：

- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath.ts`
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-router-hotpath-loader.ts`
- 少量 transport bridge helper

### 迁移后 Host 壳层目标

Host 只保留两个 servertool 相关能力：

1. 调 native：
   - request prepare
   - response orchestration
2. 执行 I/O bridge：
   - provider invoke
   - client inject

## NAPI 导出面设计

当前导出已很多，servertool 新设计要避免再散点增长。

### 新原则

从“很多小语义导出”收敛到“少量高层 orchestrator 导出”。

### 建议导出

#### 1. Request stage

- `runServertoolRequestStageJson`

输入：

- request payload
- runtime metadata
- servertool config

输出：

- updated payload
- updated metadata
- diagnostics

#### 2. Response stage

- `runServertoolResponseStageJson`

输入：

- canonical response
- adapter context metadata
- servertool config
- capability manifest

输出：

- outcome
- finalized response
- bridge requests
- event bundle

#### 3. State codec group

- `readServertoolStateJson`
- `writeServertoolStateJson`
- `migrateServertoolStateScopeJson`

#### 4. Config bootstrap group

- `bootstrapServertoolConfigJson`
- `validateServertoolSkeletonJson`

> 原则：高层导出面稳定，底层 shared functions 不暴露给 TS。

## 运行时能力桥设计

Rust orchestration 不能直接做外部 I/O，因此需要显式 bridge contract。

### Capability manifest

TS 调 native 时显式传入：

```json
{
  "providerInvoker": true,
  "clientInjectDispatch": true,
  "pendingStateStore": true
}
```

Rust 只依据 manifest 决定 outcome 是否可执行。

### Bridge request

Rust 若需要外部动作，不直接执行，而是产出 bridge request：

```json
{
  "type": "client_inject",
  "requestIdSuffix": "clock_followup",
  "payload": { "...": "..." },
  "metadata": { "...": "..." }
}
```

TS shell 只做：

1. 执行 bridge request
2. 把 bridge result 回填 native finalize

这样可以保证：

- 语义在 Rust
- I/O 在 TS
- 边界清晰

## 状态设计

### 状态类型

1. `stop_message_state`
2. `reasoning_stop_state`
3. `clock_state`
4. `pending_injection_state`
5. `session_scope_binding`

### 状态规则

- codec 唯一真源在 Rust
- scope resolve 唯一真源在 Rust
- stale cleanup policy 唯一真源在 Rust
- rebind policy 唯一真源在 Rust

### scope 规则

默认优先：

1. `tmux:<sessionId>`
2. `session:<sessionId>`
3. `conversation:<conversationId>`

但各 tool spec 可限制：

- `stop_message_auto` / `clock` / `continue_execution`：只允许 `tmux`
- `reasoning.stop`：允许 `session` / `conversation`

## 测试与验证设计

### 1. Unit

覆盖：

- parser
- state codec
- tool spec validator
- outcome resolver
- strip policy

### 2. Contract

覆盖：

- request stage JSON contract
- response stage JSON contract
- bridge request contract
- tool_call_id contract

### 3. Orchestration regression

覆盖：

- stop_message full lifecycle
- reasoning.stop stopless full lifecycle
- clock schedule -> inject
- mixed tools pending injection
- malformed tool_call fail-fast

### 4. Installed/runtime smoke

覆盖：

- native binding load
- host shell invoke native request/response stage
- real tmux inject path
- real provider reenter path

### 5. Unique implementation audit gate

新增 CI gate：

- 不允许 `src/servertool/**/*.bak*`
- 不允许 active TS path 再 export servertool business handlers
- 不允许 `sharedmodule/llmswitch-core/src/servertool/handlers/*.ts` 仍被 runtime import
- 不允许 search 命中 duplicate keywords 的双实现白名单外扩散

## 迁移顺序

### Phase 0：冻结边界

1. 新增本文档作为真源
2. 明确 TS servertool 不再接新功能
3. 建立 native high-level exports 目标

### Phase 1：先骨架，后 handler

1. 建立 Rust `servertool/` 模块树
2. 把当前 scattered servertool block 迁入模块树
3. 先实现统一 skeleton，不先急着逐个搬完 handler

### Phase 2：迁 request/response stage

1. request prepare 全量 Rust 化
2. response orchestration 全量 Rust 化
3. TS `engine.ts` 改成只转发 native outcome

### Phase 3：逐个 handler rustify

建议顺序：

1. `reasoning.stop`
2. `continue_execution`
3. `clock`
4. `stop_message_auto`
5. `review`
6. `web_search`

原因：

- 前四个主要是 internal lifecycle tool，依赖 skeleton 最深
- `web_search` 涉及 backend provider bridge，适合最后收口

### Phase 4：移除 TS 真相

1. 删除 `engine.ts` 主语义
2. 删除 `server-side-tools.ts` 主语义
3. 清理 TS handlers
4. 删除 `.bak`

### Phase 5：唯一实现门禁

新增：

- `verify:servertool-rust-only`
- `test:coverage:servertool-skeleton`
- `test:contract:servertool-runtime`

## 成功判定

当且仅当以下全部满足，才算 servertool Rust-only 完成：

1. servertool 主链不再 import TS business handlers
2. `engine.ts` / `server-side-tools.ts` 不再承载业务语义
3. request/response servertool stages 由单一 Rust orchestrator 导出
4. tool registry 来自 JSON skeleton，而非 TS side-effect register
5. stop_message / reasoning.stop / clock / continue_execution / review / web_search 的运行时语义只在 Rust 一处实现
6. mixed tools / pending injection / strip / finalize 无 TS duplicate path
7. 唯一实现审计门禁通过

## 不接受的假完成状态

以下都不算完成：

1. Rust 有 plan，TS 仍在真正执行
2. handler 虽迁到 Rust，但 registry 还是 TS 代码注册
3. request 已 Rust、response 仍 TS 双路
4. TS 删小了，但 outcome 判定仍双实现
5. `.bak`、legacy imports 仍在 active runtime

## 推荐首刀

若按最小高价值切片推进，第一刀应是：

1. 新建 Rust `servertool/skeleton/*`
2. 导出 `runServertoolResponseStageJson`
3. 让 TS `server-side-tools.ts` 先退化为：
   - 调 native
   - 执行 bridge request
   - 回填 result
4. 然后再逐个把 handler 迁进 skeleton

这样可以最早把“执行骨架真相”收回 Rust，而不是继续在 TS 里修补细节。

## 2026-05-06 首刀落地进展

本轮已先把 **response-side detect / extract contract** 收回 native：

本轮继续把 **tool-call dispatch planning contract** 收回 native：

- 新增 Rust export：`planServertoolToolCallDispatchJson`
- Rust 负责：
  - `disableToolCallHandlers` 判定
  - include/exclude handler name filter
  - registered tool_call handler existence 判定
  - 输出 executable/skipped 两类 plan block
- TS 仅负责：
  - `runPreCommandHooks(...)`
  - handler 调用 / backend invoke / finalize materialize
  - mixed tools / pendingInjection 结果消费

这意味着第二阶段已完成“response-side detect/extract + dispatch planning”两段收敛，TS 侧 dispatch 是否可执行的判断不再是语义真源。

第三阶段继续把 **executed outcome planning** 收回 native：

- 新增 Rust export：`planServertoolOutcomeJson`
- Rust 负责：
  - mixed client-tools vs servertool-only 分支判定
  - remaining tool_call ids 计算
  - pending session target / aliasSessionIds 选择
  - flowId 选择
  - use-last-followup vs generic-followup 决策
- TS 仅负责：
  - 根据 native outcome plan 组装 `pendingInjection.messages`
  - 复用现有 handler materialize 结果与 generic followup payload

这使 servertool 的“是否执行 / 执行后走哪条编排分支”两层判断都已进入 Rust skeleton。

- 新增 Rust 导出：
  - `runServertoolResponseStageJson`
- 当前责任：
  - provider response shape 判定
  - canonical chat payload 判定
  - empty assistant payload contract signal
  - response-side `tool_calls` 抽取
  - internal servertool 缺失 id 时在抽取源头补正式 id
  - transcript-like malformed historical tool_call 过滤

当前仍未迁移的部分：

- handler dispatch / backend invoke / client inject / pending injection
- auto hook queue orchestration
- finalize + strip 主编排

这意味着首刀已把 **response-stage 的 detect/extract block** 从 TS 收回 Rust，但还没有完成完整 orchestration closeout。
