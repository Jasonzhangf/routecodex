# apply_patch 错误样本分类表（2026-03-18）

## 范围

本表基于两个样本集合：

1. **近期主样本集**
   - `~/.rcc/errorsamples/client-tool-error/chat_process.req.stage2.semantic_map.apply_patch-*.json`
   - 按最近 **200** 条与最近 **500** 条做统计
2. **历史回归样本集**
   - `~/.rcc/errorsamples/apply-patch-regression/*.json`

## 结论摘要

- 近期高频错误几乎全部是 `apply_patch_verification_failed`，而且高度集中在 **4 类**。
- 当前主因不是执行器随机失效，而是 **模型 patch 心智错误**：
  1. 把 GNU diff 头混进 `*** Begin Patch` 块；
  2. 把 merge/conflict 标记直接塞进 patch；
  3. 继续硬写 GNU 行号上下文（`@@ -51,7 +51,9 @@`）；
  4. 少量真实的 `expected lines not found`。
- 历史回归样本还保留两类基础错误：
  - `unsupported_patch_format`
  - `empty_add_file_block`

---

## 近期样本统计

### 最近 200 条 apply_patch 专属样本

来源：

- `~/.rcc/errorsamples/client-tool-error/chat_process.req.stage2.semantic_map.apply_patch-*.json`

统计结果：

| 分类 | 数量 |
|---|---:|
| conflict_markers_or_merge_chunks | 72 |
| gnu_line_number_context_not_found | 55 |
| mixed_gnu_diff_inside_begin_patch | 55 |
| expected_lines_not_found | 18 |

### 最近 500 条 JSON 错误样本中的 apply_patch 相关分类

来源：

- `~/.rcc/errorsamples/**/*.json`

统计结果：

| 分类 | 数量 |
|---|---:|
| conflict_markers_or_merge_chunks | 75 |
| gnu_line_number_context_not_found | 57 |
| mixed_gnu_diff_inside_begin_patch | 49 |
| expected_lines_not_found | 19 |

备注：

- 最近 500 条 JSON 样本里，**未看到**新的 `exec_command_nested_apply_patch_warning` 成为主流；说明这轮主要问题已从“工具选错”转向“patch 形状错误”。

---

## 历史回归样本统计

来源：

- `~/.rcc/errorsamples/apply-patch-regression/*.json`

统计结果：

| 分类 | 数量 |
|---|---:|
| unsupported_patch_format | 2 |
| empty_add_file_block | 1 |

---

## 分类表

| 分类 | 典型 matchedText / 症状 | 当前数量 | 更可能的根因 | 建议修复层 | 优先级 | 建议动作 |
|---|---|---:|---|---|---|---|
| `conflict_markers_or_merge_chunks` | `Expected update hunk to start with a @@ context marker, got: '======='` | 72 / 75 | 模型把 merge/conflict chunk 或非 patch 文本直接塞进 `Update File` | **prompt/guidance** + request-path guard | P0 | 强化“禁止 `=======/<<<<<<</>>>>>>>`”与“`Update File` 必须有 `@@` hunk”；必要时在 request-path 直接拦截冲突标记并回写 guard reason |
| `gnu_line_number_context_not_found` | `Failed to find context '-114,6 +114,7 @@'` | 55 / 57 | 模型误以为必须精确写 GNU 行号上下文；或基于旧内容生成 patch | **prompt/guidance** + post-failure retry policy | P0 | 明确“可以用 `@@` + 上下文，不必强写 GNU 行号”；失败后要求重读文件并缩小唯一上下文 |
| `mixed_gnu_diff_inside_begin_patch` | `invalid hunk at line 2, '--- a/src/server/index.ts' is not a valid hunk header` | 55 / 49 | 模型把 internal `*** Begin Patch` 与 GNU diff 头混用 | **prompt/guidance** + validator normalization（可选） | P0 | 明确“二选一，严禁混用”；可评估是否把 `*** Begin Patch` 包裹的 GNU diff 头再做一层自动剥离修复 |
| `expected_lines_not_found` | `Failed to find expected lines in ...` | 18 / 19 | 真正的上下文不匹配：文件已变化、上下文过大、不够唯一 | **runtime retry guidance** | P1 | 出错后强制重读最新文件，再用更小且唯一的上下文；必要时把单次 patch 拆小 |
| `unsupported_patch_format` | `Update File` 后直接跟 frontmatter / 正文，没有 hunk | 2（历史） | 模型不理解 internal grammar；把 `Update File` 当“全文替换” | **tool guidance** + validator reason hint | P1 | 强化最小合法模板，显式提示“没有 `@@` hunk 的 `Update File` 会被拒绝” |
| `empty_add_file_block` | `*** Add File: ...` 后没有任何 `+` 行 | 1（历史） | 模型误以为空文件 Add File 合法 | **tool guidance** + validator reason hint | P2 | 明确 Add File 必须至少包含一行 `+内容`；若真要空文件，应改为 shell `touch` 之类的受控策略或专门工具，而不是空 patch |
| `exec_command_nested_apply_patch_warning` | `Warning: apply_patch was requested via exec_command` | 非近期主流，历史存在 | 工具选错：模型把 `apply_patch` 当 shell 命令 | **rewrite/guard** | P2 | 维持现有 rewrite/guard；后续做样本分类时单独追踪是否再次升高 |

---

## 已完成的前置收敛

本轮已先修正工具引导文案，避免继续制造同类错误：

- `src/config/system-prompts/codex-cli.txt`
  - 去掉“apply_patch 不好用就换 Node/Python 脚本”的弱引导
- `sharedmodule/llmswitch-core/src/guidance/index.ts`
  - 明确 **Begin Patch / GNU diff 二选一，禁止混用**
  - 增加最小合法模板
  - 禁止 conflict markers / 裸 frontmatter 作为 `Update File` body
- `sharedmodule/llmswitch-core/src/guidance/CCR_TOOL_GUIDE.md`
  - 同步补齐以上规则
- `sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-clock-tool-schemas.ts`
  - 工具描述补齐 FREEFORM 与“不混用”要求

---

## 建议修复顺序

### 第一步：先修 prompt / guidance

优先原因：

- 当前占比最高的三类错误都属于**模型生成 patch 形状错误**
- 不先收紧提示词，后面即使增强 validator，也只是在被动收垃圾输入

### 第二步：补 request-path / validator 的 reason 编码与 guard

优先看两点：

1. 对 conflict markers 的 request-path 早拦截
2. 对“mixed GNU diff inside Begin Patch”评估是否做自动修复，还是继续 fail-fast

### 第三步：为 `expected_lines_not_found` 设计统一 retry 策略

这是最像“正常 patch 失败”的一类，应通过：

- 重读文件
- 缩小上下文
- 拆小 patch

来恢复，而不是继续堆更宽松的语法容错。

---

## 下一步实施建议

1. 在 `apply_patch` 工具引导里增加**可复制模板**的实际注入验证
2. 给 `tool-governor` / request-path 增加 **conflict-marker 明确分类 reason**
3. 决定是否为“`*** Begin Patch` + GNU diff 头混用”加一层**自动正规化**
4. 把本表对应到测试矩阵，新增每类错误至少 1 条回归用例
