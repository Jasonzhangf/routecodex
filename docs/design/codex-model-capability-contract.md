# Codex Model Capability Contract

## Purpose

Lock the Codex-facing `/v1/models` capability metadata that RouteCodex exposes for bare and provider-prefixed aliases.

Primary owner:
- `src/server/runtime/http-server/routes.ts`

Feature id:
- `server.models_capability_contract`

## Bare `gpt-5.5` contract

The bare `gpt-5.5` alias is a Codex compatibility surface, not a provider-specific runtime report.

Required stable fields:
- `apply_patch_tool_type = freeform`
- `web_search_tool_type = text_and_image`
- `supports_search_tool = true`
- `input_modalities = ["text", "image"]`
- `supports_image_detail_original = true`
- `supports_parallel_tool_calls = true`
- `supports_reasoning_summaries = true`
- `reasoning_summary_format = experimental`
- `default_reasoning_summary = none`
- `support_verbosity = true`
- `default_verbosity = low`
- `default_reasoning_level = medium`
- `supported_reasoning_levels = [low, medium, high, xhigh]`
- `shell_type = shell_command`
- `prefer_websockets = false`
- `minimal_client_version = 0.124.0`
- `context_window = 272000`
- `max_context_window = 272000`
- `effective_context_window_percent = 95`

Required descriptive fields:
- `description = "Frontier model for complex coding, research, and real-world work."`
- `supported_in_api = true`
- `visibility = list`

## Built-in catalog visibility contract

Bare Codex catalog entries are scoped by the current listener when `/v1/models` can resolve a
`routingPolicyGroup`.

- If the current port routes only to `gpt-5.5`, `/v1/models` must expose the bare `gpt-5.5`
  capability contract and must not expose `gpt-5.6-*` capability fields.
- If the current port routes to `gpt-5.6-sol`, `/v1/models` must expose the bare
  `gpt-5.6-sol` lite contract.
- If no port routing context is available, RouteCodex keeps the legacy full built-in catalog
  as a broad model discovery surface.

This visibility rule is a client capability switch. It prevents Codex from enabling
`gpt-5.6` Responses Lite / WebSocket-era behavior when the configured route surface is
actually `gpt-5.5`.

Authority selection is explicit, not a fallback chain:

- Installed/live servers use the compiled Virtual Router runtime status as the route-surface truth.
- Source-config projection is only for construction/test contexts where no live HubPipeline runtime
  status exists.
- If runtime status exists but is empty or malformed, `/v1/models` must not recover by reading
  source config as a second truth.

## Built-in `gpt-5.6-*` metadata contract

Shared stable fields:
- `apply_patch_tool_type = freeform`
- `web_search_tool_type = text_and_image`
- `supports_search_tool = true`
- `input_modalities = ["text", "image"]`
- `supports_image_detail_original = true`
- `supports_parallel_tool_calls = true`
- `default_reasoning_summary = none`
- `support_verbosity = true`
- `default_verbosity = low`
- `shell_type = shell_command`
- `tool_mode = code_mode_only`
- `use_responses_lite = true`
- `prefer_websockets = false`
- `minimal_client_version = 0.144.0`
- `context_window = 372000`
- `max_context_window = 372000`

Model-specific fields:
- `gpt-5.6-sol`: description `Latest frontier agentic coding model.`, `default_reasoning_level = low`, reasoning levels include `ultra`.
- `gpt-5.6-terra`: description `Balanced agentic coding model for everyday work.`, `default_reasoning_level = medium`, reasoning levels include `ultra`.
- `gpt-5.6-luna`: description `Fast and affordable agentic coding model.`, `default_reasoning_level = medium`, reasoning levels stop at `max`.

## Provider-prefixed alias contract

Provider-prefixed aliases such as `provider.gpt-5.5` or `provider.MiniMax-M3` inherit the same Codex capability-signaling metadata unless the field is explicitly runtime-derived.

Allowed runtime overrides:
- `context_window`
- `max_context_window`
- `supports_streaming`
- `description` when provider config supplies a concrete model description

Forbidden drift:
- tool exposure fields
- reasoning / verbosity fields
- input modality fields
- `prefer_websockets`
- `minimal_client_version`

## Why this exists

Codex client behavior depends on `/v1/models` metadata:
- image inputs use `input_modalities`
- `view_image` original-detail handling uses `supports_image_detail_original`
- reasoning and verbosity request fields use `supports_reasoning_summaries` / `support_verbosity`
- search tool exposure uses `supports_search_tool`
- context budgeting uses `context_window` / `max_context_window`

If these fields drift, RouteCodex can look healthy while Codex silently disables capabilities or budgets context incorrectly.

## Verification

Mandatory gate:
- `npm run verify:models-capability-contract`

Required test:
- `tests/server/http-server/routes.invalid-json.spec.ts`

Required positive/negative cases:
- port routes only `gpt-5.5` -> no `gpt-5.6-*`, no `use_responses_lite`
- port routes `gpt-5.6-sol` -> `gpt-5.6-sol` remains visible with `use_responses_lite = true`
- compiled runtime status conflicts with source config -> compiled runtime status wins and source
  config models are not exposed
