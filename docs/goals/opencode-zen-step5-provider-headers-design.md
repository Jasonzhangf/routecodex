# OpenCode Zen Step 5 provider headers

## Contract

The client sends the same OpenAI Chat Completions body shape that passed the authenticated direct curl: `stream: true`, the actual `bash` and `read` tool definitions, `reasoning_effort: low`, and an account credential resolved by RCC. The adapter preserves that body and the selected `step-5-preview-free` wire model. It does not synthesize tools, change streaming, or select a fallback.

## First divergence and owners

The configured provider `headers` already compile into `V3ResponsesProviderTarget.headers`. The OpenAI Chat builder in `provider_compat_shared.rs` drops that map when it builds the typed transport request. The Provider-owned `ProviderResponsesTransport::send_http` then applies configured headers only for Anthropic requests. The same selected target therefore has its configured headers in dry-run projection but not on an OpenAI Chat HTTP request.

The free tier additionally rejects static `x-opencode-session` / `x-opencode-request` placeholders. The upstream OpenCode client derives both identifiers per attempt: `x-opencode-session` uses `Identifier.descending` (`ses_` + inverted 12-hex timestamp + 14 base62 chars) and `x-opencode-request` uses `Identifier.ascending` (`msg_` + ascending 12-hex timestamp + 14 base62 chars). A configured constant is therefore wrong even when the header carrier works.

The minimal fix reuses the existing target-to-transport carrier and generic HTTP send owner:

1. The Runtime OpenAI Chat transport builder converts `target.headers` into `V3ProviderRequestHeader` values and places them on the existing transport request.
2. Provider authoring validation rejects a configured header named `authorization` after trimming, case-insensitively. Provider HTTP send applies the remaining configured headers to non-Anthropic HTTP requests. Anthropic continues using its existing compatibility path. The resolved provider secret remains the sole source of the wire `Authorization` header.
3. Provider request projections redact configured header values. Names remain visible for diagnosis. This prevents arbitrary provider header values from entering dry-run/debug artifacts; transport still sends the original values.
4. The shared helper `stamp_opencode_zen_dynamic_request_headers` rewrites `x-opencode-session` and `x-opencode-request` with fresh schema-encoded identifiers at the transport-attempt boundary. It applies only to `provider_type == "openai_chat"` with compatibility profile `chat:opencode-zen-tcm`, deletes any configured placeholder first, and changes neither the body nor the wire model. Both the business transport builder and the startup probe call the same helper, so probes never carry a stale placeholder. Identifier state stays in control-space (an atomic counter plus the clock); no value is read from or written to the business payload.

The graph starts at the already compiled and selected Target/wire request. Config compilation and target selection remain with their existing owners. No Hub node, edge, protocol, body conversion, model binding, or retry behavior changes. The Provider transport remains generic and does not branch on provider ID. A successful raw provider response returns to the existing Runtime response projector. HTTP/transport failures enter the existing typed Error/recovery chain and never project as a successful payload. Cancellation or client disconnect terminates the attempt as the existing cancellation outcome. Reselection, exhaustion, and client transport behavior remain owned by existing Runtime/Error nodes; this feature does not alter them.

## Verification contract

- Runtime builder test: selected target headers reach the typed OpenAI Chat transport request, and the `chat:opencode-zen-tcm` profile replaces static `x-opencode-session` / `x-opencode-request` placeholders with values matching the `ses_`/`msg_` 12-hex + 14-base62 shape. A non-OpenCode profile and a non-Chat protocol leave the configured values untouched.
- Identifier helper test: ascending and descending encodings differ and are exact complements; consecutive `stamp` calls produce distinct session and request values.
- Probe builder test: an OpenCode Zen probe request carries generated identifiers rather than the configured placeholder.
- Provider transport loopback test: configured `x-opencode-*` headers reach the actual HTTP wire and the request contains exactly the secret-derived Bearer authorization; body and stream intent remain unchanged. Provider request projection shows header names and redacted values.
- Provider authoring test: an `Authorization` entry in `headers` fails config validation before runtime.
- Post-install live delivery acceptance: authenticated curl through the installed entry, targeting the free-tier wire model with streaming and a non-empty `read` tool, returns a model answer from Zen and no `FreeTierError`. This is a task-specific runtime closeout, not a source test gate. A non-Zen control request receives no configured OpenCode headers in the controlled author test.
- Same-entry replay: consecutive requests carry different `x-opencode-session` / `x-opencode-request` values, and a rejected free-tier attempt still projects a typed error instead of leaking the provider error to the client.
- A real upstream error remains an error; it does not become a model answer or trigger an unconfigured fallback.

## Scope

Allowed implementation owners are the existing OpenAI Chat Runtime transport adapter and generic Provider HTTP transport, plus their focused tests. Architecture maps and this feature graph may be updated to bind the existing source and gates. The locked Hub skeleton, Server, Virtual Router, Error chain, provider auth source, provider body semantics, and live configuration remain outside the author phase.
