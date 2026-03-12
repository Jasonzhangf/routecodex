# ServerTool 框架设计与使用指南

ServerTool 是 llmswitch-core 内部的「服务端工具统一框架」，用于在 Hub Pipeline 的响应侧，统一执行 web_search、vision followup 等“由服务端发起的二跳/三跳工具调用”，并对客户端保持透明。

目标：

- 一套通用骨架，支持多个 server-side 工具（web_search、vision 等）并行扩展；
- 所有工具逻辑都在 llmswitch-core 内部完成，Host / Provider 层只负责 HTTP 运输和 OAuth；
- 工具的二跳/三跳始终走 Hub Pipeline + Virtual Router，不绕过路由或工具治理。

## 总体架构

ServerTool 以 ChatEnvelope 为核心，在响应链路中挂接：

```text
Provider 响应 (各协议)
    │
    ▼
RespInbound (SSE → JSON → Chat)
    │
    ▼
ChatResponse (canonical)
    │
    ├─► ServerTool 引擎 (servertool/engine.ts + servertool/server-side-tools.ts)
    │      - 解析 tool_calls / 自动触发工具
    │      - 调用具体 handler（web_search、vision 等）
    │      - 如需要，发起二跳/三跳（通过 reenterPipeline）
    │
    ▼
ChatResponse'（带 tool_outputs 或跟进答案）
    │
    ▼
RespProcess / RespOutbound → 客户端协议 (Chat/Responses/Anthropic)
```

补充：`continue_execution` 的 tool_call 对客户端必须透明。为避免客户端收到该工具调用（会被判定 unsupported），
响应侧在 `resp_process_stage2_finalize` 统一剥离 `continue_execution` 的 tool_call，且将对应 choice 的
`finish_reason` 从 `tool_calls` 修正为 `stop`。该处理是全协议唯一入口，不在 Host/Provider 层兜底。

Host 侧只需提供：

- `providerInvoker`：给定 providerKey + payload，调用 Provider runtime 并返回 JSON；
- `reenterPipeline`：把新的请求体重新送入 HubPipeline（标准入口），用于二跳/三跳；
- AdapterContext 中的辅助信息：`routeId`、`webSearch` 配置、`capturedChatRequest` 等。

## 核心模块

### 类型与注册表

文件：`src/servertool/types.ts`、`src/servertool/registry.ts`

- `ProviderInvoker`：由 Host 注入的抽象调用器，仅描述“给哪个 providerKey / 协议发送哪段 JSON”。
- `ServerSideToolEngineOptions`：ServerTool 引擎入参（基于 ChatCompletion JSON + AdapterContext）。
- `ServerToolExecution`：单个工具执行的结果形态：
  - `flowId`: 工具流标识（如 `web_search_flow` / `vision_flow`）；
  - `followup?`: 可选第三跳计划，包含 `requestIdSuffix`、`payload` 和附加 `metadata`。
- `ServerToolHandlerContext`：传给 handler 的上下文，包含：
  - `base`: 原始 ChatCompletion payload；
  - `toolCalls`: 当前响应中的所有 tool_call 列表；
  - `toolCall?`: 具体命中的某个 tool_call（仅对 `trigger: 'tool_call'` 的 handler）；
  - `adapterContext`: 当前请求的 AdapterContext（含 routeId/webSearch/capturedChatRequest 等）；
  - `options`: 同 ServerSideToolEngineOptions。
- `ServerToolHandler` / `ServerToolHandlerResult`：统一的 handler 接口：
  - 返回值中必须包含 `chatResponse`（经过 handler 处理后的 ChatCompletion），以及 `execution`（flowId + 可选 followup）。

注册表：

- `registerServerToolHandler(name, handler, { trigger })`
  - `name`: 工具名（如 `web_search` / `vision_auto`），在内部会统一转小写；
  - `trigger`: `'tool_call' | 'auto'`：
    - `'tool_call'`: 仅当响应中存在匹配 name 的 tool_call 时触发；
    - `'auto'`: 不依赖 tool_call，按 handler 自己的条件自动触发（如 vision followup）。
- `getServerToolHandler(name)` / `listAutoServerToolHandlers()`：供引擎按名称/触发模式查找 handler。

### 引擎与 orchestration

文件：`src/servertool/server-side-tools.ts`、`src/servertool/engine.ts`

1. `runServerSideToolEngine(options: ServerSideToolEngineOptions)`

   - 从 `chatResponse.choices[].message.tool_calls` 中抽取标准化 ToolCall 列表；
   - 构造 `ServerToolHandlerContext`：`base + toolCalls + adapterContext + options`；
   - 先按工具调用触发：
     - 遍历 `toolCalls`，对每个 `name` 查找 `trigger='tool_call'` 的 handler；
     - 若某个 handler 返回非空结果，立即视为当前工具流已生效，返回 `{ mode: 'tool_flow', finalChatResponse, execution }`；
   - 若没有 ToolCall handler 生效，再遍历所有 `trigger='auto'` 的 handler：
     - 例如 vision followup：在捕获到图像附件时自动触发；
   - 若没有任何 handler 生效，则返回 `{ mode: 'passthrough', finalChatResponse: base }`。

2. `runServerToolOrchestration(options: ServerToolOrchestrationOptions)`

   - 在响应侧（`convertProviderResponse` 内）调用，入参是 ChatEnvelope payload + AdapterContext：
     - 构造 `ServerSideToolEngineOptions`，调用 `runServerSideToolEngine(...)`；
     - 若 `mode='passthrough'` 或没有 `execution`，直接返回 `{ executed: false, chat }`；
     - 若有 `execution` 但缺少 `followup` 或 Host 未提供 `reenterPipeline`，直接把 `finalChatResponse` 作为最终结果返回（保持原有二跳行为）；
     - 若存在 `followup` 且可使用 `reenterPipeline`：
       - 基于 `execution.flowId` 和 AdapterContext.routeId 计算 routeHint（避免回到工具路由本身）；
       - 统一在 metadata 中注入 `serverToolFollowup: true` 和 `stream: false`，保证第三跳在 Hub 内部使用非流式 JSON；
       - 调用 `reenterPipeline({ entryEndpoint: '/v1/chat/completions', requestId: <原ID+suffix>, body, metadata })`；
       - 返回第三跳得到的 ChatCompletion 作为 orchestration 结果。

### 已实现的内建工具

当前内建两个 ServerTool handler：

- `web_search`：服务端搜索工具，执行外部 web search 并注入虚拟工具结果；
- `vision_auto`：自动 vision followup，将图像模型的分析结果注入到原始对话并发起第三跳。

#### web_search handler

文件：`src/servertool/handlers/web-search.ts`

行为：

- 触发条件：
  - 只有当响应中存在 `tool_calls[].function.name === 'web_search'`，且环境/config 允许，才会触发；
  - 环境开关：`ROUTECODEX_SERVER_SIDE_TOOLS` / `RCC_SERVER_SIDE_TOOLS` 设为 `1/true/yes/web_search`；
  - 配置开关：Virtual Router 中存在 `virtualrouter.webSearch.engines`（详见下文配置章节）。
- 输入解析：
  - 从 tool_call.arguments 中解析：`query`（必填）、`engine`（选填）、`recency`（选填）、`count`（选填）；
  - 优先选择 arguments.engine 对应的搜索引擎，否则按 `default: true` 选中 engine；
  - 若既无 engine 参数，又无默认 engine，则回退为 engine 列表顺序。
- 多引擎 + 回退策略：
  - 引擎列表来自 `virtualrouter.webSearch.engines`，按以下规则生成优先级队列：
    - 1) `resolveWebSearchEngine(config, engineId)` 找到的 engine（arguments.engine 或 default）；
    - 2) 其余引擎按配置顺序追加；
  - 按优先级依次尝试每个 engine：
    - 调用 `executeWebSearchBackend(...)`，尝试拉取搜索结果；
    - 若返回 `ok === true`，立即选用该引擎并终止回退；
    - 若 `ok === false`（如 HTTP 失败、内容过滤等），继续尝试下一个引擎；
  - 若所有引擎均 `ok === false`，最终使用最后一次失败的结果作为工具输出（向用户解释错误原因和重试建议）。
- 后端调用路径：
  - 优先使用 Host 提供的 `reenterPipeline`：
    - 构造标准 Chat payload：`model = engine.id`，system + user 消息中描述“你是 web search 引擎”；
    - 对 GLM / OpenAI 兼容后端：在根上附加 `web_search` 字段（query/recency/count/engine），由对应 compat profile 转为上游 schema；
    - 对 Gemini / Cloud Code Search 后端：根上不附加 `web_search`，由 compat 在 `web_search` 路由下自动挂接 `tools: [{ googleSearch: {} }]`；
    - metadata 中携带 `routeHint: 'web_search'` + `serverToolFollowup: true`，保证二跳走 web_search 路由且在内部使用非流式 JSON；
  - 若 Host 未提供 `reenterPipeline`，则回退使用 `providerInvoker`，直接调用 Provider runtime：
    - Gemini：构造 `contents + tools: [{ googleSearch: {} }]` 的原生 payload；
    - 其他后端：构造 Chat + 顶层 `web_search` 字段，依靠 compat 注入工具 schema。
- 结果归一化：
  - 从后端响应中抽取 `summary` 文本（优先使用 Chat choices 内容，fallback 到 GLM `web_search[]` 数组）；
  - 尝试提取结构化 hits（title/link/media/publish_date/content/refer），形成 `results[]`；
  - 将结果写回首跳 ChatCompletion 的 `tool_outputs`：
    ```jsonc
    {
      "tool_call_id": "<原始 web_search tool_call.id>",
      "name": "web_search",
      "content": "{ \"engine\": \"<engine.id>\", \"query\": \"...\", \"summary\": \"...\", \"results\": [ ... ] }"
    }
    ```
  - 再通过 `buildWebSearchFollowupPayload(...)` 将 `tool_outputs` 转换为标准的 `role: "tool"` 消息，连同原始 messages 一起构成第三跳请求体。

配置示例：

```jsonc
{
  "virtualrouter": {
    "routing": {
      "web_search": [
        {
          "id": "web_search-primary",
          "priority": 200,
          "targets": [
            "gemini-cli.gemini-2.5-flash-lite",
            "glm.glm-4.7"
          ]
        }
      ]
    },
    "webSearch": {
      "engines": [
        {
          "id": "gemini-2.5-flash-lite",
          "providerKey": "gemini-cli.gemini-2.5-flash-lite",
          "description": "Google Search via Gemini 2.5 Flash Lite",
          "default": true
        },
        {
          "id": "glm-4.7",
          "providerKey": "glm.glm-4.7",
          "description": "GLM 4.7 web search backend"
        }
      ],
      "injectPolicy": "selective",
      "force": true
    }
  }
}
```

上例中，web_search 工具会：

- 首先尝试 `gemini-2.5-flash-lite`（Google Search）；
- 若该后端出错，则回退到 `glm-4.7`；
- 若全部失败，则仍返回最后一次失败的错误说明。

**ServerTool 感知的 Provider 级路由控制**

- Virtual Router 支持在 Provider 级声明「此 Provider 不参与 ServerTool 流程」：

  ```jsonc
  {
    "virtualrouter": {
      "providers": {
        "tab": {
          "id": "tab",
          "type": "responses",
          "endpoint": "https://api.tabcode.cc/openai",
          "serverToolsDisabled": true,
          "auth": { "type": "apikey", "apiKey": "YOUR_API_KEY" },
          "models": { "gpt-5.2-codex": {} }
        }
      }
    }
  }
  ```

  - 也支持 `serverTools: { "enabled": false }` 的等价写法。
- 当请求在 Hub Process 阶段被注入 web_search 工具时，StandardizedRequest.metadata 上会打上 `webSearchEnabled: true` 标记；
- Hub Pipeline 在调用 Virtual Router 时，会将 `serverToolRequired: true` 写入路由 metadata；
- VirtualRouterEngine 在该标记为 `true` 时，会跳过所有 `serverToolsDisabled: true` 的 Provider，只在同一池子的其余 Provider 中做健康检查与负载均衡；
- 普通对话（未注入 ServerTool）仍然可以命中这些 Provider，不受影响。

#### vision_auto handler

文件：`src/servertool/handlers/vision.ts`

行为：

- 触发模式：`trigger: 'auto'`，不依赖 tool_call，由 handler 根据 AdapterContext 决定是否执行：
  - 当 `adapterContext.hasImageAttachment === true` 且非 `serverToolFollowup` 时触发；
  - 避免在 vision flow 内部形成循环。
- 流程：
  1. 从 AdapterContext 中读取 `capturedChatRequest`（首跳请求快照），构造「图像分析」 payload：
     - 保留原始 model/messages/tools/parameters 等字段；
  2. 使用 `reenterPipeline` 发起第二跳：
     - 固定 `entryEndpoint: '/v1/chat/completions'`；
     - metadata 中携带 `routeHint: 'vision'` + `serverToolFollowup: true` + `stream: false`；
  3. 从第二跳响应中提取图像摘要文本（使用通用的 `extractTextFromChatLike`）；
  4. 在原始对话 messages 中注入 `[Vision] <summary>`：
     - 优先替换含 image 内容的消息，将图片 part 替换为 text；
     - 若找不到合适位置，则附加到最近的 user 消息或新增 system 消息；
  5. 发起第三跳：
     - `entryEndpoint: '/v1/chat/completions'`；
     - payload 使用注入完 vision summary 的 messages；
     - metadata 中携带 `serverToolFollowup: true`，并复用原有 routeId 作为 routeHint（若 routeId 本身就是 vision 则跳过）。

最终，客户端看到的仍然只有一次 Chat/Responses 调用，而内部已经完成了“图像分析 + 带 summary 的追问”的两跳流程。

## 如何添加新的 ServerTool 工具

添加新的 server-side 工具通常分为三步：

1. **定义 handler**（建议放在 `src/servertool/handlers/<name>.ts`）

   - 引入必要类型：

     ```ts
     import type { JsonObject } from '../conversion/hub/types/json.js';
     import type { ServerToolHandler, ServerToolHandlerContext, ServerToolHandlerResult } from '../types.js';
     import { registerServerToolHandler } from '../registry.js';
     ```

   - 实现 `ServerToolHandler`：

     - 对于需要 tool_call 触发的工具：

       ```ts
       const handler: ServerToolHandler = async (ctx): Promise<ServerToolHandlerResult | null> => {
         const toolCall = ctx.toolCall;
         if (!toolCall) return null;

         // 1. 解析 arguments / 配置 / AdapterContext
         // 2. 使用 ctx.options.reenterPipeline 或 ctx.options.providerInvoker 调用后端
         // 3. 生成新的 chatResponse（可以在 base 上注入 tool_outputs、messages 等）
         // 4. 如需第三跳，构造 followup payload + metadata，并返回 execution.flowId + followup

         return {
           chatResponse: nextChatResponse,
           execution: {
             flowId: 'my_tool_flow',
             followup: {
               requestIdSuffix: ':my_tool_followup',
               payload: followupPayload,
               metadata: { routeHint: 'my_route' } as JsonObject
             }
           }
         };
       };

       registerServerToolHandler('my_tool', handler);
       ```

     - 对于自动触发的工具（类似 vision）：

       ```ts
       const handler: ServerToolHandler = async (ctx) => {
         if (!shouldRunMyTool(ctx)) return null;
         // ...
         return { chatResponse: ctx.base, execution };
       };

       registerServerToolHandler('my_tool_auto', handler, { trigger: 'auto' });
       ```

2. **确保 handler 文件被加载**

   - 在 `src/servertool/server-side-tools.ts` 中引入新 handler 文件：

     ```ts
     import './handlers/web-search.js';
     import './handlers/vision.js';
     import './handlers/my-tool.js';
     ```

   - 只要模块被加载，`registerServerToolHandler` 就会被执行，工具即自动挂载到 ServerTool 框架。

3. **按需扩展配置/compat**

   - 如需从 Virtual Router 配置驱动工具行为（类似 web_search）：
     - 在 `VirtualRouterConfig` 中增加相应配置字段（例如 `virtualrouter.myTool`）；
     - 在 Hub Pipeline 中把该配置挂入 AdapterContext（例如 metadata.myTool → adapterContext.myTool）；
     - 在 handler 中从 `ctx.adapterContext` 中读取配置。
   - 如需对特定 provider 协议做 shape 调整：
     - 在 `conversion/compat/actions/` 中增加新的 compat action，并在对应 profile（如 `chat:gemini`）中挂载。

## Host 层集成要点

Host 侧不需要也不应该理解具体工具语义，只需：

- 在 HTTP server / CLI 中为 llmswitch-core 的响应侧调用提供：
  - `providerInvoker(options)`：将 providerKey + payload 转给 Provider runtime；
  - `reenterPipeline(options)`：允许 llmswitch-core 在内部再次走 HubPipeline；
  - AdapterContext 元数据：`routeId`、`webSearch` 配置、`capturedChatRequest` 等；
  - 标记 `serverToolFollowup`，避免 ServerTool 在二跳/三跳中反复触发。

所有 ServerTool 工具（包括 web_search / vision / 自定义工具）都应通过上述机制接入，避免在 Host/Provider 层硬编码工具调用逻辑或直接发 HTTP 请求。***
