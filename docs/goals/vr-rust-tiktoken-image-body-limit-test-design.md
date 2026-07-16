# Virtual Router Rust Tiktoken / Image Body-Limit Test Design

## Goal

Restore the retired TypeScript `countRequestTokens` behavior as the Rust Virtual Router truth:

- count text and structured request fields with tiktoken;
- choose the model encoding when the retired `tiktoken@1.0.22` model table knew it;
- use the retired canonical `cl100k_base` default for unknown/provider-alias model names;
- derive route `estimated_tokens` from Rust request counting, not client-provided `estimatedInputTokens` / `estimatedTokens` metadata;
- omit image/video payload bytes while retaining the small media stub in structured carriers;
- keep the configurable HTTP JSON `bodyLimit` as the transport allocation guard;
- remove the duplicate fixed 50 MiB semantic caps inside Hub format nodes.

## Lifecycle and owners

1. `ServerReqInbound01ClientRaw`: Express parses JSON under configured `server.bodyLimit` / `ROUTECODEX_HTTP_BODY_LIMIT` (default `64mb`). This is the only request body allocation cap.
2. `HubReqInbound02Standardized`: parses protocol semantics without a second fixed byte cap.
3. `VrRoute04SelectedTarget`: `virtual_router_engine/features.rs` counts request tokens with Rust tiktoken and classifies long context.
4. Req outbound / response inbound format nodes preserve protocol semantics and do not reinterpret payload byte size as token count.

## White-box tests

Positive:

- Rust count equals frozen retired-TS tiktoken results for text, tool calls, tools, parameters, and Responses context.
- Top-level `/v1/responses` `input` text participates in Rust counting even when metadata under-reports tokens.
- Known model encoding and unknown/provider-alias canonical default are both locked.
- Adding large image/video base64 data changes only the media-stub token count, not by the base64 byte length.
- Client metadata over-reporting tokens does not route image/video payload bytes as long context.
- Payloads larger than 50 MiB are not rejected by the three Hub semantic format nodes.

Negative:

- A large non-media structured tool payload still increases the estimate and can trigger long-context routing.
- Rust source gate rejects client metadata token-estimate overrides, character-ratio token approximation, and revival of fixed Hub `MAX_PAYLOAD_SIZE_BYTES` validators.
- TS token-counter/runtime owners remain physically absent.

## Black-box / live acceptance

- Build and globally install the native runtime.
- Restart the aggregate instance once with `routecodex restart --port 5555`.
- Verify every configured listener health endpoint.
- Replay the same 5555 image-bearing request entry and prove it passes Hub parsing and its route reason is not caused by base64 media size.
- Replay a large textual/tool payload and prove long-context classification still activates.

## Known gap rule

Without the original image request body or an equivalent live replay, only source/unit closure may be claimed; no live regression closure may be claimed.
