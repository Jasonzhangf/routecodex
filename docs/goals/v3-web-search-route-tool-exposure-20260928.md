# Web Search Tool Exposure at Provider Request

## Goal and authorization

Jason's 2026-09-28 request: “如果web_search路由没有声明,或者不可用,直接切掉web_search工具,避免错误工具发送到provider”. This authorizes the narrow provider-bound tool exposure behavior described here. It does not authorize rewriting the client's request, routing to a different provider, or suppressing unrelated tools.

The initial implementation that inferred route availability from `candidate.pool_ids.first() == "web_search"` failed independent architecture review. Pool names are configurable, model pools can precede search pools, and a direct pin has synthetic pool provenance. That implementation must not be merged.

## Single-entry, single-exit request path

```text
client JSON
  -> ReqInbound lossless canonicalization
  -> Router/Target resolve the main model for this attempt
  -> Req04 Chat Process keeps complete canonical tools and tool choice
  -> Router declaration and Target eligibility are read as typed policy facts
     for the current server's explicit web_search route
  -> Req07 consumes that typed availability and projects a fresh provider copy
  -> standard protocol projection
  -> provider-private Compat
  -> provider transport or typed Error chain
```

Each retry or provider switch starts again from the unchanged Req04 canonical request. Direct consumes the same typed exposure decision in its registered request hook. No decision is reconstructed from payload, logs, debug paths, `pool_ids`, or provider names.

The main model and the configured search route are separate. A direct pin only fixes the main model; it does not create a search route. `web_search` is declared only by an explicit pool matching the Router's existing route selector, including `required_capabilities = ["web_search"]` under another pool name, and satisfying that pool's ordinary entry protocol, client model, token bounds, and capability predicates for this request. An implicit capability pool is not a declaration. For this narrow exposure policy, route availability means at least one declared route candidate is currently request-eligible under Target's existing scheduling/health rules. This is an independent configuration/health gate, not search backend readiness: native hosted search executes at the selected main provider; local search executes through hooks sidecar and its configured backend binding. Neither current execution path consumes a search-route candidate selected by this policy check. The main model's search capability is an additional provider-wire requirement. Later search execution failures stay in the Error chain.

| Search declaration | Declared search-route candidate eligible | Main model can receive search tool | Provider-bound built-in tool |
| --- | --- | --- | --- |
| absent | irrelevant | either | omit |
| present | none | either | omit |
| present | at least one | no | omit |
| present | at least one | yes | retain/project |

The same table applies when the main model is direct-pinned, when a different main-model pool wins, and after each provider reselect. Local sidecar readiness is not inferred from socket existence or `ControlRequest::Health`: neither proves the search operation can complete. The table covers configured route and Target eligibility only. A local backend outage is a different observable state and remains with the existing Error-chain recovery until a real typed readiness producer and consumer are designed.

## Narrow owner correction

Req04 remains the sole owner of persistent Relay Chat semantics and never removes the client's search declaration. Router owns explicit route declaration; Target owns declared search-route candidate eligibility. Req07 consumes their typed facts for provider-bound projection, freshly on every attempt. Req07 may omit only built-in `web_search`, `web_search_preview`, and `web_search_20250305` declarations, plus a forced choice/options that refer to that omitted built-in tool. It must preserve ordinary functions named `web_search`, other tools, all arguments, and client history. Provider Compat must not make a routing decision or filter tools. Direct uses the same pure projection operator through its registered request hook. The DAGPipe `resolve_target -> plan_execution -> govern_chat_request -> project_standard_provider_request` order remains unchanged.

Proposed control resources are `v3.web_search.route_declaration` (Router06 owns the current server and request's explicit matching pool) and `v3.web_search.route_eligibility` (Target10 owns a read-only projection over that pool's candidates and current health). Both are written inside the existing `resolve_target` operation; Req07 and the registered Direct request hook read them. A producer explicitly emits `false` when configuration has no matching declaration or no eligible candidate. A missing resource, producer failure, or consumer read failure is a broken control edge and enters the typed Error chain; it must not silently remove a tool. The availability projection must not advance a selection cursor, create a provider attempt, reselect the main model, mutate health, or call a search backend. Req07 owns the only provider-copy omission operation. No backward edge reaches Req04. The DAGPipe graph declares these resources and consumers; the caller/resource/owner maps plus audit lock must record the exact edge and Jason authorization **before product-code edits**. The 2026-09-28 instruction above authorizes this narrow tool exposure behavior only; it does not authorize a broader Outbound filtering right. The design requires independent DAG review PASS before implementation.

## Acceptance evidence

- Same-entry provider-request dry-run: absent route, direct pin, and selected search-capable model omit the built-in search tool while preserving another function tool.
- A declared route with a different pool name preserves search for an eligible search-capable target.
- A declared route whose search-backend candidates are all ineligible omits search on the selected main-model attempt; an eligible route retains it even if a previous search execution failed and that failure remains in the Error chain.
- An explicit pool that fails this request's entry protocol, client model, token bound, or required capability does not count as a declared matching route.
- In one request, both `allowed first attempt -> ineligible after provider reselect` and `ineligible first attempt -> allowed after health recovery` regenerate provider copies from the intact canonical request. The eligibility read does not change the route cursor, health, attempt count, or main-model selection.
- Direct and Relay use the same decision, and Chat, Responses, Anthropic, and Gemini provider projections never receive an unavailable built-in search tool.
- Review only after focused tests, architecture gates, and real HTTP entry evidence; merge only after independent architecture PASS. The merged runtime must then be rebuilt, installed, restarted with `rccv3 restart -c <active-config>`, and replayed at the original entry.
