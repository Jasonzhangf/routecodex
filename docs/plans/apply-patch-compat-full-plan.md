# apply_patch 最大兼容修复方案 — 完整计划（修正版）

## 目标

在不猜语义的前提下，实现 apply_patch validator 对所有**合法且可确定归一**的 patch 形状的最大兼容接收。
核心约束：**只做格式归一，不推测业务语义**。

---

## 现状审计结论

### 1.1 三条 validator 路径已共享归一引擎，但结构判定仍不完全一致

| 路径 | 入口条件 | 当前状态 / 已知问题 |
|---|---|---|
| A: heredoc 提取 | `apply_patch <<` heredoc 形态 | 当前已会进入 `normalizeApplyPatchText`，但后续错误分类仍可能与其他路径不一致 |
| B: native normalize | JSON args（`{patch:...,input:...}`） | 当前会提取 `patch/input/raw`，再进入统一 normalize；结构校验与路径 A 仍存在边界不一致 |
| C: raw normalize | 非 JSON 纯文本 patch | 当前直接 normalize + extract；`unsupported_patch_format` / `missing_changes` 归类仍可能不稳 |

**关键问题**：三条路径虽然已经共享 `normalizeApplyPatchText`，但：
- 路径 A 仍以 `detectInvalidPatchReason` 为主做结构拦截
- 路径 B/C 仍依赖 `validateNormalizedPatchStructure`
- 两套规则对某些形状的归类不一致
- 当前真正的问题已不是“完全未统一归一”，而是**归一后结构判定标准不完全统一**

### 1.2 当前错误分布（以回归样本为参考）

| 错误类型 | 数量 | 占比 | 根因 |
|---|---|---|---|
| `missing_changes` | 26 | 53% | shell 包裹提取、结构归类不一致、以及部分 prompt 误用的混合结果，不能简单归因为单一 prompt 问题 |
| `unsupported_patch_format` | 14 | 29% | Update File 后 `---/+++` 头、legacy/context diff 头、或缺失 `@@` 但仍可确定归一的形态 |
| `empty_add_file_block` | 9 | 18% | Add File 无 `+` 行（正常拒绝，保留） |

### 1.3 当前自动修复能力（已有，但边界需要统一）

| 能力 | 路径 | 状态 |
|---|---|---|
| classic context diff (`*** / ---`) → internal format | normalize.ts | ✅ 已有 |
| unified diff (`--- / +++`) → internal format | normalize.ts | ✅ 已有 |
| GNU diff 头在 Begin Patch 内 → 剥离 + 补 @@ | normalize.ts（Update File 段落） | ✅ 已有 |
| 缺失 `@@` 但已有显式 `+/-` diff 行 → 安全补 @@ | `repairMissingHunkHeaderSafely` | ✅ 已有 |
| structured JSON → internal format | args-normalizer | ✅ 已有 |
| heredoc 包裹提取 | validator.ts 路径 A | ✅ 已有 |
| conflict markers → 剥离 | normalize.ts `stripConflictMarkers` | ✅ 已在归一内 |
| legacy `*** Start File:` → `*** Update File:` | normalize.ts | ✅ 已有 |
| rename metadata → `*** Move to:` | normalize.ts | ✅ 已有 |
| Update File 内 `---/+++` diff 头在所有路径上的稳定接受 | validator / extract-patch | ⚠️ 需要统一判定 |
| Update File 内纯文本 body 无 `@@` 且无 `+/-` | — | ❌ 应继续拒绝，不能靠猜语义补齐 |

---

## 方案设计原则

### 硬约束
1. **不猜语义**：不推断“这是整文件替换”“这应该加 `@@`”等业务意图；只做格式归一。
2. **单向归一**：所有修复方向为“更规范”而非“更宽松”，不降低语法门槛。
3. **fail-fast 优先**：无法归一的输入必须显式拒绝，不静默接受。
4. **唯一真源**：所有 apply_patch 兼容性收口必须落在 `sharedmodule/llmswitch-core/src/tools/apply-patch/*`，禁止在 host 侧散落补丁。

### 为什么不用“宽松验证”

| 宽松验证的问题 | 本方案（集中归一）的优势 |
|---|---|
| 允许 `---` 分隔符在 Update File 内且不区分是否是 diff 头 | 仅当能**确定识别为 unified/context diff 头**时才归一，否则拒绝 |
| 允许无 `@@` 的纯文本内容 | 继续拒绝；不能把纯文本 body 猜成整文件替换或上下文 patch |
| 事后修复 → 不同路径产生不同结果 | 所有路径共享 `normalizeApplyPatchText`，并统一结构判定边界 |

---

## 修复方案：三步

### Step 0：确认并固化唯一归一路径

**现状**：当前代码中，heredoc 路径和 native/raw 路径已经基本进入 `normalizeApplyPatchText`。

**问题**：旧方案把这里当成未修根因，但当前真实问题已经变成：
- 归一流程已大体共享
- 归一后的**结构判定标准**不完全一致

**修复目标**：
- 保持三条路径都以 `normalizeApplyPatchText` 为唯一格式归一引擎
- 禁止新增第二套 normalize 逻辑
- 后续修复只允许改：
  - `sharedmodule/llmswitch-core/src/tools/apply-patch/validator.ts`
  - `sharedmodule/llmswitch-core/src/tools/apply-patch/args-normalizer/extract-patch.ts`
  - `sharedmodule/llmswitch-core/src/tools/apply-patch/patch-text/normalize.ts`

**目的**：后面所有兼容修复都围绕同一真源进行，而不是再散落到 host 或其他桥接层。

---

### Step 1：统一“可确定 diff 头”的接收与归一

**问题**：当前 `detectInvalidPatchReason` 与 `validateNormalizedPatchStructure` 对以下形态的接受边界可能不一致：
- unified diff 头：`--- a/x` + `+++ b/x`
- legacy context diff 头：`*** n,n ****` / `--- n,n ----`
- 缺 `@@` 但已有显式 `+/-` diff 行

**修复原则**：
- 只接受**可被确定识别为 diff 头**的 `---` / `+++`
- 不接受孤立 `---` 被当成“可能是 frontmatter”后继续猜

**确定识别标准**：
1. `---` 后紧跟 `+++` → 视为 unified diff 头，可继续归一
2. `---` + `+++` 后存在 `@@` → 视为标准 unified diff with hunk，可继续归一
3. `---` + `+++` 后虽然暂未出现 `@@`，但后续已出现显式 `+/-` patch 行 → 视为裸 unified diff，可继续进入安全补 `@@` 路径
4. `---` 出现在 `*** Update File:` header 之后第一行，且下一行**不是** `+++` 或 `@@` → 视为 frontmatter / 普通正文分隔符，不归一，直接拒绝
5. 孤立 `---` 且无法与 `+++` 或 legacy context diff 头组成确定结构 → 直接拒绝

**修复内容**：
1. `normalizeApplyPatchText` 继续承担 unified/context diff 头部归一
2. `extract-patch.ts` 的 `validateNormalizedPatchStructure` 必须与 normalize 后结果对齐
3. `validator.ts` 的 `detectInvalidPatchReason` 不能提前把本可确定归一的 diff 头打成非法

**安全边界**：
- `---` 后必须有对应 `+++`，否则继续拒绝
- legacy context diff 必须满足已有上下文头模式，不能把普通正文误识别成 diff 头
- 缺失 `@@` 的自动补齐仅限于**已有显式 `+/-` patch 行**的安全场景

**为什么是安全的**：这里做的是“识别确定性的 diff 头并归一”，不是放宽语法。

---

### Step 2：统一结构判定，但禁止纯文本语义推断

**问题**：当前两套判定函数对“归一后 patch 是否结构合法”的结论不完全一致。

**允许修复的情况**：

```typescript
// Case A（允许）：显式 +/- diff 行，缺失 @@
if ((hasAdd || hasDel) && onlyPatchPrefixed) {
  out.push('@@', ...sectionBody);
}
```

**`onlyPatchPrefixed` 的边界要求**：
- 它只用于“显式 patch 行缺少 `@@`”的安全补齐
- 如果非空行里混入 `---`、`+++`、`***`、`@@`、`index `、`diff --git ` 等 diff 头残留，不能在 Step 2 里直接按普通 patch body 处理
- 这类输入应优先回到 Step 1 的 diff 头归一逻辑判定，而不是在 Step 2 里误拒绝或误补齐
- 只有在**不存在 diff 头残留**且**全部非空行都已是明确 patch 前缀（空格 / `+` / `-`）**时，`onlyPatchPrefixed` 才成立

**明确禁止的情况**：
- `Update File` 内纯文本 body，无 `@@`，也无明确 `+/-`
- 裸 frontmatter / 多行正文 / YAML / markdown body，仅靠内容形状去推断“这应该是上下文还是新增”

**禁止原因**：
- 这已经属于语义推断，不是格式归一
- 会把本应 fail-fast 的非法 patch 静默洗成另一种语义

**最终要求**：
- `detectInvalidPatchReason`
- `validateNormalizedPatchStructure`

两者必须在 normalize 之后对以下边界给出一致结论：
1. 合法 patch → 接受
2. 可确定归一的 diff 头 → 接受
3. 需要猜语义的纯文本 update body → 拒绝

---

### Step 3：收缩 `detectInvalidPatchReason` 的职责，保留真正非法输入的硬拒绝

**问题**：`detectInvalidPatchReason` 不应再承担和 normalize 冲突的“半套结构解释器”角色。

**修复**：把“可确定归一”的情况交回 normalize；`detectInvalidPatchReason` 仅保留真正非法的硬拒绝：

| 原硬拒绝条件 | 改为归一处理 / 保留 |
|---|---|
| Update File 后 `---/+++` 明确构成 unified diff 头 | → normalize 归一（Step 1） |
| Update File 无 `@@` 但有 `+/-` 行 | → 安全补 `@@`（Step 2） |
| Update File 无 `@@` 且只有纯文本 body | → **继续拒绝** |
| Add File 空块（无 `+` 行） | → **保留硬拒绝** |
| `/dev/null` 路径 | → **保留硬拒绝** |
| 冲突标记 | → `stripConflictMarkers` 已在归一前执行，保留 |

**最终 `detectInvalidPatchReason` 仅保留**：
- 空 patch / 无内容
- `/dev/null` 非法路径
- `Add File` 空块
- `Update File` 需要猜语义才能补齐的结构非法输入

---

## 修复后预期错误分布

| 错误类型 | 修复前 | 修复后 |
|---|---|---|
| `missing_changes` | 26 (53%) | 下降，但不承诺归零；这类问题是提取、归类、prompt 误用的混合结果 |
| `unsupported_patch_format` | 14 (29%) | 显著下降；仅保留真正无法确定归一的结构非法输入 |
| `empty_add_file_block` | 9 (18%) | 9（保留，正确拒绝） |

---

## 文件改动清单

| 文件 | 改动类型 |
|---|---|
| `sharedmodule/llmswitch-core/src/tools/apply-patch/validator.ts` | Step 0+3：收缩前置拒绝职责，统一走归一后结构判定 |
| `sharedmodule/llmswitch-core/src/tools/apply-patch/patch-text/normalize.ts` | Step 1+2：仅增强确定性 diff 头归一与安全 `@@` 补齐 |
| `sharedmodule/llmswitch-core/src/tools/apply-patch/args-normalizer/extract-patch.ts` | Step 2+3：与 validator 使用同一结构边界 |
| `tests/sharedmodule/apply-patch-validator.spec.ts` | 新增针对每类归一场景的测试用例 |
| `tests/sharedmodule/apply-patch-full.spec.ts` | 端到端验证三条路径结果一致性 |
| `sharedmodule/llmswitch-core/src/guidance/index.ts` | Prompt：显式说明 `---/+++` 仅在明确 diff 头时会被归一 |
| `sharedmodule/llmswitch-core/src/guidance/CCR_TOOL_GUIDE.md` | 同步 prompt 变更 |

---

## 测试矩阵

| # | 输入形态 | 期望结果 | 覆盖 Step |
|---|---|---|---|
| T1 | `*** Update File\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@` | ✅ 归一接受 | Step 1 |
| T2 | `*** Update File` + legacy context diff 头 | ✅ 归一接受 | Step 1 |
| T3 | `*** Update File\n+foo\n-bar`（缺 `@@`） | ✅ 安全补 `@@` | Step 2 |
| T4 | `*** Add File: x.txt\n*** End Patch` | ❌ `empty_add_file_block`（保留） | Step 3 |
| T5 | `bash -lc "apply_patch <<'P'\n..."` | ✅ heredoc 提取后正确归一 | Step 0 |
| T6 | 三条路径同输入 → 同 normalizedArgs | ✅ 一致性验证 | Step 0 |
| T7 | Update File + `---` + 无 `+++` | ❌ `unsupported_patch_format`（孤立 `---` 无法归一） | Step 1 边界 |
| T8 | `*** Update File\nfrontmatter\n---\ntitle: x` | ❌ 拒绝（需要猜语义，不能自动补） | Step 2 边界 |
| T9 | `*** Update File` + diff 头残留（如 `index` / `diff --git` / `---` / `+++`）+ patch 行 | ✅ 回到 Step 1 归一，不在 Step 2 误拒绝 | Step 1/2 边界 |

---

## 验证 Gate

1. **测试矩阵全绿**：T1-T9 全部通过
2. **回归样本零新增误接受**：原本真正非法的 patch 不能因为“最大兼容”被静默洗成合法
3. **三条路径一致性**：相同输入在路径 A/B/C 下产生相同的 `normalizedArgs`
4. **无语义猜测证据**：代码审查确认没有“纯文本 body → 自动推断 context/addition”的逻辑

---

## 明确不做的事

以下行为一律禁止：

1. 把 `Update File` 里的纯文本正文自动猜成整文件替换
2. 把裸 frontmatter / markdown / YAML 内容自动补成 context/addition patch
3. 在 host 侧新增第二套 apply_patch 宽松兼容逻辑
4. 为了“提高通过率”而放宽 grammar，导致非法 patch 静默通过

---

## 后续可做但不属于本方案的事

参考 hermes-agent 的分层，有三类能力值得后续单独迭代引入，但**不属于本方案的 validator 归一目标**：

### A. Layer 2 文件预检（值得引入，但不是本次范围）

hermes-agent 在“纯语法解析”和“实际写盘”之间还有一层 `_validate_operations`，会在写文件前做：
- `Update/Delete` 目标文件是否存在
- `Move` 目标路径是否已被占用
- hunk 的上下文行是否能在目标文件中定位

这类能力对 RouteCodex 也有价值，尤其是：
- 文件不存在
- move 目标冲突

这类**可确定失败**的问题，可以在写盘前更早失败并给出更精确错误。

**但这属于 Layer 2 文件预检 / 执行前校验，不属于本方案的 Layer 1 patch 形状归一。**

### B. `format_no_match_hint` 错误增强（值得考虑，但不是本次范围）

hermes-agent 在 hunk 上下文找不到时，会输出更强的调试提示，例如：

```text
hunk 'context_hint' not found

Did you mean one of these sections?
   12|   related line in file
   13|   another nearby line
```

RouteCodex 后续也可以借鉴这种 **error message 增强**，让执行期失败更可调试。

**但这属于执行层错误可观测性增强，不影响本方案的 validator 归一目标。**

### C. addition-only hunk 的 context 唯一性对齐（后续核对）

hermes-agent 对 addition-only hunk 的要求更明确：
- context hint 命中 0 次 → append 到末尾
- 命中 1 次 → 合法
- 命中 >1 次 → 拒绝

RouteCodex 当前在 `repairMissingHunkHeaderSafely` 上已有类似能力，但条件边界不一定完全一致。

**这类对齐属于执行前/执行期行为一致性核对，不应回灌到本方案的 validator 语法归一层。**

### 明确不引入的 hermes-agent 能力

以下设计不应进入本方案：

1. 多层 fuzzy matching（如 `_strategy_exact → _strategy_context_aware`）
   - 这是执行层能力，不是 validator 层的事
   - 在 validator 阶段做模糊匹配，本质上是在猜语义

2. 把空 patch / 空 Add File 当作合法输入
   - RouteCodex 保留 `empty_add_file_block` 的 fail-fast 约束
   - 不采用 hermes-agent 的宽松通过策略

3. escape-drift / 模糊定位修复
   - 同样属于执行层问题
   - validator 不应介入

---

## 下一步（Prompt 修复，非 Validator）

`missing_changes` 的剩余部分可能来自 prompt 误用，但不能在方案阶段武断下结论为“纯 prompt 问题”。
Prompt 层可以单独加强：
- 明确禁止 shell 包裹外再嵌套伪 patch
- 明确 `Update File` 必须提供 `@@` 或明确 diff 头
- 明确整文件重写必须使用 `Delete File + Add File`

---

## 后续方案：`Update File` fuzzy matching / preflight（纳入路线，但不并入本次 Layer 1）

> 结论：`Update File` 的 fuzzy matching **值得做**，但它属于执行前定位层（Layer 2），不是 validator 归一层（Layer 1）。

### 为什么值得做

`Update File` 的典型失败中，有一类不是 patch 形状错，而是：
- patch 结构合法
- 目标文件存在
- 预期上下文只发生了轻微漂移
- 严格 exact match 找不到原位置

这类失败用 fuzzy matching 处理是有意义的，因为它解决的是：
**“合法 patch 如何在真实文件中定位”**，而不是“这是不是合法 patch 形状”。

### 正确分层

| 层 | 职责 | 是否属于本方案 |
|---|---|---|
| Layer 1 | patch 形状兼容、归一、结构 fail-fast | ✅ 属于本方案 |
| Layer 2 | `Update File` 上下文定位、预检、必要时 fuzzy matching | ❌ 不并入本次实现，但纳入后续方案 |
| Layer 3 | 实际写文件 | ✅ 现有执行器负责 |

### Layer 2 的目标

只对 `Update File` 引入受限 fuzzy matching，用于：
1. 目标文件存在性检查
2. hunk/context exact match
3. exact 失败后的**受限 fuzzy fallback**
4. 生成定位证据和失败提示

### 硬约束

`Update File` fuzzy matching 必须同时满足以下限制：

1. **只允许 `Update File`**
   - `Add File` / `Delete File` / `Move` 不参与 fuzzy matching

2. **先 exact，后 fuzzy**
   - 只有 exact match 失败时，才允许进入 fuzzy matching

3. **只允许上下文漂移，不允许语义重写**
   - fuzzy 只能解决“原本应该命中这一段，但附近有轻微变化”
   - 不能把完全不相关的块配成命中

4. **多候选命中直接拒绝**
   - 如果 fuzzy 结果不唯一，必须 fail-fast
   - 禁止“挑一个最像的”静默继续

5. **漂移阈值必须有限**
   - 超过阈值直接拒绝
   - 禁止无限扩张搜索窗口

6. **必须输出命中证据**
   - exact/fuzzy 命中的行号范围
   - 使用的匹配模式
   - 命中片段摘要

7. **默认仍然 fail-fast**
   - fuzzy 是受限定位增强，不是兜底
   - 不得把定位失败静默降级成“尽量应用”

### 推荐匹配顺序

```text
1. exact hunk/context match
2. exact context-only anchor match
3. limited fuzzy context match (Update File only)
4. unique match -> allow apply
5. zero or multiple matches -> reject
```

### 推荐错误输出增强

当 `Update File` 最终定位失败时，可参考 hermes-agent 的思路输出：

```text
Failed to find expected lines for Update File hunk.

Context hint not found uniquely.
Did you mean one of these sections?
  12| related line in file
  13| another nearby line
```

但这里的“hint”仅作为**错误提示**，不是自动应用依据；
只有满足唯一性和阈值约束时，才允许真正 fuzzy 命中。

### 与当前方案的边界

本次 `apply_patch-compat-full-plan` **不实现** fuzzy matching。
本次只保证：
- 合法 patch 形状最大兼容接收
- 非法 patch 继续 fail-fast
- 不在 validator 阶段猜语义

后续若实现 Layer 2，必须单独出方案，并满足：
- 真源在 apply execution / preflight 层
- 不回灌到 validator
- 不改变 Layer 1 的 fail-fast 语义边界

### 建议新增的后续文档

后续可单独新增：

- `docs/plans/apply-patch-update-file-fuzzy-preflight-plan.md`

专门描述：
- 文件存在性校验
- `Update File` 定位策略
- fuzzy matching 阈值
- 唯一性判定
- 失败提示格式
- 执行层验证与回归测试
