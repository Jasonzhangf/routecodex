# REQ02 Gemini toolConfig inverse prerequisite

Status: dependency development verification passed; public projection consumer, production cutover and REQ02 delivery remain **INCOMPLETE**.

## First divergence and owner

The private `project_direct_fields` treated registered `v3.gemini_tool_config_to_chat_tool_choice.v1` as an identity mapping. It wrote the canonical choice scalar/function object into the native `toolConfig` object, then collided when projecting `functionCallingConfig` children or emitted the wrong shape. This code has not been connected to the installed runtime.

Red evidence: `.execution/tool-config-inverse-red.log`, exit `101`, **9 passed / 3 failed**. The failures include `noncontainer path collision at request.toolConfig.functionCallingConfig.vendor` and `.allowedFunctionNames`, plus an exact native-shape mismatch. Red log SHA256: `6c6ae6f2c01b904429dba6bb36ae7d1cf35a29f1fdc345ddd584fa97b7fefedb`.

## Change

Only `operation_runner/operators/project_canonical_fields.rs` changed. The registered transform now consumes the current data-plane Gemini extension container and reverses the current canonical choice. An unchanged choice preserves the original native mode's presence and value. A changed declared choice maps to the native mode, and a pinned function name changes its native list. Current opaque siblings are retained; deleted siblings are not revived by old opaque references. Child associations within this owned container are consumed by the same inverse transform, so they cannot overwrite the current pinned name with an old list. The original data-plane source reference identifies the initial choice conversion, allowing a current extension name-list mutation to survive an unchanged Chat alias.

Dispatch uses the registered transform identity. No model-name rules, tool-argument parsing, payload/control mirrors, inbound replay or production caller changes were introduced.

## Verification

Command: `node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-runtime --lib operation_runner`.

Final evidence: `.execution/tool-config-inverse-operation-final-r2.log`, `.exit`: **83 passed / 0 failed / exit 0**. These include six focused toolConfig tests and the existing runner/resource/path/field/tool dependency tests. Final log SHA256: `8535b11cae96cafe7d7123fc0aad5c7597f3d3f7aa14fe50659a4781038cae53`. The earlier 82-test log remains preserved as intermediate evidence.

Source SHA256: `67bab42dbabe91ed1afbf3a10d5d7696f2b4b83517beacaf7c026188ce137fba`.

Baseline HEAD: `73083890f6bb86635a50526f263b98349b338efd` plus the parent uncommitted candidate. The prior complete manifest predates this source change; checking it identified exactly one changed entry, this helper.

Updated complete manifest: `.execution/tool-config-inverse-candidate-inputs-r2.sha256`, SHA256 `2993a1ce8e03ce04046e4c37bcfccee87260fbf7778e8b1b1732fa1885e801e8`. Post-gate `shasum -c --quiet` verified all entries, exit `0` recorded in the adjacent `.exit`.

Updated complete architecture gate: `.execution/tool-config-inverse-architecture-r2.log`, `.exit`: **40/40 sub-gates green / exit 0**. Log SHA256 `8c16b703515382c9df11574640f2debf5783af16bf86054f080582fcc6d32318`. This result binds the parent candidate before any history worker is composed. Subsequent composition invalidates affected source/gate evidence and must be verified.

These are prerequisite development tests. They do not prove public full projection, provider/client round-trip behavior, installed runtime, independent review, merge or push. 4444 was not modified.
