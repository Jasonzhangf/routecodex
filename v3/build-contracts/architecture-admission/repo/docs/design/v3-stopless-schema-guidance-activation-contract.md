# V3 Stopless Schema Guidance Activation Contract

## Purpose

This document defines the same-turn schema guidance activation contract. Stopless may intercept an abnormal `stop` / `end_turn` response only when the same scoped provider turn is already in the StoplessCenter MetadataCenter state machine with `schema_guidance_active=true`. The request-side schema guidance is the state-machine activation precondition; response-side canonical reasoning `summary` and schema evidence are the completion-or-continuation decision source.

## Contract

0. **Designed protocol projection, not accidental control leakage**: Stopless current-turn injection is an intentional Chat Process protocol behavior. Req04 may project registered transparent guidance, tool declarations, tool calls, or continuation actions into the current provider-bound turn. Resp03 may remove the matching current-turn internal Stopless action/result before client projection. These protocol artifacts are distinct from StoplessCenter state: counters, phase, scope, routing identity, budget, transition reason, and other control fields remain MetadataCenter-only.
1. **Activation precondition**: Resp03 may run stopless interception only if the current scoped StoplessCenter state machine is in a same-turn schema-guidance active state produced by Req04 for the same request/turn. This is MetadataCenter runtime-control state, not an ad-hoc activation marker and not provider/client payload. Loose activation marker is forbidden.
2. **State-machine write**: Req04 legal guidance injection transitions scoped StoplessCenter to `ProviderTurnInFlight` with state-machine fields equivalent to `schema_guidance_active=true`, `schema_guidance_request_id=current_request_id`, and `schema_guidance_contract=stop_schema`.
3. **Terminal surface**: Only `finish_reason=stop` / `stop_reason=end_turn` / protocol-equivalent natural stops are eligible. Non-stop progress and ordinary tool calls bypass stopless and reset scoped state.
4. **Accepted evidence**: Resp03 accepts either canonical reasoning `summary` or canonical `stop_schema` / `stopSchema` sibling evidence. Assistant visible text, fenced JSON, `<rcc_stop_schema>`, and CLI stdout are never evidence.
5. **Pass-through**: If accepted summary exists, pass through unless an accepted schema explicitly says unfinished. If accepted schema says finished or blocked with required evidence, pass through and clear/update control state.
6. **Continuation**: If the StoplessCenter active state exists and the terminal stop has neither accepted summary nor accepted schema, or has accepted unfinished schema, project the no-input CLI bridge and continue by standard Req04 guidance on the next turn.
7. **No activation / Inactive state, no intercept**: If the current scoped StoplessCenter state machine is not schema-guidance active for this turn, Resp03 must not synthesize stopless CLI, must not write StoplessCenter, and must pass through the provider stop response.
8. **Provider validation exception**: If a provider such as Anthropic rejects or structurally validates against the guidance/system schema, RouteCodex must not force illegal injection. The scoped StoplessCenter state remains inactive for that turn, so stopless interception is disabled.
9. **Path scope**: The rule applies to Responses-protocol provider turns whether they are direct or relay. Semantic owner remains `StoplessCenterMetadataControl` under MetadataCenter. Relay writes only the Relay adapter handle (`V3ResponsesRelayStoplessControlState`). Direct writes only the Direct-scoped adapter handle (`V3ResponsesDirectStoplessControlState`) after `SameProtocolDirect` decision, and must never write Relay StoplessCenter, invent non-native remote continuation state, or re-enter Relay Chat Process for stopless. Direct no-op projection may commit a Direct remote locator for the provider-native response id so the next `previous_response_id` stays Direct.
10. **Current-turn provenance**: Every injected or stripped Stopless artifact must be attributable to the same request/turn, scope, registered Stopless declaration, and exact call identity. Literal text, a similarly named client tool, unmatched tool output, or an artifact from an earlier turn is not Stopless provenance and must remain unchanged.
11. **History immutability**: Req04 injection appends or adjusts only the current provider-bound turn. It must not rewrite, remove, reorder, deduplicate, or relabel any historical user, assistant, tool-call, tool-result, reasoning, image, attachment, or guidance content. Resp03 stripping applies only to matching internal artifacts produced in the current response.
12. **Continuation immutable interval**: After Resp04 saves the governed current response and before the next Req04 restores it, no Stopless classification, injection, stripping, tool/result repair, history rewrite, or state reconstruction may occur. Transport, protocol-equivalent framing, scope validation, storage, restore, and release are the only permitted operations.
13. **Visibility boundary**: Provider visibility of the current-turn injected protocol action is required by design. Client visibility is limited to the client protocol's intended continuation surface; internal implementation labels, RouteCodex/proxy identity, MetadataCenter fields, counters, budgets, scope, debug data, and transition reasons are forbidden.

## Decision Matrix

| StoplessCenter `schema_guidance_active` for same turn | Terminal stop/end_turn | Accepted summary | Accepted schema | Decision |
| --- | --- | --- | --- | --- |
| no | yes | any | any | Pass through; no stopless state write/projection |
| yes | no | any | any | Normal non-stop/tool progress; reset/pass through |
| yes | yes | yes | none | Pass through; summary is accepted completion evidence |
| yes | yes | any | finished/blocked with required evidence | Pass through terminal; clear/update control state |
| yes | yes | any | unfinished/nextStep | Continue; store scoped next-step prompt only |
| yes | yes | no | no | Continue; project no-input CLI bridge before continuation commit |

## Owner Boundary

- Req04 injects registered current-turn schema guidance/tool/action and writes the same-turn activation as a StoplessCenter MetadataCenter state-machine transition. It does not mutate restored history.
- Resp03 reads same-turn StoplessCenter state plus response evidence, strips only the matching current-turn internal action/result, and decides pass-through vs continuation before Resp04 continuation commit.
- Resp04 saves the already governed current response. It does not own Stopless injection, stripping, classification, or repair.
- SSE, server handler, resp_outbound, req_inbound, provider runtime, and continuation store are not semantic owners and must not infer or repair activation.

## Required Gates

- `npm run verify:v3-stopless-resource-control`
- `npm run test:v3-stopless-resource-control-red-fixtures`
- `npm run verify:v3-stopless-state-machine-docs`
- `npm run test:v3-stopless-state-machine-docs-red-fixtures`
