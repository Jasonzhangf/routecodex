Responses Debug Client (SSE + Tool Loop)

Purpose
- Minimal client to debug OpenAI Responses API through your RCC server.
- Starts with SSE event consumption, then completes a basic tool-calls loop.

Run
- npm run debug:responses -- --file scripts/tools-dev/responses-debug-client/payloads/text.json
- npm run debug:responses -- --file scripts/tools-dev/responses-debug-client/payloads/tool.json

Options
- --file <path>       Required. JSON request payload (Responses shape)
- --baseURL <url>     Default http://127.0.0.1:5520/v1
- --apiKey <key>      Default dummy
- --timeout <sec>     Default 120
- --raw               Print raw events (default off)
- --save              Save JSONL to logs/ (default off)
- --maxRounds <n>     Tool rounds limit (default 3)

Notes
- Only Responses payloads are supported (no Chat conversion).
- Listens to named SSE events (response.output_text.delta, etc.).
- Implements minimal local tools: echo, sum, time.
