# apply_patch 配置门控 servertool 设计

## 索引概要
- L1-L11 `purpose`：目标、背景与唯一事实。
- L13-L35 `decision`：配置门控两模式与禁止 fallback。
- L37-L77 `flows`：client/servertool 两条流程图。
- L79-L119 `contracts`：请求、响应、执行结果、历史的分支契约。
- L121-L143 `config`：唯一配置入口与默认值。
- L145-L190 `implementation`：唯一修改层、模块职责、删除/保留规则。
- L192-L230 `tests`：红测、contract、真实入口与 samples 验证。
- L232-L254 `risks`：风险与防错规则。

## 目标 / 唯一事实

`apply_patch` 当前不再继续强推“透明 hashline/internal line-edit 桥接”作为唯一方案。实际线上验证显示，模型可能误读工具语法，执行错误/客户端提示也可能回灌污染下一轮语义。因此 `apply_patch` 改为**配置门控的两种明确模式**。

唯一事实：

1. 默认 `client`：回到 hashline 前兼容路线；RouteCodex 不改写 `apply_patch` schema，不本地执行，不拦截返回给 client 的 `apply_patch`。
2. 显式 `servertool`：RouteCodex 在 Hub/servertool 内本地执行 `apply_patch`，执行结果通过 followup 回模型；client 不收到该 `apply_patch` required_action/tool_call。
3. 这不是 fallback。模式由配置在请求进入 Hub 前确定；请求失败后不得自动切换另一模式。

## 决策

### 模式 1：`client`（默认）

目的：兼容 Codex 原生客户端 executor，避免 RouteCodex 在不稳定语法转换中制造二次污染。

行为：
- 不启用 RouteCodex `apply_patch` servertool。
- 不启用 hashline/internal line-edit schema 改写。
- 不把 `apply_patch` tool_call 当 internal servertool 消费。
- provider/model 返回的 `apply_patch` 保持 client-facing tool_call / required_action。
- client executor 的成功/失败结果按原链路回到下一轮请求；RouteCodex 不伪造、不隐藏。

### 模式 2：`servertool`（显式打开）

目的：当用户希望 RouteCodex 接管编辑执行时，模型只面对稳定 servertool 输入协议，执行在本地完成，结果由 followup 回模型。

行为：
- provider-facing tool name 仍为 `apply_patch`。
- provider-facing schema 由 Hub request governance 改为 servertool 输入协议：`filePath` / `fileContent` / `patch`。
- provider/model 返回 `apply_patch` tool_call 后，Hub response/servertool dispatch 拦截并本地执行。
- client 不收到已执行的 `apply_patch` tool_call / required_action。
- 执行成功/失败都以结构化 tool output followup 回模型。

## 流程图

### client 模式

```text
client /v1/responses
  |
  v
HTTP server
  |
  v
llmswitch-core Hub Pipeline
  |
  +--> runtime metadata: applyPatch.mode=client (default)
  |
  +--> request governance
  |      - 不改写 apply_patch schema
  |      - 不注入 internal line-edit/hashline guidance
  |
  v
Provider V2 / upstream model
  |
  v
Hub response outbound
  - 不进入 apply_patch servertool dispatch
  - 返回 client-facing apply_patch tool_call / required_action
  |
  v
client apply_patch executor
  |
  v
下一轮请求携带 client 原生 tool result
```

### servertool 模式

```text
client /v1/responses
  |
  v
HTTP server
  |
  v
llmswitch-core Hub Pipeline
  |
  +--> runtime metadata: applyPatch.mode=servertool
  |
  +--> request governance
  |      - apply_patch schema = filePath/fileContent/patch
  |      - 正面引导模型生成 servertool 输入
  |
  v
Provider V2 / upstream model
  |
  v
Hub response + servertool dispatch
  - 识别 apply_patch tool_call
  - runtime gate 允许 dispatch
  - strip client-facing apply_patch
  |
  v
servertool.apply_patch local handler
  - resolve workspace path
  - validate fileContent/current file
  - apply line-edit patch
  - return APPLY_PATCH_APPLIED 或 APPLY_PATCH_FAILED
  |
  v
servertool 标准 followup 骨架
  - 复用 captured origin + injection ops 构造后续 payload
  - 不走 tmux/client injection
  - 模型看到结构化执行结果
  - client 不看到已执行 apply_patch required_action
```

## 分支契约

### 请求契约

| 模式 | provider-facing `apply_patch` schema | 禁止内容 |
|---|---|---|
| `client` | 保持 client 原生 schema | `fileContent`、internal line-edit guidance、hashline guidance |
| `servertool` | `filePath` / `fileContent` / `patch` | Codex canonical `*** Begin Patch` 私有提示 |

### 响应契约

| 模式 | provider response 中 `apply_patch` | client response |
|---|---|---|
| `client` | 不被 servertool 消费 | 返回 client tool_call / required_action |
| `servertool` | 被 servertool dispatch 消费 | 不返回已执行的 apply_patch |

### 执行结果契约

`servertool` 模式本地执行结果必须结构化：

```json
{
  "status": "APPLY_PATCH_APPLIED",
  "filePath": "relative/path.ts",
  "summary": "..."
}
```

失败必须暴露真实原因：

```json
{
  "status": "APPLY_PATCH_FAILED",
  "filePath": "relative/path.ts",
  "reason": "CONTENT_MISMATCH | PATH_OUTSIDE_WORKSPACE | PATCH_INVALID | IO_ERROR",
  "nextAction": "..."
}
```

不得把失败伪造成成功；不得失败后自动切换 `client` 模式。

### 历史契约

- `client` 模式：保持 client executor 原始事实，不做 servertool 清洗。
- `servertool` 模式：provider-facing 历史只包含 servertool 结构化结果；后续由 servertool 标准 followup 骨架基于 captured origin + injection ops 重建，不走 tmux/client injection，不回灌 Codex canonical patch 私有语法、客户端错误提示或 hashline 旧说明。

## 配置

唯一配置入口：

```toml
[servertool.apply_patch]
# client: 默认，返回 client executor 执行
# servertool: RouteCodex 本地执行 + followup，不回 client
mode = "client"
```

规则：

1. 默认值固定为 `client`。
2. 只支持 `client` / `servertool`。
3. 非法值 fail-fast，例如 `SERVERTOOL_APPLY_PATCH_MODE_INVALID`。
4. 不保留 `enabled` 布尔等价入口，避免双真源。
5. 配置解析后必须落到 runtime metadata，例如 `__rt.applyPatch.mode`，供 Rust Hub governance 与 servertool dispatch 使用。

## 实现边界与模块职责

唯一分支层：

```text
config -> runtimeMetadata -> Hub request governance + servertool dispatch + response outbound/history
```

必须在 Hub Pipeline / servertool 层解决，禁止在 provider 层实现分支。

模块职责：

1. Config Loader
   - 接受 `[servertool.apply_patch] mode="client|servertool"`。
   - 默认 `client`。
   - 非法值 fail-fast。
2. Runtime Metadata
   - 把规范化 mode 透传到 Rust Hub Pipeline。
3. Rust request governance
   - 仅 `servertool` 模式改写 provider-facing `apply_patch` schema。
   - `client` 模式完全不改写。
4. Rust servertool dispatch planner
   - 静态可注册 `apply_patch`，但运行时只有 `mode=servertool` 才能 dispatch。
   - `mode=client` 必须跳过，且不能吞掉 client tool_call。
5. servertool handler
   - 本地执行编辑。
   - 校验路径与内容。
   - 输出结构化成功/失败。
6. response outbound / history
   - `servertool` 模式 strip 已执行 tool_call 并进入标准 servertool followup 骨架。
   - apply_patch servertool followup 禁止 tmux/client injection；只能通过 captured origin + injection ops 形成下一跳。
   - `client` 模式不做 servertool 清洗。

## 实施计划入口

详细实施步骤、文件清单、验证矩阵与 `/goal` 提示词见：

```text
docs/goals/apply-patch-config-gated-servertool-plan.md
```

## 测试锚点

### 红测先行

1. `client` 默认：provider-request 不包含 `fileContent` / internal line-edit guidance。
2. `client`：provider-response `apply_patch` 不进入 servertool dispatch，最终返回 client。
3. `servertool`：provider-request `apply_patch` schema 为 `filePath/fileContent/patch`。
4. `servertool`：provider-response `apply_patch` 进入 servertool dispatch，client response 不含该 tool_call。
5. `servertool`：本地文件真实变化，followup/执行响应包含 `APPLY_PATCH_APPLIED`，且不调用 `clientInjectDispatch`。
6. `servertool`：错误 patch 返回 `APPLY_PATCH_FAILED`，不伪造成成功。

### Contract / samples

- Contract 测试必须覆盖两模式请求、响应、dispatch、history。
- codex samples 必须证明：
  - `client` 没有 servertool schema/dispatch/followup。
  - `servertool` 有本地执行/followup，且 client 未收到 apply_patch required_action。

### 真实入口

- 基于 10000 端口标准 provider 做真实 apply_patch smoke。
- 修改后必须自己完成构建、安装、重启、真实 smoke，再让用户测。

## 风险与防错

1. **混线**：静态注册 servertool 后默认也消费 `apply_patch`。
   - 防错：dispatch 必须 runtime gate；client 模式红测必须覆盖。
2. **语法污染**：旧 hashline/internal guidance 仍泄露给模型。
   - 防错：client/provider request samples grep `fileContent`、`hashline`、`*** Begin Patch`。
3. **失败伪成功**：handler 错误被清洗成成功。
   - 防错：失败测试断言 `APPLY_PATCH_FAILED` 与 reason。
4. **越界写文件**：servertool 本地执行可能写出 workspace。
   - 防错：workspace-relative path guard；越界 fail-fast。
5. **错误修改层**：provider 或 Windsurf 文件被误改。
   - 防错：实现和提交前检查 diff；本功能禁止触碰 provider/Windsurf。
