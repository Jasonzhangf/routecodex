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

## Built-in `gpt-5.6-*` catalog contract

Bare `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` are Codex catalog entries and must be listed even when provider config only exposes provider-prefixed aliases.

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
