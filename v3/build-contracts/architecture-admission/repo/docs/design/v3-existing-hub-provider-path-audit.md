# Existing Hub Pipeline and Provider Path Audit for V3

## Scope and evidence rule

This is a read-only audit of the existing RouteCodex runtime used to design V3. Existing V2/Rust
symbols are evidence of semantic families and failure modes; they are not V3 implementation
bindings. V3 remains owned exclusively under `v3/`.

## Existing request paths

### Hub/Relay-oriented path

The existing Rust `HubPipelineEngine::execute` in
`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
contains the closest complete skeleton:

```text
normalize
  -> req inbound format parse
  -> req inbound semantic lift/context capture
  -> req Chat Process/tool governance
  -> VR route selection
  -> req outbound provider semantic/context merge
  -> provider format build/compat
```

The response half performs:

```text
provider raw parse
  -> resp Chat Process/tool governance/servertool hook
  -> finalize
  -> client remap
  -> SSE projection
  -> effect plan
```

Useful evidence:

- the stage catalog is closed and ordered;
- request and response Chat Process already have semantic owners;
- VR is between governed request and provider semantic output;
- provider protocol and entry protocol are separate facts;
- effects can be projected after semantic decisions.

V3 correction:

- stage identity must be enforced by opaque adjacent types, not a catalog plus generic payload;
- continuation ownership and execution mode need explicit nodes before target resolution;
- response continuation commit must occur after response Chat Process and before client projection;
- provider send and host effects must be hooks of the one kernel, not a second executor lifecycle.

### Router Direct path

`src/server/runtime/http-server/router-direct-pipeline.ts` performs a separate path:

```text
Server current body
  -> direct eligibility
  -> VR-selected target
  -> direct request projection hooks
  -> Provider processIncomingDirect/processIncoming
  -> direct response hooks
  -> Server
```

It preserves same-protocol payload semantics and is useful evidence for Direct behavior, but it
skips the standard Hub request/response Chat Process and has its own response handling. V3 must not
copy this topology. Its behavior becomes implementations of the fixed Hub v1 hook slots, including
explicit Direct pass contracts at both Chat Process nodes.

### Provider Direct path

`src/server/runtime/http-server/provider-direct-pipeline.ts` selects direct/relay behavior at the
Server/provider surface and calls the Provider instance. It explicitly rejects Relay there, which
confirms Relay requires the Hub semantic path. V3 removes this lifecycle split: Server dispatches
only to Hub v1; execution-mode classification is a typed Runtime node.

## Existing Provider path

The existing host executor resolves a provider runtime, records provider protocol in control state,
builds a provider payload, invokes `handle.instance.processIncoming(...)`, and converts the provider
response. Responses-specific runtime then uses `ResponsesProvider` and `HttpRequestExecutor` /
`OpenAiResponsesSdkTransport` for wire/transport behavior.

Useful evidence:

- Provider protocol is a runtime capability distinct from provider family/identity;
- Provider instance owns auth, transport, wire compatibility, and raw/source errors;
- the selected provider/model must be known before wire build;
- Responses Direct and normal Provider calls can share transport truth.

V3 correction:

- `RequestExecutor` retry/send/response conversion cannot remain a second full lifecycle;
- the fixed Runtime kernel calls `provider_wire_build`, `provider_transport`, and
  `resp_inbound_normalize` hooks at their adjacent nodes;
- target-local reselection and global Error actions remain in their unique owners;
- Provider hooks never classify Direct/Relay, continuation owner, entry protocol, or route pool;
- Hub/VR/Server never branch on provider ID, family, or model prefix.

## Existing continuation path

The existing continuation surfaces span Rust `responses_resume.rs`, Chat Process continuation
owners, `responses-conversation-store-host.ts`, handler preparation, and `RequestExecutor` capture
effects. Existing contracts already distinguish `continuationOwner=direct|relay` and entry/port/
group/session scope.

Useful evidence:

- Direct remote state and Relay local state are different truth resources;
- continuation restore requires owner and scope isolation;
- provider pinning is required for remote/provider-owned continuation;
- response Chat Process save and next request Chat Process restore are the only legal local context
  boundaries.

V3 correction:

- `direct|relay` is renamed/typed as continuation ownership independently from execution mode;
- a non-GPT Responses Provider may use RouteCodex-local continuation;
- same wire protocol does not imply Direct;
- remote binding contains locator/pin only, never full context;
- local context is immutable between response Chat Process save and request Chat Process restore;
- handlers, inbound/outbound converters, SSE, store transport, MetadataCenter, Debug, and Provider
  runtime cannot reconstruct or mutate continuation truth.

## Branch-to-hook migration matrix

| Existing semantic family | Existing evidence surface | Hub v1 hook slot | Migration rule |
| --- | --- | --- | --- |
| entry parsing | handler bridge + Hub req inbound | `req_inbound_normalize` | one hook per closed entry protocol |
| continuation lookup | responses store/bridge | `req_continuation_classify` | new/remote/local typed result; no fallback |
| request governance | Rust req Chat Process | `req_chat_process` | Direct pass or local restore/governance; node never skipped |
| direct/relay decision | Server/direct eligibility and Hub process mode | `req_execution_plan` | Runtime policy from declarations + facts, never protocol equality |
| normal route | Rust VR + Target | `req_target_resolve::routed` | one Router hit then Target-local selection |
| continuation pin | continuation owner/provider pin | `req_target_resolve::pinned` | validate immutable binding; no reselection |
| provider semantic | Hub req outbound | `req_provider_semantic` | provider-neutral request semantic |
| provider codec | Provider runtime/profile | `provider_wire_build` | protocol hook, not provider-family branch |
| provider send | Provider transport | `provider_transport` | auth/IO/source error only |
| provider response parse | Hub resp inbound + Provider parser | `resp_inbound_normalize` | protocol parse, JSON/SSE parity |
| response governance | Rust resp Chat Process/servertool hook | `resp_chat_process` | Direct pass or Relay/tool governance; node never skipped |
| continuation save | Chat Process/store effects | `resp_continuation_commit` | none/remote locator/local context closed action |
| client projection | Hub resp outbound | `resp_client_project` | entry-protocol projection only |
| HTTP/SSE | handler/SSE transport | `server_frame` | transport only; sole response exit |

Cross-cutting paths are also absorbed without topology changes:

| Existing path | Hub v1 representation |
| --- | --- |
| servertool followup | typed invocation source that re-enters Req01; normal request/response hooks |
| Debug Dry Run | same kernel; Provider transport hook replaced by explicit no-network effect |
| JSON/SSE | one finalized client semantic; `server_frame` transport branch only |
| Provider failure | global Error chain; action returns only to routed Target-local selection |
| pinned continuation failure | explicit Error chain; no Target reselection or owner fallback |

## Required configuration abstraction

The V3 Config compiler must parse and publish only declarations:

- server allowed execution modes;
- closed entry protocols;
- provider wire protocol and static hook-set ID;
- model capabilities for remote continuation, local materialization, tool outputs, streaming, and
  protocol-specific options;
- continuation ownership policies and scope requirements;
- no request-specific execution decision, continuation owner, target, or hook plan.

Runtime consumes the Manifest plus current request/binding/target facts and produces typed branch
values. A config value never becomes executable code. Unknown hook IDs, impossible capability
combinations, and references to uncompiled hook sets fail during compile/startup validation.

## Audit conclusion

The existing runtime contains all major semantic families but spreads them across Hub, Direct,
RequestExecutor, Provider, continuation bridge/store, response converter, and Server transport
surfaces. V3 must not migrate these paths one-for-one. The only safe abstraction is the fixed Hub v1
topology plus static hooks and typed branch resources defined by
`v3-hub-pipeline-static-skeleton-contract.md`.
