# V4 标准插件库（M5）

状态：`contract_bound`，请求链 Node 01-07 已接真实 `NodeContainer` 分发。
Owner：`routecodex-v4-standard-plugins`。
合同：`v4/contracts/plugin-library.contract.json`。

## 范围

标准库交付 V4 插件的不可变描述符、确定性 artifact/contract 字节、
`PluginCatalog` 注册、per-node `NodePluginPlan` 编译和 typed
`StandardHandleRegistry`。请求链插件执行真实 JSON/SSE inbound、Chat Process
治理、VR admission/select/model replacement、provider compat 与 wire boundary；
auth 与 transport 仍由 provider owner 执行，不进入插件 payload。

## 类别与不可变 ID

标准库按 8 个类别注册 16 个不可变插件 ID：

| 类别 | 插件 ID |
| --- | --- |
| contracts | `v4.std.contract.output_validate` |
| diagnostic | `v4.std.diagnostic.debug_observe` |
| control | `v4.std.control.scope_registry` |
| error | `v4.std.error.typed_intake` |
| protocol | `v4.std.protocol.server_input`, `v4.std.protocol.sse_in`, `v4.std.protocol.responses_inbound` |
| chat_process | `v4.std.chat_process.scope_restore`, `v4.std.chat_process.continuation_restore`, `v4.std.chat_process.tool_governance` |
| routing | `v4.std.routing.entry_model_admission`, `v4.std.routing.candidate_filter`, `v4.std.routing.target_selection`, `v4.std.routing.model_replacement` |
| provider | `v4.std.provider.compat`, `v4.std.provider.wire_boundary` |

每个 `StandardPlugin` 都携带：

- 固定 `plugin_id`、版本 `0.1.0`、owner `routecodex-v4-standard-plugins`；
- 有效 node-graph role、resource axis、effect、phase、order；
- canonical SHA256 artifact/contract bytes；
- 确定性 keyless handle。

同 identity 重复注册是幂等操作；artifact/contract/owner identity 漂移由
`PluginCatalog` fail-fast 拒绝。

## 注册与编译

```text
standard_plugins()
  -> catalog_entry()
  -> register_standard_library(catalog)
  -> standard_authoring(ids)
  -> compile_standard_plan(node, role, chain, position, ids)
  -> NodePluginPlan
```

`compile_standard_plan` 复用唯一 `routecodex-v4-plugin-plan` owner，不建立第二套
排序/依赖/权限逻辑。每个描述符必须绑定 active node 的 `node_id`、`role_id` 和
`position`；编译器先按 `node-graph.contract.json` 验证 selector，再由
`standard_node_allowed_reads()` / `standard_node_allowed_writes()` 从 `node_id`
派生精确权限，调用方不能扩大读写面。请求 outbound 只允许
`normal_payload -> provider_semantic -> provider_wire_payload` 相邻前向转换；
control/error/diagnostic 资源不进入 normal/provider/client payload。

## Side-channel 边界

标准插件只通过 `ExecCtx` 的 typed data/control 通道执行：

- `execute_plan` 将当前 `PlanEntry.reads/writes` 绑定进 `ExecCtx`；control handle
  只能通过 `read_control_resource(resource_id)` / `write_control_resource(resource_id, value)`
  访问该 entry 已声明的单个资源，未声明访问立即记录并返回
  `ResourceAccessViolation`；handle 即使捕获返回值，executor 也会 fail-fast；
- control-only 插件只写 `v4.control.*` / `v4.lifecycle.payload_cycle`；
- diagnostic-only 插件只 emit diagnostics，不写 data/control；
- error 插件只写 `v4.control.error_chain`；
- provider compat 只消费 provider semantic 与 typed target selection；wire boundary
  发现控制字段立即 fail-fast，不做 silent strip；
- 任何控制、error、diagnostic 事实不得进入 `data`，payload 不得重建控制状态。

control carrier 内的 `metadata_center`、`payload_cycle`、`error_chain`、
`route_facts`、`target_selection` 是彼此独立的资源槽。metadata-only 插件不能观察
或回写 error/route 资源，error-only 插件也不能观察或回写 metadata center；执行后
未声明资源必须逐值保持不变。

标准库不实现 fallback、silent strip、第二 runtime/kernel、跨节点 dispatch、
payload reconstruction 或 provider/client metadata 泄漏。

## 验证

M5 四个 gate 已接入 V4 verification map 与 `verify:ci`：

- `v4_standard_plugins_l2_regression`：crate 单测 + L2 红测；
- `v4_standard_plugins_test_consumer`：Active surface build-link consumer；
- `v4_parity_gate_standard_plugins`：合同/注册表/函数 map/源码边界；
- `v4_parity_gate_standard_plugins_red`：负类自检。

## 边界

以下内容不属于标准插件 owner：

- provider auth materialization 与 HTTP transport；
- 未登记的跨协议 Relay compat；
- response chain 与 WebUI。

未登记 compat 明确失败；不得在 handler 或 runtime-bin 补偿。
