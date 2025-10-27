Codex Examples

This folder contains minimal, categorized examples for testing RouteCodex entrypoints.

Structure
- openai-chat/    Examples for POST /v1/chat/completions
- openai-responses/  Examples for POST /v1/responses (reserved)
- anthropic-messages/ Examples for POST /v1/messages (reserved)

Notes
- Tools are defined per‑entrypoint payload. For the shell tool, the description and schema nudge the model to place ALL flags/paths/patterns into the `command` argv array and avoid extra keys.
- Each example includes a ready‑to‑run curl script (non‑stream), with `tool_choice` targeting a single function to guarantee a tool hit.

