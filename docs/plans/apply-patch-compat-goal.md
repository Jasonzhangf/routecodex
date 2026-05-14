# /goal: apply_patch 最大兼容修复

## 目标

按 `apply-patch-compat-full-plan.md` 实施四步修复，使 validator 对所有合法 patch 形状实现最大兼容接收，同时保持 fail-fast 约束。

---

## Target Docs

- 完整方案：`docs/plans/apply-patch-compat-full-plan.md`
- 核心文件：
  - `sharedmodule/llmswitch-core/src/tools/apply-patch/validator.ts`
  - `sharedmodule/llmswitch-core/src/tools/apply-patch/patch-text/normalize.ts`
  - `sharedmodule/llmswitch-core/src/tools/apply-patch/args-normalizer/extract-patch.ts`
- 测试：
  - `tests/sharedmodule/apply-patch-validator.spec.ts`
  - `tests/sharedmodule/apply-patch-full.spec.ts`

---

## Execution Rules

1. **Step 0 优先**：先统一三条 validator 路径的归一入口，确保后续 Step 的归一逻辑对所有路径生效
2. **只做格式归一**：所有改动必须基于格式特征（`---` 位置、`@@` 存在性、行前缀），不得推测业务语义
3. **保留正确拒绝**：`empty_add_file_block`、`/dev/null` 路径、真正空 patch 必须显式拒绝
4. **先写测试再改实现**：每个 Step 的改动必须先有对应的测试用例（T1-T7）
5. **三路径一致性验证**：改完后跑端到端测试确认路径 A/B/C 结果一致

---

## Verification Gates

- [ ] T1-T7 全部通过
- [ ] 49 条回归样本重新分类：`unsupported_patch_format` 从 14 降为 0（通过归一接受或正确拒绝）
- [ ] 三条路径对相同输入产生一致的 `normalizedArgs`
- [ ] 代码审查确认无语义猜测

---

## Completion Signal

三路径一致性测试全绿 + 回归样本重新分类达标 + 无新增硬拒绝理由。
