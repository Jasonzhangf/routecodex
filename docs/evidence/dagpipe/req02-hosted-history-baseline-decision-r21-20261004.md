# Hosted web-search history: established baseline behavior

## Question and test

Parity diagnosis row8 could not establish whether converting existing hosted history to a Chat tool-call/result pair required a current web-search declaration. The user requires preserving existing behavior unless a decision is genuinely unknown. The parent therefore ran the original, unchanged public runtime regression on a clean latest-main tree, without the REQ02 candidate.

- Base/tree HEAD: `f1204ab19f10d84da8558c846990258dd20575d8`.
- Worktree: `req02-web-history-baseline-r21-20261004`.
- Command: `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-runtime --test responses_relay_field_parity_integration responses_openai_chat_field_parity_web_search_call_history_projects_tool_pair`.
- Result: 1PASS, 0FAIL, 12filtered, true exit0.
- Preserved log/exit: `req02-main338-web-history-baseline-r21.log` and `.exit` in this evidence directory.

The fixture contains a failed `web_search_call` historical event plus a user continuation and no current tools declaration. Baseline emits a historical assistant call named `web_search`, adjacent paired tool result containing the event, and the user continuation. The REQ02 candidate previously lost this history and failed the same unchanged assertion. This establishes a migration regression; no new execution policy is needed to preserve the history.

## Existing semantic mapping and owner

Baseline `responses_openai_codec.rs` routes `web_search_call` to its hosted-history pair helper. Existing call-id representation selects explicit call_id/tool_call_id/id or its declared stable source-index identifier. Arguments use the event action; the paired result retains the entire event, including unknown fields and failed status. This represents prior history; it does not enable a new web-search execution, synthesize a current declaration, change routing or implement local continuation.

The new REQ02 field-library owner must preserve that represented meaning in canonical Chat plus extensions, with source/encoding associations for reversal. Protocol distinctions use the registered field operator/profile configuration, not model/provider guesses. The old normalization chain must remain removed. The complete source event and unknown fields must remain recoverable; synthetic representation IDs do not replace original identities in inverse state. Actual current declarations still govern new response calls.

## Bounded next slice

Field rows1-5 remain owned by the active `req02-field-parity-main338-r21-20261004` author. Do not introduce a concurrent writer to that library. After its frozen result is accepted, implement hosted-history parity as the next slice in the same unique field owner, with exact operator/profile design admission when a new registration is required. Keep the original row8 assertion. Add a real HTTP public consumer covering failed/completed historical events, original IDs or absent IDs, unknown fields and exact action/result bytes, Responses roundtrip, Chat adjacency, user order and unaffected declared tool execution.

This evidence proves current source behavior and a public-runtime regression baseline. It does not prove candidate repair, real GCM tool acceptance, review, runtime delivery, merge or push.
