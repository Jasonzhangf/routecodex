# REQ02 registered include: canonical-to-standard boundary repair

Status: revised design candidate r133; independent design admission is required before Rust implementation. This revision replaces the rejected r119/r122 proposals.
Source baseline: a6e33d85b8b7e0efb84f4dd403e8235d6303ad49, composed with origin/main 459004b113d31f79d818992509c1a1fb17639b66.

## Observed gap and existing contract

The actual request contains `include: ["reasoning.encrypted_content"]`. REQ02 correctly preserves it as `chat.routecodex_chat_extension.responses_request.include` and registers the inverse mapping. The existing field profile already declares `routecodex.v3.field.responses_include_transform@1` in both directions, including `chat_to_provider` source at that extension and destination `provider.standard.request.include`.

The registered reverse direction is not consumed by the standard working-view boundary. Existing emitters therefore consume a different representation: Responses handles only four other extension keys and loses include; OpenAI Chat rejects the remaining extension leaf; Anthropic/Gemini reject that unmapped extension. Existing old top-level include tests do not cover the new canonical extension carrier.

Evidence: live gpt-5.5/gpt-5.6 r114 raw samples at the task run directory; parent public consumer `req02_responses_include_cross_protocol_public_consumer`, `include-public-red-r117.log/.exit`, exit101. All four target boundaries were exercised before the final failure assertion. This is a pre-transport representation gap, not a demonstrated provider-network failure. Historical successful overall harness runs can contain retries with the same gap; their final PASS does not prove every projection path passed.

## Unique owner and SESE slice

Reuse `operation_runner/operators/project_canonical_fields.rs::project_canonical_standard_view`. All four Relay standard emitters already call this one boundary. Keep the existing full request graph and its ARC topology. The relevant slice is:

```text
REQ02 lossless normalization and typed inverse/current associations
 -> Chat Process current canonical
 -> existing shared canonical-to-standard working view
 -> existing target-standard allowlist projection and emitter
 -> Provider Compat
```

The new work is completion of an already declared field operation at that existing owner. It does not add another normalization pass, another projector, a provider-profile workaround or an entry-protocol shortcut. Direct continues to use the registered inverse Direct projection and its hooks. Do not edit the separately owned REQ06 `project_standard_provider_request` implementation or its worktree.

## Registered operation and parameters

Consume the already compiled `chat_to_provider` binding of the registered include operator. Reuse `FieldOperatorKind::ResponsesIncludeTransform`, `ProfileIndex`, `DirectionBinding` and the existing typed path helpers. Expose the smallest necessary read-only binding enumeration/accessor if required. Do not hardcode the source field name, canonical extension address, target model or provider in the working-view implementation.

The declared parameters are authoritative:

| Parameter | Existing declaration |
| --- | --- |
| Operator | `routecodex.v3.field.responses_include_transform@1` |
| Source | `chat.routecodex_chat_extension.responses_request.include` |
| Destination | `provider.standard.request.include` |
| Transform | `v3.chat_extension_include_to_responses_wire.v1` |
| Shape | array |

The outbound binding's default projection is explicitly
`retain_in_request_canonical_only`. The existing semantic field matrix,
`response.include_fields`, defines include as an optional output selector and
permits adjacent Outbound omission when the target cannot represent it. The
previous outbound `preserve_unrepresentable_as_opaque` declaration and the
candidate AGENTS wording conflicted with that contract; this revision reconciles
those declarations with the user's explicit Outbound compatibility-filtering
rule. Inbound's `preserve_unrepresentable_as_opaque` binding is unchanged.
All original values stay in the canonical request and paired inverse context;
a projection-drop record is diagnostic only, never the carrier of that value.

Operate on the private standard working-view clone. For this registered operator, read the current canonical value at its declared source, place the unchanged value at its declared standard destination, and consume only that source contribution from the working view. Remove a containing generated object only when it became empty through that consumption. Retain unrelated extension leaves. Leave the original canonical payload, immutable request pair and current associations unchanged. No raw request is reconstructed.

This is a standard view materialization, before target encoding. The existing target-standard allowlists remain the only compatibility-filter owner:

- Responses emits the original include value.
- OpenAI Chat, Anthropic and Gemini have no equivalent include selector. Their existing explicit standard-field filtering removes it from provider wire and records the existing typed projection-drop evidence.
- The canonical request retains include for Direct/client inverse uses. Do not discard it in Inbound or Chat Process.
- Unknown extension fields retain their existing declared behavior. Do not add blanket extension deletion, guessed repair or permissive parsing.

Include presence does not change route/provider eligibility, health, target
selection, or protocol mode. In particular, do not exclude Chat, Anthropic or
Gemini candidates or create a new exhaustion case because include is present.
The existing target-standard field contracts own wire omission; this shared
materialization is not another whitelist, normalizer or Compat workaround.

The registered materialization runs once at each existing standard working-view call, not again in Compat or wire. Do not change the operator skeleton, DAG node order, route selection, health management, transport, response mapping, error policy or local continuation behavior.

## Allowed implementation and author verification

Allowed production slice: `operation_runner/operators/project_canonical_fields.rs` and, only as necessary to read the already declared outbound binding, `field_operator_profiles.rs`. This design also changes only the outbound include binding's declared default projection and reconciles the conflicting Outbound contract sentences in AGENTS. No change to inbound include normalization, target adapters, whitelist contents, route selection or provider Compat. An implementation that needs broader ownership must return to design admission first.

Author verification must cover:

1. The exact public boundary RED fixture above becomes GREEN for all four targets, with native Responses include preserved exactly.
2. No-include requests retain their existing wire output. Test the same small request with and without include to isolate this field.
3. Original canonical/pair state remains unchanged; current include changes/removal are respected; unrelated extension siblings remain intact. Malformed or client-owned opaque values retain their existing declared handling.
4. Existing native Direct field consumers continue to round trip include, and typed drop records account for unrepresentable include at standard Outbound rather than a silent drop.
5. Existing Server HTTP JSON/SSE exec, patch and MCP tool round trips include the actual selector on initial and follow-up requests, with original argument/result/ID assertions intact.
6. Host runs the affected runtime tests and public consumers, then rebuilds the exact candidate and uses the existing isolated instance through one official restart. Fresh GCM profile gpt-5.5 and gpt-5.6 consumers must prove real exec, patch, MCP, result consumption and follow-up against the exact installed candidate; audit bound raw samples for this failure.
7. Reverse only the production delta and run the unchanged public RED fixture to reproduce the gap; restore the fixed delta. Final independent architecture review follows author debug and E2E.

On cancellation or failure, this pure view transformation owns no persistent resources. Existing request/attempt finalizers remain the lifecycle owner. Real failures keep their typed Error source; no successful response is invented. No new state store, request metadata or log-derived control is introduced.
