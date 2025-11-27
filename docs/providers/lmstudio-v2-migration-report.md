**Title**
- LM Studio → Provider V2 Migration Analysis

**Summary**
- Decision: Reuse `openai-standard` provider with a thin `lmstudio-compatibility` module. This aligns with V2 principles (minimal compatibility, no tool logic in provider) and leverages existing OpenAI‑compatible behavior of LM Studio.
- Scope: Chat Completions (`/v1/chat/completions`) supported out of the box; Responses (`/v1/responses`) can be enabled using the existing Responses profile + upstream SSE passthrough design, gated by configuration.

**Why This Approach**
- OpenAI compatibility: LM Studio implements OpenAI‑compatible endpoints and shapes (messages, tools, tool_calls, streaming), so OpenAI‑standard fits.
- Existing service profile: A dedicated `lmstudio` service profile exists and targets localhost defaults and OpenAI‑style endpoints (src/modules/pipeline/modules/provider/v2/config/service-profiles.ts:92).
- Minimal compatibility needs: Only small request/response shape adjustments are required (e.g., `tool_choice` normalization), which belong in Compatibility, not Provider.

**Provider Choice**
- Use `openai-standard` with `providerType: 'lmstudio'`.
  - Mapping is already defined: `CONFIG_MAPPINGS['lmstudio-provider-simple'] = 'openai-standard'` (src/modules/pipeline/modules/provider/v2/api/provider-config.ts:103-112).
  - LM Studio profile defaults:
    - Base URL: `http://localhost:${DEFAULT_CONFIG.LM_STUDIO_PORT}`
    - Endpoint: `/v1/chat/completions`
    - Headers: `Content-Type: application/json`
    - Location: src/modules/pipeline/modules/provider/v2/config/service-profiles.ts:92-103

**Compatibility Responsibilities**
- Keep compatibility minimal, provider‑agnostic, and confined to the Compatibility layer:
  - Normalize `tool_choice` to LM Studio’s expected strings when an OpenAI object is provided, forcing `'required'` in that case (src/modules/pipeline/modules/provider/v2/compatibility/lmstudio-compatibility.ts:76-85).
  - Preserve OpenAI tool shape (direct mapping of `tools` and `choices[].message.tool_calls`).
  - Maintain `object` values like `chat.completion` and `chat.completion.chunk` in responses.
- Do not duplicate llmswitch-core tool governance (canonicalization/harvest/repair) in Compatibility per AGENTS.md.

**API Surface Alignment**
- Chat Completions (`/v1/chat/completions`)
  - Requests: `model`, `messages`, `tools`, `tool_choice`, `stream`, `max_tokens`, `temperature`, etc. Direct mapping per transformation tables (docs/transformation-tables/claude-code-router-openai-to-lmstudio.json).
  - Responses: OpenAI‑shaped `choices[0].message.tool_calls` with `finish_reason: 'tool_calls'`. `object: 'chat.completion'` and streaming chunks `chat.completion.chunk` are preserved.
- Responses API (`/v1/responses`)
  - Supported via existing “Responses provider” design when needed. Upstream SSE passthrough can be enabled and paired with compatibility that does no destructive filtering of event streams. See docs/responses-passthrough-provider-design.md.

**Streaming**
- Chat Completions streaming uses standard OpenAI chunk format; `openai-standard` handles this consistently.
- For Responses SSE passthrough, use the dedicated `responses` profile with required headers (e.g., `OpenAI-Beta`) and tee/pipe handling. See service profiles and passthrough design docs.

**Error Handling**
- LM Studio error shapes can be treated as OpenAI‑style error objects; transformation table marks them as direct mappings (docs/transformation-tables/claude-code-router-openai-to-lmstudio.json).
- Follow Fail Fast: no hidden fallbacks in provider; only shape normalization in Compatibility.

**Config Blueprint**
- Provider V2 (OpenAI standard with LM Studio profile):
```
{
  "type": "openai-standard",
  "config": {
    "providerType": "lmstudio",
    "auth": { "type": "apikey", "apiKey": "local-dev" },
    "overrides": {
      "baseUrl": "http://localhost:1234",
      "endpoint": "/v1/chat/completions"
    }
  }
}
```
- Compatibility (minimal, auto‑inferred for providerType `lmstudio`):
```
{
  "type": "lmstudio-compatibility",
  "config": {
    "toolsEnabled": true
  }
}
```

**Key Implementation Notes**
- Provider
  - Reuse `openai-standard` end‑to‑end; select `ServiceProfile('lmstudio')` for defaults. No tool logic here.
  - For Responses passthrough, use the dedicated `responses` profile if routing `/v1/responses` to LM Studio’s OpenAI‑compatible Responses endpoint.
- Compatibility
  - Ensure LM Studio module is available and registered (type: `lmstudio-compatibility`). It performs only light normalization/mapping; notably `tool_choice` normalization (src/modules/pipeline/modules/provider/v2/compatibility/lmstudio-compatibility.ts:76-85) and direct mapping rules for tools/tool_calls.
  - Keep response `object` and tool call shapes intact (see same file, response rules section around id `tool-calls-response`).
- llmswitch-core
  - Tool canonicalization, harvesting from text, and argument repair remain centralized per AGENTS.md; do not reimplement in Compatibility/Provider.

**Validation Plan**
- Local dry‑runs and shape checks
  - Use `npm run test:lmstudio-dryrun` to validate tool call flows and response shapes.
  - Review prior LM Studio dry‑run docs for expected shapes (docs/lmstudio-dry-run-summary.md, docs/lmstudio-tool-calling.md).
- Snapshots & SSE
  - Enable upstream SSE passthrough when validating `/v1/responses`; verify event integrity and headers.
- Compatibility integrity
  - Confirm that `tool_choice` object inputs become `'required'` and result in `finish_reason: 'tool_calls'` when tools are selected.

**Open Items / Risks**
- Responses header/versioning: Confirm current `OpenAI-Beta` header value when targeting `/v1/responses` upstream.
- Auth expectations: LM Studio local deployments often accept requests without Authorization; retaining an API key header is typically harmless, but confirm server configuration.
- Compatibility registration: Ensure `lmstudio-compatibility` type is registered with `CompatibilityModuleFactory` if created via type string.

**References**
- `src/modules/pipeline/modules/provider/v2/api/provider-config.ts:103` — maps `lmstudio-provider-simple` to `openai-standard`.
- `src/modules/pipeline/modules/provider/v2/config/service-profiles.ts:92` — LM Studio service profile defaults.
- `src/modules/pipeline/modules/provider/v2/compatibility/lmstudio-compatibility.ts:76` — `tool_choice` normalization logic.
- `docs/lmstudio-tool-calling.md:1` — LM Studio tool calling shape and examples.
- `docs/transformation-tables/claude-code-router-openai-to-lmstudio.json:1` — direct mappings for OpenAI↔LM Studio.
- `docs/responses-passthrough-provider-design.md:3` — Responses SSE passthrough design.

**Conclusion**
- Answer to Q1: Yes — reuse `openai-standard` with `lmstudio-compatibility`. This yields minimal, standards‑aligned integration under Provider V2, keeps tool governance centralized in llmswitch‑core, and supports both Chat Completions and Responses with straightforward configuration.

