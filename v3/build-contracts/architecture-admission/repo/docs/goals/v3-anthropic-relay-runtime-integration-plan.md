# V3 Anthropic Relay Runtime Integration Plan

## 1. 目标与验收标准

把已完成的 Anthropic codec、Relay request/response semantics、static resources/hooks 接入唯一 V3 Hub v1 Runtime，使现有 controlled-upstream harness 从 `wiring_missing` 转绿，完成 Anthropic `/v1/messages` -> Responses provider -> Anthropic response 的 JSON/SSE 固定主线。

验收标准：

- Server `/v1/messages` 只进入固定 Hub v1 Relay nodes，不直连 Provider、不扩展 P6。
- request/response 每条相邻边真实 anchored；完整 node trace 只有一个 Runtime lifecycle 和一个 response exit。
- JSON/SSE、thinking/reasoning、tool_use/function_call、provider error、side-channel isolation 四类 fixture 全绿。
- SSE Transport 只作为基础能力调用；本任务不实现第二套 parser/writer。

## 2. 范围与边界

In scope：

- 接通 Req01-Req09、Provider transport、Resp01-Resp06 的现有 Hub Relay hooks。
- 接 Anthropic client codec 与 Responses provider wire codec。
- 让 `V3_ANTHROPIC_RELAY_DRIVER` 使用真实 executable/Runtime integration path。
- provider error 进入 V3 Error01-06；JSON/SSE client projection 与 side-channel isolation。
- 更新 maps/wiki/manifest/gates 与 controlled replay evidence。

Out of scope：

- remote/local continuation E2E、servertool runtime、live 5555 endpoint cutover。
- SSE transport core 内部实现；如基础接口缺失，只提交 handoff，不在本 owner 重造。
- V2、`~/.rcc`、provider credentials、global install、restart/release。
- provider-specific Hub 分支、dynamic hooks、fallback、第二 lifecycle。

Claim：`feature_id:v3.anthropic_relay_runtime_integration`

## 3. 设计原则

- 固定 15-node Hub v1 topology，不新增/重编号节点。
- Anthropic 协议差异只在 entry/exit codec；Hub Chat Process 使用 provider-neutral canonical semantics。
- request/response payload borrow/move-first；禁止完整 JSON/SSE clone/materialize 作为 hook/debug truth。
- continuation 未接线时显式 none/not implemented，不做 handler/provider 补偿。
- Server、Provider、Debug、Error 都不能成为第二业务 owner。

## 4. 技术方案与文件清单

基线文档：

- `docs/goals/v3-hub-relay-four-worker-implementation-plan.md`
- `docs/design/v3-hub-relay-fixed-pipeline-contract.md`
- `docs/goals/v3-anthropic-codec-characterization-test-design.md`
- `docs/goals/v3-anthropic-relay-controlled-replay-harness-test-design.md`
- `docs/goals/v3-hub-relay-request-semantics-test-design.md`
- `docs/goals/v3-hub-relay-payload-copy-runtime-probes-test-design.md`

候选实现：

- `v3/crates/routecodex-v3-runtime/src/hub_v1.rs` 及现有相邻 hook owner
- `v3/crates/routecodex-v3-server/` 的 `/v1/messages` entry 薄接线
- `v3/crates/routecodex-v3-provider-responses/` 的通用 provider transport
- 已有 Anthropic codec crate/module，禁止复制 codec
- controlled replay driver、fixtures、tests、maps/wiki/gates

Worker 必须先核实现有 symbol 与并行 diff；不得覆盖 request/response/resource worker 已完成逻辑。

## 5. 风险与规避

- 为绿 harness 写 fixture transformer：harness 必须捕获一次真实 controlled upstream 请求并校验 node trace。
- 扩展 P6/创建��二 kernel：freeze/source gate 必须保持绿。
- SSE 语义落 handler：source gate 禁止 handler event allowlist、terminal/tool/continuation 判断。
- provider error 包成成功：Error01-06 正反 fixture。
- payload/control 泄漏：provider/client side-channel negative fixture。
- 与 SSE/continuation worker 冲突：只消费公开 contract；缺口走 handoff，不跨 claim 修改。

## 6. 测试计划

- 先确认当前 harness `wiring_missing` 红基线与稳定 digest。
- JSON thinking+tool_use：Anthropic request -> Responses wire -> Anthropic response。
- SSE thinking+tool_use：结构化事件顺序正确，无完整流业务 materialize。
- provider 429/5xx：Error01-06，不能投成功。
- side-channel：control/debug/resource 不进 provider/client payload。
- 反向：shortcut、缺边、重复 response exit、dynamic hook、P6 extension、伪造 trace、未访问 upstream。
- focused Rust、harness mutation/red fixtures、architecture/resource/module/rust-only/static hook/copy-budget/fmt/clippy/workspace gates。
- 本任务无 live 完成声明；5555 仍是 Responses Direct，除非 Jason 另行授权 endpoint/config cutover。

## 7. 实施步骤

1. 刷新 claims，确认 A-D 已完成 slices 和真实 symbols。
2. 固化 `wiring_missing` 红证据，写 integration test design。
3. 接 Server Anthropic entry -> Hub Req01，逐相邻节点接到 Provider transport。
4. 接 provider raw -> Hub response nodes -> Anthropic client projection。
5. 实现真实 external driver，绿化四类 controlled fixtures。
6. 同步 maps/wiki/manifest/gates，运行 combined checker。
7. architecture review：无第二 lifecycle/P6 扩展/fallback/handler 业务语义/continuation 越界。

## 8. 完成定义

- controlled-upstream harness 四类 fixture 全绿且每例恰好捕获一次 provider 请求。
- 固定 request/response node trace 完整、Error01-06 正确、payload isolation 通过。
- `/v1/messages` Runtime integration 在源码与 controlled blackbox 完成；不冒充 live 5555 或 continuation 完成。
