# REQ02 mixed history fold: bounded design amendment

Status: author design; independent design admission required before implementation.
This amends the existing REQ02 consumer contract. It introduces no pipeline node,
second normalization pass, provider policy, or continuation behavior.

## Observed boundary and owner

The public capture → REQ02 SDK → original typed pair consumer reproduces two
failures: `messages` contains an assistant tool call, while `input` contains its
result; the current field walker emits only the result. `finish()` overwrites the
unconsumed `messages` field. The duplicate result case also loses its call.
Both fail with canonical history length 1 instead of 2. The frozen test hash is
`685f8fbeec139fbecbc5e6d41448a36b571471555f4bb0a5af2a91ebe6d69265`.

The unique repair point is the shared field library and its compiled request
profile, inside `normalize_request_losslessly`. Legacy Inbound, Outbound,
Provider Compat, response projectors, and Server must not repair this loss.
Existing main accepts the mixed input; its legacy implementation is behavioral
reference only, never a second decoder called by this implementation.

## Explicit source binding

Register `responses:request.messages` as an observed Chat-compatible request
extension in the existing source inventory. Mark its compatibility provenance
explicitly; it is not an SDK-native Responses field or a new protocol coverage
claim. Update the actual inventory count by the added entry, without changing
semantic coverage statuses. Keep the existing exact-source admission rule.

Its structural row uses the already registered `array_container_shape@1`,
destination `chat.messages`, and transform
`v3.openai_chat_messages_to_chat_messages.v1`. It reuses the existing Chat
message item handler and opaque-leaf preservation. Unknown nested members keep
their original values and inverse associations. Tool arguments, custom input,
and outputs are complete opaque values; do not parse their contents.

## One configured fold after traversal

Add one request-direction registration to the existing `fold_contract`:

```yaml
operator: routecodex.v3.field.fold_history_merge
operator_version: "1"
direction: client_request_to_chat
protocol: responses
input_paths: [request.messages, request.input]
params:
  destination: chat.messages
  source_order: [request.messages, request.input]
  equivalence_policy: canonical_exact_or_declared_text_or_empty_assistant_tool_content
  conflict_policy: preserve_distinct_in_source_order
finalize_operator: routecodex.v3.field.fold_finalize@1
finalize_position: after_all_fold_input_paths
```

Register the exact operator/version and typed parameters in the existing field
operator registry. A compiled fold selects its explicitly declared protocol
and direction; runtime must not infer a fold from a protocol/model name or a
field spelling. Compilation rejects unknown operators, input sources outside
the inventory, duplicate fold ownership, missing/duplicate source order entries,
unknown policies, and more than one finalizer for a destination.

Each existing field handler visits its source once and contributes normalized
messages plus source associations to that configured destination. The normalizer
holds these temporary business values locally; they are not control resources.
The one fold finalizer consumes the contributions in the declared order,
before the existing instruction/system flush and before immutable pair publication.
Absent source containers contribute nothing. An unbound request uses its
existing behavior. No raw JSON re-traversal or legacy codec call is introduced.

## Equivalence and lossless conflicts

The shared pure fold merges representations of the same ordered history. It
does not globally deduplicate repeated messages within one source. A whole
secondary history equivalent to the primary history contributes associations
without adding a second copy. A secondary tool result equivalent to an existing
result for the same call ID similarly contributes an alias; unmatched entries
append in the configured source order.

Equality compares complete canonical business values. Only the declared
representation equivalences are permitted: scalar text and a singleton plain
text part with no extra business members; and absent/null/empty assistant
content when the otherwise identical assistant contains tool calls. Preserve
the primary representation and all nonconflicting extra fields. Conflicting
unknown fields, differing opaque values, different kinds/names/namespaces, or
different IDs are distinct and remain present. Same call ID alone is never
sufficient evidence of equality. No history conflict rejects business traffic.

All original source associations remain in inverse/history records, including
aliases for a folded duplicate. Remap existing canonical destination references
to the final indices before publishing the pair; records contain identities,
paths, encoding, and associations only. Business values remain in canonical.
The three fixtures must retain the full 70,000-character exec arguments, tail
sentinel, result CRLF, call IDs, and all source paths.

## Lifecycle and implementation scope

The existing REQ02 SESE graph, request handle, immutable pair publication,
attempt resources, error chain, and finalizer remain unchanged. Success emits
one canonical value and one pair; a configuration/internal execution failure
uses the existing typed error exit; cancellation/Drop retains the already
verified request finalization. This fold has no independent lifecycle.

Implementation ownership is limited to `operation_runner/operators/field_operator_`
library, profiles, helpers/records, and their existing tests; the field profile
manifest, matrix source inventory, and the existing operation-runner verifier
and its negative fixtures. Use the existing module files; add no new framework.
The parent owns map/review-surface synchronization. Do not change runtime callers,
other protocol codecs, the frozen public test, or production wiring in this slice.

## Acceptance and evidence

1. Preserve `.execution/req02-mixed-history-parent-red-r11.log` and the frozen
   `v3/crates/routecodex-v3-server/tests/req02_mixed_responses_history.rs` unchanged.
2. Run `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable
   -p routecodex-v3-server --test req02_mixed_responses_history -- --nocapture`:
   all three public SDK consumers must pass, including original typed associations.
3. Add public boundary regressions for distinct opaque results with the same
   call ID, different extra business fields, and repeated equal messages within
   one source. They must remain distinct; no payload rejection or truncation.
4. Run existing public normalization/tool-shape consumers and field-library
   development tests. Run `verify:v3-operation-runner-dagpipe` and
   `test:v3-operation-runner-red-fixtures`, including malformed fold configuration.
5. Save raw logs and hashes under task-owned `.execution/` and bind the exact
   source/profile/test inputs. These prove this slice only. Real caller cutover,
   HTTP/WS, both GCM models and exec/apply_patch/MCP round trips, installed runtime,
   implementation review, merge/push, and cleanup remain REQ02 delivery gates.
