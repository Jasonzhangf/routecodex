# V4 Response ChatProcess Plugin Implementation Plan

## 目标与验收标准

将 V4 响应链 `V4HubRespChatProcess03Governed` group 的插件槽位从 keyless mock 补齐为可编译、可执行、可验证的标准插件实现：

```text
V4ChatProcess03ContinuationCommit
  -> V4ChatProcess03ResponseGovernance
  -> V4ChatProcess03ToolHarvest
  -> V4HubRespChatProcess03Governed exit
```

本 worker 只负责：

- `response_governance`：响应治理和内部 action/provenance 处理；
- `tool_harvest`：响应中的工具调用/工具结果收割与 typed governance facts；
- `continuation_commit` / 必要的 `continuation_release`：在唯一合法 owner 处保存/释放 continuation truth；
- 对上述插件的 descriptor、catalog、typed handle、plan、L2/负向测试。

完成标准：

- continuation save 只发生在 `V4HubRespChatProcess03Governed`；
- `resp_chatprocess save -> next req_chatprocess restore` immutable interval 内无任何语义修改；
- tool governance、servertool followup 判定、internal action/provenance 只在 ChatProcess owner；
- continuation key 同时包含入口协议/endpoint、owner、session/conversation、port/group scope；
- 控制事实写入 typed control resources，不进入 response/client payload；
- malformed tool order、owner mismatch、scope mismatch、missing full input 显式失败；
- 不实现、不修改 response inbound codec、client semantic projection、frame build。

## 范围与边界

### In scope

- `v4/crates/routecodex-v4-standard-plugins/` 中 response ChatProcess 插件实现；
- group 内部插件 descriptor、typed handle、资源声明、顺序和 selection/依赖关系；
- continuation/tool governance 的单元、L2、负向和 group contract 测试；
- 仅在必要时对标准库注册入口做最小接线。

### Out of scope

- `V4HubRespInbound02Parsed` 的 `protocol_decode`；
- `V4HubRespOutbound04ClientSemantic` 的 `client_semantic_projection`；
- `V4ServerSseOut05FrameBoundary` / `V4ServerRespOutbound06ClientFrame`；
- provider codec、provider runtime、router、error policy；
- handler/SSE/outbound/adapter/store transport 中的 continuation 修补；
- 请求侧 history cleanup、payload cleanup、fallback、silent strip；
- 另建 continuation store、runtime kernel 或 response 专用出口。

## 设计原则

1. 唯一 owner：响应治理和 continuation 语义只归 `V4HubRespChatProcess03Governed`。
2. 不可变区：save 完成后只允许传输、投影、scope 校验和释放；下一轮 restore 只能由 request ChatProcess owner 执行。
3. 控制面隔离：route、scope、owner、retry、servertool、continuation 状态只走 typed control/error chain。
4. 真实语义保留：工具参数、reasoning、assistant response、tool result 不裁剪；错误不转成功。
5. 相邻 group 边：group 外只暴露单一 entry/exit；内部子节点不能成为旁路出口。

## 技术方案与文件清单

先读取并核实：

- `v4/contracts/node-graph.contract.json`
- `v4/contracts/skeleton-plan.contract.json`
- `v4/contracts/node-plugin.contract.json`
- `v4/contracts/pipeline-abstraction.contract.json`
- `v4/docs/architecture/v4-standard-plugin-library.md`
- `v4/docs/architecture/v4-standard-nodes-and-node-graph.md`
- `v4/docs/architecture/v4-resource-operation-map.yml`
- `v4/docs/architecture/v4-responses-direct-compatibility-slice.yml`
- `docs/goals/v3-resp03-tool-governance-gap-closeout-plan.md`
- `docs/goals/v3-responses-direct-remote-continuation-integration-plan.md`
- `docs/goals/v3-responses-resp04-v2-continuation-parity-test-design.md`
- `docs/agent-routing/30-servertool-lifecycle-routing.md`

实现目标文件：

- `v4/crates/routecodex-v4-standard-plugins/src/response_chat_process.rs`：治理、tool harvest、continuation descriptors/handles；
- `v4/crates/routecodex-v4-standard-plugins/src/lib.rs`：只做模块声明、插件集合和 typed handle 的最小注册接线；
- `v4/crates/routecodex-v4-standard-plugins/tests/`：group、continuation、tool governance 和资源隔离测试。

若 continuation truth 的 typed carrier/store 尚未存在，先定位唯一 runtime owner；本 worker 只补插件合同和必要的 typed interface，禁止在插件层重建 store 或把状态塞进 payload。

## 风险与规避

- continuation 逻辑最容易越界到 handler/SSE/outbound：发现这些路径已有补偿逻辑，记录 finding，不在本 worker 加第二版。
- tool harvest 不得依赖当前污染 payload 猜测补偿；输入不足必须 fail-fast。
- `response_governance` 不得承担 client protocol projection；provider-specific shape 修补必须留在 provider runtime。
- 注册表与 Worker A 可能同时需要 `lib.rs`：使用模块级实现，root 只做最小接线；冲突写 handoff，不覆盖对方修改。

## 测试计划

### 单元

- 无 tool call 的普通响应保持语义等价；
- 有 tool call/tool result 的响应生成正确 typed governance facts；
- internal action/provenance 按登记规则处理；
- continuation pending/terminal/non-terminal 状态正确提交或释放；
- direct/relay、入口协议、session/port/group scope 隔离。

### 正反测试

- 正向：合法 tool order、合法 continuation owner/scope 能进入下一节点；
- 反向：重复 tool identity、非法 tool order、owner mismatch、scope mismatch、缺 `fullInput`、跨入口恢复均 fail-fast；
- 正向：pending tool call 保存 continuation；
- 反向：already-terminal response 不重复保存、不误判 pending；
- 正向：治理后响应进入 outbound；
- 反向：治理失败不投影为成功响应。

### 集成

- catalog registration、authoring、group plan compilation、typed handle execution；
- continuation save-only gate、immutable interval gate、group no-shortcut gate；
- error intake、control/resource isolation、debug/snapshot read-only gate；
- 与 Worker A 的插件 ID/文件边界无冲突。

## 实施步骤

1. 刷新 `.agent-collab` runs/claims/handoff/merge-queue/KILL_SWITCH 视图。
2. 申请 `feature_id:v4.response_plugin_chat_process` claim，建立独立 clean worktree。
3. 固化最小 failing test，确认当前缺口为红。
4. 实现 ChatProcess group 插件和最小注册接线。
5. 跑定向 unit/L2/architecture gates，写 `evidence.jsonl`。
6. 做 continuation immutable interval 和模块边界自检，生成 handoff/merge-queue；未通过不得交付。

## 完成定义

代码、测试、descriptor/catalog/plan 接线和证据均在本 worker scope 内完成；continuation 只由 ChatProcess owner 控制；无 payload 控制语义、fallback、silent strip、handler 补偿或第二 runtime；handoff 明确列出 inbound/outbound codec 尚未覆盖部分。
