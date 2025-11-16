## OpenAI Responses 通信样本（FC upstream）

本节记录当前已经验证 **可以和 `https://www.fakercode.top/v1/responses` 正常通信** 的典型请求形状，方便后续实现 Responses provider 和 llmswitch-core 路由时参考。

> 真实原始样本快照文件（已有）：  
> `~/.routecodex/codex-samples/openai-responses/req_req-v2-1763210807098-758t06r1s_request_1_validation_pre.json`  
> 其中 `data.originalData` 即为发送给 FC 的完整请求体。

### 1. 已验证成功的请求形状（摘要）

核心字段结构如下（去掉了大段系统提示与对话文本，只保留结构）：

```jsonc
{
  "model": "gpt-5.1",
  "instructions": "（一段较长的系统说明，定义 Codex CLI 能力与工作模式……）",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "……用户提问 1……" }
      ]
    },
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "……用户提问 2……" }
      ]
    }
    // 若干 user message，全部使用 type=message + content[].type=input_text
  ],
  "tools": [
    {
      "type": "function",
      "name": "shell",
      "description": "Runs a shell command and returns its output.",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "command": { "type": "array", "items": { "type": "string" } },
          "justification": { "type": "string" },
          "timeout_ms": { "type": "number" },
          "with_escalated_permissions": { "type": "boolean" },
          "workdir": { "type": "string" }
        },
        "required": ["command"],
        "additionalProperties": false
      }
    },
    {
      "type": "function",
      "name": "list_mcp_resources",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "cursor": { "type": "string" },
          "server": { "type": "string" }
        },
        "additionalProperties": false
      }
    },
    {
      "type": "function",
      "name": "read_mcp_resource",
      "strict": false,
      "parameters": {
        "type": "object",
        "properties": {
          "server": { "type": "string" },
          "uri": { "type": "string" }
        },
        "required": ["server", "uri"],
        "additionalProperties": false
      }
    }
    // 其余 MCP / update_plan / view_image / mcp__chrome-devtools__* 等函数工具……
  ],
  "metadata": {
    "level": "normal",
    "hookCount": 1,
    "successCount": 1,
    "errorCount": 0
  },
  "stream": true
}
```

关键结论：

- **模型**：当前推荐使用 `model: "gpt-5.1"`（历史快照中为 `gpt-5`，但通过 Responses SDK 直接回放同一 payload、仅替换模型为 `gpt-5.1`，FC 端同样可以正常工作）。  
- **instructions 必须存在且较长**：包含系统级 persona 与行为约束；直接省略 instructions 的简化请求在 FC 侧返回 400。  
- **input 必须是 Responses 规范的 `type: "message"` + `content[].type: "input_text"` 结构，而不是简化版 `messages[]`。  
- **tools 可以是完整的 Codex 工具集合**（shell + MCP + view_image + chrome-devtools 等），FC 能接受并返回正常响应。  
- **metadata 可以保留 RouteCodex 自己的统计字段**，对上游兼容无明显影响。  
- **stream=true + SSE**：该请求在 FC 上下游是以 Responses SSE 事件流的形式返回（`response.created` / `response.output_text.delta` / `response.completed` 等事件）。

### 2. 失败的简化请求形状（对比）

在本仓库中使用 `scripts/fc-responses-tool-loop.mjs` 进行了多次实验：

- 仅包含 `model + input[ { role, content[input_text] } ] + stream` 的最简 SSE 请求 → **400 `openai_error`**。  
- 在最简请求中补充 `instructions` 与简单 `tools`（单个 echo 工具） → 仍然 **400 `openai_error`**。  

结论：  
目前 FC 的 `/v1/responses` 接口更接近“完整 Codex Responses 负载”的使用方式，对字段组合/shape 较敏感；**简单缩减字段容易 400**。因此：

- 调试 / 文档中应优先使用已验证的完整样本形状；  
- 如需精简，请务必通过快照 + 对比方式逐步删减字段，每删一类字段都重新验证 FC 是否仍返回 2xx。

### 3. 通过 Responses SDK 回放快照（SSE 事件形状）

使用 `scripts/fc-responses-from-snapshot.mjs` 可直接读取上述快照的 `originalData`，经 OpenAI Responses SDK 调用 FC `/v1/responses`：

```bash
FC_API_KEY=... FC_MODEL=gpt-5.1 \
node scripts/fc-responses-from-snapshot.mjs \
  ~/.routecodex/codex-samples/openai-responses/req_req-v2-1763210807098-758t06r1s_request_1_validation_pre.json
```

在成功场景下，SDK 报告的事件分布如下（节选）：

```jsonc
{
  "response.created": 1,
  "response.in_progress": 1,
  "response.output_item.added": 2,
  "response.reasoning_summary_part.added": 3,
  "response.reasoning_summary_text.delta": 329,
  "response.reasoning_summary_text.done": 3,
  "response.reasoning_summary_part.done": 3,
  "response.output_item.done": 2,
  "response.function_call_arguments.delta": 73,
  "response.function_call_arguments.done": 1,
  "response.completed": 1
}
```

说明：

- FC 在 Responses wire 上使用的是 **标准 `response.*` 事件族**，包含 reasoning 与 function_call_arguments 相关事件；  
- monitor / provider 在做直通时，必须完整透传这些事件，而不能只假定存在 `response.output_text.delta`；  
- 该事件分布可作为后续设计 `responses-standard` provider 与 llmswitch-core SSE 直通逻辑时的“金标准”参考。

### 4. 与 RouteCodex / llmswitch-core 的关系

- 通过 `routecodex monitor` + `monitor.json.transparent.wireApi = "responses"`，当前 monitor 路径会把 Codex 客户端产生的完整 Responses JSON **原样透传**到 FC `/v1/responses`，并在本地记录快照：  
  - `http-request` / `http-request.parsed` / `monitor.upstream-request` / `monitor.upstream-response` / `monitor.http-response`。  
- 这类样本为后续实现 **Responses provider + llmswitch-core responses 直通路由** 提供了可靠的“金标准负载”，后续设计将以此为基线，不再依赖简化/猜测字段。
