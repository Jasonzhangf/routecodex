# V3 Target context admission and priority regression design

## Contract

- Owner feature: `v3.virtual_router_target_interpreter`.
- Owner function: `V3TargetInterpreter::select_available` in `v3/crates/routecodex-v3-target/src/lib.rs`.
- Route order from `V3Router07OpaqueTargetHitOnce -> V3Target09CandidateSetExpanded` remains the configured priority truth among candidates in the same context-admission class.
- Target10 compares the request's RCC-owned `request_input_tokens` with each candidate's `max_context_tokens`; it never reconstructs token counts from provider errors or payload metadata.
- Context admission has exactly three classes: below 90% keeps configured priority, 90% through 100% remains eligible but is ordered after every below-90% candidate, and above 100% is filtered before provider transport.
- A missing `max_context_tokens` remains eligible in the normal class. Genuine `web_search/search` and `multimodal/vision` capability mismatch remains an independent hard filter.
- After context and capability admission, Provider availability/health and request-local provider-failure exclusion remain explicit switch inputs. No provider-specific branch, payload mutation, or Error/SSE compensation is allowed.

## Lifecycle test

1. Build a priority pool with `short` first and `long` second; both candidates satisfy the request capability contract.
2. Positive normal: below 90% of `short`, Target10 selects `short` by configured priority.
3. Positive near-limit: from 90% through 100% of `short`, Target10 keeps `short` eligible but selects normal-class `long` first.
4. Positive retained boundary: at exactly 100%, if normal-class alternatives are unavailable, Target10 may still select `short`.
5. Negative oversized: above 100%, Target10 filters `short`; it cannot be revived by provider health or default-floor behavior.
6. Negative all oversized: when every declared candidate is oversized, Target10 exhausts before provider transport and reports each context admission rejection.

## White-box impact

- Add one Target-owned context admission classifier using integer-safe comparisons.
- Select normal-class candidates first, then near-limit candidates, preserving configured order inside each class.
- Preserve genuine search/vision capability validation, health availability, direct pin semantics for context-eligible targets, default-floor semantics, and request-local failure exclusion.

## Module/project black-box impact

- Reproduce the failing Fable shape with a request estimate above its `262144` context window and prove Target10 does not select Fable for provider transport.
- Reproduce a 90% through 100% request and prove the candidate is demoted rather than filtered.
- Verify cc-sol uses its configured/catalog context truth and is not classified from Fable's upstream tokenizer count.

## Required evidence

- Red: focused Target tests fail before implementation because current Target always selects configured priority without context admission.
- Green: focused Target tests plus package tests pass.
- Architecture gates mapped to `v3.virtual_router_target_interpreter` pass or baseline failures are identified with unrelated file evidence.
- Online: provider-request dry-run proves an oversized Fable candidate is absent from Target10 selection, while a near-limit-only candidate remains selectable; a safe real in-band request proves provider send through the selected eligible target.

## Known boundary

- Provider tokenizers may still disagree with RCC's request estimate. A provider-returned context 400 remains health-neutral and enters Error01→06/reselection; that error must not rewrite Target context truth.
