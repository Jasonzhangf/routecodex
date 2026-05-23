# apply_patch 统一处理规范（Client apply_patch · Rust internal line-edit · Canonical return）

## 索引概要
- L1-L8 `purpose`：apply_patch 当前唯一设计目标。
- L10-L38 `surface-contract`：client 外部契约、upstream/internal 契约、工具结果回灌契约。
- L33-L58 `runtime-owner`：Rust 唯一 owner 与 TS/provider 边界。
- L60-L78 `mode-selection`：direct/relay 分流规则。
- L80-L104 `validation-guard`：校验与失败边界。
- L100-L116 `removed-legacy`：必须物理移除的旧路径。
- L118-L142 `verification`：测试与验证要求。

## 目标

`apply_patch` 的客户端外部契约只允许是标准结构化 tool call；RouteCodex relay/chat-process 内部可以把上游 authoring schema 改为 **internal line-edit**：`filePath + fileContent + patch`，其中 `patch` 使用 `- old\n+ new` 的最小行编辑表达。client 不感知该内部格式，response/outbound 必须统一映射回 canonical `*** Begin Patch ... *** End Patch`。

## Surface Contract

### 1. Client-facing tool contract

客户端仍只看见 `apply_patch`，且返回/执行时仍使用 canonical patch：

```json
{
  "type": "function",
  "function": {
    "name": "apply_patch",
    "parameters": {
      "type": "object",
      "properties": {
        "patch": { "type": "string" },
        "input": { "type": "string" }
      },
      "required": ["patch"],
      "additionalProperties": false
    }
  }
}
```

### 2. Upstream/internal relay contract

在 Hub Pipeline / chat-process relay 内，Rust 请求治理可把上游工具 schema 改为：

```text
filePath: workspace-relative target path
fileContent: exact current file content snapshot
patch: internal line-edit text, e.g. "- old\n+ new"
```

该格式只存在于 relay 内部和上游 provider 请求，不得作为 client-facing API、provider alias guidance 或通用 system prompt 出现。

### 3. Transparent return contract

无论上游返回 canonical patch、`filePath/fileContent/patch` line-edit，还是同等结构化响应，client 侧只允许看到 canonical `apply_patch` 参数。禁止把内部 line-edit 原文直接漏给 client。

### 4. Tool result return contract

client 执行 `apply_patch` 后的 `function_call_output` / `role=tool` 历史会再次进入模型请求。该段必须由 Hub inbound 统一翻译成 internal line-edit 结果语义：

- 成功：`APPLY_PATCH_RESULT: ... internal line-edit contract ...`
- 失败：`APPLY_PATCH_ERROR: ... retry using filePath + exact fileContent + - old/+ new ...`

禁止把 Codex executor 原始 `aborted`、`Done!`、canonical patch 错误提示直接回灌给模型；也禁止重复包装已有 `APPLY_PATCH_ERROR:`。


## 2026-05-23 Design Direction Update

apply_patch 当前设计改为配置门控：详见 `docs/design/apply-patch-config-gated-servertool.md`。

- `servertool` 模式：Hub/servertool 本地执行 apply_patch，执行结果 followup 回模型，不返回 client。
- `client` 模式：兼容旧客户端路线，回到 hashline 前行为，不做 internal line-edit schema 改写，不做 servertool 本地执行。
- 这不是失败 fallback；单请求模式由配置固定决定。

## Runtime Owner

唯一 owner：

```text
sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/
```

当前最小责任拆分：

- `req_process_stage1_tool_governance.rs`：relay/chat-process 请求侧唯一 schema 改写点。
- `resp_process_stage1_tool_governance.rs`：response 侧识别 internal line-edit 并归一为 canonical patch。
- `hub_resp_outbound_client_semantics.rs`：outbound client semantics 最终保障。
- `hub_req_inbound_tool_call_normalization.rs`：下一轮请求中 apply_patch 执行结果/错误回灌的唯一翻译点。
- `hashline/*`：仅作为历史命名的内部 line-edit/native edit helper；不得把“hashline-first”作为当前文档或 prompt 主事实。

TS / provider 边界：

- provider-direct same-protocol：必须 identity passthrough。
- router-direct same-protocol：必须 identity passthrough。
- TS 不得新增 apply_patch authoring guidance、validator、normalizer 或 provider alias。
- Windsurf provider 不得把 `apply_patch` 映射为 native `propose_code/write_to_file`。
- 通用 system prompt 不得强制模型手写 canonical apply_patch 语法。

## Mode Selection

唯一分流规则：

1. **provider-direct / router-direct same-protocol**：原始 payload 透传，不改 tools，不注入 `fileContent`，不注入 line-edit 文案。
2. **relay/chat-process**：进入 Rust `req_process_stage1_tool_governance.rs`，由该处统一决定是否把 `apply_patch` schema 改为 internal line-edit。
3. **response/outbound**：进入 Rust response governance，统一映射回 canonical client apply_patch。
4. **tool result inbound**：client 执行结果进入下一轮请求时，进入 Rust inbound normalization，统一映射回 internal line-edit 结果语义。

禁止：

- provider 层按模型/平台自行决定 apply_patch mode。
- 同一请求同时给模型两套 apply_patch authoring 规范。
- fallback 到另一套 patch authoring。

## Validation / Guard

validator / guard 只做 shape 与明显非法内容校验，不做语义猜测。

必须拒绝或显式 guard：

- 缺失 `patch`/`input`。
- `patch`/`input` 不是字符串或为空。
- line-edit 模式下缺失 `filePath` 或 `fileContent`。
- 明显冲突标记：`<<<<<<<` / `=======` / `>>>>>>>`。

禁止：

- 从 prose 猜 patch。
- 从 shell 正文猜工具名。
- 内部 line-edit 失败后偷偷退回 canonical authoring。
- 对已有 `APPLY_PATCH_ERROR:` 二次包装，导致模型看到重复/冲突错误。
- 在 TS/provider 层补第二套修复。

## Removed Legacy / Dead Semantics

必须物理移除或保持不可回流：

- provider/system-prompt 的 apply_patch authoring guidance。
- Windsurf `apply_patch -> propose_code/write_to_file` native bridge。
- `exec_command -> run_command` Windsurf native bridge；当前仅 `shell_command -> run_command` 是已证明 native equivalent。
- 把 `hashline-first` 写成当前请求主事实的设计文档。
- provider/direct 里的 relay apply_patch 改写。

## Verification

最小回归矩阵：

1. direct/provider-direct payload identity，且不含 `fileContent` / internal line-edit guidance。
2. router-direct same-protocol payload identity。
3. relay/chat-process request-side schema 改写命中 Rust 真入口。
4. response/outbound 能把 internal line-edit 转 canonical patch。
5. tool result inbound 能把 `aborted`/executor 错误/`Done!` 翻译成 internal line-edit `APPLY_PATCH_ERROR` / `APPLY_PATCH_RESULT`。
6. Windsurf provider：`apply_patch/exec_command` 进入 RCC unsupported text protocol；`shell_command` 才映射 native `run_command`。
7. installed runtime smoke：10000 端口 apply_patch 完整工具调用链；若端口被其他上游长请求阻塞，必须报告阻塞证据而不是宣称 smoke 已完成。
