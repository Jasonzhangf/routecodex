# V3 Foundation Implementation Order

## Objective

Deliver an executable V3 foundation in dependency order: complete Config, complete multi-listener Server, complete Debug and Error infrastructure, then the single Responses direct lifecycle. Every phase leaves a runnable artifact or an explicit typed placeholder; no phase introduces a shortcut.

Canonical definition: [V3 system definition](../design/v3-system-definition.md).

## Ordering rule

A phase may start implementation only when its contract, positive/negative test design, resource bindings, mainline edges, and verification mapping exist. Runtime/live promotion additionally requires installed-binary evidence.

## Task sequence

### P0 — Contract and gate baseline

Deliver system definition, resource/mainline/verification maps, wiki, and gates for Rust-only source, unique owners, adjacent nodes, config IO uniqueness, and lifecycle shortcuts. Exit only when document gates and red fixtures pass; no runtime usability claim.

### P1 — Full Config compiler

1. Freeze schema for servers, providers, auth handles/keys, models/aliases/capabilities, forwarders, route groups/pools, policies, and feature/debug/error declarations.
2. Reject unknown fields; validate local constraints and unique IDs/listeners.
3. Build provider/model/forwarder/route reference graph.
4. Support nested forwarders and reject cycles.
5. Require every route group's non-empty `default` pool.
6. Reject literal secrets and publish handles only.
7. Publish a deterministic declaration-only manifest without single-server/default-tier compatibility projections.
8. Lock all config file IO to `V3ConfigStore` with a source gate/red fixture.
9. Cover the full schema with positive and negative fixtures.

Exit: config tests, deterministic manifest snapshot, config-only IO gate, and CLI config-check pass. No server claim.

### P2 — Full multi-listener Server startup

1. Project and preflight all enabled listeners from the manifest.
2. Fail aggregate startup explicitly on any bind failure.
3. Bind every address/port under one server runtime handle.
4. Implement explicit lifecycle handles, `/health`, and the full endpoint table.
5. Route pending endpoints through Debug/Error placeholders.
6. Implement CLI `config check`, `server start`, and `server status` through public APIs.
7. Prove one CLI process starts multiple fixture ports.

Exit: multi-port positive, duplicate/unavailable-port negative, per-listener health identity, and typed pending endpoint tests pass. No provider-call claim.

### P3 — Global Debug system

1. Define trace/event/snapshot/dry-run resources and static node registration.
2. Implement request-scoped trace, console/file sinks, and secret isolation.
3. Implement transient snapshots and raw request/response capture policy.
4. Implement dry-run fixture registry using the same runtime kernel and an explicit no-network terminal effect.
5. Implement debug status/log/snapshot/dry-run endpoints.
6. Test retention, concurrency, malformed fixtures, and payload/secret isolation.

Exit: Server placeholder lifecycle emits ordered events; dry run traverses registered nodes; normal execution does not retain every node payload.

### P4 — Global Error system and Provider health contract

1. Define six typed error nodes and adjacent conversions.
2. Define common taxonomy, client projections, and target-local action/exhaustion plans.
3. Define provider instance/auth key/model health scopes.
4. Define Provider health action executor and availability query.
5. Prove Target can query availability but cannot mutate health.
6. Prove Virtual Router cannot see health or be re-entered.
7. Cover success/failure/non-terminal/already-terminal in positive/negative pairs.

Exit: all errors enter one chain; health mutates only inside Provider; only full target exhaustion escapes; no fallback or error-as-success.

### P5 — Virtual Router and Target Interpreter

1. Implement initial `default` request classification and listener route-group resolution.
2. Hit exactly one opaque target.
3. Classify and recursively expand concrete/forwarder targets.
4. Apply priority/weight/round-robin at their declared target level.
5. Query Provider availability and select concrete provider/auth/model.
6. Execute target-local reselection without re-entering Virtual Router.
7. Add deterministic policy and exhaustion fixtures.

Exit: route hit count stays one across failures; nested selection is deterministic; empty candidates produce `TargetPoolExhausted`; default pool is selectable.

### P6 — Responses direct Pipeline and Provider

1. Normalize generic Responses input.
2. Register a typed first-slice Chat Logic/Tool Governance hook.
3. Build provider wire from canonical model ID/base URL; resolve secret only at transport.
4. Send JSON/SSE and capture raw response/source error.
5. Normalize/provider-project the client Responses output.
6. Execute Error -> Provider health -> Target-local reselection on failure.
7. Register all node snapshots/dry-run fixtures and implement `/v1/models` catalog.
8. Prove CLI-started multi-listener routing with controlled upstream.

Exit: exact JSON/SSE blackboxes, one-VR-hit failure fixture, same-kernel dry run, installed-binary multi-port start, and a real `/v1/responses` call pass. Only then is Responses direct MVP usable.

### P7 — Later protocols and relay

Add generic Anthropic, generic Gemini, OpenAI Chat, then relay/continuation/servertool. Each is a static hook set in the same Runtime lifecycle and requires separate maps, test design, positive/negative fixtures, and live evidence.

## Immediate work queue

1. Finish P0 drift: synchronize V3 wiki, maps, and architecture verifier with this definition.
2. Finish P1 gaps: nested forwarders, cycle detection, alias ambiguity, declaration-only manifest, removal of single-server/default-tier projections, full negative fixtures.
3. Run P1 source gates and record evidence.
4. Start P2 only after P1 exit evidence is green.

## Explicit non-completion

Existing early Responses direct code is not evidence that P1-P6 are complete. Until ordered gates and live evidence pass, it is a prototype bound to an incomplete foundation contract.
