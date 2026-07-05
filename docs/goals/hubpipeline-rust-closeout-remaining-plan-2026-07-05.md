# HubPipeline Rust 化剩余 Phase 1/2 执行计划

**日期**: 2026-07-05
**状态**: active
**基于**: Jason 给定的目标 (pasted-text-1.txt), 实际审计 (58 nonNative files, 9333 LOC)
**目标**: Rust 化 Hub Pipeline 剩余的 TypeScript 语义变换模块

---

## 当前基线

| 维度 | 值 |
|------|-----|
| 非 Native TS 文件 | 58 |
| 非 Native LOC | 9,333 |
| 主线边 total | 86 |
| 主线边 anchored | 84 (97.7%) |
| 主线边 partial | 2 (2.3%, 非 Hub 域) |
| 主线边 pending | 0 |
| servertool | 完全 Rust-only |

---

## Phase 1 (P0) — 3 个 feature_id, 7 文件, 2,770 LOC

### Phase 1-A: conversion.shared.anthropic (865 LOC)

| 文件 | LOC | 语义命中 | 现有 Rust owner |
|------|-----|---------|---------------|
| `conversion/shared/anthropic-message-utils.ts` | 344 | 40 | `anthropic_openai_codec.rs` (2,344 LOC) |
| `conversion/shared/anthropic-message-utils-core.ts` | 248 | 28 | 同上 |
| `conversion/shared/anthropic-message-utils-tool-schema.ts` | 273 | 18 | 同上 |

**现有 Rust 覆盖**:
- `build_openai_chat_from_anthropic_json` / `build_anthropic_from_openai_chat_json` 已通过 #napi 导出
- `build_anthropic_tool_alias_map` 已实现
- 19 个 Rust 单元测试覆盖消息转换路径
- `anthropic_openai_codec.rs` 已有 2,344 LOC

**剩余 TS 语义需迁移**:
- `anthropic-message-utils.ts` — `buildOpenAIChatFromAnthropic` 中间补丁: bridge action police, tool_call_id strip, alias map logic
- `anthropic-message-utils-core.ts` — `normalizeShellLikeToolInput`, `normalizeAnthropicToolName`, `denormalizeAnthropicToolName`, `requireTrimmedString`, `normalizeToolResultContent`, `safeJson`, `flattenAnthropicText`
- `anthropic-message-utils-tool-schema.ts` — `mapAnthropicToolsToChat`, `mapChatToolsToAnthropicTools`, schema 归一化, built-in tool schema sanitize

**验证栈**:
- `npm run verify:anthropic-roundtrip`
- `npm run verify:hub-response-anthropic-native`
- `npm run verify:function-map-compile-gate`
- `cargo test -p router-hotpath-napi --lib -- --nocapture` (现有 19 个 anthropic codec test)

---

### Phase 1-B: conversion.responses.store (1,216 LOC)

| 文件 | LOC | 语义命中 | 现有 Rust owner |
|------|-----|---------|---------------|
| `conversion/shared/responses-conversation-store.ts` | 1,125 | 32 | `shared_responses_conversation_utils.rs` |
| `conversion/shared/responses-conversation-store-types.ts` | 91 | 0 (type only) | 可保持 TS |

**现有 Rust 覆盖**:
- `shared_responses_conversation_utils.rs` 已有完整 store 语义
- 48 个 Rust 单元测试
- `responses-continuation-store.spec.ts` 39 test cases

**剩余 TS 语义需迁移**:
- `responses-conversation-store.ts` — store/resume/continuation IO 逻辑。已有 `responses-conversation-store-native.ts` 薄壳

**验证栈**:
- `npm run verify:responses-history-protocol-contract`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `tests/sharedmodule/responses-continuation-store.spec.ts`

---

### Phase 1-C: conversion.bridge.action_parsing (689 LOC)

| 文件 | LOC | 语义命中 | 目标 Rust 文件 |
|------|-----|---------|---------------|
| `native/router-hotpath/native-hub-bridge-action-semantics-parsers.ts` | 411 | 32 | 新建 `hub_bridge_action_semantics.rs` |
| `native/router-hotpath/native-hub-bridge-action-semantics-types.ts` | 278 | 0 (type only) | 可保持 TS |

**说明**: `native-hub-bridge-action-semantics-parsers.ts` 包含 Anthropic/GLM/Gemini 等协议的 bridge action pipeline 解析 — 这是 `buildOpenAIChatFromAnthropic` 在 TS 调用链中的编排层。需新建 Rust 文件迁移后删除 TS。

**验证栈**: 复用 Phase 1-A 验证栈 + `npm run verify:function-map-compile-gate`

---

## Phase 2 (P1) — 3 个 feature_id, 7 文件, 1,060 LOC

### Phase 2-D: conversion.openai.control_text + tool_history (458 LOC)

| 文件 | LOC | 语义命中 | 目标 Rust 文件 |
|------|-----|---------|---------------|
| `conversion/shared/openai-message-normalize-control-text.ts` | 185 | 18 | 新建 `hub_openai_message_normalize.rs` |
| `conversion/shared/openai-message-normalize-tool-history.ts` | 238 | 7 | 同上 (合并) |
| `conversion/shared/openai-message-normalize-contract.ts` | 35 | 3 | 同上 (类型) |

### Phase 2-E: conversion.marker_lifecycle (220 LOC)

| 文件 | LOC | 语义命中 | 目标 Rust 文件 |
|------|-----|---------|---------------|
| `conversion/shared/marker-lifecycle.ts` | 220 | 23 | 新建 `hub_marker_lifecycle.rs` |

### Phase 2-F: conversion.responses.bridge + reasoning (382 LOC)

| 文件 | LOC | 语义命中 | 目标 Rust 文件 |
|------|-----|---------|---------------|
| `conversion/responses/responses-openai-bridge/utils.ts` | 244 | 14 | `shared_responses_conversation_utils.rs` |
| `conversion/shared/responses-reasoning-registry.ts` | 104 | 8 | 同上 |
| `conversion/responses/responses-openai-bridge/types.ts` | 34 | 0 (type only) | 可保持 TS |

---

## 完成标准

| 指标 | Phase 1 目标 | Phase 2 目标 |
|------|-------------|-------------|
| `verify:llmswitch-rustification-audit` | <=53 files / <=7,600 LOC | <=50 files / <=7,000 LOC |
| `verify:function-map-compile-gate` | PASS | PASS |
| `verify:architecture-mainline-call-map` | PASS | PASS |
| `npx tsc --noEmit` | PASS | PASS |
| `cargo test -p router-hotpath-napi --lib` | PASS | PASS |
| `node scripts/build-native-hotpath.mjs` | PASS | PASS |
| 旧 TS 语义文件 | 物理删除 | 物理删除 |
| 无 fallback 补偿 | 强制 | 强制 |

---

## 执行顺序

1. Phase 1-A (conversion.shared.anthropic) → commit: `feat(rustify): conversion.shared.anthropic owned by rust`
2. Phase 1-B (conversion.responses.store) → commit: `feat(rustify): conversion.responses.store owned by rust`
3. Phase 1-C (conversion.bridge.action_parsing) → commit: `feat(rustify): conversion.bridge.action_parsing owned by rust`
4. Phase 2-D (conversion.openai.control_text + tool_history) → commit
5. Phase 2-E (conversion.marker_lifecycle) → commit
6. Phase 2-F (conversion.responses.bridge + reasoning) → commit

每步验证栈:
```
cargo test -p router-hotpath-napi
npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit
npm run verify:llmswitch-rustification-audit
npm run verify:function-map-compile-gate
npm run verify:architecture-mainline-call-map
node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs
cargo test -p router-hotpath-napi --lib
```
