# P0 route control facts red test

## Hypothesis

`nodes.rs` currently calls `extract_active_turn_signals(body)` and derives route control from request business payload. The unique fix is a typed current-turn carrier built at the request execution boundary; `classify_route` must consume that carrier and no longer scan raw payload.

## Baseline evidence

- `v3/crates/routecodex-v3-route-classifier/src/active_turn.rs` exports `extract_active_turn_signals(&Value)`.
- `v3/crates/routecodex-v3-runtime/src/nodes.rs` calls it from `build_v3_router_request_facts_for_entry_with_control`.
- `docs/architecture/v3-verification-map.yml` keeps `vr.current_turn_typed_route_facts` at `design_not_implemented`.

## Red assertion

The source-boundary check failed at baseline while the raw-payload extraction call and exported helper were the classifier input surface. The production correction keeps parsing in the named current-turn builder and removes raw `Value` from `classify_route`; the failing condition is source-level, not behavior-only, because behavior can pass while the forbidden dependency remains at the classifier boundary.

## Positive / reverse contract

- Positive: typed current-turn facts classify the same current-turn tool/image/turn state deterministically.
- Reverse: changing historical messages or prose alone cannot create or alter route-control facts.
- Reverse: removing the typed carrier at the classifier boundary must fail compilation or the boundary gate; no raw `Value` shortcut is accepted.
