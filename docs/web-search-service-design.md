# Server-side Web Search Tool – Design

## Goals

- Provide a single, server-side `web_search` tool that any provider/model can call as a normal function/tool.
- Use Virtual Router to pick which *search backend* (GLM / Gemini / others) actually performs web search.
- Keep the main model routing unchanged: normal routes decide the “brain” model; `web_search` only plugs in as a tool.
- Make search backends pluggable and config-driven; allow multiple engines with clear semantics (e.g. GLM vs Google/Gemini).

## High-level Architecture

### Roles

- **Main model**  
  - Selected by existing virtual router routes (`default`, `coding`, `longcontext`, …).  
  - Sees a standard `web_search` function tool in its `tools` list when search is enabled.  
  - Decides when to call `web_search` and with which arguments (including engine choice when multiple are exposed).

- **Server-side `web_search` tool**  
  - Implemented inside llmswitch-core / Hub Pipeline.  
  - Intercepts `web_search` tool calls from the main model and runs the actual web search via a *search backend*.  
  - Returns a normalized result payload back to the main model as a tool result (tool role / function_call_output).

- **Search backend(s)**  
  - One or more “search-capable” models, managed by Virtual Router:
    - v1: `glm.glm-4.7` (via GLM WebSearchToolSchema).  
    - Future: Gemini (`gemini-2.5-flash-lite`, `gemini-3-flash`, …).
  - Only used for the *secondary* “search” call, not as the main model for the user request.

### Routing Responsibilities

- **Main route (`chatRoute`)**  
  - Same as today: virtual router chooses providers for `/v1/chat/completions` / `/v1/responses` etc.
  - `web_search` does **not** override the main route or main provider/model.

- **Search intent route (`web_search` intent)**  
  - A separate “intent flag” carried in pipeline metadata, derived from classifier output based on **the latest user message** (text-only).  
  - Intent rules (substring match, not regex):
    - **Chinese – hard hits (100%):** `"谷歌搜索"`, `"谷歌一下"`, `"百度一下"` 一旦出现，即视为联网搜索意图；这三种说法都会被视为 “Google‑preferred”（优先尝试谷歌系搜索后端）。  
    - **Chinese – soft hits:**  
      - 包含 `"上网"` 视为联网搜索意图；  
      - 或者同时包含动词 {`"搜索"`, `"查找"`, `"搜"`} 与名词 {`"网络"`, `"联网"`, `"新闻"`, `"信息"`, `"报道"`} 中任意组合。  
    - **English – hard hits:** `"/search"`, `"web search"`, `"websearch"`, `"internet search"`, `"search the web"`, `"web-search"`, `"internet-search"` 等常见短语。  
    - **English – soft hits:** 当文本里同时包含动词 {`"search"`, `"find"`, `"look up"`, `"look for"`, `"google"`} 与名词 {`"web"`, `"internet"`, `"online"`, `"news"`, `"information"`, `"info"`, `"report"`, `"reports"`, `"article"`, `"articles"`} 时，也视为联网搜索意图；其中包含 `"google"` 时会被视为 “Google 优先”。  
  - Controls whether the server injects the `web_search` tool for the main model (and whether the intent is marked as “Google‑preferred” for engine filtering).

- **Search backend route (`routing.web_search`)**  
  - Dedicated VR route that lists search backend targets (e.g. `glm.glm-4.7`, later Gemini).  
  - Used only for the *secondary* search call, inside the server-side `web_search` tool implementation.
  - Not exposed as a direct model name to clients.

### Separation from existing `search`

- Existing “search files / code / knowledge base” behaviour currently wired via `websearch` routes should be:
  - Renamed to `search` (config + docs), as it is not “web search” but internal search.
  - Kept functionally identical (same providers/behaviour).
- New `web_search` is strictly *web* search:
  - Uses external search-capable models / services.
  - Implemented as a server-side tool that internally fans out to GLM / Gemini / others.

## Configuration Model

### Web Search Engines

At the virtual router / host config level, expose a compact `webSearch` section that enumerates available engines and how they map to providers:

```jsonc
{
  "webSearch": {
    "engines": [
      {
        "id": "glm",
        "providerKey": "glm.glm-4.7",
        "description": "GLM 4.7 – better for Chinese / domestic news",
        "default": true
      },
      {
        "id": "google",
        "providerKey": "antigravity.geetasamodgeetasamoda.gemini-3-flash",
        "description": "Gemini – broader global web coverage",
        "default": false
      }
    ],
    "injectPolicy": "selective" // or "always"
  }
}
```

Behaviour:

- `engines` may contain:
  - Only one engine → server can treat it as implicit default; `engine` argument becomes optional.
  - Multiple engines, no `default:true` → server does **not** choose for the model; instead, enumerates all engine ids and descriptions in the tool schema, so the main model can pick.
- `injectPolicy`:
  - `"selective"`: only inject `web_search` when the classifier detects web search intent (or a sticky flag is set).
  - `"always"`: whenever this route/provider is used, always inject `web_search` into `tools`.
- **Google‑preferred selection (中文 “谷歌搜索 / 谷歌一下”):**
  - When the intent classifier detects explicit “Google search” wording (e.g. 中文 `"谷歌搜索"`, `"谷歌一下"` or English text mentioning `"google"` together with search verbs), the server treats this as a **Google‑preferred** web search intent.
  - In Google‑preferred mode, the injected `web_search` tool’s `engine.enum` is **narrowed** to:
    - Engines whose `providerKey` is backed by Gemini CLI / Antigravity search backends (e.g. `gemini-cli.*`, `antigravity.*`); and
    - Engines whose `id` contains `"google"` (to support configs that encode Google in the id).  
  - If this filtered set is non‑empty, only these engines are exposed to the main model for this call. If the filtered set is empty, the server falls back to the full `engines` list.

### Search Backend Route

The actual “search backend” route is declared as:

```jsonc
{
  "virtualrouter": {
    "routing": {
      "web_search": [
        {
          "id": "web-search-backends",
          "priority": 200,
          "targets": [
            "glm.glm-4.7"
            // later: "antigravity.geetasamodgeetasamoda.gemini-3-flash", ...
          ]
        }
      ]
    }
  }
}
```

- This route is used only for the *secondary* search call from the server-side `web_search` tool.
- The mapping `engine.id → providerKey` is read from `webSearch.engines` and used to:
  - Validate that the configured engines are present in `routing.web_search`.
  - Find the correct backend when executing a web search.

## Server-side `web_search` Tool Schema

This is the unified tool presented to main models (OpenAI Chat / Responses shape):

```jsonc
{
  "type": "function",
  "function": {
    "name": "web_search",
    "description": "Perform web search for news and web pages using configured search engines.",
    "parameters": {
      "type": "object",
      "properties": {
        "engine": {
          "type": "string",
          "enum": ["glm", "google"], // generated from config.webSearch.engines
          "description": "Search engine id. For example: glm=better for Chinese/domestic information; google=better for global web coverage."
        },
        "query": {
          "type": "string",
          "description": "Search query or user question."
        },
        "recency": {
          "type": "string",
          "enum": ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"],
          "description": "Time range filter; maps to backend-specific recency options."
        },
        "count": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "description": "Number of results to retrieve."
        }
      },
      "required": ["query"]
    }
  }
}
```

Notes:

- If only one engine is configured:
  - `engine` can be omitted by the main model; the server uses the sole engine as default.
- If multiple engines are configured and no `default:true` is present:
  - The server does **not** pick an engine; it expects the main model to choose.

## Execution Flow

### 1. First request – main model

1. Client sends a standard `/v1/chat/completions` or `/v1/responses` request (no explicit `web_search` tool).
2. Hub Pipeline / Virtual Router:
   - Runs the normal route classifier to pick `chatRoute` and main provider/model (e.g. `tab.gpt-5.2-codex`).
   - Runs intent classification; if web search intent is detected (or `injectPolicy="always"`), it:
     - Marks metadata with `searchIntentRoute = 'web_search'`.
     - Appends the unified `web_search` function tool to `tools` for the main model.
3. Request is sent to the main provider with:
   - The chosen model (from `chatRoute`).
   - An augmented `tools` list containing `web_search`.

### 2. Main model emits `web_search` tool call

- The main provider responds with a function/tool call:

```jsonc
{
  "role": "assistant",
  "tool_calls": [
    {
      "id": "call_1",
      "type": "function",
      "function": {
        "name": "web_search",
        "arguments": "{\"engine\":\"glm\",\"query\":\"今天的国际新闻头条\",\"count\":3}"
      }
    }
  ]
}
```

- Hub Pipeline detects `function.name === "web_search"` and *intercepts* it as a server-side tool:
  - Parses `engine`, `query`, `recency`, `count` and validates against `webSearch.engines`.

### 3. Secondary request – search backend

- Based on the parsed `engine`:
  - Look up the selected engine in `config.webSearch.engines`.
  - Resolve its `providerKey` (e.g. `glm.glm-4.7`).
- A secondary request is constructed and sent via the internal pipeline:

```jsonc
{
  "route": "web_search", // search backend route
  "model": "glm.glm-4.7",
  "messages": [
    {
      "role": "user",
      "content": "今天的国际新闻头条"
    }
  ]
}
```

- For each backend family, compat will:
  - GLM: inject GLM’s `tools.web_search` schema (`type: "web_search"`, `web_search.search_engine`, `enable`, `search_result`, etc.) before sending upstream.
  - Gemini: use Gemini’s equivalent search-specific schema when we add it.

### 4. Backend response → tool result

- The search backend returns:
  - Answer text summarizing the news.
  - Backend-specific metadata (e.g. GLM `web_search` field with hits, URLs, publish dates, etc.).
- Server-side `web_search` handler:
  - Normalizes this response into a tool result JSON, e.g.:

```jsonc
{
  "summary": "<model-written summary>",
  "hits": [
    { "title": "...", "url": "...", "source": "...", "date": "..." },
    ...
  ],
  "engine": "glm"
}
```

- Wraps it as a tool result message associated with the original tool call id:

```jsonc
{
  "role": "tool",
  "tool_call_id": "call_1",
  "name": "web_search",
  "content": [
    {
      "type": "output_json",
      "output": { /* normalized result as above */ }
    }
  ]
}
```

### 5. Third request – back to the main model

- Hub constructs a new request to the *same* main provider:
  - `messages` = original messages + assistant tool_call + tool result (standard OpenAI tool-calling pattern).
- Main model receives the web_search result as if the client had executed the tool locally.
- Main model generates the final answer to the user.
- When the final assistant message has `finish_reason == "stop"`, the server:
  - Resets the “sticky web_search enabled” flag for this call chain.

## Sticky Behaviour

- During a single call chain (including tool calls and retries):
  - Once web search intent is detected, or a `web_search` tool call has occurred, the session is considered “web_search-enabled” for this chain.
  - Web search tools continue to be injected for the main model within this chain as needed.
- Reset:
  - When the final assistant response for the call has `finish_reason == "stop"`, the sticky state is reset.
  - A subsequent user turn may re-trigger web search injection based on intent and `injectPolicy`.

## Backends

### GLM (`glm.glm-4.7`)

- First production backend.
- Implementation details:
  - Maps canonical `web_search` parameters to GLM’s `web_search` schema:
    - `engine` → choice of GLM backend (if GLM exposes multiple search engines).
    - `query` → GLM prompt content.
    - `recency` / `count` → `web_search` fields (`search_recency_filter`, `count`, etc.).
  - Allows reading `web_search` field from GLM response and converting it into the normalized hit list.

### Gemini (future)

- Candidate models: `gemini-2.5-flash-lite`, `gemini-3-flash`, etc.
- Many Gemini models restrict tools to *search tools only*; we need to:
  - Ensure `web_search` backend requests use the correct Gemini schema and obey tool constraints.
  - Treat these models as pure web search engines in the backend pool.

## Summary of Changes vs. Current Behaviour

- Introduce a server-side `web_search` tool:
  - Main models see a standard function; actual web search execution runs via a separate search backend route.
- Split “search” responsibilities:
  - `search`: existing file/code/knowledge search (renamed from current websearch usage).
  - `web_search`: true web search via GLM/Gemini backends.
- Keep main routing unchanged:
  - Main provider selection remains fully owned by the existing Virtual Router route logic.
- Provide sticky but bounded web search capability:
  - Enabled per call chain; automatically reset when final `finish_reason == "stop"` is observed.
