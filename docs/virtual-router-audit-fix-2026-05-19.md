# Virtual Router 修复报告（2026-05-19）

## 改动

### P0
1. **删除单 provider 强制回填 fallback（fail-fast）**
   - 文件：former TS VR engine（已删除，禁止复活）
   - 变更：
     - 删除 `tryForceSingleProviderDecisionWhenPoolExhausted` 方法。
     - 删除 `route()` 内 3 处调用，native 路由异常/无效 payload 直接抛错。

2. **删除 edge stage 的 protocol/payload 回退路径**
   - 文件：`sharedmodule/llmswitch-core/src/native/router-hotpath/native-hub-pipeline-edge-stage-semantics.ts`
   - 变更：
     - `parseFormatEnvelopePayload` 移除 `fallbackProtocol/fallbackPayload` 参数。
     - native 返回 envelope 若缺少 `format` 或 `payload`，直接返回 `null` -> 上层 fail-fast。

### P1
3. **移除 TS 重复状态应用入口（运行时统一 Rust 真源）**
   - 文件：
     - former TS VR routing-instructions entry
     - former TS VR routing-instructions declaration
     - former TS VR routing-instructions state entry
     - former TS VR routing-instructions state declaration
   - 变更：
     - 移除 `applyRoutingInstructions` export。
     - 从 `state.ts` 删除 `applyRoutingInstructions` 实现，仅保留 serialize/deserialize。

4. **清理依赖旧入口的测试**
   - 删除：`sharedmodule/llmswitch-core/tests/router/stop-message-clear.test.ts`

5. **收缩 stop/pre-command TS 壳层到 0（仅保留 Rust 真源）**
   - 删除：
     - former TS VR routing-stop-message-actions entry/declaration
     - former TS VR routing-pre-command-actions entry/declaration
   - 说明：该两组文件仅被已移除的 TS `applyRoutingInstructions` 路径引用，删除后运行时完全走 Rust 真源。

### P0-B（Hub 硬违规）
6. **移除 anthropic mapper 的 JS fallback 路径（fail-fast）**
   - 文件：
     - `sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/anthropic-mapper-from-chat.ts`
   - 变更：
     - native build 失败后不再回退 `buildAnthropicRequestFromOpenAIChat`（JS fallback）。
     - 改为记录 `nativeBuildFailed` 后直接抛错。

---

## 验证

### 1) grep 扫描（要求项）
- 命令：
  - `npm run verify:vr-no-ts-runtime`
- 结果：**无输出**（目标字符串已移除）。

### 1.1) stop/pre-command 壳层引用扫描
- 命令：
  - `npm run verify:vr-no-ts-runtime`
- 结果：**无输出**（壳层及引用已清零）。

### 2) native 异常不回退 TS
- 证据：
  - `engine.ts` 中 `route()` 的 catch/invalid payload 路径只 `throw normalized`，不存在 forced decision 回填。
  - `native-hub-pipeline-edge-stage-semantics.ts` 中 envelope 关键字段缺失时直接 `return null` 并由上层 `fail("invalid payload")`。

### 3) 单 provider 被过滤后显式报错
- 证据：
  - 原先“池耗尽时单 provider 强制回填”的唯一实现已删除。
  - 当前行为为 Rust 返回错误后 TS 直接抛错（fail-fast）。

### 4) 相关测试（已执行）

#### routing-instructions（直接相关）
`npm run jest:run -- --runTestsByPath tests/servertool/routing-instructions.spec.ts`

- 结果：**38 passed, 11 skipped, 0 failed** ✅

#### stop-message-auto（直接相关）
`npm run jest:run -- --runTestsByPath tests/servertool/stop-message-auto.spec.ts`

- 结果（修改后）：**5 failed, 16 skipped, 17 passed**
- 基线对比（stash 后运行同测试）：**7 failed, 16 skipped, 15 passed**
- 结论：本次改动未引入新失败，且净改善 2 个用例。

#### virtual-router fallback/命中日志回归（本次改动直接覆盖）
`npm run jest:run -- --runTestsByPath tests/servertool/virtual-router-context-fallback.spec.ts tests/servertool/virtual-router-longcontext-fallback.spec.ts tests/sharedmodule/virtual-router-hit-log.spec.ts`

- 结果：**3 suites passed, 9 tests passed, 0 failed** ✅
- 说明：
  - 单 provider 被过滤后改为显式报错（fail-fast）语义已由测试覆盖。
  - longcontext 在非 fatal 429 下保持同路由池（无 TS fallback）语义已由测试覆盖。

#### Hub anthropic fallback 清理回归
`npm run jest:run -- --runTestsByPath tests/sharedmodule/anthropic-semantics-stage2.spec.ts tests/sharedmodule/provider-compat-anthropic.spec.ts`

- 结果：**2 suites passed, 5 tests passed, 0 failed** ✅

### 5) 构建验证
`npm run build:min`

- 结果：**通过** ✅

---

## 风险 / 未完成

1. `stop-message-auto` 仍有历史失败（与本次 virtual-router P0 改动非同一路径），需单独治理。
2. Hub 仍有 B 类 TS 语义残留（见 `docs/audit/p0-hub-ts-semantic-residue.md`），按 P1 继续收敛。

---

## 下一步

1. 先单独处理 `tests/servertool/stop-message-auto.spec.ts` 的历史失败并恢复全绿。
2. 按 `docs/audit/p0-hub-ts-semantic-residue.md` 进入 P1：逐项下沉/删除 Hub B 类语义残留。
