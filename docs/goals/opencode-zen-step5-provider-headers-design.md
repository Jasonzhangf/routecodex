# OpenCode Zen Step 5 provider headers

## Contract

The client sends the same OpenAI Chat Completions body shape that passed the authenticated direct curl: `stream: true`, the actual `bash` and `read` tool definitions, `reasoning_effort: low`, and an account credential resolved by RCC. The adapter preserves that body and the selected `step-5-preview-free` wire model. It does not synthesize tools, change streaming, or select a fallback.

## First divergence and owners

The configured provider `headers` already compile into `V3ResponsesProviderTarget.headers`. The OpenAI Chat builder in `provider_compat_shared.rs` drops that map when it builds the typed transport request. The Provider-owned `ProviderResponsesTransport::send_http` then applies configured headers only for Anthropic requests. The same selected target therefore has its configured headers in dry-run projection but not on an OpenAI Chat HTTP request.

The minimal fix reuses the existing target-to-transport carrier and generic HTTP send owner:

1. The Runtime OpenAI Chat transport builder converts `target.headers` into `V3ProviderRequestHeader` values and places them on the existing transport request.
2. Provider authoring validation rejects a configured header named `authorization` after trimming, case-insensitively. Provider HTTP send applies the remaining configured headers to non-Anthropic HTTP requests. Anthropic continues using its existing compatibility path. The resolved provider secret remains the sole source of the wire `Authorization` header.
3. Provider request projections redact configured header values. Names remain visible for diagnosis. This prevents arbitrary provider header values from entering dry-run/debug artifacts; transport still sends the original values.

The graph starts at the already compiled and selected Target/wire request. Config compilation and target selection remain with their existing owners. No Hub node, edge, protocol, body conversion, model binding, or retry behavior changes. The Provider transport remains generic and does not branch on provider ID. A successful raw provider response returns to the existing Runtime response projector. HTTP/transport failures enter the existing typed Error/recovery chain and never project as a successful payload. Cancellation or client disconnect terminates the attempt as the existing cancellation outcome. Reselection, exhaustion, and client transport behavior remain owned by existing Runtime/Error nodes; this feature does not alter them.

## Verification contract

- Runtime builder test: selected target headers reach the typed OpenAI Chat transport request.
- Provider transport loopback test: configured `x-opencode-*` headers reach the actual HTTP wire and the request contains exactly the secret-derived Bearer authorization; body and stream intent remain unchanged. Provider request projection shows header names and redacted values.
- Provider authoring test: an `Authorization` entry in `headers` fails config validation before runtime.
- Post-install live delivery acceptance: authenticated curl through the installed 7777 `/v1/chat/completions` entry, with real `bash`/`read` tools and streaming, returns a model answer from Zen. This is a task-specific runtime closeout, not a source test gate. A non-Zen control request receives no configured OpenCode headers in the controlled author test.
- A real upstream error remains an error; it does not become a model answer or trigger an unconfigured fallback.

## Scope

Allowed implementation owners are the existing OpenAI Chat Runtime transport adapter and generic Provider HTTP transport, plus their focused tests. Architecture maps and this feature graph may be updated to bind the existing source and gates. The locked Hub skeleton, Server, Virtual Router, Error chain, provider auth source, provider body semantics, and live configuration remain outside the author phase.
