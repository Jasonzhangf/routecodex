# /goal: apply_patch tool-call-only 收口

## 目标

按 `apply-patch-tool-call-only-spec.md` 收口 apply_patch：移除旧 raw-tool-input/legacy fixer 路径，只保留结构化 `{ patch: string, input?: string }` 工具调用与 Rust 侧 shape-only 治理。

---

## Target Docs

- 完整方案：`docs/plans/apply-patch-tool-call-only-spec.md`
- 核心文件：
  - `sharedmodule/llmswitch-core/src/tools/apply-patch/validator.ts`
  - `sharedmodule/llmswitch-core/src/tools/apply-patch/patch-text/normalize.ts`
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- 测试：
  - `tests/sharedmodule/tool-governor-apply-patch-rewrite.spec.ts`

---

## Execution Rules

1. **单一路径**：apply_patch 只接受结构化 tool call；禁止 raw string/legacy fallback/fixer 第二路径。
2. **shape-only**：只基于显式 patch wrapper/schema 做形状归一；不得推测业务语义或补文件内容。
3. **Rust 真源**：治理入口收口到 `resp_process_stage1_tool_governance`；TS validator 只做薄壳调用与必要 schema 检查。
4. **真实 payload 不裁剪**：不得为了让工具成功而改写真实 patch 语义。

---

## Verification Gates

- [ ] `sharedmodule/llmswitch-core` TypeScript 构建通过
- [ ] native hotpath build 通过
- [ ] 根仓 `npm run build:min` 通过
- [ ] apply_patch 相关回归不再依赖 legacy fixer/raw input 路径
- [ ] 代码审查确认无 fallback/静默降级/语义猜测

---

## Completion Signal

tool-call-only 路径验证通过 + legacy fixer/raw input 被物理移除 + 无新增 fallback/静默降级。
