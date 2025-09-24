# LM Studio Pipeline (HTTP) — Implementation & Usage

This document describes the standardized LM Studio pipeline implementation in RouteCodex using the HTTP provider, its layering, configuration, logging, and end‑to‑end usage including tool calling.

## Layers (RouteCodex)

- LLM Switch (openai-passthrough)
  - No opinionated logic; forwards OpenAI‑style requests
- Compatibility (lmstudio-compatibility)
  - Adapts OpenAI request/response to/from LM Studio REST API
  - Handles tool calling format (tools/function mapping)
- Provider (lmstudio-http)
  - Pure HTTP client to LM Studio REST (e.g., http://<host>:1234)
  - No transformation; reads `provider.config` only
- AI Service (LM Studio)
  - Executes models and parses tool calls into OpenAI response fields

## Standardization

- Provider type is `lmstudio-http` (REST). Base URL must be HTTP: `http://192.168.99.149:1234` (or your host)
- Compatibility module is `lmstudio-compatibility`; default rules include tools and message mapping
- LLM Switch is `openai-passthrough`
- Pipeline assembly carries `provider.auth` (apikey or empty) to provider

## Configuration

- User config is merged from:
  - `./config/config.json`
  - `~/.routecodex/config.json`
  - `~/.routecodex/config/*.json` (fragments)
- Arrays are merged via union (no destructive overwrite)
- Environment override: `LMSTUDIO_BASE_URL` supersedes provider baseURL

### Minimal fragment example (~/.routecodex/config/lmstudio.json)

```
{
  "virtualrouter": {
    "inputProtocol": "openai",
    "outputProtocol": "openai",
    "providers": {
      "lmstudio": {
        "type": "lmstudio",
        "baseURL": "http://192.168.99.149:1234",
        "apiKey": ["default"],
        "compatibility": { "type": "lmstudio-compatibility", "config": { "toolsEnabled": true } },
        "llmSwitch": { "type": "openai-passthrough", "config": {} },
        "workflow": { "type": "streaming-control", "enabled": true, "config": {} },
        "models": {
          "gpt-oss-20b-mlx": { "maxContext": 128000, "maxTokens": 4096 }
        }
      }
    },
    "routing": {
      "default": ["lmstudio.gpt-oss-20b-mlx.default"]
    }
  }
}
```

## Routing & Load Balancing

- Router attaches `routePools` from merged config
- For a route category (e.g., `default`), if multiple pipelines exist, they are chosen via round‑robin
- Single provider works out of the box; multiple LM Studio models are automatically balanced within the route category

## Debug & IO Logging

- PipelineDebugLogger publishes transformation/provider IO to DebugEventBus
- Your DebugCenter records per‑port sessions with operation input/output
- Server log also prints transformation stages (compatibility/workflow/llm‑switch) and provider timing

## End‑to‑End Tool Calling

- Request (OpenAI chat.completions) containing `tools` + `tool_choice: "auto"`
- LM Studio returns `finish_reason: "tool_calls"` with `choices[0].message.tool_calls[]`

### Example request

```
curl -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-oss-20b-mlx",
    "messages": [
      {"role":"system","content":"你可以调用工具来完成任务。"},
      {"role":"user","content":"请调用 echo 工具，并传参 {\"text\":\"hello-from-tool\"}"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "echo",
          "description": "Echo back text",
          "parameters": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }
        }
      }
    ],
    "tool_choice": "auto",
    "temperature": 0
  }' \
  http://127.0.0.1:<server-port>/v1/openai/chat/completions
```

### Expected response (excerpt)

```
{
  "choices": [
    {
      "message": {
        "tool_calls": [
          {
            "type": "function",
            "id": "256815796",
            "function": {
              "name": "echo",
              "arguments": "{\"text\":\"hello-from-tool\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

## Scripts

- Provider only: `scripts/test-lmstudio-http-provider.mjs`
- Compat + Provider: `scripts/test-lmstudio-compat-provider.mjs`
- Inspect session IO: `scripts/inspect-pipeline-io.mjs --port <port> --limit 5`

## Notes

- Provider is strictly HTTP (REST). No WS is used here
- If LM Studio requires auth, place `auth` under `provider.config`
- `LMSTUDIO_BASE_URL` can override baseURL during startup
