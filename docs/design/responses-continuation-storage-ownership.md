# Responses Continuation Storage Ownership 设计文档

## 目标

把 `/v1/responses` continuation / submit_tool_outputs / servertool followup / direct / relay 的状态归属收成单一语义，禁止跨存储介质恢复，禁止普通 create 因 scope 历史误触发 continuation。

## 背景共识（新增架构约束）

这条线必须先有一个基础共识，再谈实现：

1. continuation 不是“有历史就自动续接”，而是“只有保存过的状态才有恢复权”
2. save / restore 的归属必须和执行介质绑定，不能跨 `direct` / `relay` 偷切
3. followup 不是特殊协议，它只是“正常请求再次进入标准流水线”
4. 内部控制面信息只能在 hub / router / servertool / provider runtime 内部消费，不能出站污染 provider payload，也不能回给客户端

因此，Responses continuation 的判断不能再按“同 session / 同 scope 是否命中旧状态”处理，而必须按 **store ownership** 处理。

## 核心结论

Responses continuation 的唯一判定，不是“同 session / 同 scope 是否存在历史”，而是：

1. 这条状态是否真的被保存过
2. 保存发生在哪个介质
3. 当前请求是否是明确 continuation 入口
4. 若为 direct，当前 provider 是否与保存时 provider 完全一致
5. 当前入口协议 / 入口 endpoint 是否与保存时允许恢复的入口完全一致

## 单一语义（SSOT）

### 1. store=false

语义：
- 不保存 continuation 状态
- 不存在后续 continuation 恢复权
- 下一个请求只能当普通 create 处理

强约束：
- 不能因为同 session / 同 conversation / 同 scope 自动注入 `previous_response_id`
- 不能因为本地 store 中存在旧状态就自动 materialize

### 2. direct + store=true

语义：
- continuation 状态保存在远程 provider
- `response_id` / `previous_response_id` 属于该 provider 的远程 state
- 下一轮 continuation 只能回到同一个 provider

强约束：
- direct 保存的状态只能 direct 恢复
- direct 保存的状态不能转成 relay 本地 continuation
- direct 保存的状态不能切换到另一个 provider 恢复
- 若保存时 provider 不可用，应显式报 continuation 无法恢复；不能偷偷 reroute 到别的 provider
- direct 首发若 `store=false`，即便后续同 session / 同 scope 命中历史，也不得自动补 `previous_response_id`
- direct continuation 的 sticky 真相是“远程 state + 同 provider ownership”，不是“本地历史看起来像同一个会话”

### 3. relay + store=true

语义：
- continuation 状态保存在本地 responses conversation store
- 下一轮 continuation 只能由本地 store 恢复
- 恢复出的请求再按正常流水线进入 relay

强约束：
- relay 保存的状态不能伪装成 remote continuation 发给 direct provider
- relay 恢复不得构造假的远程 `previous_response_id` 去冒充上游远程保存状态
- relay followup 只是“正常请求重入 + 明确 continuation 标记”，不是第二套协议
- relay 恢复后的请求仍然是标准 `/v1/responses create` 语义，只是由本地 store 在入口前 materialize 出继续所需上下文

## continuation 合法入口

只有以下场景允许触发 continuation 恢复：

1. `/v1/responses.submit_tool_outputs`
2. 请求体已显式带 `previous_response_id`
3. 请求体已显式带 `response_id`
4. 已被内部明确标记为 followup / continuation 重入
5. 已知是 relay 本地 continuation 恢复入口

以下场景一律不允许自动 continuation：

1. 普通 `/v1/responses` create
2. 普通 search 首发
3. 普通 thinking 首发
4. 普通 coding 首发
5. 仅仅因为同 session / conversation / scope 命中历史
6. `/v1/chat/completions` 或 `/v1/messages` 仅因为 session/scope 命中旧 Responses continuation

补充说明：

- `/v1/responses.submit_tool_outputs` 属于 continuation 入口，因为它本身就是对既有 response chain 的显式续接。
- 普通 `/v1/responses` create 即使带长历史、即使上一轮刚发生 tool call，也不等于 continuation；只有显式 ownership 证据成立时才进入 continuation 分支。

## 状态模型

建议统一收成以下 ownership 结构：

```ts
ContinuationOwnership = {
  storeEnabled: boolean;
  storageKind: 'none' | 'remote-direct' | 'local-relay';
  entryKind: 'responses' | 'chat' | 'messages';
  providerKey?: string;
  responseId?: string;
  sessionId?: string;
  conversationId?: string;
}
```

恢复规则：

- `none` → 禁止 continuation
- `remote-direct` → 仅允许同 `providerKey` + 同 `entryKind=responses` 继续
- `local-relay` → 仅允许本地 store materialize / resume，且仅对 `entryKind=responses` 生效

补充要求：

- 若 `storageKind === 'remote-direct'`，则 `providerKey` 必须是恢复时的强校验条件，而不是仅用于观测日志。
- 若 `storageKind === 'local-relay'`，则本地 store 是唯一恢复真源；不得再派生一个假的 remote continuation 影子。
- `entryKind` 必须进入 store scope key，而不是只作为 metadata 注释字段；chat/messages 入口不得共享 responses continuation scope。

## 真源修改边界

### A. continuation 触发真源

唯一真源：
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/responses_resume.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`

职责：
- 判断当前请求是否具备 continuation 证据
- 判断 continuation 属于 direct 远程恢复还是 relay 本地恢复
- 禁止 scope-only 自动续接
- direct continuation 必须校验 sticky provider ownership

禁止：
- 在其他 request executor / handler / provider client 层偷偷补 continuation 判定
- 在 followup builder 中再塞第二套 continuation 语义
- 恢复已删除的 `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/route-aware-responses-continuation.ts` TS owner 或对应测试作为兼容层

### B. relay 本地保存真源

唯一真源：
- `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`

职责：
- 只保存 relay 本地 continuation 所需状态
- 显式记录其为 local-relay ownership
- 不为普通 store=false 请求生成 continuation 恢复权
- 必须把 `entryKind` 与 `continuationOwner` 编进 scope key

### C. direct 保存真源

职责真相：
- state 归属在远程 provider
- 本地只能保存最小 ownership / sticky 信息，不能伪造完整远程 state

### D. followup 重入真源

职责真相：
- followup 只是“按上一轮 origin 形状重建一条新的标准请求”
- 它能否 continuation，完全取决于上一轮 ownership 与当前入口证据
- 不允许在 followup builder / provider converter / HTTP handler 各自再偷偷补一套 continuation 语义

## direct / relay 切换规则

### 合法
- direct 首发 -> direct submit_tool_outputs -> direct continuation
- relay 首发 -> relay followup -> relay continuation

### 非法
- direct store 后切 relay 继续同一个 remote response chain
- relay store 后切 direct 并注入 fake `previous_response_id`
- direct provider A store 后切 direct provider B 恢复
- 普通 create 因为 scope 命中旧状态而自动续接

### 为什么必须这样

因为 direct 与 relay 的 save/store 介质根本不同：

- direct 的 state 真源在远程 provider
- relay 的 state 真源在本地 responses conversation store

一旦允许跨介质恢复，就会出现：

1. 本地 followup 污染正常 direct 请求
2. direct 远程 state 被错误投影成 relay 本地 continuation
3. relay 本地历史被错误伪装成 remote `previous_response_id`
4. provider / client 看到不属于自己协议面的控制字段
5. chat/messages 入口命中 responses continuation scope，导致桥层在错误入口上恢复 Responses 历史

## followup 规则

followup 不是特权协议，只是正常请求重入。

但 followup 若要 continuation，必须满足 ownership：

- direct-origin followup → 同 provider direct 恢复
- relay-origin followup → 本地 relay 恢复

不允许：
- followup 跨 direct/relay 介质切换 continuation
- followup 绕过 store=true 条件凭历史直接恢复

最小语义：

- 先恢复 origin request 的标准输入形状
- 再把 tool result / delta 作为正常增量并入
- 最后按普通 `/v1/responses create` 再次进入标准流水线

也就是说：

- submit 是显式 continuation 入口
- followup 是“标准 create 重入 + 内部 continuation 打标”
- 两者都不能绕开 ownership
- chat/messages 入口不是 Responses continuation 合法恢复入口；若确需跨协议重放，必须先由唯一 owner 把 origin request materialize 成新的标准请求，再显式进入目标入口，不能靠 scope 自动命中

## 三重隔离键（新增）

Responses continuation 的恢复键必须同时包含：

1. `entryKind`
   - `responses`
   - `chat`
   - `messages`
2. `continuationOwner`
   - `direct`
   - `relay`
3. `session/conversation + port/group`

最小要求：

- `responses` continuation store 只能给 `entryKind=responses` 请求命中。
- `continuationOwner=direct` 与 `continuationOwner=relay` 必须使用不同 scope key，不能只作为 entry 属性记录。
- `sessionId/conversationId` 只用于同入口同 owner 下缩小命中范围，不能单独成为恢复权。

禁止：

- chat 请求因为 session 相同而命中 responses scope
- relay scope materialize 恢复出 direct 记录
- direct submit_tool_outputs 恢复到 relay 记录
- bridge 层通过读 `deltaInput` / `fullInput` 猜测“既然像 continuation 就先续接”

## Continuation Provider Routing Pin

continuation 恢复后的下一个请求必须路由回到**保存该状态的原 provider.key**，否则跨 provider 恢复将破坏 ownership 语义。此约束通过 `__shadowCompareForcedProviderKey` 路由 pin 指令实现。

### 生产者

`__shadowCompareForcedProviderKey` 在以下两条路径写入 `normalizedMetadata`：

1. **servertool followup 注入** — `stop-message-auto.ts:597-617` 在 handler 触发 `stop_message_flow` 时，通过 `readPinnedTargetFromAdapterContext()` 读取当前请求的 providerKey，注入到 followup metadata 中，一并携带 `providerKey`、`targetProviderKey`、`assignedModelId`、`modelId`、`target`。

2. **relay store restore 同步** — Rust `shared_responses_conversation_utils.rs` 的 restore/materialize payload 负责返回 store 中保存的 `providerKey`，再由 Hub/VR metadata carrier 消费；禁止恢复旧 `route-aware-responses-continuation.ts` 中的 TS routing pin 同步逻辑。

### 消费者

Rust 侧在两个阶段消费此字段：

1. **`build_router_metadata_input`** (`router_metadata_input.rs:205-215`) — 将 `normalizedMetadata.__shadowCompareForcedProviderKey` 透传到 `RouterMetadataInput` 输出中。

2. **路由指令解析** (`instructions/state.rs:40-44`) — 读取 `RouterMetadataInput.__shadowCompareForcedProviderKey`，将其解析为 `RoutingInstruction { kind: "force", target: <providerKey> }` 加入路由指令列表。`force` 指令在路由选择中的优先级高于所有 mode-based 策略（round-robin / priority / weighted）。

### 优先级链

```
1. <**forced:provider**> / routing instruction "force"   → 最高，由 __shadowCompareForcedProviderKey 触发
2. semantics.continuation.resumeFrom.providerKey         → assertDirectProviderOwnership 校验用
3. sticky session provider (session 残留)                → 次高
4. 普通路由策略（round-robin / priority / weighted）    → 最后
```

### 约束

- `passthrough_remote_direct` 模式不写 `__shadowCompareForcedProviderKey`，因为 remote state 由远程 provider 维护，本地无需 pin；`assertDirectProviderOwnership()` 确保 outbound provider 一致。
- `__shadowCompareForcedProviderKey` 只存在于 hub pipeline 内部的 `normalizedMetadata` 中，**不允许出站发给 provider**。

## 与 metadata 收口的关系

内部 metadata 只允许做：
- continuation 入口打标
- ownership / sticky / runtime hint 传递

内部 metadata 不允许：
- 出 hub pipeline 发给 provider
- 出给客户端
- 作为 provider 可见协议字段存在于 outbound payload

所以 continuation ownership 与 provider outbound metadata allowlist 必须同时成立：

1. continuation 判定只在 hub 内部完成
2. provider 只接收合法外部协议字段
3. direct / relay 的内部 ownership 不能泄露到外部 payload
4. 客户端也不应看到内部 `meta/id/routeHint/responsesResume/clientInject*` 等控制字段

## 测试规格

### 红测

1. 同 scope 已存在历史 continuation，但普通 `/v1/responses` create 不得自动注入 `previous_response_id`
2. direct store 后，如果 provider 不同，禁止 continuation 恢复
3. relay store 后，禁止生成 remote direct continuation 字段
4. submit_tool_outputs 仍可在合法 ownership 下恢复
5. followup 在 direct-origin / relay-origin 下各自只能走对应恢复路径

### control

1. direct + store=true + same provider → continuation 正常
2. relay + store=true → 本地 materialize 正常
3. store=false → 永不 continuation

## 完成标准

1. 普通 `/v1/responses` create 不再因 scope 历史误触发 continuation
2. continuation 恢复必须以 store ownership 为前提
3. direct 与 relay continuation 完全隔离
4. direct continuation 必须 sticky 到原 provider
5. 内部 continuation metadata 不出 hub pipeline
6. followup 作为正常请求重入，不再产生第二套私有协议语义
