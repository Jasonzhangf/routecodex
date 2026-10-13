# interface needs (corpus -> runner)

This file records corpus consumption requirements against the published
runner interface:
`/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/runner/interface.md`.

## Format

- `manifest.json` at `v3/fixtures/protocol-live-mock-matrix/manifest.json`,
  with `harness_id` `v3.protocol_live_mock_matrix` and a sorted unique case id
  list.
- One case JSON object per file under `v3/fixtures/protocol-live-mock-matrix/cases/<case-id>.json`.
- Case `cell` identifies entry protocol, provider protocol, transport and
  execution mode; runner maps Direct/Relay accordingly.
- `client_request`, `expected_provider`, `upstream_response`, `expected_client`
  and `assertions` follow the runner field names in the published interface.

## Required runner behavior

1. Reach the real RCC HTTP listener for each case, not a Rust driver or codec.
2. Route each `entry_protocol` to the declared `provider_protocol` loopback
   upstream; explicit same-protocol Relay must select Relay for
   `same-protocol-relay-chat-to-chat-json`.
3. Capture raw method, path, headers, body, response script, attempt kind and
   attempt index. Probes are identified and excluded from business attempt
   count.
4. Assert `expected_provider.body_must`/`body_must_not` and optionally `exact`;
   assert `expected_client` transport, status, body and terminal semantics.
5. `transport=closed` means an empty-body client disconnect is expected for
   provider exhaustion. `transport=complete` means a finished HTTP response is
   expected.
6. No control field (`routecodex_internal`, `metadata_center`, `debug_snapshot`,
   `provider_protocol`, `resource_handle`, `runtime_control`,
   `selected_target`, and any `routecodex_*` marker) may appear in provider or
   client business payload.

## Current runner capability

- `protocol-semantics.mjs` and `tool-consumer.mjs` exist. They own parsed
  semantic observations and declared no-side-effect tool execution.
- The observer `call_id` duplicate bug is fixed. The original tool-followup red
  result was a harness observation defect, not proof of a product tool failure.
- Live results remain separate evidence; module existence and unit tests do not
  prove a live matrix pass.

## Multi-turn cases

`tool-followup-responses-to-chat` and `namespace-custom-complete-args` define a
second turn under `turns`. The runner should:

- Execute the first turn against RCC.
- Run the declared no-side-effect echo consumer for the first case; for the
  namespace case, record the client-side handling of the returned call.
- Send the second-turn client request, assert `expected_provider_exact` where
  present, and assert the second client output.
- Fail if any turn synthesizes a tool result or grants undeclared permission.

## Semantic notes

- `usage-missing-or-null-preserved` uses `null` values in `body_must` on
  purpose; the assertion must distinguish explicit null from missing and never
  coerce null to zero.
- `reasoning-provided-signature-not-invented` uses `body_must_not` for
  `contents.1.parts.0.functionCall.thoughtSignature`; a synthesized signature is
  a product failure, not a compatible adaptation.
- `provider-error-exhaustion` expects no provider error bytes at the client and
  no substitute success. Its `runtime_setup` declares a configured, eligible
  `mock-chat/mock.unavailable-model` candidate whose one scripted provider
  attempt returns the fixture's 429. Model selection must succeed and reach the
  mock; this case must not claim exhaustion by failing model selection first.
- `provider-fault-stream-cut` carries two attempts in `upstream_response` and
  now declares two same-tier provider candidates. Its `expected_provider.auth_orders`
  permits only A->B or B->A and never A->A or B->B; do not weaken the attempt
  count or accept an arbitrary auth header.
- Gemini SSE cases use `:streamGenerateContent`. If the bound entry cannot
  serve that path, classify the case as an explicit coverage gap in the runner
  report; do not mark it passed by routing to another endpoint.

## Runtime setup metadata need

Two cases declare `runtime_setup`:

- `provider-error-exhaustion` needs its declared `mock.unavailable-model`
  candidate to reach the mock 429. A model-selection failure is not exhaustion.
- `provider-fault-stream-cut` needs both `mock-chat-a` and `mock-chat-b`
  declared in one default-pool tier. The second attempt must use the other
  declared identity; same-candidate retry is not an implicit fallback.

The declaration is test configuration metadata and is never sent in client or
provider business payload.

Corpus routing context (applies to every case, not only this one):

- Client models are written `mock.<wire-model>`. `resolve_direct_provider_model`
  splits the string on its first `.` into `provider_id = "mock"` and
  `model_part = "<wire-model>"`; because no enabled provider is named `mock`,
  every case resolves `NotDirect` and is routed by the default pool tier.
- These are therefore **not** provider-model direct pins. No case silently
  demands a provider switch, so the direct-pin contract is not violated.
- The provider wire body model comes from the resolved provider model's
  `wireName`, which is why `expected_provider.body_must.model` is the bare
  wire name.

Exact fields, consumed by the config generator and lifecycle owner:

| Field | Meaning |
| --- | --- |
| `provider_id` | Provider whose generated directory gains the extra model. |
| `model` | Provider model key; equals the visible `client_request.body.model`. |
| `wire_model` | Upstream provider wire name; must equal `expected_provider.body_must.model`. |
| `candidate_ids` | Exact `provider/model-key` candidates the compiled default tier must contain. `candidate_ids[0]` is `${provider_id}/${model}`. |
| `all_candidates_fail` | Every listed candidate must serve this fixture's scripted 429; none may succeed. |

`expected_provider.auth_orders` is a harness-only expectation field. When
present, it lists exactly two allowed full authorization sequences, and each
sequence must contain exactly two distinct non-empty auth strings. It is not an
RCC config field and it must not be derived from actual captures.

Generator requirements for the runtime setup cases:

1. Emit `[provider.models."mock.unavailable-model"]` with
   `wireName = "unavailable-model"` and route the default tier to
   `use = "mock-chat/mock.unavailable-model"`, matching the adapter's existing
   `mock.<wire>` model-key convention. `config check` alone does not validate
   this reference, so the runner must assert the resolved provider body model.
2. Keep `candidate_ids[0]` equal to the generated tier member; the lifecycle
   helper must not silently fall back to its default `mock.chat-model`
   candidate when `runtime_setup` is present.
3. Keep `expected_client.transport = "closed"`. Reaching the mock 429 must be
   provable from provider captures before the client close is classified as an
   exhaustion expectation rather than a selection failure.
4. For `provider-fault-stream-cut`, generate `mock-chat-a` and `mock-chat-b`
   with distinct fixed test tokens, model key `mock.chat-model`, and wire name
   `chat-model`. Put both candidates in the same default-pool tier.

The exhaustion case needs one candidate. The fault case needs two candidates.
Both sets are explicit typed setup, not a general config language.

## Candidate recovery requires explicit config, not same-candidate retry

`provider-fault-stream-cut` expects two provider attempts. That expectation is
not satisfiable by this repository's production failure policy:

- `V3RelayProviderFailureRetryPolicy::from_manifest` is documented as
  `same_candidate_retries = 0`.
- `is_v3_retryable_transient_source` returns `false`; SSE and transport
  failures are provider-health events that reselect the candidate set.
- The direct path rejects `WaitThenRetrySame` with `retry_same is not a
  production provider failure action`.
- `resolve_v3_direct_model_plan` builds its own single-target synthetic `direct`
  pool with `key: None`, so a resolved direct pin cannot widen to a second
  provider or auth identity either.

The only way to obtain a second attempt is a declared alternative eligible
identity outside business payload. This fixture now declares two providers
behind one route tier and records the two allowed auth orders. Magpie retries
the same logical turn; RCC recovery uses a declared alternative identity and
does not perform implicit same-candidate retry. The live replay must prove the
actual auth sequence and recovered response before this case can be marked
passed.
