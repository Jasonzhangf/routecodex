# 10000 端口 apply_patch 样本定位计划

## 目标与验收标准

目标：仅基于 `10000` 端口最新 `codex-samples`、相关日志与代码真源，定位当前这轮 Codex 会话里 `apply_patch` 为何没有形成真实可执行链路，并给出唯一修改点与修复方向。

验收标准：
- 明确区分三种可能：客户端未声明 `apply_patch`、服务端未注入/未保留 `apply_patch`、中途转换/裁剪丢失 `apply_patch`。
- 用最新 `10000` 样本证明当前真实发生的是哪一种。
- 给出“唯一真源修改点”所属模块，禁止把问题泛化到多层同时修。
- 交付结果必须能回答用户关心的 4 个问题：
  1. 这轮请求里有没有真实 `apply_patch tool call`
  2. 暴露给模型的实际工具集合是什么
  3. `apply_patch` 丢失发生在哪一层
  4. 应该改哪个唯一模块

## 范围与边界

### In Scope
- `~/.rcc/codex-samples/openai-responses/ports/10000/**`
- 与本轮相关的 RouteCodex 请求日志
- `/v1/models` 能力暴露链路
- request inbound / req_chatprocess / tool governance / relay 判定代码
- 与 `apply_patch_tool_type=freeform` 到最终 `tools[]` 之间的桥接代码

### Out of Scope
- 先做实现修复
- 先讨论提示词优化
- 把自然语言中的 `*** Begin Patch` 当作真实 tool call
- 大范围测试无关链路
- 凭经验推断“应该是 servertool 空回”

## 设计原则

- 先样本，后代码，最后结论。
- 没有 `provider-request.json` / `provider-response.json` / `__runtime.json` / 日志证据，不下结论。
- 禁止 fallback 解释；只找唯一事实链。
- 必须区分“文本提到 apply_patch”和“真实 function/tool call 发出”。

## 技术方案

### 样本层
- 读取 `10000` 端口最新请求目录。
- 检查 `capturedEntryRequest.tools`、`body.tools`、模型输出中的真实 tool use。
- 检查是否存在 `servertool.execution*` / `servertool.followup.request*` / `hub_followup.response*` 样本。

### 代码层
- 查 `capturedEntryRequest.tools` 在入口如何构建与保留。
- 查 `/v1/models` 返回的模型 metadata 与 capability 是否足以让 Codex 客户端开放 `apply_patch`。
- 查 relay/servertool 判定是否要求“请求已声明 apply_patch”才进入。
- 查 Rust request governance 是否仅在已有 `apply_patch` 时改写 schema、而不会主动注入。

### 归因层
- 若 `capturedEntryRequest.tools` 已无 `apply_patch`，则优先判为客户端未发或客户端 capability 未开。
- 若 `capturedEntryRequest.tools` 有但 `body.tools` 无，则定位为 RouteCodex 请求链裁剪。
- 若 `body.tools` 有且模型真实发出，但无 servertool 样本，则定位为响应治理/执行链问题。

## 关键文件清单

- `src/server/runtime/http-server/routes.ts`
- `src/server/runtime/http-server/index.ts`
- `src/server/handlers/responses-handler.ts`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/apply_patch_schema.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
- `sharedmodule/llmswitch-core/src/conversion/snapshot-utils.ts`
- `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- `sharedmodule/llmswitch-core/src/servertool/followup-mainline-block.ts`

## 风险与规避

- 风险：把旧样本或其他端口样本混入结论。
  - 规避：只用最新 `10000` 端口重采样目录。
- 风险：把模型自然语言自述当成系统事实。
  - 规避：必须与 `tools[]` 和真实 tool call 结构对照。
- 风险：把 capability 暴露问题与执行链问题混为一谈。
  - 规避：先判“是否声明工具”，再判“是否执行工具”。

## 验证计划

- 样本验证：
  - 最新 `10000` 目录存在且时间顺序明确。
  - 至少 1 条关键样本能证明 `capturedEntryRequest.tools` 与 `body.tools` 的真实集合。
- 代码验证：
  - 找到 `capturedEntryRequest.tools` 的来源构建点。
  - 找到 relay/servertool 的 apply_patch 进入条件。
  - 找到 `/v1/models` metadata 返回点。
- 结论验证：
  - 结论能逐条回答 4 个核心问题。
  - 修改建议能落到单一 owner 模块，而不是“多处都改”。

## 实施步骤

1. 锁定最新 `10000` 样本并抽取关键字段。
2. 核对样本中实际暴露给模型的工具集合。
3. 核对模型是否真实发出 `apply_patch tool call`。
4. 检查 servertool / followup 样本是否存在。
5. 追代码确认工具集合在入口如何保留。
6. 追代码确认 `/v1/models` 与 capability 暴露链。
7. 追代码确认 RouteCodex 是否只对已声明的 `apply_patch` 做 relay/servertool。
8. 输出唯一归因与唯一修改点。

## 完成定义（DoD）

- 用样本证据确认 `apply_patch` 是否真实出现在请求工具集合中。
- 用样本证据确认模型是否真实发出 `apply_patch tool call`。
- 用代码证据确认丢失层级。
- 给出唯一修改点、非目标层不动的理由、以及后续修复方向。
- 输出结论时明确说明：当前问题是否属于 servertool 执行失败，还是在更前面的 capability / tool surface 阶段已丢失。
