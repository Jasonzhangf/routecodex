# V4 MetadataCenter (routecodex-v4-control) Independent Freeze Plan

## Objective

实现并冻结 V4 控制面核心组件 `routecodex-v4-control`：一个 scope 隔离、typed、带完整审计的
MetadataCenter（register / consume / release 状态机）。它是 request / response / error /
config / lifecycle 所有链族共用的控制信号注册与消费资源，也是 P0「控制面与业务 payload
物理隔离」红线的执行核心。

设计输入（已存在的合同，本计划不重新发明）：

- `v4/contracts/data-control-boundary.contract.json`（INV-01/03/05、RED-02/03/04/06/09）
- `v4/docs/architecture/v4-resource-operation-map.yml`（`v4.control.metadata_center` 定义）
- `v4/docs/architecture/v4-data-control-plane-boundary.md`
- 已冻结的 `routecodex-v4-base-node`（复用其 `Scope` 五维闭环 scope，不重复实现）

## 合同锁定

1. **scope 隔离**：`MetadataCenter` 实例绑定唯一 `LoopScope`
   （request_id / pipeline_id / port / session_scope / conversation_scope）。
   跨闭环复用控制信号 = 红。闭环结束必须 `release`，未释放即复用 = 红。
2. **register / consume / release 状态机**：
   `unregistered -> registered -> (consume*) -> released`。
   - 重复 register = 红；
   - 未注册 consume / release = 红；
   - 已释放后 consume / release = 红；
   - consume 不改状态（与已冻结 Edge `ScopeRegistry` 语义一致）。
3. **typed 控制信号**：`ControlSignalKind` 是显式枚举
   （route / continuation / stopless / error / scope），禁止自由 JSON。
   客户端协议字段（`metadata` / `client_metadata` / `x-*`）不是控制信号类别；
   协议 metadata 搬进 MetadataCenter = 红（RED-09）。
4. **控制信号绝不进入 payload**：`PayloadGate::write_control` 必须 fail-fast 返回错误并记录
   owning boundary 审计（RED-02/03/05）；payload 不得重建控制状态（RED-04）。
5. **每条操作写不可变审计记录**：record_id、control_key、operation、scope、signal、
   sequence、timestamp_ms；可被 debug/诊断只读查询，禁止进入 live path。

## API 面（冻结后不可变）

```rust
MetadataCenter::new(scope: Scope) -> Self
register(&mut self, control_key, signal: ControlSignal) -> Result<MetadataRecord, ControlError>
consume(&mut self, control_key) -> Result<&ControlSignal, ControlError> // 写 Consume 审计，状态不变
release(&mut self, control_key) -> Result<MetadataRecord, ControlError>
records(&self) -> impl Iterator<Item = &MetadataRecord>
is_registered(&self, control_key) -> bool
is_released(&self, control_key) -> bool
PayloadGate::write_control(&mut self, signal) -> Result<(), ControlError> // 恒 Err，fail-fast + leak 审计
PayloadGate::leak_attempts(&self) -> impl Iterator<Item = &PayloadLeakRecord> // 只读诊断查询
ControlSignal::try_from_protocol_metadata(key, value) -> Result<Self, ControlError> // 恒 Err（RED-09）
ControlSignal::try_reconstruct_from_payload(...) -> Result<Self, ControlError> // 恒 Err（RED-04）
```

## 红测清单（正反成对）

| 测试 | 正向 | 反向（红） |
| --- | --- | --- |
| register->consume->release 周期 | 全成功 + 3 条审计 | 重复 register / 未注册 consume / 已释放 consume |
| scope 隔离 | 同闭环 register/consume 成功 | 跨闭环（不同 scope center）consume 红 |
| 泄漏 gate | 正常业务写入不受影响 | `write_control` fail-fast Err + 审计 |
| 协议 metadata 隔离 | 内部信号可注册 | 协议字段不可构造控制信号 |
| payload 重建 | 控制信号类型独立 | `try_reconstruct_from_payload` 恒 Err |
| 审计不可变 | 记录含 scope/sequence/timestamp | 无记录操作（count 不变） |

## 边界（不做）

- 不做 route_facts / target_selection / stopless 状态机实现（后续 router / stopless 模块）。
- 不做广播/订阅总线（后续 debug/diagnostic 模块）。
- 不接 V3 runtime，不改 V3。
- 不把控制信号序列化进任何业务 payload 结构。

## 完成标准

- `routecodex-v4-control` 独立编译、独立发布、独立冻结（AppSDK 生命周期）。
- Protected 含 source、contracts、records、hashes。
- L2 回归报告含 whitebox + blackbox 证据。
- Edge（接线合同）与 BaseNode（节点能力）均保持 frozen，不受本模块影响。
- 生成物 gitignored，不提交。
