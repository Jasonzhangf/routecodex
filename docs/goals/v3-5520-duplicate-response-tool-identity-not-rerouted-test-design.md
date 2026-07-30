# V3 5520 Duplicate Response Tool Identity Error05 Test Design

## Lifecycle

`ProviderRespInbound01Raw -> ProviderRespCompat02ProviderCompat -> V3HubRespInbound02Normalized -> V3HubRespChatProcess03Governed -> V3Error01SourceRaised -> V3Error02Classified -> V3Error03TargetLocalAction -> V3Error04TargetExhaustionDecision -> V3Error05ExecutionDecision -> reselect or V3Error06ClientProjected`

## White-Box

- Lock Responses SSE terminal merge identity: every output item carrying a non-empty `call_id` uses it as semantic identity and `id` only as fallback; items without `call_id` use `id`. This covers function/custom/tool calls plus provider-native call families such as `tool_search_call` without a brittle type allowlist.
- Positive control: stream item and terminal item with the same `call_id` but different item `id` merge into one tool call.
- Positive control: a `tool_search_call` with a stream-only item `id` and a stable terminal `call_id` also merges into one item.
- Negative control: two provider-origin tool calls with distinct `call_id` values remain distinct even if their item `id` values collide; Resp03 still rejects actual duplicate `call_id` values.
- Keep `duplicate_response_tool_identity_fails_inside_response_chat_process` proving Resp03 rejects duplicate `call_id`.
- Lock `is_v3_responses_provider_response_failure` to classify provider-origin `V3HubRelayResponseError` variants, excluding local execution-mode and stopless projection defects.
- Lock `provider_response_hook_failure` to preserve `V3HubRespChatProcess03Governed` as the first-failure stage for Resp03 malformed provider output.
- Negative control: a real `V3ProviderError::ResponseBody` remains owned by `V3ProviderRespInbound01Raw`; do not change the shared raw provider-stage classifier.
- Lock the Error05 console projection for a switching provider failure: print the selected next target first as `[switch to:...]`, then the failed current target as `[switch from:...]`; print status/type/message cause fields only after both identities. A terminal failure without `next_provider_key` must not be mislabeled as a switch.

## Module Black-Box

- JSON: first provider returns two function calls with the same `call_id`; second provider returns a valid response. Assert two sends, one provider failure event, Error05 reselection trace, and HTTP 200 from the second provider.
- SSE: first provider streams two output items with the same `call_id`; second provider streams a valid terminal response. Assert the same Error05 reselection behavior.
- Positive controls: one valid function call and two distinct tool identities do not emit provider failure events.
- Terminal control: a single-provider/default-floor fixture projects typed Responses error after policy exhaustion, reports `/error/stage=V3HubRespChatProcess03Governed`, and never projects malformed output as success.
- Console control: a switching provider-error line must be unambiguous without relying on the prefix or a second provider-switch line; terminal errors retain `target=... result=... next=-` because no switch occurred.

## Project Black-Box

- Build and globally install the reviewed V3 runtime.
- Restart only with `routecodex restart --port 5555`; verify 10000/5520/5555 health and identical build version.
- Replay the saved 5520 request sample. Accept only provider switch/reselection or typed terminal Responses `event: error`; reject generic `responses_relay_runtime_error` caused directly by Resp03.

## Known Gap Before Fix

JSON and SSE both call `run_json_response_hooks`, but `V3ResponsesRelayRuntimeError::Response` currently falls through the non-provider branch. The existing Resp03 unit test proves detection only; it does not prove Error05 routing.

The SSE terminal merge currently reads `id` before `call_id` for every output type. Providers may emit a different item `id` in `response.completed.output` while preserving the same tool `call_id`; the merge misses the semantic match, inserts a second tool item, and Resp03 then reports a false duplicate `call_id/id` provider failure.
