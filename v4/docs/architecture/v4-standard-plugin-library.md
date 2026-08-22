# V4 标准插件库（M5）

状态：`contract_bound`，源实现已落地，未接真实生产 NodeContainer 分发。
Owner：`routecodex-v4-standard-plugins`。
合同：`v4/contracts/plugin-library.contract.json`。

## 范围

M5 交付 V4 标准插件库的不可变描述符、确定性 artifact/contract 字节、
`PluginCatalog` 注册、per-node `NodePluginPlan` 编译和 typed
`StandardHandleRegistry`。标准插件全部是 keyless、行为最小化 mock/validator，
不声称真实产品迁移、真实凭据、真实 provider/client 语义或真实 wire codec。

## 类别与不可变 ID

标准库按 8 个类别注册 23 个不可变插件 ID：

| 类别 | 插件 ID |
| --- | --- |
| contracts | `v4.std.contract.input_validate`, `v4.std.contract.output_validate` |
| diagnostic | `v4.std.diagnostic.debug_observe`, `v4.std.diagnostic.timing`, `v4.std.diagnostic.snapshot_record` |
| control | `v4.std.control.scope_consume`, `v4.std.control.payload_cycle_record` |
| error | `v4.std.error.typed_intake`, `v4.std.error.projection_adapter` |
| protocol | `v4.std.protocol.wire_codec_proto`, `v4.std.response.protocol_decode`, `v4.std.response.client_semantic_projection`, `v4.std.response.sse_frame_boundary`, `v4.std.response.frame_build` |
| chat_process | `v4.std.chat_process.request_governance`, `v4.std.chat_process.response_governance` |
| routing | `v4.std.routing.route_facts_producer`, `v4.std.routing.route_facts_consumer` |
| provider | `v4.std.provider.wire_build`, `v4.std.provider.capability_mock`, `v4.std.provider.auth_handle_mock`, `v4.std.provider.wire_mock`, `v4.std.provider.transport_mock` |

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
control/error/diagnostic 资源不进入 normal/provider/client payload。响应链严格按
`provider_raw -> normal_payload -> client_wire_payload -> client_object` 相邻流动；
`V4ServerSseOut05FrameBoundary` 只验证 wire payload，不重建或修补响应。
`client_object` 是标准库 keyless frame object；canonical runtime terminal
resource 仍是 `v4.response.client_frame`，由 `routecodex-v4-runtime::FrameBuild`
唯一 owner 写出。

## Side-channel 边界

标准插件只通过 `ExecCtx` 的 typed data/control 通道执行：

- `execute_plan` 将当前 `PlanEntry.reads/writes` 绑定进 `ExecCtx`；control handle
  只能通过 `read_control_resource(resource_id)` / `write_control_resource(resource_id, value)`
  访问该 entry 已声明的单个资源，未声明访问立即记录并返回
  `ResourceAccessViolation`；handle 即使捕获返回值，executor 也会 fail-fast；
- 读取已声明但尚不存在的 control/error/lifecycle 资源同样 fail-fast；标准 handle
  只能更新 owner 已创建的 typed resource，不能用空对象创建 MetadataCenter、
  payload-cycle 或 Error-chain 真相；
- control-only 插件只写 `v4.control.*` / `v4.lifecycle.payload_cycle`；
- diagnostic-only 插件只 emit diagnostics，不写 data/control；
- error 插件只写 `v4.control.error_chain`；
- provider capability/auth/transport mock 只在 provider wire boundary 读取并校验
  已登记资源，不写 normal data 或 control；
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

## M8 非目标

以下内容不是 M5 基线能力：

- 真实 protocol codec、provider wire/transport、routing/decision 语义；
- M6 PluginManager candidate pipeline、M7 WebUI 消费；
- 将 `StandardHandleRegistry` 接入真实生产 NodeContainer 分发；
- 真实凭据、真实请求/响应 payload 语义或产品迁移。

这些能力必须先在后续 milestone 中建立 typed dispatch budget 与真实 provider
contract 后再落地。
