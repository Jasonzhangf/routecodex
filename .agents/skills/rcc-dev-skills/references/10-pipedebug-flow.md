# 10 PipeDebug Flow（逐段定位）

## 索引概要
- L1-L10 `goal`：按流水线切段定位。
- L11-L56 `stage-checklist`：每段检查什么。
- L57-L95 `signature-map`：常见错误签名 -> 对应层。
- L96-L129 `minimal-replay`：最小复现模板。

## 调试原则

只回答三个问题：
1. 失败发生在哪一段？
2. 这一段的唯一功能块是谁？
3. 输入形状是否已被上游破坏？

## 第一动作：先看样本

- 所有请求链 / provider / response / SSE / 502 问题，先看 `~/.rcc/codex-samples/` 的同 requestId / provider / endpoint 样本。
- 优先读 `provider-request*.json`、`provider-response*.json`、`client-request.json`、`client-response*.json`、`__runtime.json`。
- 找不到 codex sample 时，再看 `~/.rcc/diag/` 和 `~/.rcc/logs/`；日志只能定位症状，不能替代上游原始样本。
- 禁止未看 provider/request sample 就判断 payload shape、协议错位、model rewrite 或 parser 根因。

## 分段检查清单

### Stage-0：入口与配置
- 看：`/health`、`/v1/models`、active routing group。
- 关键文件：`http-server-runtime-setup.ts`、`routecodex-config-loader.ts`。

### Stage-1：req_inbound / chat-process
- 看：工具是否被识别、marker 是否被解析。
- 关键文件：
  - Rust: `resp_process_stage1_tool_governance.rs`
  - TS: `hub-pipeline-execute-chat-process-entry.ts`

### Stage-2：route select
- 看：`[virtual-router-hit]`、`reason=`、`provider-switch`。
- 关键文件：
  - Rust: `virtual_router_engine/engine/selection.rs`
  - TS bootstrap: `bootstrap/routing-config.ts`

### Stage-3：provider send
- 看：`provider.runtime_resolve` / `provider.send` / upstream 状态码。
- 关键文件：`executor-provider.ts`、`provider-runtime-resolver.ts`。

### Stage-4：resp finalize
- 看：finish_reason、tool_calls 是否被丢、正文是否被清空。
- 关键文件：
  - Rust: `resp_process_stage2_finalize.rs`
  - Rust: `hub_reasoning_tool_normalizer.rs`

### Stage-5：client injection / stopMessage
- 看：tmux scope、注入是否成功、状态是否清理。
- 关键文件：
  - Host: `executor/client-injection-flow.ts`
  - Core: `servertool/handlers/stop-message-auto.ts`

## 错误签名 -> 层

- `Provider runtime ... not found`：runtimeKey / provider registry 装配层。
- `No available providers after applying routing instructions`：route select 可用集为空。
- `HTTP_400 param tools.0.type`：outbound payload 形状问题。
- `finish_reason=tool_calls 但无 tool_calls`：finalize/tool harvest 问题。
- `upstream rejected request` + oauth/provider：auth/session 建立层。

## 最小复现模板（建议）

1. 先 direct model 测单 provider（排除路由干扰）。
2. 再同样 payload 走目标 route（验证调度）。
3. 最后开启工具/多模态/marker，逐个叠加。
4. 每次只加一个变量，确保可归因。

## 修复后 dry-run 回环（强制）

请求链或响应链问题修复后，必须先完成 dry-run 回环，再做 live replay：

1. request dry-run
- 真实请求：对同一 API 入口加 `x-routecodex-dry-run: provider-request`。
- 捕获样本：`node scripts/replay-codex-sample.mjs --sample <client-request.json> --dry-run provider-request --base http://127.0.0.1:<port>`。
- 必须确认返回 `object=routecodex.pipeline_dry_run`、`kind=provider_request`、`evidence.stoppedBeforeProviderSend=true`，并且输出最终 `providerRequest.url/body/headers`。
- 以 `providerRequest.body` 为最终上游样本真相。请求侧 bug 的验证必须看这里的实际 model、endpoint、headers、payload；不能只看 client request、配置、日志或静态 codec 输出。
- 如果 dry-run 返回普通 provider response、`output_text`、`choices` 或真实上游内容，说明 provider-request cut point 已失效；先修 dry-run loop，不能把这次结果当验证样本。
- 这个流程必须走当前 server handler、Hub/VR/provider runtime；禁止直接调用 provider codec 或手拼 provider body 当 request dry-run。

2. response dry-run
- 使用相关 `provider-response*.json`：`npm run dry-run:codex-response -- --sample <provider-response.json>`。
- 必须确认脚本调用 `convertProviderResponseIfNeeded` 并产出 `response-dry-run.json`。
- 对 chat 入口直通 Responses provider 的样本，脚本应从 provider payload 真相识别 `openai-responses`，不能只按 sample 目录或 entry endpoint 推成 `openai-chat`。
- 离线 response dry-run 需要 materialized 响应体。只有序列化 live `sseStream` 且没有 `bodyText` / `raw` / `text` / `sseBodyText` 的样本不可重放，必须重新捕获或换完整 provider-response 样本。
- 禁止在脚本里新写第二套 provider response parser / converter。

3. live replay
- dry-run 过后，再重放旧失败样本或同入口真实样本。
- request dry-run + response dry-run + live replay 三者缺一，不能说请求/响应修复闭环。
