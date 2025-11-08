# Responses 直通 Provider 与 LLM Switch 直通方案（设计与执行文档）

本文档给出“OpenAI Responses 真实 SSE 透传”的设计与实施计划：在不修改客户端的前提下，让服务器直接连接上游 Responses 接口并原样透传 SSE，且具备完善的可观测性与最小改动范围，符合 RouteCodex V2 架构原则。

## 1. 目标与范围

- 目标
  - 在 `/v1/responses` 下提供“真实 SSE 透传”能力：输入 Responses 请求，输出同规范 Responses 事件流。
  - 使用配置驱动：`~/.routecodex/config.json` 中新增一个 `type: "responses"` 的 provider；模型设为 `gpt-5`；将其设置为默认路由（`routing.default`）。
  - 与黑盒客户端无耦合：不需要客户端改代码即可稳定收到事件与字节。
  - 强可观测：保留请求/响应快照；增加服务端原始 SSE 字节 tee 日志。

- 非目标（本阶段不做）
  - 不在直通流程中修改上游事件内容；不做协议“转换”与“修剪”。
  - 不在直通流程中做工具参数重写、合成填充等逻辑。

## 2. 架构与职责边界

- Provider 层（V2）：统一 HTTP 通信，连接上游 Responses 接口；不参与工具处理；仅做超时/重试与 headers 构建。
- LLM Switch 层：提供“Responses 直通”模块，在该模式下不做 request/response 转换（保留 single-path 与最小耦合）。
- Compatibility 层：最小化（保持空操作），不做工具/文本处理。
- HTTP Server：SSE 首部、立即 flush、tee 日志、pipe 给客户端；`/v1/responses/:id/submit_tool_outputs` 续轮直通。

## 3. 模块设计

### 3.1 新 Provider：`responses`（真实 SSE 透传）

- 文件：`src/modules/pipeline/modules/provider/v2/core/responses-provider.ts`
- 类型：`responses`
- 关键点：
  - 从 provider 配置读取 `baseUrl`、`auth.apiKey`、`overrides.timeout`，构造请求。
  - 请求端点：`POST <baseUrl>/responses`（与 OpenAI Responses 文档一致）。
  - 当请求 `metadata.entryEndpoint === '/v1/responses'` 且本 provider 生效：
    - 设置 Header：`Accept: text/event-stream`，发起真实 SSE；
    - 将 WHATWG Readable 转成 Node Readable，返回 `{ __sse_stream, __sse_meta }` 给上层。
  - 旁路快照：
    - `provider-request.json`：请求体；
    - `provider-response.json`：状态与 headers（SSE 情况记录 meta）；
    - `provider-error.json`：上游错误（含 HTTP 状态/文案）。
  - 续轮工具：
    - `POST <baseUrl>/responses/:id/submit_tool_outputs`，同样走 `Accept: text/event-stream`，返回 Node Readable。

### 3.2 LLM Switch：Responses 直通模块

- 文件：`src/modules/pipeline/modules/llmswitch/llmswitch-responses-passthrough.ts`
- 类型：`llmswitch-responses-passthrough`
- 行为：
  - `processIncoming`：原样返回 `{ data, metadata: { protocol: 'openai-responses' } }`；
  - `processOutgoing`：原样返回（直通模式不做转换）。

### 3.3 路由器（选择直通）

- 文件：`src/modules/pipeline/modules/llmswitch-v2-adapters.ts`
- 规则：
  - 若 provider 类型为 `responses`（或 `metadata.protocol === 'openai-responses'`），则 pick 为 Responses 并走直通模块；
  - 否则保持现有逻辑。

### 3.4 HTTP Server（SSE 透传与日志）

- 文件：`src/server/http-server.ts`
- `/v1/responses`：
  - 早写响应头并 `flushHeaders()`：
    - `Content-Type: text/event-stream; charset=utf-8`
    - `Cache-Control: no-cache, no-transform`
    - `Connection: keep-alive`
    - `X-Accel-Buffering: no`
  - 若上游返回 `__sse_stream`：tee 到 `~/.routecodex/logs/sse/<requestId>_server.sse.log`，同时 pipe 至客户端。
  - 不做本地合成（直通模式）。
- `/v1/responses/:id/submit_tool_outputs`：
  - 同上，透传上游返回的 SSE，tee+pipe。

## 4. 配置与选择

- Provider 配置（示例，已按照你的要求生成到 `~/.routecodex/config.responses.json`）：
  - `type`: `"responses"`
  - `baseUrl`: `"https://www.fakercode.top/v1"`
  - `auth.type`: `"apikey"`
  - `auth.apiKey`: 从 `~/.zshrc` 的 `FC_API_KEY` 读取
  - `overrides.timeout`: `60000`
  - 直通开关：本方案对 `responses` 类型默认走真实上游 SSE（不再依赖 env）。
- 路由：
  - `routing.default = ["fc.gpt-5"]`
  - `routing["/v1/responses"] = ["fc.gpt-5"]`

## 5. 任务拆解与文件清单

1) Provider：responses
   - 新增：`src/modules/pipeline/modules/provider/v2/core/responses-provider.ts`
   - 注册：`src/modules/pipeline/core/pipeline-manager.ts` → `this.registry.registerModule('responses', this.createResponsesProviderModule)`
   - ServiceProfile（可选）：`src/modules/pipeline/modules/provider/v2/config/service-profiles.ts` → `responses` 默认 `defaultEndpoint: '/responses'`

2) LLM Switch 直通模块
   - 新增：`src/modules/pipeline/modules/llmswitch/llmswitch-responses-passthrough.ts`
   - 路由器：`src/modules/pipeline/modules/llmswitch-v2-adapters.ts` 里选择直通。

3) HTTP 层
   - `src/server/http-server.ts`：
     - `/v1/responses` 收到 `__sse_stream` 时 tee+pipe（当前分支已具备 tee 基础，补 flushHeaders/X-Accel-Buffering）。
     - `/v1/responses/:id/submit_tool_outputs` 直通处理（沿用现有结构，接 provider 方法）。

4) 配置示例（你已要求，已生成在用户目录）：
   - `~/.routecodex/config.responses.json`（不改仓库内默认 config）。

## 6. 测试与验收

- 黑盒客户端测试：
  - 直接打 `POST /v1/responses`，观察是否稳定收到：
    - `response.created` → `response.in_progress` → `response.output_text.delta`* → `response.output_text.done` → `response.completed` → `response.done` → `[DONE]`。
  - 工具回路：收到 `required_action` 后，黑盒 `submit_tool_outputs`，再验证下一轮直到 `done`。

- 服务端可观测：
  - 原始 SSE 字节：`~/.routecodex/logs/sse/<reqId>_server.sse.log`
  - 快照：`~/.routecodex/codex-samples/openai-responses/` 下的 `provider-request.json` / `provider-response.json` / `provider-error.json` 与 `*_sse_pre/post.json`

- 代理排查建议：
  - Nginx：`proxy_buffering off;` `proxy_http_version 1.1;` `proxy_set_header Connection '';` `chunked_transfer_encoding on;`；
  - Cloudfront/反代：关闭转换（`no-transform`）。

## 7. 失败与回退

- 如上游不可用或频繁 429，直通仍会原样透传（便于排查真实问题）。
- 若上线后需要回退：将 `routing.default` 指回原 pipeline，或将 provider.type 换回 `openai` 并覆盖 endpoint `/chat/completions`。

## 8. 里程碑与工期

1) Day 0：落地 Provider 与直通模块骨架、注册、HTTP 细节（flushHeaders/X-Accel-Buffering），本地联调。
2) Day 1：黑盒连通性测试、工具回路验证、快照与 tee 日志对齐。
3) Day 2：文档/READMEs 更新、可观测性清单复核。

## 9. 合规性与约束（对齐 AGENTS.md）

- 统一工具处理：直通模式不改写工具事件；工具治理入口仍在 llmswitch-core（但此模式仅旁路）。
- 最小兼容：Compatibility 层不做转换、不兜底。
- Fail Fast：上游错误透传（不隐藏）；必要时仅在 HTTP 层合成 SSE error 帧作为最后兜底（可开关）。
- 模块化：新增文件均 <500 行；职责单一。
- 配置驱动：所有开关通过 provider 配置与路由选择生效，不写死。

---

附：配置示例（已生成在用户目录）

- `~/.routecodex/config.responses.json`（节选）

```
{
  "providers": {
    "fc": {
      "id": "fc",
      "enabled": true,
      "type": "responses",
      "baseUrl": "https://www.fakercode.top/v1",
      "auth": { "type": "apikey", "apiKey": "<从 ~/.zshrc 读取 FC_API_KEY>" },
      "overrides": { "timeout": 60000 }
    }
  },
  "routing": {
    "default": [ "fc.gpt-5" ],
    "/v1/responses": [ "fc.gpt-5" ]
  },
  "pipelines": [
    {
      "id": "fc.gpt-5",
      "provider": { "type": "responses" },
      "modules": {
        "provider": {
          "type": "responses",
          "config": {
            "baseUrl": "https://www.fakercode.top/v1",
            "timeout": 60000,
            "auth": { "type": "apikey", "apiKey": "<FC_API_KEY>" },
            "model": "gpt-5"
          }
        },
        "llmSwitch": { "type": "llmswitch-conversion-router", "config": {} },
        "compatibility": { "type": "compatibility", "config": {} },
        "workflow": { "type": "streaming-control", "config": {} }
      },
      "settings": { "debugEnabled": true }
    }
  ]
}
```

以上为实施蓝图。审批后我按此执行，并在实现中严格对照本文件逐项落地与验证。

