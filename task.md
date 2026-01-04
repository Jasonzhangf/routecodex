# Task: apply_patch 参数化工具治理

## 目标

将 `apply_patch` 工具在 Hub Chat Process 中统一规范为「参数化」调用：所有工具调用最终都使用 JSON 形式的 `arguments`，并以 `patch` 字段承载完整的 `*** Begin Patch`/`*** End Patch` 补丁内容，同时兼容现有的 `input` 形状，减少模型自由发挥导致的执行失败。

---

## 子任务

- [ ] 梳理现有 apply_patch 流程（文本 → tool_calls → tool-governor → CLI 执行），列出所有可能的 `arguments` 形状。
- [ ] 在 `tool-registry.validateToolCall('apply_patch', ...)` 中：
  - [ ] 支持三种输入来源：`raw.arguments` 字符串、`args.patch` 字段、`args.input` 字段。
  - [ ] 统一使用 `normalizeApplyPatchInput()` 规范化补丁文本。
  - [ ] 产出标准 `normalizedArgs`：`{ patch: "<canonical_patch>", input: "<canonical_patch>" }`（兼容旧路径，首选 `patch`）。
- [ ] 确认 `text-markup-normalizer` / `streaming-text-extractor` 等文本收割路径，对 apply_patch 一律生成 `{"patch": "<patch>"}` 形状的参数。
- [ ] 检查工具 guidance（`augmentApplyPatch` + system tool guidance），在 description 中明确：
  - [ ] arguments 必须是 JSON 字符串，且包含单个 `patch` 字段。
  - [ ] 补丁必须使用 `*** Begin Patch` / `*** End Patch` 包裹的统一 diff 语法，禁止 git-style 头（`--- a/` / `+++ b/`）。
- [ ] 使用 `~/.routecodex/errorsamples/req/apply-patch-*` 中的样本进行回归（包括 `npm run verify:apply-patch`），确认：
  - [ ] 纯字符串 `arguments` 的 apply_patch 调用会被自动规范为参数化 JSON。
  - [ ] 带 `input`/`patch` 混合字段的旧调用仍可正常执行。
  - [ ] 语义错误的补丁（上下文不匹配等）仍然被拒绝，并产生醒目的 `[apply_patch][tool_error]` 日志。

---

## 状态

- 进行中：参数治理实现 + 样本回归。
