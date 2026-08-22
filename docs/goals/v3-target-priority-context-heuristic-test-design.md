# V3 Target context admission and priority regression design

## Contract

- Owner feature: `v3.virtual_router_target_interpreter`.
- Owner function: `V3TargetInterpreter::select_available` in `v3/crates/routecodex-v3-target/src/lib.rs`.
- Route order from `V3Router07OpaqueTargetHitOnce -> V3Target09CandidateSetExpanded` is the selection truth among compatible candidates.
- Only genuine `web_search/search` and `multimodal/vision` model capability checks may produce capability mismatch. Separately, Target10 must skip ordinary candidates whose `max_context_tokens` is below `request_input_tokens` before availability/transport; explicit direct pins and the default-pool floor remain last-resort eligible with a typed overflow reason.
- After context and capability admission, Provider availability/health and request-local provider-failure exclusion are the switch inputs at this edge. No provider-specific branch is allowed.

## Lifecycle test

1. Build a priority pool with `short` first and `long` second; both candidates satisfy the request capability contract.
2. Give the first target a context declaration smaller than the request and the second target a sufficient context window.
3. Positive: when the request is within `short`'s window, Target10 selects the configured first target without an overflow reason.
4. Negative: when the request exceeds `short`'s window, Target10 skips `short`, records `context_window_exceeded`, and selects `long`; request-local provider failure still switches to the next candidate.

## White-box impact

- Keep context admission in the Target10 owner; do not create a separate route-priority heuristic or payload cleanup path.
- Preserve genuine search/vision capability validation, health availability, direct pin semantics, default-floor semantics, candidate order among eligible candidates, and request-local failure exclusion.

## Module/project black-box impact

- Reproduce the failing Fable shape with a request estimate above its `262144` context window and prove Target10 does not select Fable for provider transport.
- Reproduce a 90% through 100% request and prove the candidate is demoted rather than filtered.
- Verify cc-sol uses its configured/catalog context truth and is not classified from Fable's upstream tokenizer count.

## Required evidence

- Red: focused Target test fails before implementation because old code keeps the over-limit `short` candidate selected and emits no `context_window_exceeded` evidence.
- Green: focused Target tests plus package tests pass.
- Architecture gates mapped to `v3.virtual_router_target_interpreter` pass or baseline failures are identified with unrelated file evidence.
- Online: provider-request dry-run proves an oversized Fable candidate is absent from Target10 selection, while a near-limit-only candidate remains selectable; a safe real in-band request proves provider send through the selected eligible target.

## Known boundary

- Provider tokenizers may still disagree with RCC's request estimate. A provider-returned context 400 remains health-neutral and enters Error01→06/reselection; that error must not rewrite Target context truth.
