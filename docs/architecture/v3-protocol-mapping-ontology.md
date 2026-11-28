# V3 Protocol Mapping Ontology: Inbound Completeness and Outbound Allowlist

Status: approved and bound; executable parity and public JSON/SSE tests verify MAP-001 and MAP-002.
Owner feature: `v3.protocol_conversion_field_parity`.
Approval source: user clarification at
`/Users/fanzhang/.agents/task-notes/routecodex-master-audit-20261123/dbc3d38-contract-clarification-20261124.md:22-32`.

## Objects

### `v3.inbound.business_payload`

- Definition: parseable source-protocol business values before adjacent Inbound normalization.
- Identity: source request/response plus semantic field path.
- Owner: adjacent Inbound codec; missing semantic conversion work belongs to Chat Process.
- Attributes: complete source value, source protocol, semantic path.
- Perception: public protocol entry and canonical Chat/extension capture.
- Must have: every parseable business field represented losslessly in Chat or a registered extension.
- Must not have: RouteCodex control state reconstructed from payload.

### `v3.outbound.projected_field`

- Definition: one complete Chat business field considered by the adjacent target Outbound codec.
- Identity: request/attempt identity, target protocol, semantic path.
- Owner: adjacent Outbound codec.
- Attributes: complete value, target protocol, declared allowlist mapping when present.
- Perception: provider wire and scoped local diagnostic evidence.
- Must have: mapped values projected mechanically; complete unmatched business values identified by absence of a target allowlist mapping.
- Must not have: malformed registered values, invalid pairings, control leaks, source-schema invalidity, capability failures, or unrepresentable protocol boundaries classified as unmatched allowlist fields.

### `v3.outbound.unmatched_field_diagnostic`

- Definition: scoped local diagnostic evidence for a complete business field without a target allowlist mapping.
- Identity: target protocol, semantic path, request/attempt identity.
- Owner: Outbound diagnostic path.
- Attributes: warning and field identity; never business payload or Error terminal.
- Perception: diagnostic record tied to the public request.
- Must have: one record per unmatched field when diagnostic persistence is available.
- Must not have: provider selection, request terminal, or business semantics.

## Behaviors

### `v3.inbound.complete_lossless_conversion`

- Owner: adjacent Inbound codec; Chat Process owns missing semantic conversion work.
- Precondition: parseable JSON and open request/response graph.
- Input: complete source payload.
- Output: canonical Chat plus registered extensions.
- Transition: `(parseable_source, source_value) -> (chat_value, open_for_chat_process, no_filter_effect)`.
- Effects: none that filter business data.
- Perception: public entry plus canonical Chat/extension capture.
- Must have: missing conversion work remains eligible for Chat Process.
- Must not have: inbound filtering, rejection, silent drop, or control-state reconstruction.

### `v3.outbound.allowlist_projection_with_nonblocking_omission`

- Owner: adjacent Outbound codec.
- Precondition: complete Chat business field and target allowlist evaluation.
- Input: complete mapped or unmatched business field.
- Output: target field when mapped; otherwise warning/diagnostic candidate and omission of that field.
- Transition: `(projection_open, unmatched_complete_field) -> (mapped_remainder, projection_open, field_omitted)`.
- Effects: allowlist absence alone does not fail conversion, reselect provider, create synthetic status, or abort request.
- Perception: provider wire plus warning/diagnostic record and first-attempt public result.
- Must have: only the unmatched field omitted; mapped remainder continues.
- Must not have: treating malformed registered values or independent protocol failures as unmatched.

### `v3.outbound.record_unmatched_diagnostic`

- Owner: Outbound diagnostic path.
- Precondition: complete business field has no target allowlist mapping.
- Input: unmatched field identity.
- Output: scoped local diagnostic evidence when available.
- Transition: `(field_seen, no_record) -> (field_seen, diagnostic_recorded)`.
- Effects: no payload, Error, selection, or terminal mutation.
- Perception: persisted diagnostic record bound to request/attempt identity.
- Must have: local-only evidence.
- Must not have: business payload or control decision.

## Relations

### `inbound_routes_missing_conversion_to_chat_process`

- From: `v3.inbound.business_payload`.
- To: `v3.outbound.projected_field` (via Chat Process canonicalization).
- Kind/direction: semantic conversion work, inbound -> Chat Process -> outbound.
- Cardinality: each source field has zero or one canonical representation and at most one pending conversion action.
- Perception: public entry plus canonical/extension capture.
- Must have: lossless carrier.
- Must not have: inbound filter effect.

### `outbound_allowlist_reports_unmatched_field`

- From: `v3.outbound.projected_field`.
- To: `v3.outbound.unmatched_field_diagnostic`.
- Kind/direction: diagnostic side channel, projection -> local evidence.
- Cardinality: one warning/diagnostic per unmatched semantic path and request/attempt identity.
- Perception: diagnostic record plus provider-wire omission.
- Must have: field omitted while mapped remainder continues.
- Must not have: local abort or reselection.

## Clauses

### MAP-001

- Axis: behavior; axis id `v3.inbound.complete_lossless_conversion`.
- Scope: parseable source business fields.
- Rule: Inbound preserves complete business data; missing conversion work belongs to Chat Process.
- Scenario: parseable source field has no direct adjacent codec conversion.
- Trigger: Inbound sees that field.
- Allowed actions: preserve in canonical Chat/registered extension and route conversion work to Chat Process.
- Forbidden actions: inbound filtering, rejection, silent drop, or control reconstruction.
- State before/after: parseable source -> Chat/extension value eligible for Chat Process.
- Effects: no filter effect.
- Owner: Inbound codec and Chat Process.
- Approval: `approved_bound`.
- Evidence: user clarification cited above and `v3/crates/routecodex-v3-server/tests/protocol_mapping_ontology_public.rs`.
- Governance: bound by `v3.protocol_conversion_field_parity` (`npm run verify:v3-protocol-conversion-field-parity` and `npm --prefix v3 run test:v3-protocol-conversion-field-parity`), `anthropic_inbound_preserves_multikey_metadata_losslessly`, and public `/v1/messages` entry capture.
- Legal case: missing conversion remains observable in Chat/extension and reaches Chat Process.
- Illegal case: field is omitted or request rejected before Chat Process.
- Observation: public `/v1/messages` inbound capture in `map001_map002_outbound_unmapped_fields_omit_without_reselection_and_tolerate_small_response_quirks` plus `anthropic_inbound_preserves_multikey_metadata_losslessly`.

### MAP-002

- Axis: behavior; axis id `v3.outbound.allowlist_projection_with_nonblocking_omission`.
- Scope: complete business field absent from target allowlist mapping.
- Rule: warn and record scoped local diagnostic evidence, omit only the unmatched field, and continue mapped remainder.
- Scenario: complete Chat business field has no target allowlist mapping.
- Trigger: adjacent Outbound allowlist evaluation.
- Allowed actions: warning/diagnostic evidence, field omission, mapped remainder projection and continuation.
- Forbidden actions: conversion failure, provider reselection, synthetic 4xx/5xx, whole-request abort, or diagnostic in business payload/Error terminal.
- State before/after: open projection with field -> open projection with that field omitted and mapped remainder available.
- Effects: no local terminal or selection effect.
- Owner: adjacent Outbound codec and its diagnostic side channel.
- Approval: `approved_bound`.
- Evidence: user clarification cited above, `v3/crates/routecodex-v3-runtime/src/projection_drop_log.rs`, and `v3/crates/routecodex-v3-server/tests/protocol_mapping_ontology_public.rs`.
- Governance: bound by `v3.protocol_conversion_field_parity` (`npm run verify:v3-protocol-conversion-field-parity` and `npm --prefix v3 run test:v3-protocol-conversion-field-parity`), `target_protocol_unmapped_field_continues_first_attempt_without_reselection`, `map001_map002_outbound_unmapped_fields_omit_without_reselection_and_tolerate_small_response_quirks`, and `map001_map002_public_hard_errors_reject_malformed_cross_protocol_and_empty_attempts`.
- Legal case: one complete unmatched optional business field is omitted while a strict provider accepts mapped remainder on first attempt.
- Illegal case: allowlist absence causes local error, provider reselection, synthetic response, or whole-request failure.
- Observation: public JSON/SSE `/v1/responses` -> `anthropic` entry test asserting `projection-drops.jsonl` diagnostic emission, provider-wire omission (`store`, `prompt_cache_key`) on both JSON and SSE, zero fallback hits (`openai_fallback == 0`), first-attempt HTTP 200 delivery, plus public negative rejection of malformed fields, cross-protocol SSE leakage, missing content block `type`, missing `stop_sequence`, and empty deliverable attempts.
