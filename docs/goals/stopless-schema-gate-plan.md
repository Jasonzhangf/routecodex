# Stopless Schema Gate Plan

## 目标与验收标准

目标：为 stopless / stop_message followup 增加一个简单闭环 schema gate。模型在 `finish_reason=stop` 且 stopless 激活时，必须用小 schema 表明停止原因、是否完成/阻塞、证据与下一步；不满足停止条件则按缺失/错误生成 followup 继续执行或补齐字段。

验收标准：
- `/goal active` 与 plan mode 不激活 stopless gate：不解析 schema、不 followup、不计预算。
- stopless 激活时，只解析当前 assistant stop 文本，不扫描/改写历史。
- 只校验数字枚举字段 `stopreason` / `has_evidence`；文本字段只判空。
- `stopreason=0|1` 且 `reason` 非空：允许 stop，并把 reason 加到 stop summary 开头。
- `stopreason=0|1` 但 `reason` 空：不允许 stop，followup 要求补 reason。
- `stopreason!=0|1` 且 `next_step` 非空：不允许 stop，followup 要求执行 next_step。
- 缺 schema / `stopreason` 缺失或非数字 / `next_step` 空：不允许 stop，followup 要求继续目标或按 schema 停止。
- 预算耗尽时显式 fail-fast，不循环、不 fallback。
- budget 是连续 `finish_reason=stop` 的预算：只要本链路出现非 stop 响应或工具调用/正常进展，必须 reset 连续 stop budget；不得把非连续 stop 计入同一轮预算。

## ASCII 生命周期图

```text
Provider response
  |
  v
[HubRespInbound02Parsed]
  |
  v
[HubRespChatProcess03Governed]
  |
  +-- finish_reason != stop ------------------------------+
  |                                                       |
  |                                                       v
  |                                          [Reset continuous stop budget]
  |                                                       |
  |                                                       v
  |                                          [normal resp_outbound]
  |
  v
finish_reason == stop
  |
  v
[Stopless Activation Precheck]
  |
  +-- /goal active == true -------------------------------+
  |                                                       |
  |                                                       v
  |                                          [normal stop passthrough]
  |                                          no schema check / no followup / no budget
  |
  +-- plan mode == true ----------------------------------+
  |                                                       |
  |                                                       v
  |                                          [normal stop passthrough]
  |                                          no schema check / no followup / no budget
  |
  v
activated
  |
  v
[Capture current assistant stop text only]
  |
  v
[Parse Stop Schema]
  |
  +-- schema missing / parse error -----------------------+
  |                                                       |
  |                                                       v
  |                                      [Build followup prompt]
  |                                      ask: provide schema OR continue goal
  |                                                       |
  |                                                       v
  |                                      [Budget used + 1]
  |                                                       |
  |                         +-----------------------------+
  |                         |
  |                         v
  |              budget left? ---- no ----> [Fail-fast explicit error]
  |                  |
  |                 yes
  |                  |
  |                  v
  |      [ServertoolReq04FollowupBuilt]
  |                  |
  |                  v
  |      [normal Hub Pipeline reenter]
  |                  |
  |                  v
  |             Provider response
  |
  v
[Validate Numeric Fields Only]
  |
  +-- stopreason missing / non-numeric -------------------+
  |                                                       |
  |                                                       v
  |                                      [Build followup prompt]
  |                                      ask: include numeric stopreason
  |                                      0=finished, 1=blocked, 2=continue_needed
  |                                                       |
  |                                                       v
  |                                      [Budget -> reenter or fail-fast]
  |
  v
stopreason == 0 finished OR stopreason == 1 blocked
  |
  v
[Check reason text]
  |
  +-- reason empty ---------------------------------------+
  |                                                       |
  |                                                       v
  |                                      [Build followup prompt]
  |                                      ask: add reason description
  |                                      if not done/blocked, continue tools
  |                                                       |
  |                                                       v
  |                                      [Budget -> reenter or fail-fast]
  |
  v
reason non-empty
  |
  v
[Allow Stop]
  |
  v
[Prefix stop summary with reason]
  |
  v
[Clear stopless runtime state]
  |
  v
[HubRespOutbound04ClientSemantic]
  |
  v
Client


stopreason != 0/1
  |
  v
[Check next_step text]
  |
  +-- next_step non-empty -------------------------------+
  |                                                       |
  |                                                       v
  |                                      [Build followup prompt]
  |                                      instruction: execute next_step now
  |                                      do not stop without finished/blocked schema
  |                                                       |
  |                                                       v
  |                                      [Budget -> reenter or fail-fast]
  |
  +-- next_step empty -----------------------------------+
                                                          |
                                                          v
                                         [Build followup prompt]
                                         ask: continue current goal;
                                         if stopping, provide schema:
                                           stopreason numeric
                                           reason
                                           has_evidence numeric
                                           next_step
                                                          |
                                                          v
                                         [Budget -> reenter or fail-fast]
```

## 范围与边界

In scope：
- Rust `stop-message-core` 增加 schema parse/gate 纯逻辑。
- Rust `chat_servertool_orchestration` 消费 gate，输出 followup prompt 或 summary prefix。
- 更新 stopless followup prompt，要求 schema。
- 定向 Rust 红绿测试。

Out of scope：
- 不新增 TS 语义判断。
- 不扫历史、不改写历史、不清洗工具列表。
- 不 provider-specific。
- 不改变 `/goal active` / plan mode 的不激活行为。

## 设计原则

- 唯一路径：`HubRespChatProcess03Governed -> stop-message-core -> chat_servertool_orchestration -> normal Hub reenter`。
- 简单闭环：允许 stop / followup 继续 / fail-fast 三种出口。
- 连续预算：budget 只统计连续 stop；任何非 stop 响应或工具调用/正常进展都 reset budget。
- 只校验数字枚举：`stopreason` 与 `has_evidence` 只接受数字；非数字不按枚举处理。
- 文本字段只判空：`reason` / `next_step` / `evidence` 不做语义判定。
- 错误也闭环：缺 schema、非法 stopreason、缺 reason、缺 next_step 都生成明确 followup；预算耗尽 fail-fast。

## 技术方案与文件清单

- `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`
  - 新增 `StopSchemaParsed` / `StopSchemaGateDecision`。
  - 新增 `evaluate_stop_schema_gate(current_text, used, max_repeats)`。
  - 解析 fenced JSON 或裸 JSON object；只读取字段。
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs`
  - 从当前 stop response 提取 assistant text。
  - 在 stop followup handler 中调用 schema gate。
  - `allow_stop` 时 prefix current summary；`followup` 时覆盖 followup_text。
  - 预算耗尽输出显式错误。
- `docs/agent-routing/30-servertool-lifecycle-routing.md`
  - 更新 stopless schema gate 生命周期。
- `.agents/skills/rcc-dev-skills/SKILL.md`
  - 增加 stopless schema gate 精华规则。

## 风险与规避

- 风险：误改历史导致缓存命中下降。规避：只处理当前 response 文本，禁止修改 request history。
- 风险：模型输出非 JSON schema。规避：闭环提示补 schema 或继续目标。
- 风险：自定义 stopMessageText 被覆盖。规避：schema gate 只影响 stop 判定/followup，不改自定义提示原文语义。
- 风险：预算循环。规避：预算耗尽 fail-fast。

## 测试计划

- finished/block + reason 非空：允许 stop，summary prefix 包含 reason。
- finished/block + reason 空：followup 要求补 reason。
- continue_needed + next_step：followup 要求执行 next_step。
- continue_needed + next_step 空：followup 要求继续目标或补 schema。
- schema missing / stopreason missing / non-numeric：followup 要求 numeric stopreason/schema。
- budget exhausted：fail-fast，不产生 followup。
- non-stop response after prior stop：reset continuous stop budget，下一次 stop 从 used=0 开始。
- `/goal active` / plan mode：不激活 gate，原 stop passthrough。

## 实施步骤

1. 落盘本设计和 `/goal` 提示词。
2. 在 `stop-message-core` 实现 schema parse/gate 与单元测试。
3. 在 `chat_servertool_orchestration` 接入 gate，保持 Rust-only。
4. 更新文档和 skill 精华。
5. 跑 targeted Rust 测试、build、global install、5555 restart health。
6. 提交，不 push。

## DoD

- 设计图和 `/goal` 提示词已落盘。
- schema gate 逻辑完整闭环，无逻辑空白。
- 定向测试、构建、全局安装、5555 health 全部通过。
- 变更已提交，未 push。
