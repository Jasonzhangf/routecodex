# V3 Gemini Relay Runtime Integration Test Design

## 1. Scope

Feature: `v3.gemini_relay_runtime_integration`.

Entry:

```text
POST /v1beta/models/:model/generateContent
```

Completion boundary is controlled Rust Runtime and loopback Server evidence only. This design does
not authorize or claim V2/P6 changes, live configuration, credentials, install, restart, release,
real Gemini provider compatibility, global availability, or production cutover.

## 2. Lifecycle Under Test

```text
Config entry binding registry
  -> Server registry consumer
  -> V3GeminiRelayRuntimeInput
  -> Hub Req01 -> Req09
  -> controlled Gemini upstream
  -> Hub Resp01 -> Resp06
  -> typed JSON or incremental SSE client body
```

Error lifecycle:

```text
provider/runtime failure
  -> V3Error01SourceRaised
  -> V3Error02Classified
  -> V3Error03TargetLocalAction
  -> V3Error04TargetExhaustionDecision
  -> V3Error05ExecutionDecision
  -> V3Error06ClientProjected
```

The request and response normal payloads must never carry RouteCodex internal side-channel fields.

## 3. White-box Matrix

| Case | Input/state | Expected evidence | Risk locked |
|---|---|---|---|
| JSON success | Gemini contents/tools/generationConfig, client alias in URL | one Req01–Req09 and Resp01–Resp06 trace; provider URL uses wire model; provider body remains semantically equal and has no synthetic `model` | URL model routing and wire rewrite do not mutate Gemini body |
| Function call | provider candidate contains `functionCall.name` | response governance succeeds and client projection preserves the same name | Gemini function-call identity is not dropped or remapped |
| SSE incremental | first non-terminal candidate arrives before terminal candidate | first client frame is observable before terminal release; no synthetic `[DONE]` | no full-stream materialization |
| SSE malformed | framed `data` is not JSON | stream emits explicit error and no success payload | malformed provider stream is not silently accepted |
| SSE non-terminal end | stream closes after `finishReason: null` | explicit `ended without terminal finishReason` error | still-running response is not misclassified as terminal success |
| SSE post-terminal | provider emits another frame after terminal `finishReason` | explicit post-terminal error | late provider frames are not appended to a completed response |
| Provider HTTP error | controlled 429 | Error01–06 trace; no `V3ProviderRespInbound01Raw` success node | provider failure is not wrapped as success |
| Malformed provider error body | controlled HTTP error with non-JSON body | explicit `provider_error_body_malformed` error payload and Error01–06 | provider error parsing cannot silently fall back to a generic success/error shape |
| Request isolation | request contains `metadata_center` | codec fails before transport; capture remains empty | internal request control truth cannot enter provider body |
| JSON response isolation | provider JSON contains `metadata_center` | codec fails before client projection | internal provider-side control truth cannot enter client body |
| SSE response isolation | provider frame contains `metadata_center` | stream emits error before projecting provider data | side-channel leak cannot escape through streaming |

## 4. Runtime Module Black-box

Test:

```text
v3/crates/routecodex-v3-runtime/tests/gemini_relay_runtime_integration.rs
```

Required assertions:

- `execute_v3_gemini_relay_runtime` consumes the Config manifest and the endpoint URL model.
- Client alias selects the controlled provider target while the provider URL uses
  `/v1beta/models/gemini-wire/generateContent`.
- Gemini request body remains semantically equivalent; URL-path model truth is not injected as a
  provider body field.
- JSON and SSE both traverse the same fixed Hub v1 lifecycle.
- SSE uses `SseIncrementalDecoder`, emits before terminal, and rejects malformed/non-terminal/late
  frames.
- Provider HTTP failure uses Error01–06 and does not enter Resp01 success.
- Request and response side-channel fields fail closed.

## 5. Server Loopback Black-box

Test:

```text
v3/crates/routecodex-v3-server/tests/gemini_relay_controlled.rs
```

Required assertions:

- Server resolves the endpoint only through `entry_protocol_binding_for_endpoint`.
- Config binds Gemini as `relay`, `implemented`, and owned by
  `execute_v3_gemini_relay_runtime_with_default_transport`.
- Valid JSON and SSE requests each produce exactly one controlled upstream capture.
- Upstream receives the expected authentication header, wire-model URL, and unchanged Gemini body.
- SSE first frame reaches the client before the controlled terminal delay; Server uses
  `Body::from_stream` and performs no candidate/functionCall/finishReason parsing.
- Controlled 429 exposes Error01–06.
- Rejected `metadata_center` request produces zero upstream captures.

## 6. Positive and Negative Pairing

Positive gates lock:

- JSON candidate, usage, function-call identity, URL model, and body semantics.
- Incremental SSE first-frame timing and terminal finishReason.

Negative gates lock:

- malformed SSE, non-terminal stream end, and post-terminal frames.
- provider HTTP error never becoming success.
- request/response side-channel leakage never reaching provider/client normal payload.
- unknown or unbound endpoint never reaching a generic fallback.

## 7. Project-level Impact

The focused integration must stay compatible with:

- Gemini codec characterization.
- Config entry protocol binding contract.
- V3 module boundaries and Rust-only gates.
- V3 resource/function/mainline/verification maps.
- Architecture wiki/manifest sync.
- Cargo fmt, Clippy, and full V3 workspace tests.

## 8. Known Gaps

- No real Gemini provider request was sent.
- No live V3 listener, `~/.rcc` config, credential, global install, restart, or production process was
  changed.
- Controlled loopback proves source/runtime integration shape, not global or production Gemini
  compatibility.
