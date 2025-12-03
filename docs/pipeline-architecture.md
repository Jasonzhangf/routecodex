# Pipeline Architecture (v0.52.40+)

This document captures the end-to-end request flow after the latest LLMSwitch refactor
and the subsequent removal of all "silent" fallbacks. The goal is to ensure `/v1/chat/completions`,
`/v1/messages`, and `/v1/responses` are always processed by a predictable switch while sharing the same
downstream workflow/compatibility/provider modules.

## 1. Boot Flow

```
rcc start
└─ routecodex/dist/index.js
   ├─ loadRouteCodexConfig()
   │   └─ reads user config (~/.routecodex/config.json or ROUTECODEX_CONFIG_PATH)
   ├─ bootstrapVirtualRouterConfig(userConfig.virtualrouter ?? userConfig)
   │   ├─ validates routing/providers/classifiers
   │   ├─ outputs `{ virtualRouter, targetRuntime }`
   │   └─ infers compatibility profiles + provider runtime metadata
   ├─ new HubPipeline({ virtualRouter })
   └─ ProviderFactory.initializeFromRuntime(targetRuntime)
```

### No Fallbacks

- `config-manager` no longer synthesizes pipelines when `buildPipelineAssemblerConfig` fails. Any error
  aborts startup and logs the offending condition.
- `config-compat` exporters refuse to fabricate pipelines if `pipelineConfigs` is empty or inconsistent
  with `routeTargets`. Validation errors bubble up to `ConfigManager`.

## 2. Request Routing

At runtime, the HTTP server dispatches requests based on their entry endpoint:

Config compatibility now generates **one pipeline per route target** defined in `virtualrouter.routing`. Even if they share the same module types, each pipeline instance carries its own provider configuration (model, auth, baseUrl, etc.). Every generated pipeline has the same module chain:

```
llmswitch-conversion-router
  └─ streaming-control workflow
      └─ <compatibility module>
          └─ <provider module>
```

`llmswitch-conversion-router` inspects `entryEndpoint` at runtime to determine which codec profile to execute:

| Entry Endpoint           | Profile ID           | Behaviour                                           |
|--------------------------|----------------------|-----------------------------------------------------|
| `/v1/chat/completions`   | `openai-chat`        | OpenAI ↔ OpenAI passthrough/normalization.          |
| `/v1/messages`           | `anthropic-messages` | Anthropc ↔ OpenAI request/response conversion.      |
| `/v1/responses`          | `responses-chat`     | Responses ↔ Chat deterministic conversion pipeline. |

### Responses Conversion Router

`llmswitch-conversion-router` consults the built-in profile registry shipped with `@jsonstudio/llms`
to map entry endpoints to the appropriate codec:

```
profiles:
  anthropic-messages -> anthropic-openai codec
  openai-chat        -> openai-openai codec
  responses-chat     -> responses-openai codec (Responses ↔ Chat)
endpointBindings:
  /v1/messages        => anthropic-messages
  /v1/chat/completions=> openai-chat
  /v1/responses       => responses-chat
```

Each codec implements the request/response transformation pair while enforcing schema validation (`SchemaValidator`). Because every route target becomes its own pipeline, the provider module still receives a unique config block even though the module chain is identical.

## 3. Request Lifecycle

1. Protocol handler receives HTTP request, tags `entryEndpoint`, and forwards to the pipeline manager.
2. Pipeline manager looks up the pipeline ID from `routePools`/`routeMeta`.
3. LLMSwitch canonicalizes the request (and, in the responses case, serializes tool calls).
4. Streaming workflow converts streaming flag if needed (currently forced off for GLM).
5. Compatibility module sanitizes payloads for the target provider (GLM, Qwen, etc).
6. Provider module issues the HTTP call. Request/response snapshots are persisted under `~/.routecodex/codex-samples/...`.
7. LLMSwitch `processOutgoing` reconstructs the protocol-native response before returning to the HTTP layer.

### 3.1 SSE Integration (host → llmswitch-core)

LLMSwitch v3 统一了所有 SSE ↔ JSON 转换，host 侧只需要保证入站 metadata 和出站传输契约：

- **入站**：handler 在把请求交给 `executePipeline` 之前要写入：
  - `metadata.entryEndpoint`：`/v1/chat/completions` / `/v1/responses` / `/v1/messages`；
  - `stream`, `clientStream`, `inboundStream`, `outboundStream`（布尔）：来源是客户端 `stream` 字段 + `Accept: text/event-stream`；
  - `__raw_request_body`、`clientHeaders`（快照用，可选）。
 这样 `SSEInputNode` 会调用 `defaultSseCodecRegistry`，把任意 SSE 流聚合成对应协议的 JSON，再映射为内部 Chat 请求。host **不再** 需要对 SSE 进行本地解析。

- **出站**：`HubPipeline.execute` 若决定返回 SSE，会在 `result.body.__sse_responses` 写入一个 Node Readable（或 AsyncIterable）。handler 只需检测该字段并设置 SSE 头；若请求声明 `stream=true` 但结果缺少 `__sse_responses`，应视为 502。  
  - 不管 provider 返回 JSON 还是 SSE，llmswitch-core 都会根据入口端点的 streaming 标记决定是否调用 `defaultSseCodecRegistry.convertJsonToSse` 去 synthesize SSE；
  - host 不得再调用 `sse-response-normalizer`/`openai-sse-normalizer` 之类的历史兜底逻辑——这些文件已经移除。

- **唯一事实来源**：入口端点 + 入站 streaming 标记是响应阶段是否 SSE 的唯一决策点；providerType 只能决定 inbound converter 与 provider 调用，不得覆盖 outbound 的协议类型。

## 4. Required Configuration

- **User configuration** only needs to provide `virtualrouter.providers` + `virtualrouter.routing` (plus shared modules such as httpserver).
- `routecodex-config-compat` automatically converts those declarations into:
  * uniform `pipelineConfigs` (one per route target),
  * `routeTargets` mapped from routing,
  * `routePools` / `routeMeta` for the assembler.
- Because fallbacks were removed, missing providers or malformed routing still surface as startup errors, but a minimal provider configuration is enough to produce the pipelines above—no manual LLMSwitch selection is required.

## 5. Observability

Artifacts are written to `~/.routecodex/codex-samples` for every request:

```
responses-replay/
  raw-request_<reqId>.json        # raw HTTP payload received at /v1/responses
  pre-pipeline_<reqId>.json       # after LLMSwitch conversion
  provider-response_<reqId>.json  # upstream provider payload
  responses-final_<reqId>.json    # final Responses JSON returned to client
provider-out-glm_<timestamp>.json # raw upstream requests (for GLM provider)
```

The debug center logs module lifecycle events (`~/.routecodex/logs/debug-center.log`), allowing you to confirm
which LLMSwitch instances were instantiated.

## 6. Summary

- Startup now fails fast if the configuration lacks explicit `pipelineConfigs`/`routeTargets`.
- Three pipeline entrypoints have deterministic LLMSwitch assignments, avoiding heuristics.
- Downstream modules (workflow/compatibility/provider) remain shared, so behaviour is consistent across endpoints.
- Conversion router handles all Responses-specific transformations; LLMSwitch modules stay lean and schema-driven.
