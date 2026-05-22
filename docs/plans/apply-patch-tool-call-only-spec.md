# apply_patch 统一处理规范（Client apply_patch · Upstream hashline · Rust bridge）

## 索引概要
- L1-L8 `purpose`：apply_patch 当前唯一设计目标。
- L10-L46 `surface-contract`：client 外部契约与 upstream authoring 契约。
- L48-L73 `runtime-owner`：Rust 唯一 owner 与 TS 边界。
- L75-L97 `mode-selection`：schema/hashline 模式选择规则。
- L99-L121 `validation-guard`：轻量 shape 校验与失败边界。
- L123-L139 `removed-legacy`：必须物理移除的旧路径。
- L141-L162 `verification`：测试与验证要求。

## 目标

`apply_patch` 的**客户端外部契约**仍然是结构化 tool call；但当 schema 显式声明 `filePath/file_path` 时，**上游模型 authoring 主路径切换为 hashline**。所有 apply_patch/hashline 专属 shape normalize / validate / transparent bridge 都由 Rust runtime 统一处理，TS 只能传输 Rust 已治理后的结果，不得保留第二实现。

## Surface Contract

### 1. Client-facing tool contract

工具定义对 client 仍然必须叫 `apply_patch`，并保持结构化 JSON schema：

```json
{
  "type": "function",
  "function": {
    "name": "apply_patch",
    "description": "Edit files through apply_patch. Upstream authoring mode is decided by schema; client still receives canonical apply_patch back.",
    "parameters": {
      "type": "object",
      "properties": {
        "patch": {
          "type": "string",
          "description": "Patch text using *** Begin Patch / *** End Patch grammar. Paths are workspace-relative."
        },
        "input": {
          "type": "string",
          "description": "Backward-compatible alias of patch for schema-shaped callers only. Prefer patch."
        }
      },
      "required": ["patch"],
      "additionalProperties": false
    }
  }
}
```

client 请求给出的结构化字段必须被按原始 schema 形状处理：
- 首选 `patch`。
- `input` 仅作为结构化 alias 接受。
- 不猜测 `raw_patch` / `raw` / 任意文本字段。

### 2. Upstream authoring contract

当 `apply_patch` schema **声明了** `filePath/file_path`：

- 该工具的 upstream authoring 主路径应切到 **hashline**
- guidance / req profile / tool mode 都要明确这是 hashline-capable apply_patch
- 发给模型的 description / patch schema **不得再主教** `*** Begin Patch`
- upstream 产物回到 Rust 后，再透明桥接回 canonical apply_patch

当 schema **未声明** `filePath/file_path`：

- upstream 才继续使用 canonical apply_patch authoring

### 3. Transparent return contract

无论 upstream 实际 authoring 是 hashline 还是 canonical：

- downstream / client 看到的都必须是 canonical apply_patch
- client 不感知 hashline 中间层
- 禁止把 hashline 原文直接漏给 client

## Runtime Owner

唯一 owner：

`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`

其中最小责任拆分：

- `hub_pipeline.rs`：决定 `applyPatchToolMode = schema | hashline`
- `req_outbound_stage3_compat/*`：按 mode 注入正确上游 guidance
- `hub_req_inbound_tool_call_normalization.rs`：收割 hashline/canonical apply_patch，并统一回写 canonical apply_patch
- `hashline/*`：hashline parse/hash/apply/emit 真源

Rust 负责：
1. 识别 `apply_patch` tool call。
2. 决定是 `schema` 还是 `hashline` authoring mode。
3. 解析结构化 `arguments`。
4. 轻量 normalize schema shape（`input` → `patch`）。
5. 对 hashline 走 native parse/hash/apply/emit。
6. 做必要 guard，生成可读错误 patch。
7. 将治理后的 `arguments` 统一写回 canonical apply_patch。

TS 边界：
- TS 不得新增 apply_patch/hashline 专属 validator / normalizer / guard builder。
- TS 不得新增 apply_patch raw-tool-input 兼容层。
- TS 不得自行决定 schema/hashline mode。
- TS 只允许薄壳调用 Rust governance，或读取已治理后的 goal/tool state。

## Mode Selection

模式选择规则必须是确定性的：

1. 遍历 tools
2. 命中 `function.name == "apply_patch"`
3. 读取 `parameters.properties`
4. 若显式声明 `filePath` 或 `file_path` → `mode = "hashline"`
5. 否则 → `mode = "schema"`

禁止：

- 无条件默认 schema
- 看到 provider/model 再临时猜 mode
- client 请求是 canonical 就强制认定不能走 hashline 主 authoring
- 同一工具同时给模型两套平级 authoring 规范

## Validation / Guard

validator / guard 只做 shape 与明显非法内容校验，不做深度审计，不做语义猜测。

必须拒绝：
- 缺失 `patch`/`input`。
- `patch`/`input` 不是字符串或为空。
- schema mode 下缺失 canonical patch 基本包络。
- hashline mode 下缺失 `filePath/file_path`。
- 明显冲突标记：`<<<<<<<` / `=======` / `>>>>>>>`。

禁止把下面这些行为塞进“修复”：

- 从 prose 猜 patch 语义
- 从 shell 正文猜工具名
- hashline 失败后偷偷退回另一套 authoring
- 同一 payload 内混用 canonical apply_patch 与 hashline 两种语法

错误反馈使用 guard patch，写入 `function.arguments.patch`：

```text
*** Begin Patch
*** Update File: __APPLY_PATCH_ERROR__/missing_patch.txt
@@
-guard
+APPLY_PATCH_ERROR: apply_patch requires schema arguments {"patch":"*** Begin Patch\n...\n*** End Patch"}.
*** End Patch
```

guard 只负责引导模型下一轮给出正确 schema，不执行真实文件变更。

## Removed Legacy Surfaces

以下旧路径必须物理移除或保持无第二语义面逻辑，不能只是不接入：

- `compat_fix_apply_patch.rs`
- `src/tools/apply-patch*`
- `src/tools/patch-regression-capturer*`
- `conversion/compat/actions/apply-patch-fixer*`
- TS post-governance apply_patch validator / blocked args builder
- request path apply_patch validator / guard（若绕开 Rust mode resolver）
- “无条件 canonical apply_patch upstream authoring” 旧设计文案
- 文档中的旧兼容计划、旧 raw-tool-input 报告、旧目标文档

## Verification

最小验证：
1. Rust unit：schema 未声明 `filePath/file_path` → mode=`schema`。
2. Rust unit：schema 声明 `filePath/file_path` → mode=`hashline`。
3. Rust unit：hashline payload 进入 native hashline pipeline，并回写 canonical apply_patch。
4. Rust unit：schema `{input}` 归一为 `{patch}`。
5. Rust unit：raw string arguments 被 guard 为 `missing_patch`。
6. Rust unit：冲突标记被 guard。
7. req profile / guidance 测试：声明 `filePath/file_path` 后上游 guidance 明确 hashline 主路径。
8. TS compile：确保删除旧 TS 路径后无引用。
9. targeted grep：无“无条件 canonical upstream authoring”旧设计残留。
