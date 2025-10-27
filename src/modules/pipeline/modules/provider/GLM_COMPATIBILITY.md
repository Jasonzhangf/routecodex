GLM Compatibility Mapping (Requests/Responses)

Overview
- Goal: Interpret GLM chat API precisely in the provider compatibility layer, and convert to OpenAI Chat standard before handing off to workflow → llmswitch.
- Scope: Non-OpenAI endpoints (e.g., open.bigmodel.cn) detected as GLM; apply request and response mappers; preserve original semantics without losing fields.

Activation
- GLM compatibility is enabled only when explicitly configured:
  - provider.config.compatibility.provider === 'glm'
  - No domain-based auto-detection.

Endpoint
- GLM endpoint: /paas/v4/chat/completions
- OpenAI endpoint (others): /v1/chat/completions

Request Mapping (OpenAI → GLM)
- messages
  - Ensure content is string or null.
  - If role === 'assistant' and message has tool_calls → set content = null (GLM expects null on tool call turns).
  - If content is array → flatten textual parts and join with newlines.
- passthrough
  - model, stream, temperature, top_p, max_tokens
  - tools, tool_choice, stop, response_format
  - request_id, user_id (if provided by the client)
- Important
  - We do not inject or synthesize tool_calls into the request; GLM uses tools param + model decision.

Response Mapping (GLM → OpenAI)
- created
  - GLM uses created or created_at (seconds). We map created_at → created when created is absent.
- choices[].message
  - Keep role (default assistant).
  - Keep content as null when tool_calls exist (do not coerce to empty string).
  - tool_calls[].function.arguments: GLM returns an object; convert to JSON string for OpenAI compatibility.
- usage
  - Map output_tokens → completion_tokens if completion_tokens is absent.
  - Keep prompt_tokens_details.cached_tokens when present.
- finish_reason
  - Preserve GLM values; OpenAI consumers use stop/length/tool_calls primarily.
- Extra objects (e.g., mcp, video_result, web_search, content_filter)
  - Preserve when present; they are left in the message or top-level payload for downstream consumers.

Streaming (SSE)
- SSE handling remains provider-agnostic and follows the standard OpenAI protocol in the higher-level streaming manager.
- The compatibility layer does not inject provider-specific SSE translations here.

Rationale
- Placing GLM compatibility in the provider layer ensures workflow and llmswitch always see OpenAI Chat standard inputs/outputs, simplifying downstream logic.

File Locations
- Mapper functions implemented in:
  - src/modules/pipeline/modules/provider/openai-provider.ts
    - mapOpenAIToGLMRequest(req)
    - mapGLMToOpenAIResponse(resp)
  - GLM endpoint routing decided in sendRequest() for non-OpenAI baseURL.

Limitations / Notes
- We do not alter the client’s tools schema definitions; strictness remains enforced by the model/tooling.
- We do not synthesize missing tool arguments; upstream prompts should ensure valid argument structures.
- If your client expects GLM-specific fields (e.g., mcp output), verify they are present after mapping; we preserve them as-is.
