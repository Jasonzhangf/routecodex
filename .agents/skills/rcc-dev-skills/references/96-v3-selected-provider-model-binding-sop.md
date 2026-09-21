# V3 Selected Provider Model Binding SOP

## Trigger

Use this SOP for wrong provider model, alias leakage, model-specific compatibility, Direct/Relay
model divergence, retry candidate model leakage, or upstream "model not configured" errors.

## Client input syntax

- `provider.model` is the standard direct-pin route input. Example:
  `kdns.deepseek-v4.1-flash`.
- It splits on the first `.`, resolves the leading segment against an enabled
  provider id, then resolves the model id or alias inside that provider.
- Unknown provider prefix falls back to normal routing. Known provider with an
  unknown model fails without pool fallback.
- Do not bypass direct-pin resolution with headers, payload fields, or
  per-provider suffix hacks.

## Evidence order

1. Inspect canonical `ports/<port>/<requestId>/request.json`.
2. Inspect every `provider-request.json.attempts[].request.{providerId,body.model,url}`.
3. Inspect matching `provider-response.json.attempts[].response`.
4. Separate strings generated locally from strings appearing only in upstream responses/headers.
5. Trace `Router07 -> Target10 {model_id,wire_model} -> binding -> compat -> wire -> transport`.

## Hard contract

- `request.model` is client route input only.
- `Target10.candidate.wire_model` is upstream model truth.
- Virtual Router is payload-pure.
- `selected_provider_model_binding` is the sole semantic model replacement owner.
- Direct and Relay must call the same owner before provider-specific compatibility.
- Provider wire validates equality and must not repair a mismatch.
- Retry/reselect binds each attempt independently.
- Never add provider suffix/prefix special cases to Router/Hub.

## Diagnosis matrix

| Evidence | Owner |
| --- | --- |
| wrong model already in provider-request body | local selected-model binding contract |
| provider-request correct; different model only in provider response | upstream provider mapping/billing |
| compat behavior matches client alias, final wire model is correct | binding occurred too late |
| second attempt carries first target model | retry attempt binding leak |

## Required proof before closure

- Positive and negative model-binding tests.
- Static unique-writer gate.
- Provider-request dry-run showing client alias != selected wire model.
- Old live sample replay.
- Root cause and architectural owner explanation in the final summary.
