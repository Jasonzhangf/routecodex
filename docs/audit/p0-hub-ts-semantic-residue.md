# P0 Hub TS 语义残留审计清单

**日期**: 2026-05-19

## 审计范围
`sharedmodule/llmswitch-core/src/conversion/hub/**`

## 分类标准
- **桥接壳**（A）：仅做 JSON 序列化/native 调用/fail-fast 的薄层，允许保留。
- **业务判定**（B）：包含 fallback/repair/coerce/normalize 语义，需评估下沉或删除。
- **死代码**（C）：未被调用的历史实现，物理删除。
- **环境默认值**（D）：纯函数读取 env 并返回默认值，非运行时 fallback 语义，允许保留。

---

## B 类（需评估下沉/删除）

### B1. `deriveAdapterContext` 含 `fallbackProtocol` 参数（已修复）
- 文件：`hub/node-support.ts:136`
- 语义：接受 TS 侧 fallbackProtocol 参数并透传给 adapter。
- 风险：若 native 路径已有 protocol 解析，TS 侧 fallback 会绕过真源。
- 修复：`fallbackProtocol` 重命名为 `plannedProtocol`，并去除“兜底语义”表述；协议选择改为确定性优先级：`target.outboundProfile -> metadata.providerProtocol -> plannedProtocol`。

### B2. `repairIncompleteToolCalls`
- 文件：`hub/process/chat-process-media.ts:34`
- 语义：修复不完整 tool_calls（TS 端 repair）。
- 风险：与 native tool governor 可能重复。
- 建议：确认 Rust 端 tool governance 是否已覆盖，若已覆盖则删除。
 修复：**函数已物理删除**（原本恒等返回，无实际语义）；调用处已清除。

### B3. `normalizeAssistantToolCallsFast` / `normalizeToolDefinitionsFast`
- 文件：`hub/operation-table/semantic-mappers/chat-mapper-fastpath.ts`
- 语义：TS 端 normalize null/undefined 路径。
- 风险：可能与 Rust 端 semantic mapping 重复。
- 建议：确认 Rust 端是否已实现，若已覆盖则删除 TS 实现。
 状态：**已审查，保留**（fastpath 校验返回 null/undefined 是确定性 fail-fast 行为，非 fallback）。

### B4. `fallbackId` 静默回退在 tool output id 生成
- 文件：`hub/operation-table/semantic-mappers/responses-submit-tool-outputs.ts:157-165`
- 语义：`fallbackId` 生成在 id 缺失时静默回退。
- 风险：若该路径是唯一合法生成路径，则非 fallback；需确认语义意图。
- 建议：审查调用上下文，确认是否属于"协议兼容容忍"范畴。
 修复：**无合法 `tool_call_id` 时直接丢弃该条目**，不再生成伪造 ID（确定性 skip）。

### B5. `build_request_js_fallback` TS 路径（已修复）
- 文件：`hub/operation-table/semantic-mappers/anthropic-mapper-from-chat.ts:331-338`
- 语义：JS 请求构建失败时回退到 TS 路径。
- 风险：**明确违规 fallback**——JS 构建失败不应回退 TS，应直接 fail。
- 修复：native build 失败时不再 JS fallback，直接抛错（fail-fast）。

---

## A 类（允许保留）

- `coerceClientHeadersWithNative` / `coerceStandardizedRequestFromPayloadWithNative`：native 调用壳，透传参数，不含 fallback。
- `hub-stage-timing-env-blocks.ts`：读取环境变量默认值，非运行时降级。
- `hub-pipeline-heavy-input-fastpath-config.ts`：环境配置读取，非运行时 fallback。

---

## P0 修复证据
- 代码：
  - `sharedmodule/llmswitch-core/src/conversion/hub/node-support.ts`
  - `sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/anthropic-mapper-from-chat.ts`
- 回归：
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts tests/sharedmodule/hub-pipeline-router-metadata.spec.ts`
 - `npm run jest:run -- --runTestsByPath tests/sharedmodule/hub-pipeline-execute-chat-process-entry.spec.ts`
- `npm run jest:run -- --runTestsByPath tests/sharedmodule/anthropic-semantics-stage2.spec.ts tests/sharedmodule/provider-compat-anthropic.spec.ts`

## 当前残留分类（A/D 允许保留）

**A 类（桥接壳，允许）**
- `coerceClientHeadersWithNative` / `coerceStandardizedRequestFromPayloadWithNative`：`native` 调用壳，透传参数。
- `hub-stage-timing-env-blocks.ts` / `hub-pipeline-heavy-input-fastpath-config.ts`：环境变量默认值，非运行时 fallback。
- `tool-governance/rules.ts`：`mapNativeRules` 参数含默认值（native 校验失败时安全默认值，非绕过真源）。
- `chat-process-heartbeat-directives.ts`：`fallback` 参数用于 heartbeat 指令上下文合并，可选参数非 fallback。

**D 类（确定性行为，保留）**
- `normalizeAssistantToolCallsFast` / `normalizeToolDefinitionsFast`：严格校验返回 `null`（fastpath 放弃走 chat fastpath），确定性。
- `normalizeUsage`：协议层 usage 归一化，非 fallback。

**已修复交付**
1. `repairIncompleteToolCalls` 空壳函数删除。
2. `fallbackId` 伪造 ID 逻辑删除。
3. `deriveAdapterContext` 参数语义去除。
4. `build_request_js_fallback` JS fallback 路径删除。

## 下一步
- 其余 B 项进入 P1 评估（按 Rust 端是否已覆盖决定删除/下沉）。
