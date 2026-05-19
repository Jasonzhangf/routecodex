# P0 Rust 化任务计划（Hub + Virtual Router）

## 目标
在不扩散到 P1/P2 的前提下，完成：
1. 双真源清零（TS 与 Rust 语义重复删除）
2. Virtual Router 与 Hub 链路中的 TS 判定逻辑清零（fail-fast、无 fallback）
3. 提供可复验的命令证据与回归结果

---

## 范围
- Virtual Router：`sharedmodule/llmswitch-core/src/router/virtual-router/**`
- Hub（P0 仅审计+最小修正）：`sharedmodule/llmswitch-core/src/conversion/hub/**`
- Rust 真源对照：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/**`

---

## P0-A：双真源清零（Virtual Router）

### A1. 删除 single-provider fallback 语义
- 文件：`virtual-router/engine.ts`
- 动作：移除 `tryForceSingleProviderDecisionWhenPoolExhausted` 与全部调用。
- 验收：
  - `grep -rn "tryForceSingleProviderDecisionWhenPoolExhausted" .../virtual-router`
  - 期望：无输出。

### A2. 删除 edge-stage fallbackProtocol/fallbackPayload
- 文件：`virtual-router/engine-selection/native-hub-pipeline-edge-stage-semantics.ts`
- 动作：缺 `format/payload` 时直接 invalid + fail-fast。
- 验收：
  - `grep -rn "fallbackProtocol\|fallbackPayload" .../virtual-router`
  - 期望：无输出。

### A3. 移除 TS 重复状态应用入口
- 文件：
  - `virtual-router/routing-instructions.ts`
  - `virtual-router/routing-instructions/state.ts`
- 动作：移除 `applyRoutingInstructions` 运行时路径，仅保留序列化辅助。
- 验收：
  - `grep -rn "applyRoutingInstructions" .../virtual-router --include="*.ts" --include="*.d.ts"`
  - 期望：运行时代码 0 命中（测试文本可有）。

### A4. 收缩 stop/pre-command TS 壳层
- 动作：删除未被运行时引用的 stop/pre-command TS 语义壳文件。
- 验收：
  - `grep -rn "routing-stop-message-actions\|routing-pre-command-actions" .../virtual-router`
  - 期望：无运行时引用。

---

## P0-B：Hub TS 语义判定残留审计（不扩散）

### B1. 清单化
- 输出：`docs/audit/p0-hub-ts-semantic-residue.md`
- 内容：文件路径、函数名、语义类型（fallback/repair/normalize/coerce）、迁移优先级。

### B2. 只修“硬违规”
- 仅修 fail-fast/no-fallback 明确冲突项。
- 其余进入 Batch B（P1）计划，不在本批扩写。

---

## 测试与验证

## 必跑
1. `npm run jest:run -- --runTestsByPath tests/servertool/routing-instructions.spec.ts`
2. `npm run jest:run -- --runTestsByPath tests/servertool/virtual-router-context-fallback.spec.ts tests/servertool/virtual-router-longcontext-fallback.spec.ts tests/sharedmodule/virtual-router-hit-log.spec.ts`

## 审计命令
- `grep -rn "fallbackProtocol\|fallbackPayload\|tryForceSingleProviderDecisionWhenPoolExhausted\|applyRoutingInstructions" sharedmodule/llmswitch-core/src/router/virtual-router --include="*.ts" --include="*.d.ts" || true`

## 构建验证
- `npm run build:min`

---

## 交付物
1. 代码修复（仅 P0 范围）
2. `docs/virtual-router-audit-fix-YYYY-MM-DD.md`（改动/验证/风险/下一步）
3. `docs/audit/p0-hub-ts-semantic-residue.md`

---

## 完成标准（DoD）
- P0-A 四项全部完成并有 grep/测试证据
- Virtual Router 回归测试集通过
- 无新增 fallback / 静默吞错
- Hub 侧有可执行残留清单，不在本批无边界扩散
