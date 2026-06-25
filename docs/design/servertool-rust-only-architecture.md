# Servertool Rust-only 重构设计（唯一真源方案）

## 目标

本文定义 servertool 的 **Rust-only 目标架构**、模块边界、JSON skeleton 契约、迁移顺序与验证门禁。

## Pipeline 节点锁

servertool 只能作为 Hub response chat-process 的子链执行，固定拓扑为：

```text
HubRespChatProcess03Governed
  -> ServertoolResp03RuntimeAction
  -> ServertoolReq04FollowupBuilt
  -> normal Hub request/reenter chain
  -> ServertoolResp03FollowupResult
  -> HubRespOutbound04ClientSemantic
```

- `ServertoolResp03RuntimeAction`：Rust effect plan 中的动作 carrier；只在 `HubRespChatProcess03Governed` chat 标准态决定是否需要 runtime/followup，并携带 chat-process payload 给 TS IO/reenter shell。
- `ServertoolReq04FollowupBuilt`：只从 origin snapshot 构造正常 followup 请求；不得从当前污染 payload 猜测补齐。
- `ServertoolResp03FollowupResult`：followup 回来的 governed response；若存在且非空，必须成为 `HubRespOutbound04ClientSemantic` 的唯一输入。
- TS 只允许作为 runtime IO/reenter 薄壳；不得做工具语义判断、工具列表清洗、requires_action 修补或旧 payload 回填。
- TS shell 收到 `servertoolRuntimeAction` 时只能消费 Rust effect 携带的 chat-process payload；payload 缺失必须 fail-fast，禁止回退到 provider raw、client outbound 或 SSE payload。
- SSE/JSON client projection 必须使用 post-servertool governed payload；禁止使用 pre-followup native `streamPipe.payload` 覆盖 followup truth。

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
- `planChatWebSearchOperationsJson(...)` 等仍有测试或运行时消费者的最小 native 调用壳
- Rust 内部 `plan_chat_servertool_orchestration_bundle(...)` helper 直连；不得恢复 standalone `planChatServertoolOrchestrationBundleJson(...)` public bridge

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

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath.ts`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-loader.ts`
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

## 面向能力较弱模型的 apply_patch 执行计划（审计后新增）

本节目标：把本文重构路线拆成**低认知负担、强约束、可机械执行**的 patch 序列，降低“弱模型”在大改造任务中的偏航风险。

### A. 适配原则（给弱模型的硬约束）

1. **单 patch 单职责**  
   每次 patch 只做一件事：要么“新增 Rust 文件骨架”，要么“切一条 TS 调用壳”，要么“删一个已失效导出”。

2. **禁止跨层混改**  
   单 patch 不允许同时改 `shared + handlers + runtime + TS shell` 四层；最多触达一层 Rust + 一处 TS 壳。

3. **先加门禁再迁移**  
   在删 TS 语义前，先加 fail-fast 审计脚本与 contract test；否则弱模型容易产生“看起来可跑”的假完成。

4. **强模板提交说明**  
   每个 patch 的 commit message 必须包含：`[scope] [ssot] [evidence]` 三段，避免弱模型遗漏验证语义。

5. **无 fallback 文本检查**  
   patch 后必须 grep `fallback|degrade|legacy path`，命中即失败，防止弱模型偷偷保留双路径。

### B. Patch 序列（最小可执行切片）

#### Patch 0：冻结与门禁（只增不删）

- 新增：
  - `scripts/verify-servertool-rust-only.sh`（或等价命名）
  - CI 任务占位：`verify:servertool-rust-only`
- 检查项：
  - 拦截 `src/servertool/**/*.bak*`
  - 拦截 TS runtime import `src/servertool/handlers/*.ts`
  - 拦截 duplicate semantic 关键字白名单外扩散

**验收证据**：本地与 CI 均能执行门禁脚本，且当前仓状态下输出可解释（允许先告警，后在后续 patch 清零）。

#### Patch 1：建立 Rust skeleton 空壳

- 仅新增目录与 `mod.rs` 串接，不迁移业务：
  - `servertool/skeleton/{request_prepare,response_detect,internal_dispatch,outcome_resolve,finalize,strip,registry}.rs`
- 仅做可编译最小骨架（空实现或 `todo!` 受控占位，但不可暴露到 runtime 主路径）。

**验收证据**：Rust 编译通过；无 TS 行为变化。

#### Patch 2：接入单一高层导出 `runServertoolResponseStageJson`

- Rust：
  - 导出函数签名与最小 contract（输入校验 + 空结果结构）
- TS：
  - `server-side-tools.ts` 仅新增调用壳，不改旧执行分支判定。

**验收证据**：可通过开关/参数跑通 native call，日志可见请求与返回 shape。

#### Patch 3：把 detect/extract 语义切到 Rust（仅这一件事）

- Rust 接管：
  - canonical response 识别
  - tool_calls 抽取
  - internal tool_call id 补全
- TS 删除对应重复判定（仅删除 detect/extract 部分）。

**验收证据**：对同一输入，TS 旧路径与 Rust 新路径产出一致快照（golden test）。

#### Patch 4：把 dispatch planning 切到 Rust

- Rust 接管：
  - handler 可执行性判定
  - include/exclude filter
  - executable/skipped 计划块输出
- TS 仅消费 plan 执行 bridge。

**验收证据**：`planServertoolToolCallDispatchJson` contract test + 回归样例。

#### Patch 5：把 outcome planning 切到 Rust

- Rust 接管：
  - mixed-tools 分支
  - pending injection target/flow 选择
- TS 仅 materialize payload，不再做分支决策。

**验收证据**：mixed/pending 样例矩阵回归通过。

#### Patch 6：finalize + strip 切换

- Rust 接管：
  - strip executed internal tools
  - finish_reason / finalized marker invariant
- TS 删除 duplicate strip/finalize 逻辑。

**验收证据**：malformed tool_call fail-fast、生效 strip、client payload 不含已执行 internal calls。

#### Patch 7：物理删除 TS 业务真相

- 删除：
  - `engine.ts` 业务语义
  - `server-side-tools.ts` 业务语义
  - `handlers/*.ts` 业务实现与 side-effect 注册链
  - `.bak` 与 legacy import

**验收证据**：门禁脚本全绿；runtime 不再 import TS business handlers。

### C. 弱模型专用执行卡片（每次 patch 都要填）

每个 patch 必须附以下卡片（可放 PR 模板）：

1. **改动边界**：本 patch 只改哪些文件/目录。  
2. **不改动声明**：明确不触达哪些层（防止越界）。  
3. **语义真源声明**：本 patch 把哪一条语义迁到 Rust。  
4. **删除清单**：删了哪些重复语义（若无，写“本 patch 不删除”）。  
5. **验证证据**：最少一条 unit/contract + 一条 runtime/smoke。  
6. **回归风险**：仅列真实剩余风险，不写空话。  

### D. 审计结论（为何这样改）

当前文档技术方向正确，但对弱模型存在三个执行风险：

1. 阶段粒度偏大，容易一次 patch 跨层混改；  
2. “先迁后验”空间过大，容易产生假完成；  
3. 对每 patch 的输入/输出契约约束不够刚性。  

新增本节后，迁移被重写为可机械执行的 0-7 patch 流程，且每步都有可验证证据与删除边界，符合“单一路径真源 + fail-fast + 无 fallback”硬护栏。

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

## strict-zero 扩围后的历史债清理优先级（2026-05-20 审计补充）

本节用于承接“文档约束 -> 脚本门禁 -> CI 门禁 -> active runtime strict-zero”之后的**下一阶段物理清理顺序**。

规则：

1. 先清理 **active runtime 主语义链** 上仍残留的高频 `fallback` 命中；
2. 一次只处理一个模块族，禁止 `stop-message-auto + clock + heartbeat` 混改；
3. 每轮清理都必须满足：
   - 命中数下降有证据；
   - `verify:servertool-rust-only` 继续 PASS；
   - 不通过“改名躲 grep”伪造清理结果；
4. 只有在 Rust 真源已接住对应语义后，TS 侧历史实现才允许物理删除。

### 当前高优先级债务队列（按命中数排序）

#### P0：stop-message-auto 族（先做）

- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`：6
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/ai-followup-pure-blocks.ts`：3
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/blocked-report.ts`：3

原因：

- 该族直接处于 servertool followup / stop_message 生命周期主链；
- 与 Rust-only skeleton 的 request/response/finalize 收口关系最紧；
- 继续保留大量 TS fallback 语义，会阻碍 Patch 3-7 的“主链单真源”收敛。

执行要求：

- 先把 `fallback` 区分为：
  - 真 fallback/降级语义；
  - 仅变量命名/文本拼接中的“fallback”；
- 仅当前者成立时才进入 Rust 化/删除计划；
- 不允许为了过 grep 直接重命名而保持同样双路径语义。

#### P1：clock / orchestration 族

- `sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.ts`：6
- `sharedmodule/llmswitch-core/src/servertool/clock/tasks.ts`：3
- `sharedmodule/llmswitch-core/src/servertool/clock/daemon.ts`：2
- `sharedmodule/llmswitch-core/src/servertool/clock/session-scope.ts`：2

原因：

- clock 已属于 Rust-only 目标架构中的核心 internal lifecycle tool；
- 这些文件仍承载 session scope / timeout / due task 相关语义，属于后续必须收回 Rust 的块。

执行要求：

- 先拆“默认值参数 fallback”与“运行时降级语义 fallback”；
- 如果只是局部 helper 参数名，不应误判为架构性 fallback；
- 若涉及 scope resolve / pending injection / due window 判定，则必须按 Rust 真源迁移处理。

#### P2：heartbeat / store 族

- `sharedmodule/llmswitch-core/src/servertool/heartbeat/session-store.ts`：7
- `sharedmodule/llmswitch-core/src/servertool/heartbeat/daemon.ts`：3
- `sharedmodule/llmswitch-core/src/servertool/heartbeat/history-store.ts`：2

原因：

- 命中数高，但主要风险更偏存储/恢复/文件态兼容；
- 与当前 response-side skeleton closeout 相比，优先级低于 stop-message-auto 与 clock 主链。

执行要求：

- 先确认哪些 `fallback` 只是文件名/sessionId 恢复型局部变量；
- 若属于历史状态兼容逻辑，必须等对应 Rust codec/state 真源落地后再删。

#### P3：非主链辅助文件

- `sharedmodule/llmswitch-core/src/servertool/pre-command-hooks.ts`：6
- `sharedmodule/llmswitch-core/src/servertool/skeleton-config.ts`：2
- `sharedmodule/llmswitch-core/src/servertool/backend-route-runtime-block.ts`：1
- `sharedmodule/llmswitch-core/src/servertool/origin-request-store.ts`：1

原因：

- 这些文件不是当前 strict-zero 主链入口；
- 可在主链收口后再做命名/语义级去债，不应抢在主链前面。

### 推荐下一刀

下一刀只做：

1. **审计 `stop-message-auto` 族的每一个 `fallback` 命中**；
2. 对每个命中标注：
   - 变量名/文案；
   - 局部默认值；
   - 真降级路径；
   - 历史兼容路径；
3. 产出“可直接删 / 需 Rust 接管后删 / 仅重命名无价值”三分类表。

禁止在这一刀中同时改动 `clock` 或 `heartbeat`，否则弱模型极易跨模块混改，违反本文“单 patch 单职责”的执行约束。

## stop-message-auto 族 fallback 命中分类表（2026-05-20 审计补充）

本节是对 P0 队列的逐条审计结果，只做分类，不在本节直接改代码。

### 审计范围

1. `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
2. `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/ai-followup-pure-blocks.ts`
3. `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/blocked-report.ts`

总命中数：12

---

### A. `stop-message-auto.ts`（6 处）

#### 命中 1-6：`fallbackStickyKey`

出现位置：

- 类型字段声明：`fallbackStickyKey?: string;`
- `collectPersistedStopMessageCandidateKeys(...)` 内部使用
- `loadPersistedStopMessageSnapshot(...)` 参数
- `loadPersistedStopMessageTombstone(...)` 参数
- 两处调用点：`fallbackStickyKey: stickyKey`

分类：**需 Rust 接管后删**

原因：

- 这里不是简单文案或局部默认值，而是 **strictSessionScope 未命中时，用 stickyKey 补充持久化 stop_message 状态读取候选键**；
- 它直接参与：
  - persisted stop_message snapshot 查找
  - tombstone 查找
  - session / tmux / conversation scope 回溯
- 这属于 **state scope resolve + persisted state lookup** 语义，正是本文 Rust-only 目标架构里应收归：
  - `servertool/state/session_scope.rs`
  - `servertool/state/rebind.rs`
  - `servertool/state/stop_message.rs`

结论：

- **不能仅重命名为 backup/secondary 就算清理完成**；
- **也不能现在直接删除**，否则会改变 persisted stop_message 命中顺序与恢复行为；
- 正确做法是：待 Rust state codec / scope resolve 真源接住后，再物理移除 TS 这套候选键回溯语义。

---

### B. `ai-followup-pure-blocks.ts`（3 处）

#### 命中 7-9：局部变量 `fallback`

出现形态：

- `const fallback = extractUnknownText(...) || ...`
- `if (fallback) chunks.push(fallback)`

分类：**仅命名，不应作为架构性清理目标**

原因：

- 这里的 `fallback` 只是 **未知 content part 的文本提取链**；
- 语义是“按多个字段顺序抽取文本”，不是运行时降级路径，也不是双实现补偿；
- 它既不改变 servertool orchestration outcome，也不承担第二条业务路径。

结论：

- 不应为了 grep 指标单独改这里；
- 若未来要改，最多是局部重命名为 `derivedText` / `extractedTextCandidate`，但**当前没有架构收益**；
- 在 Rust-only closeout 语境下，这 3 处不应抢优先级。

---

### C. `blocked-report.ts`（3 处）

#### 命中 10-12：局部变量 `fallbackText`

出现形态：

- `const fallbackText = ...`
- `if (fallbackText) chunks.push(fallbackText)`

分类：**仅命名，不应作为架构性清理目标**

原因：

- 这里是 blocked report 文本抽取时，对非 text/output_text/input_text item 做的补充字段读取；
- 语义仍然是 **文本抽取 candidate**，不是 fallback runtime path；
- 不涉及 pending injection、state migration、tool outcome、followup dispatch。

结论：

- 不应把这 3 处视为 Rust-only 主链风险；
- 若未来为了降低 grep 噪音统一改名，可以作为独立纯重命名 patch 处理；
- 当前阶段不值得优先消耗 patch 预算。

---

### 三分类总表

#### 1. 需 Rust 接管后删

- `stop-message-auto.ts` 中全部 `fallbackStickyKey`（6 处）

#### 2. 仅命名噪音，当前不处理

- `ai-followup-pure-blocks.ts` 中局部 `fallback`（3 处）
- `blocked-report.ts` 中局部 `fallbackText`（3 处）

#### 3. 可直接删

- **当前无**

原因：

- 本轮 12 个命中里，没有一处属于“已无语义价值、删除后不影响行为”的死 fallback 路径；
- 真正有架构意义的是 `fallbackStickyKey`，但它还绑定 persisted stop_message state 的读取语义，必须等 Rust state 真源先落地。

---

### 下一刀唯一范围

基于本表，下一刀只能是下面二选一，且推荐顺序固定：

1. **先做 stop_message state / session scope / stickyKey lookup 的 Rust 接管设计**；
2. 接管后，再删除 `stop-message-auto.ts` 中 `fallbackStickyKey` 相关 TS 语义。

不建议下一刀去改：

- `ai-followup-pure-blocks.ts`
- `blocked-report.ts`

因为那只会减少 grep 噪音，不会减少真正的双真源风险。

## `fallbackStickyKey` Rust 接管落点与 TS 替换点（2026-05-20 审计补充）

本节回答两个问题：

1. `fallbackStickyKey` 语义在 Rust-only 架构里应该落到哪里；
2. TS 侧哪些位置在 Rust 接管后必须收缩或删除。

### 一、现状判定

当前 `fallbackStickyKey` 不是孤立变量，而是以下链路的一部分：

```text
record/runtimeMetadata
  -> resolveStopMessageSessionScope(...)
  -> strictSessionScope || resolveStickyKey(...)
  -> collectPersistedStopMessageCandidateKeys(...)
  -> loadPersistedStopMessageSnapshot(...)
  -> loadPersistedStopMessageTombstone(...)
```

它承担的是：

1. stop_message persisted state 候选键回溯；
2. strict session scope 未命中时的 stickyKey 补充查找；
3. snapshot / tombstone 的统一恢复入口。

因此它不是“局部默认值”，而是 **state lookup policy**。

---

### 二、Rust 唯一落点

按当前仓内已有 Rust 模块，唯一正确落点应拆成三块：

#### 1. state codec 真源

当前真源：

- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/loop_state_contract.rs`
- Stopless goal state codec is removed; loop state must come from MetadataCenter/runtime request truth.

职责：

- stop_message / stopless state 的字段 normalize / transition / persisted lookup；
- `text/maxRepeats/used/stageMode/updatedAt/lastUsedAt` 等 state 语义必须进入当前 servertool-core 合同。

已退休：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_stop_message_state_codec.rs`
- `serializeStopMessageStateJson`
- `deserializeStopMessageStateJson`

本次结论：

- 独立 VR stop-message state codec export 是零 consumer 控制面，已物理删除；
- stopless state shape / lookup / transition 不再通过 standalone VR codec 表达。

#### 2. servertool orchestration / routing resolve 真源

已有：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`

当前已见能力：

- `resolve_session_scope`
- `resolve_sticky_key`
- `resolve_stop_message_scope`

本次结论：

- `fallbackStickyKey` 对应的第一落点必须在这里扩展出：
  - **stop_message persisted candidate key planning**
  - **strict scope + stickyKey 的有序候选链生成**
- 也就是 Rust 不仅要返回单个 `stickyKey` / `scope`，还要返回：
  - `candidateKeys[]`
  - `primaryScope`
  - `lookupPolicy`

换句话说，**TS 不该再自己拼候选键列表**。

#### 3. servertool skeleton state 子模块（设计目标落点）

本文前面已定义目标模块：

- `servertool/state/stop_message.rs`
- `servertool/state/session_scope.rs`
- `servertool/state/rebind.rs`

本次结论：

- 从长期架构看，`fallbackStickyKey` 真正应沉到这三个目标模块，而不是永久留在 `chat_servertool_orchestration.rs`；
- 近期 patch 可先在 `chat_servertool_orchestration.rs` 实现高层 NAPI 导出；
- 后续再把内部实现迁入：
  - `stop_message.rs`：snapshot/tombstone lookup contract
  - `session_scope.rs`：strict scope normalize / resolve
  - `rebind.rs`：candidate key order 与 scope rebind 规则

---

### 三、建议新增的 Rust/NAPI 合约

为了彻底替掉 `fallbackStickyKey` 相关 TS 语义，最小必要导出不应再只是单个 string resolve，而应新增一个高层 JSON 能力，例如：

- `planStopMessagePersistedLookupJson`

输入建议：

- request/adapter record
- runtime metadata
- optional current routing state summary

输出建议：

```json
{
  "strictSessionScope": "tmux:xxx",
  "stickyKey": "tmux:xxx",
  "candidateKeys": ["tmux:xxx", "session:xxx", "conversation:xxx"],
  "lookupPolicy": "strict_then_sticky_then_session_family",
  "readStopMessageSnapshot": true,
  "readStopMessageTombstone": true
}
```

关键要求：

1. **candidateKeys 顺序必须由 Rust 唯一决定**；
2. TS 只消费该 plan，不再自己 `push(args.fallbackStickyKey)`；
3. tombstone 与 snapshot 查找必须走同一 candidate policy，避免双份顺序漂移。

---

### 四、TS 侧替换点（必须收缩）

#### 1. `stop-message-auto.ts`

当前待替换点：

- `collectPersistedStopMessageCandidateKeys(...)`
- `loadPersistedStopMessageSnapshot(...)`
- `loadPersistedStopMessageTombstone(...)`
- `fallbackStickyKey` 参数与两处调用

处理原则：

- Rust plan 落地后，这三个 TS 函数都不应再保留主语义；
- 最多只保留：
  - 调 native
  - 读本地 store
  - 把结果回填为 snapshot/tombstone block

也就是说：

- **候选键生成删除**
- **回溯顺序删除**
- **fallbackStickyKey 字段删除**

#### 2. `runtime-utils.ts`

当前保留能力：

- `resolveStopMessageSessionScopeWithNative(...)`
- `resolveServertoolStickyKeyWithNative(...)`

本次结论：

- 这两个单点 resolve 能力不足以消除 TS lookup 语义；
- 后续要新增一个更高层的 native 调用壳，例如：
  - `planStopMessagePersistedLookupWithNative(...)`
- 旧的 `resolveStopMessageSessionScope` / `resolveStickyKey` 可保留给其他调用方；
- 但 stop-message-auto 主链应切到新的 lookup-plan 能力。

#### 3. `routing-state.ts`

当前职责：

- state snapshot shape normalize
- create/apply/clear stop_message state

本次结论：

- 这里暂时**不是首个删除点**；
- 因为它更多是 state shape helper，而不是 candidate lookup policy；
- 真正先删的是 `stop-message-auto.ts` 里的 lookup orchestration。

---

### 五、唯一正确迁移顺序

必须按下面顺序做，不能反过来：

1. Rust 新增 `planStopMessagePersistedLookupJson`（或等价高层能力）；
2. TS `runtime-utils.ts` 增加对应 native bridge；
3. `stop-message-auto.ts` 改为只消费 Rust 返回的 `candidateKeys` / `strictSessionScope` / `stickyKey`；
4. 删除 `collectPersistedStopMessageCandidateKeys(...)`；
5. 删除 `fallbackStickyKey` 参数与调用；
6. 最后把 strict-zero 或专项门禁扩大到该文件。

如果跳过第 1-3 步直接删 TS：

- 会破坏 snapshot/tombstone 恢复顺序；
- 会把 persisted stop_message 命中逻辑打散到别处；
- 会形成新的“隐式 fallback”或查找漂移。

---

### 六、排他性结论

`fallbackStickyKey` 的唯一正确修改处，不是在 `ai-followup-pure-blocks.ts`、`blocked-report.ts`、也不是简单重命名字段。

唯一真源修改点是：

1. **Rust：新增 stop_message persisted lookup plan 真源**
2. **TS：删除 `stop-message-auto.ts` 内的 candidate key 编排语义**

原因：

- 问题根因不是单词 `fallback`，而是 **TS 仍在本地决定 stop_message persisted state 的候选查找顺序**；
- 只改命名无法消除双真源；
- 只删 TS 而不先补 Rust plan 会破坏行为；
- 因此上述两点是当前唯一正确、且可验证闭环的修改路径。

## `planStopMessagePersistedLookupJson` 合同草案（2026-05-20 审计补充）

为消除 `fallbackStickyKey` 对应的 TS lookup policy，本设计要求新增一个高层 native 合同，而不是继续叠加零散 string resolver。

### 目标

替代当前 TS 主链中的：

```text
resolveStopMessageSessionScope
  -> strictSessionScope || resolveStickyKey
  -> collectPersistedStopMessageCandidateKeys
  -> loadPersistedStopMessageSnapshot
  -> loadPersistedStopMessageTombstone
```

### 建议导出

- `planStopMessagePersistedLookupJson`

### 输入草案

```json
{
  "record": {
    "sessionId": "optional",
    "conversationId": "optional",
    "tmuxSessionId": "optional",
    "clientTmuxSessionId": "optional",
    "metadata": {}
  },
  "runtimeMetadata": {},
  "options": {
    "includeSnapshotLookup": true,
    "includeTombstoneLookup": true
  }
}
```

约束：

1. TS 不得在传入前先拼 candidate key 列表；
2. TS 不得在传入前先决定 fallback 回溯顺序；
3. `options` 只表达用途，不表达排序。

### 输出草案

```json
{
  "strictSessionScope": "tmux:abc",
  "stickyKey": "tmux:abc",
  "candidateKeys": [
    "tmux:abc",
    "session:abc",
    "conversation:xyz"
  ],
  "lookupPolicy": "strict_then_sticky_then_session_family",
  "readStopMessageSnapshot": true,
  "readStopMessageTombstone": true
}
```

约束：

1. `candidateKeys` 顺序必须由 Rust 唯一决定；
2. snapshot / tombstone 必须共享同一组 `candidateKeys`；
3. TS 只消费，不重排、不追加、不删改。

### TS bridge 要求

在：

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`

新增：

- `planStopMessagePersistedLookupWithNative(...)`

然后由：

- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts`

提供 stop-message-auto 专用包装。

### TS 删除顺序

1. 新增 Rust contract
2. 新增 TS bridge
3. `stop-message-auto.ts` 改为消费 `candidateKeys`
4. 删除 `collectPersistedStopMessageCandidateKeys(...)`
5. 删除 `fallbackStickyKey` 参数与调用
6. 再把该文件纳入更强门禁

### 为什么这是唯一正确方案

因为当前问题不是：

- “TS 缺少一个 resolver”

而是：

- “TS 正在本地编排 persisted lookup policy”

所以继续补：

- `resolveStopMessageSessionScopeWithNative(...)`
- `resolveServertoolStickyKeyWithNative(...)`

这样的单点 string 能力，并不能消除双真源；只有把 **candidate key planning 本身** 提升为 Rust 高层合同，才能真正完成收口。

### 文件级落地顺序（固定）

实现该合同的 patch 顺序必须固定为：

1. Rust：
   - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
   - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/lib.rs`
2. TS bridge：
   - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-required-exports.ts`
   - `sharedmodule/llmswitch-core/src/native/router-hotpath/native-chat-process-servertool-orchestration-semantics.ts`
3. stop-message runtime 壳层：
   - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts`
4. stop-message 主链：
   - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
5. 最后才允许升级门禁：
   - `scripts/verify-servertool-rust-only.mjs`

禁止倒序：

- 禁止先删 `fallbackStickyKey`
- 禁止先改 `stop-message-auto.ts` 再补 Rust contract
- 禁止在 TS bridge 或 runtime-utils 中复制 candidate key 编排

### 删除点固定

当 Rust contract 与 TS bridge 验证通过后，唯一正确删除点是：

- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`
  - `collectPersistedStopMessageCandidateKeys(...)`
  - `fallbackStickyKey` 参数
  - `fallbackStickyKey` 两处调用

这三个删除点必须视为**同一组语义删除**，不可拆成“先删参数、后删编排”的半完成状态。
