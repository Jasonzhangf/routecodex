# Virtual Router / Servertool Latest-Turn Audit Plan

## 目标

审计并确认 VR 与 servertool 的激活判定只看最新轮，不看历史；同时确认该行为已被 gate 锁定，且当前事实成立。

## 验收标准

- VR 选路与 stopMessage 激活只依据最新轮或最新相邻轮，不回看更早历史。
- servertool stopMessage / followup 激活只依据最新轮上下文，不从历史轮误触发。
- fresh user 的非 stopless turn 不应读取旧 tmux scope stopMessage 状态。
- 相关 gate / red test / CI 已存在并能锁住上述行为。
- 若存在违规，必须先红测再修复真源，且清理旧实现，不留 fallback。

## 范围与边界

### In Scope
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/**`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/**`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts`
- `sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.ts`
- `tests/sharedmodule/**` 与 `tests/servertool/**`
- 相关 gate / verification 脚本与文档

### Out of Scope
- 不改 provider 路由池、端口配置、模型配置，除非验证必须。
- 不改 unrelated Hub Pipeline 逻辑。
- 不引入 fallback / 兜底 / 静默吞错。

## 设计原则

- 真源优先：Rust 判定链路为唯一真源，TS 仅薄壳。
- 先证据后结论：文件、日志、测试、gate 结果齐全才下结论。
- 红测先行：发现违规先补红测，再修复。
- 只看最新轮：历史只作为不可触发的背景，不参与激活。
- 物理删除错误实现：确认错误后删除旧逻辑，不保留“备用路径”。

## 技术方案

### 1) VR 审计
- 读取 `virtual_router_engine::features` 与 `classifier`，确认 latest-turn gate 的输入边界。
- 核对是否存在“历史轮工具信号”仅作为被忽略输入而非激活依据。
- 对应红测锁定：旧历史存在时，最新轮未满足条件则不得激活。

### 2) Servertool 审计
- 读取 persisted lookup / cli contract / engine call site，确认 stopMessage 与 repeatCount 来源只来自当前闭环。
- 核对 fresh user 非 stopless turn 读取旧状态的路径是否已被阻断。
- 对应红测锁定：旧 tmux scope 状态存在时，fresh user 仍应 `active=no`。

### 3) TS 薄壳审计
- 确认 TS 只做 IO / 传参 / native 调用，不重建历史判定。
- 检查是否有历史轮裁剪、补偿、fallback、重复逻辑。

### 4) Gate / CI 审计
- 验证相关测试与 gate 是否会在违规时变红。
- 检查 verify 脚本是否覆盖 Rust 真源与 TS residue。

## 文件清单

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/features.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/classifier.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/persisted_lookup.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-runtime.ts`
- `sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.ts`
- `tests/sharedmodule/virtual-router-web-search-route-selection.spec.ts`
- `tests/servertool/stopmessage-session-scope.spec.ts`
- `tests/servertool/cli-contract-tool-loop-replay.spec.ts`

## 风险点

- 误把“历史可读”当成“历史可触发”。
- TS 残留旧逻辑影响结论。
- gate 只覆盖一边，缺少反向测试。
- 误修到旁路而非真源。

## 验证矩阵

- Rust 定向测试：VR latest-turn、servertool fresh-user gate。
- TS 定向测试：route selection / stopmessage session scope。
- gate 验证：`verify:servertool-rust-only`、`verify:vr-no-ts-runtime`、`verify:architecture-ci`。
- live smoke：fresh user non-stopless turn → hit log `active=no`。

## 实施步骤

1. 审计 VR 真源与测试。
2. 审计 servertool 真源与测试。
3. 审计 TS 薄壳与 residue。
4. 跑 gate / CI 验证。
5. 必要时 live smoke 复核。
6. 将已验证结论写入 `MEMORY.md`，工作记录写入 `note.md`。

## 完成定义

- 结论有文件/日志/测试/gate 证据闭环。
- “只看最新轮，不看历史”被证明是当前事实。
- gate 已锁死该事实；若存在违规，已修复并补回归测试。
