# V3/V2 Route Classifier Parity Test Design

## Goal

Characterize V2 route behavior, then implement and lock the equivalent contract in V3's own
Rust crate. V2 and V3 must not share a runtime crate or owner. V3 must classify the active turn,
capture the same ordered optional route candidates as the accepted V2 behavior, and append the
mandatory `default` tier inside the original V3 Virtual Router plan. Provider health, cooldown,
context rejection, and request-local failure exclusion remain Target/Error concerns.

## Verified pre-fix gaps

1. V3 marks `thinking` when any historical user item exists; V2 marks it only when the active turn
   ends in fresh user input (or a classified thinking continuation).
2. V3 marks `coding`, `search`, and `tools` from the declared tool inventory; V2 classifies those
   routes only from actual tool calls and outputs inside the active turn segment.
3. V3 independently ranks every matching fact and captures one optional pool; V2 emits an ordered
   route queue containing the primary route, a triggered `longcontext` candidate when it is not
   already primary, and the mandatory `default`.
4. V3's request `reasoning` field can force `thinking` during a tool-output continuation; V2 does
   not use that request option as the active-turn route owner.
5. V3 used a fixed `180000` route threshold instead of the current server route group's configured
   `longcontext.match.min_input_tokens` value.
6. V3 trusted client `metadata.hasImageAttachment` as routing truth. Client protocol metadata is
   payload data, not RouteCodex control; image capability must come from actual protocol image
   items in the normalized request.
7. The V2-to-V3 config compiler emitted `longcontext` as a capability-only pool and discarded
   `virtualrouter.classifier.longContextThresholdTokens`, so a V2-authored listener could never
   activate V3's config-owned longcontext classifier.

## Lifecycle cases

| Active turn | Expected primary route | Required following tiers |
| --- | --- | --- |
| fresh user text below longcontext threshold | `thinking` | `default` |
| fresh-user, thinking/search/tools, or background turn at or above longcontext threshold | `longcontext` | `default` |
| actual protocol image item | `multimodal` | triggered `longcontext`, then `default` |
| fresh user web intent, independent of declared tools | `thinking` + required capability `web_search` | triggered `longcontext`, then `default` |
| actual web-search tool continuation in the active turn | `tools` + required capability `web_search` | triggered `longcontext`, then `default` |
| coding tool output below longcontext threshold | `coding` | `default` |
| test/build/lint tool output below longcontext threshold | `tools` | `default` |
| search tool output below longcontext threshold | `search` | `default` |
| thinking tool output below longcontext threshold | `thinking` | `default` |
| other/unknown tool output below longcontext threshold | `tools` | `default` |
| no active route signal | `default` | none |

## Positive tests

- Independent V2 and V3 classifiers select the same primary route, reason, and candidate order
  for all accepted matrix rows.
- The V3 route order is `multimodal > thinking > coding > longcontext > search > tools > background > default`; web_search is a required target capability, not a route; the thinking trigger is disabled at longcontext, while coding continuation remains above longcontext exactly as characterized from V2.
- V2 preserves its current public classification output in its own owner. V3 contains a complete
  independent implementation and does not call, import, or link the V2/shared classifier.
- V3 request-fact extraction scopes user text, tool calls, tool outputs, and last assistant tool
  category to the active turn.
- V3 derives multimodal capability from actual image items in current normalized protocol data.
  Client `metadata` never becomes routing or MetadataCenter control.
- V3 Virtual Router captures every configured candidate route tier in shared-contract order and one
  mandatory `default` tier, with one VR hit.
- Target preserves configured candidate order and applies only genuine capability/health/request-local
  availability; it does not infer a 90% context-near-limit veto from model catalog metadata.
- The same request crosses `longcontext` only when it reaches the active server group's configured
  route threshold; changing that threshold changes classification without a code change.
- Once that configured threshold is crossed, `longcontext` outranks fresh-user thinking,
  thinking/search/tools continuations, and background. Multimodal and coding continuations retain priority above longcontext; strict current-turn `web_search` records required target capability without becoming a route reason.
- V2 config compilation preserves `virtualrouter.classifier.longContextThresholdTokens` as the
  compiled longcontext pool's `match.min_input_tokens`; an omitted V2 field preserves V2's 180000
  default through the same compiled config field.

## Negative tests

- Historical user text does not force V3 `thinking` during a tool-output continuation.
- Historical assistant tool calls and outputs do not set active tool-output facts for a fresh user.
- Declaring `exec_command`, `tool_search`, or other coding tools does not by itself route a fresh
  user turn to `coding`, `search`, or `tools`.
- An explicit `tool_choice` or `additional_tools` declaration does not count as an actual tool call.
- A request-level `reasoning` option does not overwrite a coding/search/tool continuation route.
- Missing or higher longcontext route thresholds do not activate longcontext through a built-in
  token constant.
- A native V3 `longcontext` pool without `min_input_tokens` fails config compilation instead of
  becoming a silently unreachable route.
- Declared web-search tools of every spelling and shape contribute zero route signal.
- Historical web-search intent does not add `web_search` capability or select a web_search pool.
- Client metadata claims, stringified image JSON, image placeholders, and tool descriptions do not
  select `multimodal` without an actual protocol image item.
- Missing optional route pools are skipped while the already captured `default` tier remains; no
  second Virtual Router call or runtime fallback is introduced.
- Malformed shell/apply_patch/write_stdin calls are not classified; `cargo test` and mutating git
  commands route through `tools`, while read/search/write commands preserve the V2 category matrix.

## Verification map

- Independent V2 classifier tests and V3-local classifier tests.
- `npm run test:v3-route-classifier-semantics` is the V3 semantic gate.
- `npm run test:route-classifier-semantics` runs V2 characterization and V3 parity independently.
- `npm run verify:v3-route-classifier-local-owner` rejects any V3 dependency on the V2/shared
  classifier and is wired into V3 build and CI.
- V2 classifier and route-queue tests.
- `routecodex-v3-runtime` node tests.
- `routecodex-v3-virtual-router` route-plan tests.
- `npm run test:v3-p5-router-target`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:v3-cargo-fmt`
- `npm run verify:v3-clippy`
- `git diff --check`
- Installed V3 build plus 5555 real probes for fresh-user thinking and tool-output continuation.

## Known boundary

Target context admission remains a separate owner from route classification. The classifier
supplies route order, RCC-owned active-turn input tokens, and the configured longcontext threshold;
Target10 first applies the candidate model's validated context-token estimate scale (default 1.0), then compares those tokens with each candidate context window. Below 90% keeps configured
priority, 90% through 100% is demoted but retained, and above 100% is filtered before transport.
Provider tokenizer disagreement can still produce a health-neutral context error in the provider
error/switch chain, but that error cannot rewrite Target token truth.
