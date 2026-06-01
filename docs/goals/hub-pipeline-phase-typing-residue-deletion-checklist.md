# Hub Pipeline Phase Typing Residue Deletion Checklist

## Status

No safe live-path deletion in this phase.

Phase 3/4/5 adds contract wrappers and red tests only. Existing `req_process_*` and `resp_process_*` files remain live Rust stage implementations and must not be deleted as part of this typing pass.

## Not Safe To Delete Yet

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage2_route_select.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage2_finalize.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/`

## Deletion Rule

Delete only after a later migration proves the live path has moved behind `ReqChatProcess` / `RespChatProcess` typed entrypoints, with red tests failing on old direct imports and green runtime verification after deletion.
