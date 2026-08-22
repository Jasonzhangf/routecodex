# V3 Hub Pipeline Static Skeleton Contract

## Status

This document defines the fixed V3 Hub Pipeline topology before Relay, continuation, or additional
provider protocols are implemented. The detailed Relay execution contract is
[V3 Hub Relay Fixed Pipeline Contract](v3-hub-relay-fixed-pipeline-contract.md). All new Hub nodes
and edges are `binding_pending`. The current P6 Responses Direct chain remains source-bound only as
a migration source; it is not the final Hub Pipeline and must not be extended with more lifecycle
branches.

## Non-negotiable architecture

V3 has one lifecycle skeleton. Direct, Relay, remote continuation, local continuation, target
selection mode, and provider protocol are typed branch values carried through that skeleton. They
are not independent pipelines and are not provider-family conditions.

```text
entry protocol
  x continuation ownership
  x execution mode
  x target resolution mode
  x provider wire protocol
```

The four axes are independent:

1. Entry protocol: generic Responses, generic Anthropic, generic Gemini, or OpenAI Chat.
2. Continuation ownership: none/new, remote-provider-owned, or RouteCodex-local-owned.
3. Execution mode: Direct or Relay.
4. Provider wire protocol: Responses, Anthropic, Gemini, or OpenAI Chat.

`provider family`, provider ID, model-name prefix, and same-protocol equality are never branch
owners. A non-GPT Responses provider may require RouteCodex-local save/restore. A Responses-to-
Responses request may still be Relay when RouteCodex owns Chat Process context.

The skeleton also carries three closed cross-cutting branch families without adding nodes:

- invocation source: client request, servertool followup re-entry, or Debug Dry Run fixture;
- transport projection: JSON or SSE;
- terminal outcome: success or the global Error chain.

Servertool followup re-enters `V3HubReqInbound01ClientRaw` with a typed origin binding and follows
the same request/response nodes. Dry Run follows the same kernel and replaces only the transport
effect with a no-network hook. JSON/SSE diverge only inside `server_frame` after client semantics are
final. Provider failure enters the global Error chain; target-local actions may choose another
candidate only inside a routed target, while pinned continuation remains pinned and fails explicitly.

## Fixed request chain

```text
V3HubReqInbound01ClientRaw
  -> V3HubReqInbound02Normalized
  -> V3HubReqContinuation03Classified
  -> V3HubReqChatProcess04Governed
  -> V3HubReqExecution05Planned
  -> V3HubReqTarget06Resolved
  -> V3HubReqOutbound07ProviderSemantic
  -> V3ProviderReqOutbound08WirePayload
  -> V3ProviderReqOutbound09TransportRequest
```

Every request traverses every node. A branch that has no semantic work still returns a typed node
result; it cannot skip to a later node.

### Request branch contracts

- `Continuation::New`: no existing continuation truth is read.
- `Continuation::RemoteProviderOwned`: validate immutable locator/pin; do not restore local context.
- `Continuation::RouteCodexLocalOwned`: restore the immutable local context only at
  `V3HubReqChatProcess04Governed` entry, then execute request-side governance.
- `Execution::Direct`: remote/provider-owned semantic lifecycle; Direct is not inferred from
  protocol equality.
- `Execution::Relay`: RouteCodex-owned semantic lifecycle; Relay may use the same entry and provider
  wire protocol.
- `TargetResolution::Routed`: Virtual Router hits one opaque target and Target Interpreter expands
  and selects inside it.
- `TargetResolution::Pinned`: validate the continuation binding and project the already-owned
  concrete target. It is a standard Target Resolution hook, not a Server-to-Provider shortcut.

Both target branches produce exactly `V3HubReqTarget06Resolved`. Provider hooks cannot tell which
branch produced it except through typed control facts explicitly allowed by the contract.

## Fixed response chain

```text
V3ProviderRespInbound01Raw
  -> V3HubRespInbound02Normalized
  -> V3HubRespChatProcess03Governed
  -> V3HubRespContinuation04Committed
  -> V3HubRespOutbound05ClientSemantic
  -> V3ServerRespOutbound06ClientFrame
```

All response modes merge before client projection. Direct, Relay, servertool followup, JSON, and SSE
cannot own separate response exits.

`V3HubRespContinuation04Committed` produces one closed action:

- `None`: do not create continuation state;
- `RemoteBinding`: store only immutable remote ID, owner, scope, and provider/model/auth pin;
- `LocalContext`: save complete canonical Chat Process context and begin the immutable interval.

## Continuation immutable interval

Local continuation is owned only by the two Chat Process boundaries:

```text
V3HubRespChatProcess03Governed
  -> V3HubRespContinuation04Committed(LocalContext saved)
  -> immutable store interval
  -> V3HubReqContinuation03Classified(scope resolved)
  -> V3HubReqChatProcess04Governed(LocalContext restored)
```

After save and before restore, only lossless serialization/deserialization, round-trip-equivalent
normalization, scope validation, storage/transport, expiry, and release are allowed. The invariant
is:

```text
restore(normalize(save(context))) == context
```

No routing, target selection, provider adaptation, Chat Process, tool governance, history merge,
tool-call/result repair, required-action inference, request rebuilding, stopless/servertool action,
Debug replay, snapshot recovery, fallback, or success wrapping may occur in this interval. Missing,
expired, corrupt, or mismatched context enters the global Error chain.

This means no request processing and no response processing may run in the interval except
semantic-equivalent normalization. If an operation can change what restore later sees, it must run
before `V3HubRespContinuation04Committed` saves the context or after
`V3HubReqChatProcess04Governed` restores it.

Remote continuation stores no local Chat Process context. Its binding contains only the remote
response ID, `continuationOwner=remote_provider`, entry protocol, server/port/group/session scope,
provider/model/auth pin, capability revision, and expiry. A pinned continuation cannot reselect a
different provider or silently become local continuation.

## Static hook slots

The Runtime owns a compile-time registry with exactly one slot family for each fixed node:

| Hook slot | Input -> output | Standard implementations |
| --- | --- | --- |
| `req_inbound_normalize` | Req01 -> Req02 | Responses, Anthropic, Gemini, OpenAI Chat |
| `req_continuation_classify` | Req02 -> Req03 | new, remote binding, local binding |
| `req_chat_process` | Req03 -> Req04 | direct pass contract, relay/local restore + governance |
| `req_execution_plan` | Req04 -> Req05 | direct, relay |
| `req_target_resolve` | Req05 -> Req06 | routed, pinned |
| `req_provider_semantic` | Req06 -> Req07 | provider-neutral semantic projection |
| `provider_wire_build` | Req07 -> Provider08 | Responses, Anthropic, Gemini, OpenAI Chat |
| `provider_transport` | Provider08 -> Provider09 | protocol runtime transport |
| `resp_inbound_normalize` | Resp01 -> Resp02 | Responses, Anthropic, Gemini, OpenAI Chat |
| `resp_chat_process` | Resp02 -> Resp03 | direct pass contract, relay governance/tool handling |
| `resp_continuation_commit` | Resp03 -> Resp04 | none, remote binding, local context save |
| `resp_client_project` | Resp04 -> Resp05 | entry-protocol projection |
| `server_frame` | Resp05 -> Resp06 | JSON/SSE/HTTP framing only |

Invocation source, stream intent, and success/error polarity are required typed inputs to the
relevant slots; they are never inferred from arbitrary payload shape. No servertool, Dry Run, SSE,
retry, or error hook may create a second lifecycle or response exit.

Hooks are static Rust function tables compiled with the binary. Config may select declared hook IDs
and capabilities, but cannot load code, invent nodes, change order, or define a lifecycle. An absent
or incompatible hook is an explicit startup/configuration error; there is no default protocol or
Direct fallback.

The generic `V3ProviderReqOutbound08WirePayload` envelope type is owned by Runtime so the fixed
chain has one node type; the protocol hook owns its wire content construction. Runtime cannot inspect
or rewrite protocol-specific fields after the hook returns.

## Configuration declaration contract

Config parses and publishes declarations without deciding request behavior:

```toml
[pipelines.hub_v1]
skeleton = "hub_v1"
entry_protocols = ["responses", "anthropic", "gemini", "openai_chat"]

[providers.<id>]
protocol = "responses"

[providers.<id>.models.<model>.capabilities.continuation]
remote = true
local_materialization = true
tool_outputs = true

[servers.<id>.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
```

These fields are declarations. Runtime classification consumes the published Manifest, current
request facts, resolved continuation binding, and selected model capabilities. Config never decides
whether a concrete request is Direct/Relay, remote/local, routed/pinned, or continuation/new.

The compiled Manifest must contain:

- closed protocol IDs and static hook-set references;
- provider/model capability facts;
- allowed execution modes and continuation ownership policies;
- no selected execution mode, selected continuation owner, selected target, resolved secret, or
request-specific hook plan.

The current V3 Config schema does not yet implement these Hub declarations. Their resource is
`v3.config.hub_pipeline_declarations` with `binding_pending`; H1 must extend the unique
`V3ConfigStore -> V3Config04ResourceRegistryBuilt -> V3Config05ManifestPublished` chain rather than
introduce a Runtime/Server config reader.

## Existing-path audit

Detailed source audit: [Existing Hub Pipeline and Provider Path Audit for V3](v3-existing-hub-provider-path-audit.md).

The current V2 path proves the required semantic families but also shows why V3 must freeze the
skeleton first:

- Rust `HubPipelineEngine::execute` already sequences request normalization, inbound parsing,
  request Chat Process, VR, outbound build, response parsing, response Chat Process, and projection.
- `responses.direct_passthrough.mainline` is a separate Server path that jumps from raw request to VR
  and Provider wire; it is unsuitable as the final V3 topology because Chat Process and continuation
  classification are absent.
- `RequestExecutor` owns host orchestration, attempts, Provider calls, response conversion, and
  continuation capture effects; these must become effects/hooks around the fixed V3 nodes rather
  than a second semantic pipeline.
- Existing continuation truth correctly distinguishes remote Direct ownership and local Relay
  ownership, but ownership, entry protocol, port/group/session scope, and provider pinning have
  historically crossed handler/metadata/bridge surfaces. V3 makes them typed resources.
- Provider protocol is already a runtime fact; V3 must remove all provider-family/model-prefix
  branching from Hub/VR and keep provider differences inside protocol/runtime hooks.

## Migration from P6 Direct

The current `V3Server03HttpRequestRaw -> ... -> V3Server16HttpFrame` chain cannot receive inserted
nodes because its published node numbers are already contracts. Migration therefore uses a new
chain version:

1. Freeze the P6 chain: bug fixes only; no Relay, continuation, or new protocol branches.
2. Implement all Hub v1 node types and static hook slots with explicit unimplemented branches.
3. Adapt the existing Responses Direct standardizer, Router/Target, Responses Provider, Error,
   Debug, Dry Run, and Server frame implementations behind Hub v1 hooks.
4. Prove Hub v1 Responses Direct behavior equivalent with controlled upstream and real CLI replay.
5. Move the Server `/v1/responses` entry to Hub v1 as the only runtime entry.
6. Physically delete the old P6 lifecycle types/builders/maps after dependency and red-gate proof.
7. Only then implement remote continuation, local continuation, Relay, and additional protocols by
   filling existing hook slots.

There is no permanent dual path and no fallback from Hub v1 to P6.

## Required architecture gates

Before runtime implementation, gates must reject:

- a second Runtime kernel or response exit;
- Server/handler/CLI direct Provider calls;
- non-adjacent node conversion or construction outside the owning builder;
- provider ID/family/model-prefix branches in Hub, VR, Target, or Server;
- same-protocol equality used as Direct classification;
- Provider protocol used as continuation-ownership classification;
- Direct binding storing full context or local context storing remote Provider truth as a substitute;
- remote/local owner fallback or cross-owner restore;
- pinned continuation entering ordinary provider reselection;
- continuation save/restore outside the two Chat Process boundaries;
- semantic logic inside the immutable interval;
- Debug fixture/snapshot/raw capture used as business or continuation truth;
- dynamic hook discovery, missing-hook defaults, or unknown hook IDs;
- Relay/new provider implementation that adds or renumbers skeleton nodes.
- servertool followup, Dry Run, SSE, retry, or error handling implemented as an independent
  lifecycle instead of a typed hook/effect in Hub v1.
