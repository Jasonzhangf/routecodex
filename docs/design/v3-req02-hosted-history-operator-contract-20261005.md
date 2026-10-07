# REQ02 hosted history: configured normalization and inverse

Status: design candidate; implementation requires independent design PASS.
Scope: restore established hosted-history behavior in the existing REQ02 field
library. This is not current hosted tool execution or local continuation.

## Evidence and ownership

The unchanged public runtime test
`responses_openai_chat_field_parity_web_search_call_history_projects_tool_pair`
passes on clean main338 and fails on the REQ02 candidate. Evidence is preserved
in `docs/evidence/dagpipe/req02-hosted-history-baseline-decision-r21-20261004.md`.
The failed historical event requires no current tool declaration. It represents
an earlier operation, with an adjacent call and result followed by the user turn.

The unique inbound owner is the registered field library inside
`normalize_request_losslessly`. Its inverse owner is the registered current
history projection. Server, Provider Compat and wire construction do not decode
or repair this history. The old Responses codec is a behavioral reference only;
do not call it from REQ02 or restore a second normalization path.

## Operator and typed configuration

Extend the existing `request_input_shape_branch@1` typed profile with an optional
`hosted_history_cases` list. Configuration compilation resolves that list once.
Each case has these exact typed parameters:

| Parameter | Meaning |
| --- | --- |
| discriminator_value | Original item type selected by the configured discriminator |
| function_name | Standard Chat name for this historical representation |
| identity_paths | Ordered, explicit source fields used for a nonempty call identity |
| generated_identity_prefix | Stable representation identity prefix if no configured field has a usable nonempty string |
| argument_paths | Ordered source fields for the represented call arguments |
| non_object_argument_encoding | `value_member`; preserve a nonobject value under `value` |
| absent_argument_encoding | `empty_object` |
| canonical_encoding | `single_hosted_event_extension` |
| canonical_extension_key | `responses_hosted_history_event` |
| provider_chat_encoding | `adjacent_call_and_complete_event_result` |
| provider_anthropic_encoding | `assistant_native_hosted_blocks` |
| provider_gemini_encoding | `adjacent_call_and_complete_event_result` |
| native_call_block_type | `server_tool_use` for the Anthropic profile |
| native_result_block_type | `web_search_tool_result` for the Anthropic profile |
| native_result_encoding | `current_event_outcome_members` |
| native_result_excluded_fields | Original `type`, `id`, `call_id`, `tool_call_id`; these identity/type fields are represented by the paired native blocks |
| inverse_encoding | `current_source_event_value` |

This slice declares only the confirmed single-event Web Search case:

| Original type | Chat name | ID fields | Generated prefix | Argument fields |
| --- | --- | --- | --- | --- |
| web_search_call | web_search | call_id, tool_call_id, id | call_routecodex_web_search | action |

`tool_search_call` and `tool_search_output` have separate source items and a real
discovered-tools result. They are excluded from this single-event configuration.
Do not synthesize a tool-search result from its call event or collapse its two
source items. Their existing separate-source semantics must remain unchanged;
REQ02 overall acceptance still requires the existing tool-search public tests.
Any missing separate-source behavior needs its own bounded configuration slice.

Generated IDs append the original source item index, matching established
behavior. They are representation IDs only. The inverse preserves the original
identity fields and their absence. Models, providers, declaration names and
schemas never select this branch. Other protocols have no case unless their
profile explicitly registers one. The operation skeleton does not change.

The compiler rejects unknown encoding values, duplicate discriminator cases,
ambiguous field ownership and malformed configuration. Those are authoring
errors. A business event with unknown members or unusual argument values is
preserved, not rejected. New profile fields must be bound in the source inventory
as observed compatibility semantics; no unsupported SDK-native coverage claim.

## One source visit and one canonical business value

When the Web Search case matches, the existing input walker emits one assistant
history anchor with null content and a `routecodex_chat_extension` containing the
complete event under the configured `responses_hosted_history_event` key. This
is native hosted semantics carried as an extension, consistent with the Inbound
contract. It is not an ordinary assistant completion or a newly declared tool.
The complete event is stored once as its original JSON value, including every
unknown member, action, status, result, errors, execution and original IDs.

Use the existing message span and history pairing/source records to associate
the source item with this single current destination. Record each source leaf
to the corresponding event value, with escaped paths for unknown keys. The one
anchor participates in the existing configured mixed-history fold. No alias
editor, duplicate action value or extra current resource is needed. Existing
typed Replace/Remove/Move operates on this one business value and its existing
current associations. Distinct events are not deduplicated by call ID.

Inbound does not generate a provider-specific call/result representation.
Standard Outbound's registered input/history projection consumes this extension
and the same current source association. A Chat target emits an assistant
function call followed by its adjacent tool result, derived together from the
same current event. Configured action and ID policies produce call arguments
and identity; the result is a JSON encoding of the entire same current event.
These are transient emitted values, not a second canonical truth. The Responses
target emits the one current native event. Gemini target projection reuses its
existing standard call/result encoders for the same derived pair. Anthropic
uses its registered native hosted-history encoding described below. It never
represents a server-executed hosted event as an ordinary client tool call.

### Anthropic native hosted history and ordinary tool adjacency

The configured Anthropic emission emits `server_tool_use` and
`web_search_tool_result` blocks together in one assistant message. The call
block uses the configured name, the same selected identity, and the current
action value. The result block uses that identity as `tool_use_id`. Its content
is the current event's outcome members: status, action, result, result_items,
output, error and every unknown sibling. Only the explicitly configured
original identity/type fields are excluded from that content; their meaning is
already represented by the native block identity/types. Missing or removed
members remain missing. Do not invent completed status or an empty result.
Do not copy the old codec's semantic action/status rejection rules. Preserve
representable values through the standard registered projection contract.

When a hosted anchor occurs between ordinary call(s) and their matching
output(s), append both native hosted blocks to the existing assistant message
after the ordinary tool_use blocks. Emit the ordinary outputs in the following
user message with their unchanged tool_use_id and full values. The hosted
blocks cannot satisfy, consume or clear ordinary pending call identities.
An isolated anchor emits its own assistant message. Consecutive hosted anchors
remain ordered. This uses the existing standard history emitter's grouping
owner; no new normalization pass, history editor or cross-node state is added.

The unchanged public characterization case
`responses_hosted_web_search_between_tool_call_and_output_preserves_anthropic_adjacency`
defines the established externally visible block types and order. Add a public
canonical projection consumer and real HTTP provider capture for the same
interleaving, including failed/completed events, absent identities, unknown
fields and explicit current edits/deletions. This protocol emission is part of
this slice's acceptance, not a deferred compatibility repair.

Implement the configured event-expansion helper in the existing operator
library. Existing standard protocol emitters invoke that helper at their
history emission point. Do not mutate canonical, implement another normalization
pass, call the old codec, create a Chat Process postprocessor, or move semantic
expansion into Provider wire/Compat. The helper's registered recipe and typed
parameters own the distinction; models/providers and raw type string guesses
cannot select it. Ordinary function/custom/exec/patch/MCP items stay on their
existing emitters and keep complete opaque values.

Preserve event position relative to other history and ordinary call/result
adjacency. Existing Chat Process readers must recognize the registered history
anchor as native historical semantics. It must not become a fabricated user
turn, execute a new hosted operation, alter route/continuation policy, or
invent a current tools declaration. Check affected routing/servertool/image
readers through the real consumer; report a concrete owner gap rather than
adding a downstream shortcut.

## Reverse projection and current-value authority

Direct/current Responses inverse reads the one current event through the
recorded source/current association and emits it once. It does not invert a
transient provider pair or parse its duplicated JSON strings to find current
truth. Source opaque references describe original shape/presence only; they
cannot revive deleted event fields or replay prior action/result values.

Preserve original ID fields and their absence. A typed edit of the current event
action appears in both the emitted Chat call arguments and full-event result,
and in the single native inverse. Result/unknown-field edits behave the same way.
Removing an event field omits it in all representations that can express that
absence. Removing the history anchor emits no native event or generated Chat
pair. No completed status, result, call or error is invented. Only an actual
target representation limit can use the existing typed projection error exit.

## SESE lifecycle and allowed implementation

Reuse the existing request graph, capture, immutable pair publication, fold,
successful attempt resources and finalizer. No new graph node or control edge is
needed. Normal success returns canonical data and the one original pair.
Compile/internal execution failures use the existing Error chain. Cancellation,
disconnect and Drop release the existing request resources. This operator owns
no process, listener, provider attempt or independent lifecycle.

Allowed implementation: existing field library and its helper/profile/record
modules, current history projection, field profile manifest/source inventory,
the existing standard history emit points, existing verifier/red fixtures and
narrow public tests. No alias-editor change is needed. Do not alter REQ06's
`project_canonical_request.rs`, Server transport, Compat, response governance or
the official hosted-history assertions. Integrate only after the tool-output
author freezes its library changes. Parent owns map synchronization and delivery.

## Acceptance

1. Keep the existing main338 baseline and candidate red evidence. Do not rerun an
   unchanged baseline or weaken the original field-parity assertion.
2. The original public runtime hosted-history test passes with one provider
   attempt, an adjacent assistant/result pair and the final user turn.
3. Add a public SDK normalize/current inverse consumer. Cover Web Search,
   explicit and absent IDs, failed/completed status, unknown nested fields,
   nonobject/absent arguments, complete long strings and CRLF. Assert exact
   original event equality on the unchanged roundtrip, current action/result/
   unknown-field edits, field deletion and full history deletion. Assert both
   Chat emitted halves derive from the same current event and that native inverse
   reads that same value; no duplicate source truth or resurrection is permitted.
   Keep the real separate tool-search call/output public tests unchanged.
4. Add a real HTTP runtime consumer whose provider rejects a missing/reordered
   pair or altered complete action/result. Assert the provider receives the pair
   once and returns the expected public response. Absence of a current hosted
   declaration must not lose historical events. Current ordinary tool execution
   remains independent and unchanged.
   Include Anthropic native hosted blocks between an ordinary function call and
   its output. Assert native block types, order, complete current outcome and
   unchanged ordinary pairing. The source event must roundtrip natively once.
5. Run affected field library/current projection tests, the complete runtime
   field-parity integration target, operation-runner DAG and negative configuration
   gates. Save true exit codes and source/profile/test identities.
6. Those slice tests do not replace the complete candidate's Server entry,
   GPT-5.5/GPT-5.6 exec/apply_patch/MCP execution and follow-up, exact-SHA build,
   installed runtime, implementation architecture review, merge/push and cleanup.
