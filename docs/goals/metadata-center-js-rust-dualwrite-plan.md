# MetadataCenter JS/Rust Dual-Write Migration Plan

## 1. 目标

建立一个中心化的 `MetadataCenter` 双写架构：

1. 所有 metadata/runtime-control/continuation/provider-observation 写入都只能走统一 `MetadataCenter` API。
2. 每次写入自动同时落到：
   - JS `MetadataCenter`
   - Rust `MetadataCenter`
3. JS 业务逻辑只读 JS center；Rust 业务逻辑只读 Rust center。
4. 当前阶段允许双份存储，但不允许双份散落语义。
5. 最终在 Rust 化完成后移除 JS 读侧/存储侧，收敛到 Rust 单真源。

本计划不是立即执行项。执行顺序锁定为：

1. 先完成 stopless 当前修复；
2. stopless 黑盒/在线闭环稳定后；
3. 再按本计划实施 MetadataCenter 双写迁移。

## 2. 当前问题与触发证据

当前 stopless 暴露出的真实问题是：

- JS 入口已通过 `MetadataCenter.writeRuntimeControl(...)` 写入 `stopMessageEnabled`；
- 但 Rust request chat process 没有稳定读到同一份状态；
- 结果是 response 侧 stopless 可触发，而 request 侧 provider-request 没注入 stopless guidance / `reasoningStop` tool。

这说明现状存在结构性风险：

1. JS `MetadataCenter` 是运行时真相之一；
2. Rust 侧语义消费并没有绑定到一个中心化、强制同步的 Rust center；
3. 跨边界字段传播当前仍可能依赖零散投影或散落 plain metadata。

## 3. 方案结论

采用 Jason 指定方案：

1. 建立 Rust 版本 `MetadataCenter`。
2. 所有 `MetadataCenter` 写 API 在写入时自动双写 JS + Rust。
3. Rust 请求/响应/chat process/continuation 只读取 Rust center。
4. JS handler/bridge/host adapter 只读取 JS center。
5. 禁止任何模块绕过 `MetadataCenter` API 直接写 plain metadata / `__rt` / 顶层 runtime-control 字段。

本方案的核心不是“零散 projection”，而是“中心化双写 + 单入口治理”。

## 4. 范围

### In Scope

- `src/server/runtime/http-server/metadata-center/**`
- `src/server/handlers/**` 中通过 `MetadataCenter` 写入 metadata 的入口
- `src/modules/llmswitch/bridge/**` 中 continuation/request-context/response-context 写入
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/**` 对 metadata 的 request/response 消费
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/**` 对 stopless/servertool 相关 metadata 的消费
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`

### Out of Scope

- 本轮 stopless 现修
- SSE transport 层改动
- provider transport/auth/retry 改造
- “一次性删光 JS metadata center”

## 5. 架构约束

### 5.1 单一写入口

所有共享 metadata 只能通过 `MetadataCenter` API 写入，例如：

- `writeRequestTruth(...)`
- `writeRuntimeControl(...)`
- `writeContinuationContext(...)`
- `writeProviderObservation(...)`

禁止：

- `metadata.foo = ...`
- `metadata.__rt = ...`
- 手拼 `stopMessageEnabled` / `routeHint` / `responsesResume` / `providerKey`
- 在 handler/bridge/executor 中私自再做一份 Rust plain metadata 同步

### 5.2 双写策略

每次 API 写入都必须通过同一个 owner 自动执行：

1. 写 JS center
2. 写 Rust center
3. 保证同一 schema、同一 key、同一生命周期语义

禁止“每个调用点顺手补一份 Rust 同步”。

### 5.3 读侧分离

- JS 逻辑只读 JS center
- Rust 逻辑只读 Rust center

禁止：

- Rust 消费 JS `MetadataCenter` 私有结构
- JS 业务层再去读 Rust center 反向补偿

### 5.4 迁移终态

迁移终态是 Rust 单真源。

当前双写只是迁移期设计，不允许把“JS+Rust 双长期真源”当作最终架构。

## 6. 共享 Schema 设计

JS center 与 Rust center 必须共用同一份 shared schema registry，至少分四类：

1. `request_truth`
2. `runtime_control`
3. `continuation_context`
4. `provider_observation`

每个字段必须声明：

- `shared_sync`: JS/Rust 双写同步字段
- `js_only`: 只允许 JS 持有
- `rust_only`: 只允许 Rust 持有

未声明为 `shared_sync` 的字段，禁止自动双写。

## 7. 同步总线约束

必须存在一个唯一 owner 承担 JS<->Rust center 同步，不允许多入口。

推荐形态：

- `metadata-center-sync`

职责：

1. 接收 `MetadataCenter.write*` 写事件
2. 依据 shared schema registry 校验字段合法性
3. 自动同步 Rust center
4. 产出确定性的 debug/diag/gate surface

禁止：

- 在 handler 内直接同步
- 在 bridge 内直接同步
- 在 Rust N-API 调用点随意补同步

## 8. 生命周期与边界

### 请求侧

- 请求进入后：JS center 建立
- 任何 request-side metadata 写入：自动双写 JS/Rust
- request chat process：Rust 只从 Rust center 读

### 响应侧

- response chat process：Rust 只从 Rust center 读/写
- 响应收尾前：由中心 owner 管理释放，不允许 SSE transport 介入语义

### continuation

- save/restore 相关 context 进入 `continuation_context`
- continuation restore 后新的请求也必须先恢复双 center，再进入 chat process

## 9. 阶段计划

### Phase 0: stopless closeout first

前置条件：

- 当前 stopless 黑盒红点全部转绿
- 至少完成 stopless request-side/provider-request/client-response 的黑盒锁定
- 必要的在线闭环完成

Phase 0 不做本计划实施，只锁边界与顺序。

### Phase 1: schema + owner surface

交付：

- JS/Rust shared metadata schema registry
- function map 增加 `metadata_center_dualwrite_sync`
- verification map 增加 schema/gate/test 映射
- mainline map 标出 metadata center sync 不属于 SSE，不属于 provider runtime

### Phase 2: 双写基础设施

交付：

- `MetadataCenter.write*` 统一进入双写总线
- Rust center 基础对象与读 API
- 最小同步集先跑通 `runtime_control.stopMessageEnabled`

### Phase 3: stopless first consumer

交付：

- stopless request chat process 改为只读 Rust center
- stopless response chat process 改为只读 Rust center
- stopless continuation/save/restore 相关共享字段接入双写

### Phase 4: broader runtime-control migration

交付：

- `routeHint`
- `responsesResume`
- `streamIntent`
- `clientAbort`
- 后续 servertool/web_search/continuation 依赖字段

### Phase 5: gate hardening + delete bypasses

交付：

- 物理删除旧的散落 plain metadata 写法
- gate 锁住绕过写入 API 的代码路径
- 黑盒覆盖关键能力 provider/client 闭环

### Phase 6: JS center shrink

前置条件：

- Rust 读侧完全接管
- JS 只剩 host adapter 必需读法

交付：

- 缩减 JS center 读侧
- 为最终 Rust 单真源做删除计划

## 10. 必补 Gate

### 10.1 静态 Gate

必须新增或收紧扫描，禁止：

- 直接写 plain metadata
- 直接写 `__rt`
- 手拼共享 runtime-control 字段
- handler/bridge/executor 绕过 `MetadataCenter.write*`

### 10.2 Contract Gate

必须验证：

1. JS center schema 与 Rust center schema 一致
2. `shared_sync` 字段双写后两侧可读一致
3. 非 shared 字段不会错误跨边界同步

### 10.3 黑盒 Gate

关键能力必须锁最终结果，不只锁 center 内部状态：

1. provider-request 看到了期望 guidance/tools/context
2. client-response 看到了期望治理后结果
3. continuation save/restore 后下一轮行为正确

## 11. stopless 作为首个迁移样板

stopless 是本计划的第一条落地主线，因为它已经暴露出：

- request-side metadata 同步缺口
- response-side stopless owner 边界
- continuation save/restore 对 metadata 的依赖

stopless 在本计划中的作用：

1. 作为第一条 shared runtime-control 双写样板；
2. 作为第一条 Rust-only metadata 消费样板；
3. 作为第一条 provider/client 黑盒闭环样板。

## 12. 完成标准

本计划实施完成时，必须满足：

1. 共享 metadata 写入全部只能走 `MetadataCenter.write*`
2. JS/Rust center 双写由单一 owner 负责
3. Rust request/response 语义层不再依赖零散 plain metadata 同步
4. stopless/servertool/continuation 至少一条主线已通过双写机制闭环
5. 绕过中心写入的旧实现被物理删除
6. gate 能稳定阻止未来再次出现“JS 写了，Rust 没同步”的问题

## 13. 当前决策

当前只落计划，不执行迁移。

锁定顺序：

1. 先修 stopless；
2. stopless 黑盒与在线闭环通过；
3. 再按本计划实施 MetadataCenter JS/Rust 双写迁移。
