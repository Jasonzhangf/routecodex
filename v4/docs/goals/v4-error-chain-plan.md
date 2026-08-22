# V4 ErrorChain + ErrorCenter (routecodex-v4-error) Independent Freeze Plan

## Objective

实现并冻结 V4 错误控制面核心组件 `routecodex-v4-error`：单向、固定六阶段的错误链
（source raised -> host captured -> runtime classified -> router policy applied ->
execution decision -> client projected），以及 intake/classify/audit-only 的 ErrorCenter。
它把 BaseNode 的 typed error intake 与 Edge 的 error_intake 边接成唯一错误真源，
并把「错误中心不得路由、不得读 payload、不得本地重试」变成类型和状态机层面的红测。

设计输入（已存在的合同，本计划不重新发明）：

- `v4/contracts/pipeline-abstraction.contract.json`（error_center / route_exit / payload_cycle）
- `v4/docs/architecture/v4-resource-operation-map.yml`（`v4.control.error_chain`、
  `v4.control.error_center`、`v4.control.retry_policy`、`v4.error.client_projection`）
- `v4/docs/architecture/v4-data-control-plane-boundary.md`
- 已冻结的 `routecodex-v4-base-node`（复用 `Scope`，不重复实现）

## 合同锁定

1. **单向六阶段链**：`V4Error01SourceRaised -> V4Error02HostCaptured ->
   V4Error03RuntimeClassified -> V4Error04RouterPolicyApplied ->
   V4Error05ExecutionDecision -> V4Error06ClientProjected`。
   只允许相邻转换；跨阶段跳转、跳过头、终止后继续、未 raise 先操作 = 红。
2. **typed error facts**：每阶段携带 `stage + code + scope + payload_hash +
   typed_context + sequence + timestamp`；错误中心永远只消费 hash + typed context，
   禁止重读业务 payload（RED-04：payload 不得重建控制状态）。
3. **message-only projection 禁止**：`V4Error06ClientProjected` 只能从
   `V4Error05ExecutionDecision` 进入；直接拼 message 出站、跳过决策 = 红。
   `ClientProjection` 只含 `code` + `message`，无 scope/stage/hash 等内部控制字段。
4. **ErrorCenter 只做 classify + audit**：写不可变审计记录（含 category），
   无任何 route / retry / cooldown / reroute / payload 写入 API（类型面缺失即锁）。
5. **RetryPolicy 只被 execution decision 消费**：typed（policy_id / provider_scope /
   matcher / action_class / reason_code）；provider-local retry / cooldown 持久化无 API。
6. **scope 隔离**：错误链与错误中心绑定唯一 `Scope`；跨闭环复用 = 红。

## API 面（冻结后不可变）

```rust
ErrorChain::new(scope: Scope) -> Self
raise(&mut self, code, payload_hash, typed_context) -> Result<ErrorFact, ErrorChainError>   // -> 01
capture(&mut self) -> Result<ErrorFact, ErrorChainError>                                    // 01 -> 02
classify(&mut self, witness: ClassifyAuditWitness) -> Result<ErrorFact, ErrorChainError>    // 02 -> 03
apply_policy(&mut self, policy: RetryPolicy) -> Result<ErrorFact, ErrorChainError>          // 03 -> 04
decide(&mut self, decision: ExecutionDecision) -> Result<ErrorFact, ErrorChainError>        // 04 -> 05
project(&mut self, message) -> Result<ClientProjection, ErrorChainError>                    // 05 -> 06，终止
records(&self) -> impl Iterator<Item = &ErrorChainRecord>
current_stage(&self) -> Option<ErrorStage>
is_terminal(&self) -> bool

ErrorCenter::new(scope: Scope) -> Self
classify(&mut self, fact: ErrorFact) -> Result<ClassifyAuditWitness, ErrorChainError>        // audit + category
records(&self) -> impl Iterator<Item = &ClassifyAuditRecord>

ErrorFact::try_reconstruct_from_payload(...) -> Result<Self, ErrorChainError>                // 恒 Err（RED-04）
```

## 红测清单（正反成对）

| 测试 | 正向 | 反向（红） |
| --- | --- | --- |
| 六阶段全链 | raise..project 全成功 + 6 条审计 + terminal | 跳阶段（01->03）红 |
| raise 生命周期 | 首个 raise 成功 | 未 raise 先 capture / 二次 raise 红 |
| 终止后操作 | project 后 is_terminal | terminal 后任何转换红 |
| message-only projection | 仅 05 可 project，返回 code+message | 05 前 project 红 |
| RetryPolicy 消费位 | 03 后 apply_policy 成功 | 01/02 后 apply_policy 红；decide 重复红 |
| scope 隔离 | 同 scope chain + center 成功 | 跨 scope fact 进 center 红 |
| ErrorCenter audit-only | classify 写不可变审计（category） | 重复 classify 同一 fact 红 |
| ErrorCenter intake 完整性 | HostCaptured + payload hash + typed context 产出 witness | 缺/空 hash、缺/空 context、非 HostCaptured 红 |
| Error03 审计准入 | 消费同一 ErrorFact lineage 的 opaque witness | 无 witness 编译失败；错 witness / clone 重复消费红 |
| payload 重建 | typed facts 独立 | try_reconstruct_from_payload 恒 Err |
| 审计不可变 | 记录含 scope/sequence/timestamp | 只读查询不改变记录数 |
| blackbox 回归 | 公共 API 全量可用 | — |

## 边界（不做）

- 不做 route_facts / target_selection / VR 决策实现（后续 router 模块）。
- 不做 retry/cooldown/reroute 执行、不写 cooldown 持久化。
- 不接 V3 runtime，不改 V3。
- 不把错误事实序列化进任何业务 payload 结构。

## 完成标准

- `routecodex-v4-error` 独立编译、独立发布、独立冻结（AppSDK 生命周期）。
- Protected 含 source、contracts、records、hashes。
- L2 回归报告含 whitebox + blackbox 证据。
- BaseNode / Edge / Control 均保持 frozen，不受本模块影响。
- 生成物 gitignored，不提交。
