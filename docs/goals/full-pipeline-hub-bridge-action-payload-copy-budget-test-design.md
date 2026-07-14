# Hub Bridge Action Payload Copy Budget Test Design

## Scope

`feature_id: hub.bridge_action_payload_copy_budget` owns transient payload ownership inside Rust `run_bridge_action_pipeline`. It does not own bridge policy selection, action semantics, request/response protocol projection, provider configuration, MetadataCenter, or client/provider payload truth.

## Lifecycle

1. One `BridgeActionState` owns messages, raw request, raw response, captured tool results, and bridge metadata.
2. Configured actions execute in declared order.
3. Read-only actions borrow raw request/response state.
4. Mutating actions temporarily take ownership of the exact state field and return it to the same state slot.
5. The final state is serialized once by the existing N-API wrapper or consumed by the internal Rust caller.

## Positive Cases

- Two consecutive request actions can borrow the same raw request and two consecutive response actions can borrow the same raw response.
- A mutating metadata action returns raw request and metadata ownership before the next configured action runs.
- Final messages, raw request, raw response, captured tool results, and metadata remain semantically equivalent.
- `capturedToolResults: []` remains present when capture finds no result, and non-object metadata remains unchanged when no metadata update applies.
- Placeholder filtering that finds no matching call id returns the original captured result owner to pipeline state.
- The existing N-API JSON wrapper returns captured results normally and never exposes the internal retained-owner transfer field.
- Unknown actions remain ignored under the existing contract.

## Negative Cases

- `pipeline.rs` must not clone complete `state.raw_request` or `state.raw_response` per action.
- It must not clone complete captured tool-result or metadata trees before actions that return updated ownership.
- Request-outbound history normalization must not clone the complete raw tools array solely to read it.
- Borrowed action cores must not become duplicate semantic implementations.
- `Option::take()` must not change `Some([])` into `None` or discard non-object metadata and unmatched captured tool results.

## Required Gates

- Focused red/green Jest source gate.
- Focused Rust Hub bridge action pipeline tests.
- `npm run verify:hub-response-responses-chat-projection`
- `npm run verify:request-payload-copy-budget`
- `npm run build:native-hotpath`
- Target `cargo fmt --check`
- Target `git diff --check`

## Known Gap

This slice removes repeated in-process Rust object graph clones. The outer JSON-string N-API serialization remains a contract limit, and process RSS improvement requires installed-runtime large-payload replay evidence.
