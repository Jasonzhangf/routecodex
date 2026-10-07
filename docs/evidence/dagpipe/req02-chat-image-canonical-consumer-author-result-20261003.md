# Req02 Chat Image Canonical Consumer Result

## Status

`INCOMPLETE`

Implemented the permitted minimal canonical consumer and the single Chat Process cleanup edge. The four-protocol public behavior gate is blocked at the canonical Gemini `media` shape, which the read-only helper does not support. No HTTP/WS or full tool-round-trip claim is made.

## Scope Completed

- Added `build_v3_hub_req_inbound_02_from_canonical(input: V3HubReqInbound01ClientRaw, canonical: Value) -> V3HubReqInbound02Normalized`.
- The constructor passes the canonical value directly to `previous.payload`, preserves entry protocol, invocation source, and transport intent, sets semantic protocol to Chat, and sets `canonicalized_from_responses = true` only as the unified canonical consumer marker.
- Removed historical image cleanup calls from the old ReqInbound02 protocol normalization branches.
- Added cleanup exactly once at the public ReqChatProcess04 constructor.
- Added the public server test `req02_chat_history_images`.

## Changed Paths

- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs`
- `v3/crates/routecodex-v3-server/tests/req02_chat_history_images.rs`
- `docs/goals/req02-chat-image-owner-blocker-20261003.md`
- `docs/goals/req02-chat-image-owner-result-20261003.md`

## Verification

### API compile red before implementation

Command:

```bash
cd /Volumes/Intel/playground/routecodex/req02-chat-image-owner-20261003
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_chat_history_images -- --nocapture
```

- Actual exit: `101`
- Result: missing `build_v3_hub_req_inbound_02_from_canonical`
- Evidence: `docs/goals/req02-chat-image-owner-compile-red-20261003.execution.log`

### Public behavior red after implementation

- Same command.
- Actual exit: `101`
- Result: Gemini canonical media history image survives Req04 unchanged.
- Evidence: `docs/goals/req02-chat-image-owner-behavior-red-20261003.execution.log`

### Existing helper regression

Command:

```bash
cd /Volumes/Intel/playground/routecodex/req02-chat-image-owner-20261003
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib history_image -- --nocapture
```

- Actual exit: `0`
- Result: 19 passed, 0 failed.
- Evidence: `docs/goals/req02-chat-image-owner-runtime-history-image-20261003.execution.log`

### ReqInbound02 regression

Command:

```bash
cd /Volumes/Intel/playground/routecodex/req02-chat-image-owner-20261003
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib req_inbound_02 -- --nocapture
```

- Actual exit: `0`
- Result: 5 passed, 0 failed.
- Evidence: `docs/goals/req02-chat-image-owner-runtime-req-inbound-02-20261003.execution.log`

## Source and Test Hashes

- `req_inbound_02_normalized.rs`: `5b11ff3bd381b91592a90f31aa38e399dede50236943af4943620fc3b19ff9d0`
- `req_chat_process_04_governed.rs`: `3a3631664cb5ece36a8215a9072641c91814ab4e03c03038afe2a30cb8818349`
- `req02_chat_history_images.rs`: `226d6741c2f59ecc36cafc1aadf273eb300b10d17a0db6aeb1a9aa37f0b29ce5`
- `behavior-red log`: `5ee6fe5ab085cff3cd3c07f43dcef0671f56f597ccc0431eb84c191e20dc83c0`
- `compile-red log`: `d036ab082897994e4b572f1cc9a49d83c042d56438b4d45b78e77ffad368b6d5`

## Remaining Gate

The helper owner must support canonical Gemini media cleanup. Until then, the public four-protocol consumer test is red and this result remains `INCOMPLETE`.
