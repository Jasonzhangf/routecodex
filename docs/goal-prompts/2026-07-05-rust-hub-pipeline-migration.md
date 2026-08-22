# /goal 提示词: Rust化 RouteCodex Hub Pipeline 剩余 P0/P1 语义层 (Phase 1-2)

复制以下内容使用:

```
/goal Rust化 RouteCodex Hub Pipeline 剩余 P0/P1 语义层 (Phase 1-2)

## 目标
Rust 化 Hub Pipeline 剩余的 TypeScript 语义变换模块，目标：
1. Phase 1 (3 个 feature_id, ~2,400 LOC) 完成红→绿后物理删除旧 TS
2. Phase 2 (3 个 feature_id, ~643 LOC) 完成消息归一化迁移
3. 每批次必须先红后绿，禁止 fallback，双批次不混做

## 文档路径
- docs/goals/hubpipeline-rust-closeout-remaining-plan-2026-07-05.md (核心执行计划)
- docs/goals/hubpipeline-rust-closeout-master-plan.md (历史参考)
- docs/goals/hubpipeline-module-rust-closeout-plan.md (历史参考)
- docs/architecture/function-map.yml
- docs/architecture/verification-map.yml
- docs/architecture/mainline-call-map.yml

## Phase 1 执行规范
1. 查 docs/architecture/function-map.yml，确认每个 feature_id 的 owner_module、allowed/forbidden paths、required_gates
2. 读现有 Rust 目标文件，确认当前实现状态 (薄壳还是已有完整实现)
3. 对每个 TS 文件：
   a. 设计红测 (黑盒 replay 或 Rust 单元测试)，确认当前为红
   b. 将语义迁移到目标 Rust 文件
   c. 改 TS 为薄壳调用 Rust，验证红→绿
   d. 物理删除旧 TS 语义代码
4. 跑验证栈
5. 提交 (每个 feature_id 一 commit)

## 验证栈 (每个批次必跑)
- cargo test -p router-hotpath-napi --lib -- --nocapture
- npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit
- npm run verify:llmswitch-rustification-audit
- npm run verify:function-map-compile-gate
- npm run verify:architecture-mainline-call-map
- node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs
- cargo test -p router-hotpath-napi --lib

## Phase 1 顺序
1-A: conversion.shared.anthropic (anthropic-message-utils.ts + core + tool-schema, 865 LOC)
1-B: conversion.responses.store (responses-conversation-store.ts, 1,125 LOC)
1-C: conversion.bridge.action_parsing (native-hub-bridge-action-semantics-parsers.ts, 411 LOC)

## Phase 2 顺序
2-D: conversion.openai.control_text + tool_history (423 LOC, 合并到一个 RS 文件)
2-E: conversion.marker_lifecycle (220 LOC)
2-F: conversion.responses.bridge + reasoning (382 LOC)

## 完成标准
- Phase 1 完成: conversion.shared.anthropic, conversion.responses.store, conversion.bridge.action_parsing 三个 feature_id 的 owner_kind=rust_ssot，旧 TS 语义文件物理删除
- Phase 2 完成: conversion.openai.control_text, conversion.openai.tool_history, conversion.marker_lifecycle, conversion.responses.bridge 等 feature_id 同上
- verify:llmswitch-rustification-audit 基线: 58 files / 9,333 LOC; Phase 1 目标: <=53 files / <=7,600 LOC; Phase 2 目标: <=50 files / <=7,000 LOC
- 全线 gate PASS, 无 fallback，无静默补偿
```
