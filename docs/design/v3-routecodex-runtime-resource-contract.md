# RouteCodex V3 Runtime Resource Contract

## Goal

Canonical system definition: [RouteCodex V3 System Definition](./v3-system-definition.md).
Ordered implementation plan: [V3 Foundation Implementation Order](../goals/v3-foundation-implementation-order.md).

V3 must make every request path pass through typed resources and adjacent nodes. Responses direct is still a full lifecycle; it is not a shortcut to provider HTTP.

The runtime kernel is the only executor. Flow modules register static hooks and return typed plans/effects; they do not own complete lifecycles.

Current binding baseline: P0-P6 are source-bound through `V3Server16HttpFrame`. Runtime owns the
only lifecycle executor, static hooks own adjacent typed plans, the generic Responses Provider owns
nodes `12-14`, Runtime owns client projection node `15`, and Server owns frame node `16`.
`routecodex-v3-provider-responses` never selects implementation branches from deployment provider
identities.

## Required lifecycle skeleton

```text
V3Config01FileSource
  -> V3Config02AuthoringParsed
  -> V3Config03SchemaValidated
  -> V3Config04ResourceRegistryBuilt
  -> V3Config05ManifestPublished
  -> V3Server03HttpRequestRaw
  -> V3Req04StandardizedResponses
  -> V3Router05RequestClassified
  -> V3Router06RoutePoolResolved
  -> V3Router07OpaqueTargetHitOnce
  -> V3Target08KindClassified
  -> V3Target09CandidateSetExpanded
  -> V3Target10ConcreteProviderSelected
  -> V3ResponsesDirect11Policy
  -> V3Provider12ResponsesWirePayload
  -> V3Transport13ResponsesHttpRequest
  -> V3ProviderResp14Raw
  -> V3Resp15ClientPayload
  -> V3Server16HttpFrame
```

Nodes may initially return an explicit pending/not-implemented result, but no request path may omit or shortcut a required node.

## Resource families

| Resource | Kind | Canonical writer | Provider body | Client body |
| --- | --- | --- | --- | --- |
| `v3.config.file_source` | config_authoring | config store | no | no |
| `v3.config.authoring_parsed` | config_authoring | config parser | no | no |
| `v3.config.schema_validated` | config_contract | config validator | no | no |
| `v3.config.resource_registry` | resource_registry | config registry builder | no | no |
| `v3.config.published_manifest` | config_manifest | config publisher | no | no |
| `v3.secret.provider_auth_handle` | secret_handle | config manifest compiler | no | no |
| `v3.request.normal_payload` | normal_payload | runtime inbound builder | input only | no |
| `v3.request.protocol_context` | protocol_context | server inbound | no | no |
| `v3.route.opaque_target` | side_channel | virtual router | no | no |
| `v3.target.candidate_set` | side_channel | target interpreter | no | no |
| `v3.target.concrete_provider` | side_channel | target interpreter | no | no |
| `v3.responses_direct.policy` | control_contract | Responses direct route hook | no | no |
| `v3.provider.responses_wire_payload` | provider_wire | Responses provider request projection | yes | no |
| `v3.provider.transport_request` | transport | Responses provider transport | transport | no |
| `v3.response.provider_raw` | provider_response | Responses provider transport | no | no |
| `v3.response.client_payload` | normal_payload | runtime response projection | no | yes |
| `v3.error.chain` | side_channel | runtime error chain | no | projected only at final error |
| `v3.debug.artifact` | diagnostic | debug owner | no | no |

## Node responsibilities

### `V3Config01FileSource`

- Raw `config.v3.toml` bytes plus canonical path.
- Created only by `V3ConfigStore`.

### `V3Config02AuthoringParsed`

- Unknown fields fail.
- Declares multi-server listeners, provider/model/auth handles, forwarders, route groups/pools, selection policies, and feature flags.

### `V3Config03SchemaValidated`

- Structural validation only.
- Requires an enabled server, unique listener addresses, valid references, canonical provider model keys, and a non-empty `default` pool in every route group.
- Does not choose routes, expand targets, or execute selection policy.

### `V3Config04ResourceRegistryBuilt`

- Typed registry of servers, providers, models, forwarders, route pools, and feature flags.
- Forwarders remain opaque target declarations.

### `V3Config05ManifestPublished`

- Deterministic runtime manifest.
- No legacy config fallback.
- Runtime/server/router/target/provider/error/debug consume this manifest or typed projections, not config files.
- API keys never enter the manifest; only env/token-file handles may enter.

### `V3Server03HttpRequestRaw`

- Raw HTTP request envelope for `/v1/responses`.
- Server may validate size, method, endpoint, and parseability.
- Server must not choose provider or rewrite provider wire.

### `V3Req04StandardizedResponses`

- Current Responses request data-plane payload plus protocol context.
- Must preserve the current request body semantics.
- Must not reconstruct payload from debug/snapshot/metadata.

### `V3Router05RequestClassified`

- Request classification result. A default-only implementation may always classify as `default`.

### `V3Router06RoutePoolResolved`

- Resolves the selected server's route group and required pool.
- Missing/empty default pool is an explicit config/runtime error.

### `V3Router07OpaqueTargetHitOnce`

- Virtual Router's only target hit.
- The target remains opaque: concrete provider-model or aggregate/forwarder.
- Virtual Router must not expand provider/key members and must not be re-entered for target-local errors.

### `V3Target08KindClassified`

- Target interpreter identifies concrete versus aggregate target.

### `V3Target09CandidateSetExpanded`

- Aggregate/forwarder target expands to internal provider/key/model candidates.
- Priority/weight/round-robin policy applies only inside this target boundary.

### `V3Target10ConcreteProviderSelected`

- One concrete provider/key/model is selected.
- Provider/key errors remain target-local while another candidate exists.
- Only full target-pool exhaustion returns upward.

### `V3ResponsesDirect11Policy`

- Request-scoped direct policy.
- Reads selected target and current request facts.
- Must not enter provider body, client body, or debug artifact as truth.

### `V3Provider12ResponsesWirePayload`

- Final OpenAI-compatible Responses provider body/headers/url intent.
- Built only by Responses provider/request projection owner.
- For direct MVP, the current request body is provider wire except for explicitly typed top-level transport additions from the validated manifest.
- No provider-wire preflight, sanitize, repair, raw replay, or forced relay.

### `V3Transport13ResponsesHttpRequest`

- Provider HTTP transport request.
- Consumes only the validated `auth_env` handle name from the manifest.
- Resolves the secret value at the transport point.
- Must not write secret values into manifest, debug, error, or client payload.

### `V3ProviderResp14Raw`

- Raw status, headers, bytes/stream, and provider error source.
- Provider transport captures it; runtime parses/projects later.

### `V3Resp15ClientPayload`

- Client-visible semantic response.
- Must not save/restore continuation in MVP.
- Must not infer request history.

### `V3Server16HttpFrame`

- HTTP/SSE/JSON frame emission.
- Transport only. No business repair.

## Error chain

All provider/runtime/direct errors enter `v3.error.chain`:

```text
V3Error01SourceRaised
  -> V3Error02Classified
  -> V3Error03TargetLocalAction
  -> V3Error04TargetExhaustionDecision
  -> V3Error05ExecutionDecision
  -> V3Error06ClientProjected
```

Provider errors cannot bypass the error processor and cannot be projected as success. A target-local retry/reselect is invisible to Virtual Router. Only `TargetPoolExhausted` may escape the target interpreter.

## Static hook contract

Each hook declares:

- `hook_id`
- `hook_point`
- `input_node`
- `output_node`
- resources read
- resources written
- forbidden resources

Hook output is a typed plan/effect. Hooks must not:

- call the next lifecycle node
- call provider transport directly unless the hook is the registered provider transport hook
- mutate resources outside the declared output node
- fallback to success
- write debug/metadata into provider/client payload

## Implementation gate prerequisites

Before runtime code starts, the V3 implementation must have:

- resource map
- mainline call map
- verification map
- human wiki review page
- compile/source gate design
- positive/negative test design
