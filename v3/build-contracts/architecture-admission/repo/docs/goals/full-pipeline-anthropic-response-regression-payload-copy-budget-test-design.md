# Anthropic Response Regression Payload Copy Budget Test Design

## Contract

- `feature_id`: `debug.anthropic_response_regression_payload_copy_budget`
- `resource_id`: `debug.anthropic_response_regression_projection`
- Owner: `sharedmodule/llmswitch-core/scripts/tests/anthropic-response-regression.mjs`
- Semantic owner: Rust native `buildOpenAIChatFromAnthropicMessageFullWithNative`
- Goal: remove the diagnostic sample deep clone and deleted TS semantic path while preserving the exact Hub response projection.

## Lifecycle

1. Read and parse the tracked Anthropic response sample once.
2. Serialize its payload once at the mandatory JS/Rust native boundary.
3. Let the Rust native response owner build the Hub chat projection.
4. Parse the native envelope/result and assert the canonical tool-call and usage shape.
5. Release all diagnostic values when the process exits; no value may enter live provider/client/config/metadata truth.

## Positive Gates

- Importing the module performs no native work and emits no output.
- Direct CLI execution loads the compiled native owner and validates the tracked response sample.
- The projected response retains id, model, finish reason, tool call, arguments, and usage semantics.

## Negative Gates

- Reject `structuredClone`, JSON round-trip cloning, recursive clone helpers, and deleted TS response-runtime imports.
- Reject dist-path fallback and semantic reimplementation in the debug script.
- Malformed native envelopes/results and missing native capability fail explicitly.

## Verification Boundary

- Focused Jest and direct CLI provide source and local compiled-native blackbox evidence.
- This slice does not prove installed-runtime behavior, live provider equivalence, concurrent memory residency, or RSS reduction.
