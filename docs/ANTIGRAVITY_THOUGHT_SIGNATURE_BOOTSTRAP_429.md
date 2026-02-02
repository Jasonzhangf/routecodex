# Antigravity / Gemini：ThoughtSignature 429 Bootstrap（ServerTool 方案）

## 目标

当 Antigravity / Gemini 路径在工具循环阶段出现 `HTTP 429`（或可确认的签名失效 `HTTP 400`）时，使用 **llmswitch-core 的 ServerTool 编排**做一次性 “thoughtSignature 预热/恢复”，避免 Host/Provider 在业务语义层面做旁路修复。

约束：

- 单执行路径不变：`HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream`。
- **只注入 user 层面的信息**；不修改 system 指令。
- 预热阶段强制模型调用 **`clock.get`**（不是 `clock.list`）。
- **一次性处理**：预热失败（仍为 429/400）则停止 bootstrap，并把错误按正常错误链路上抛/走重试策略。

## 触发条件（现行实现）

仅对以下组合启用：

- `providerProtocol === 'gemini-chat'`
- `providerKey` 前缀为 `antigravity.` 或 `gemini-cli.`
- provider→chat 语义映射后的 payload 含有 `error` 且满足：
  - `status === 429`，或
  - `status === 400` 且 message/codes 可判定为 signature invalid

## 为什么是 “ServerTool preflight + replay”

`thoughtSignature` 的核心问题是：当请求中包含历史工具调用（或工具循环上下文）时，上游可能要求其 `functionCall` 带有有效 signature；缺失/失效时会被拒绝（有些服务端会以 429 形式返回）。

因此 recovery 不能只在原请求上“继续跑一遍”，而需要：

1) **preflight**：构造一个“无历史工具调用”的最小请求，强制模型产生一次 `clock.get` 的工具调用，从响应里拿到新的 `thoughtSignature` 并写入缓存；
2) **replay**：再用原始 captured request 重新发起一次请求（此时 compat 层可注入有效 signature）。

这两步都通过 **ServerTool followup（内部二跳/三跳）**完成，对客户端透明。

## Preflight 请求形状（关键点）

- `messages`：
  - 第 1 条 user message **必须与原请求的第一条 user message 完全一致**（保证 `extractAntigravityGeminiSessionId` 导出的 `sid-*` 不变）。
  - 追加第 2 条 user message（仅 user 层）：
    - `请先调用 clock 工具并传入 {"action":"get","items":[],"taskId":""} 获取当前时间；得到工具返回后只需回复 OK（不要调用其它工具）。`
- `tools`：仅包含 `clock` schema（避免模型发起其它工具调用造成噪声）。
- `parameters.tool_config`：强制 Gemini function calling 只允许 `clock`：
  - `tool_config.functionCallingConfig.mode = "ANY"`
  - `tool_config.functionCallingConfig.allowedFunctionNames = ["clock"]`
- 路由：followup metadata 带 `__shadowCompareForcedProviderKey=<原 providerKey>`，确保同一账号执行 preflight + replay（signature 可能与账号绑定）。

## Replay 请求

preflight 成功后，立即重放原始 `capturedChatRequest`（模型/消息/工具/参数保持原样）。

Replay 同样以内部 followup 方式执行，并携带 `__shadowCompareForcedProviderKey`，保持同一账号。

## 一次性/止损策略

- preflight 返回仍含 `error` 且 `status` 为 `429/400`：停止 bootstrap，返回原始错误（让 Host 的 provider retry / route fallback 逻辑接管）。
- 通过 runtime metadata `antigravityThoughtSignatureBootstrapAttempted` 做一次性防重入。

## 实现位置（代码入口）

- ServerTool auto handler：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/antigravity-thought-signature-bootstrap.ts`
- ServerTool orchestration 二阶段（preflight + replay）：
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts`
- 允许该 flow 在 followup 中继续执行 servertools（仅白名单 flow）：
  - `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- `clock.get` followup 清理 `tool_config`（避免被锁死在 clock-only）：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/clock.ts`
- Antigravity/Gemini provider 将 429/400(signature) 以 response 形式回传（让 llmswitch-core 能编排）：
  - `src/providers/core/runtime/gemini-http-provider.ts`
  - `src/providers/core/runtime/gemini-cli-http-provider.ts`

## 与 `docs/SERVERTOOL_CLOCK_DESIGN.md` 的关系

本 bootstrap 方案依赖 clock 的既有 contract：

- `clock` schema 支持 `action: "get"`
- followup 必须请求 `clock.get`（不是 list）

Clock 的职责仍然是“时间/闹钟”，thoughtSignature bootstrap 仅把它当成可控、低风险、可强制调用的 servertool 触发器。

