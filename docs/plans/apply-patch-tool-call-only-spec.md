# apply_patch 统一处理规范（Schema only · Rust only）

## 索引概要
- L1-L8 `purpose`：apply_patch 当前唯一设计目标。
- L10-L38 `schema-contract`：工具定义与请求/响应形状。
- L40-L61 `runtime-owner`：Rust 唯一 owner 与 TS 边界。
- L63-L88 `validation-guard`：轻量 shape 校验与错误引导。
- L90-L106 `removed-legacy`：必须物理移除的旧路径。
- L108-L128 `verification`：测试与验证要求。

## 目标

`apply_patch` 只保留结构化 tool call 形状，不再支持 raw tool input。所有 apply_patch 专属 shape normalize / validate / guard 都由 Rust runtime 统一处理，TS 只能传输 Rust 已治理后的结果，不得保留第二实现。

## Schema Contract

工具定义必须是结构化 JSON schema：

```json
{
  "type": "function",
  "function": {
    "name": "apply_patch",
    "description": "Edit files. Call with {"patch": "*** Begin Patch\n...\n*** End Patch"}.",
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

请求给出的结构化字段必须被按原始 schema 形状处理：
- 首选 `patch`。
- `input` 仅作为结构化 alias 接受。
- 不猜测 `raw_patch` / `raw` / 任意文本字段。
- 不把 shell heredoc、Markdown fence、GNU diff wrapper 当作工具调用形状兜底。

## Runtime Owner

唯一 owner：

`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`

Rust 负责：
1. 识别 `apply_patch` tool call。
2. 解析结构化 `arguments`。
3. 轻量 normalize schema shape（`input` → `patch`）。
4. 做必要 guard，生成可读错误 patch。
5. 将治理后的 `arguments` 写回响应。

TS 边界：
- TS 不得新增 apply_patch 专属 validator / normalizer / guard builder。
- TS 不得新增 apply_patch raw-tool-input 兼容层。
- TS 只允许薄壳调用 Rust governance，或读取已治理后的 goal/tool state。

## Validation / Guard

validator 只做 shape 与明显非法内容校验，不做深度审计，不做语义猜测。

必须拒绝：
- 缺失 `patch`/`input`。
- `patch`/`input` 不是字符串或为空。
- 不包含 `*** Begin Patch` 与 `*** End Patch`。
- 明显冲突标记：`<<<<<<<` / `=======` / `>>>>>>>`。

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

以下旧路径必须物理移除或保持无 apply_patch 专属逻辑，不能只是不接入：

- `compat_fix_apply_patch.rs`
- `src/tools/apply-patch*`
- `src/tools/patch-regression-capturer*`
- `conversion/compat/actions/apply-patch-fixer*`
- TS post-governance apply_patch validator / blocked args builder
- request path apply_patch validator / guard
- 文档中的旧兼容计划、旧 raw-tool-input 报告、旧目标文档

## Verification

最小验证：
1. Rust unit：schema `{patch}` 正常通过。
2. Rust unit：schema `{input}` 归一为 `{patch}`。
3. Rust unit：raw string arguments 被 guard 为 `missing_patch`。
4. Rust unit：冲突标记被 guard。
5. TS compile：确保删除旧 TS 路径后无引用。
6. targeted grep：无旧 raw-tool-input 设计残留；只允许本规范/skill 中出现“移除旧设计”的说明。
