# R1: tool_outputs Rustification Plan

## 目标
将 `responses-submit-tool-outputs.ts` 的语义下沉到 Rust，TS 仅保留最小 FFI 壳层 + 装配层；删除 TS 旧语义实现。

## 范围
- TS: `sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/responses-submit-tool-outputs.ts`
- Native bridge: `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-hub-*.ts`
- Rust: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/*`

## 迁移策略
1. 在 Rust 实现 submit_tool_outputs payload 构建（含 fail-fast 校验）。
2. 在 TS native bridge 暴露 `buildSubmitToolOutputsPayloadWithNative(...)`。
3. TS mapper 改为薄壳：只做输入透传 + 输出类型断言。
4. 删除 TS 旧语义函数（normalize/collect/extract/resolve 一整套）。
5. 用 shadow fixture 对比 TS 旧结果与 Rust 结果逐字段一致后切主路径。

## 验证
1. Hub 定向测试：tool governance / ingress / execute-entry / anthropic compat。
2. `npm run build:min`。
3. `node scripts/ci/hub-deterministic-audit.mjs`。
4. `node scripts/ci/llmswitch-rustification-audit.mjs --json`（观察 hub 侧非 native 语义减少）。

## DoD
- `responses-submit-tool-outputs.ts` 不再承载语义逻辑，仅保留 FFI 壳。
- TS 旧实现已物理删除。
- 测试、构建、审计全绿。
