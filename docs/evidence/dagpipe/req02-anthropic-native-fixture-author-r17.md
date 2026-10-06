# REQ02 Anthropic native fixture correction - r17 result

Status: DONE for the bounded author task.

Input

- Tree: `/Volumes/Intel/playground/routecodex/req02-anthropic-response-r15-20261004`
- Input HEAD: `3d2fa062c9933a48e726591f78a32f2e30aee67b`
- Writable source: `v3/crates/routecodex-v3-server/tests/req02_protocol_relay_consumers.rs`
- Changed-file SHA256: `1abf0a956161a23383fa2ae13dda36a81cfef86e7c721e157cecc0cb78e491cf`

Correction

- Replaced the invalid Responses-style namespace declarations in `anthropic_tool_relay_capture` with flat native Anthropic declarations:
  `functions.exec`, `custom.apply_patch`, and `mcp__search.find`, each with `input_schema`.
- Kept all original call IDs, exec command bytes, apply_patch bytes, SSE partial payloads, nested MCP query/limit values, stop reasons, and real HTTP endpoints.
- Updated the provider declaration assertion to keep encoding/restoration evidence. `functions.exec` and `custom.apply_patch` pass through unchanged on the provider wire; provider MCP name `mcp__search__find` is distinct from the restored client name `mcp__search.find`.

Command and result

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test req02_protocol_relay_consumers req02_anthropic
```

- True exit: `0` (`.execution/anthropic-native-r17-public.exit`)
- Test count: `4 passed; 0 failed; 0 ignored; 0 measured; 2 filtered out`
- Public log: `.execution/anthropic-native-r17-public.log`
- Tests: plain Anthropic JSON, plain Anthropic SSE, tool JSON, tool SSE

Scoped diff

- `git diff --stat` for the changed source: `1 file changed, 242 insertions(+)`
- The diff is test-only and confined to the authorized file. No Rust product source, profile, standard builder, map, or other test was changed by this task.

Remaining gap

- This correction proves the four targeted successful-attempt tool cases. Full Anthropic failure/EOF/cancel successful-attempt lifecycle coverage still requires the separate product slice owned by the parent.
