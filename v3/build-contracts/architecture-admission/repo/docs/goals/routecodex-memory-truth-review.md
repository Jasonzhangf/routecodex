# RouteCodex memory truth review

Date: 2026-09-05

## Confirmed and recorded

- V3 is the production baseline; V4 is an unconnected refactor.
- V2 runtime, config-reader ownership, migration paths, and backups are retired.
- Architecture is fixed skeleton plus typed configuration, with physical data/control separation.
- Same-protocol defaults to Direct unless configuration explicitly selects Relay.
- Direct payload rewriting is Direct-hook-only; Relay payload rewriting is Chat-Process-only.
- Inbound is lossless normalization; Outbound is standard projection with explicit compatibility filtering; Compat is provider-private adjustment.
- SSE owns client communication; Provider is decoupled through a full-attempt buffer and independent Error chain.
- Internal request/response failures use 598/599; network failures use 502; external failures retain real status.

## Needs remediation before architecture closure

- Direct typed hooks currently reference semantic implementation in `resp_chat_process_03_governed.rs`; verify and move Direct rewrite ownership inside the registered Direct hook boundary.
- Current maps describe some Outbound and Compat nodes as payload writers. Verify that they perform only protocol projection/private adjustment and explicit compatibility filtering, never general rewriting.
- Current response resources allow both Inbound and Chat Process writers. Split normalization output from governed rewrite output so Inbound remains normalization-only.
- Verify that the full-attempt buffer and client commit barrier apply to every Direct and Relay provider response, not only the mapped Direct SSE feature.
- Bind the confirmed error status policy as explicit resource/function/mainline/verification contracts for both Direct and Relay.
- Remove actual V2 runtime/config-reader/backup ownership after distinguishing it from protocol-version names such as `websocket_v2` or `tool_thinking_json_v2`.

## Not yet clarified

- Whether protocol-version identifiers containing `v2` are renamed or retained.
- Detailed V4 Cordis node status, parity scope, cutover plan, and admission gates.
- Provider inventory, ports, keys, active config paths, and deployment state.
- Continuation, Stopless, toolreason, provider health, WebUI, and retry implementation details.
- Historical commits, review IDs, run IDs, and live replay samples that should remain searchable but not act as current architecture truth.
- Exact allowlist/denylist ownership and configuration schema for lossy Outbound filtering.
- Exact Direct hook catalog and hook ordering for request, JSON response, and SSE response rewriting.

## Unmentioned implementation and gate findings

- Full `verify:local` reaches `verify:v3-provider-session-cooldown` and fails on missing typed session-scope/runtime ownership bindings, including the absent `direct_sse_provider_outcome.rs` source and retained provider-global mutation ownership. This is an existing runtime remediation, not evidence against the memory schema or the confirmed payload-rewrite contract.
- The installed `appsdk 0.1.6 (rust)` accepts `appsdk verify .` but does not expose the documented `verify-git-main-protection` subcommand. Hook files and `core.hooksPath=.githooks` are present, but canonical Git-protection verification remains unproven in this run.
