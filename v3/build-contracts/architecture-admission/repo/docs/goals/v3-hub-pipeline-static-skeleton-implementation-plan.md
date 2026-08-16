# V3 Hub Pipeline Static Skeleton Implementation Plan

## Objective

Replace the extend-only P6 Direct lifecycle with one fixed Rust Hub v1 skeleton whose typed branch
contracts and static hook slots already cover Direct, Relay, remote/local continuation, routed/pinned
targets, all four configured protocols, JSON/SSE, Error, Debug, and Dry Run. Relay and new providers
must later fill hooks without changing topology.

Canonical design: [V3 Hub Pipeline Static Skeleton Contract](../design/v3-hub-pipeline-static-skeleton-contract.md).

## Current evidence

- V3 P6 is source/local-live verified for single-turn Responses Direct.
- V3 has no Request/Response Chat Process runtime implementation.
- V3 has no continuation ownership classifier, remote binding, local context store, execution-mode
  plan, routed/pinned target merge, or complete Hub static hook registry.
- V2 Rust Hub Pipeline contains the semantic stage families, but Server Direct and host executor
  remain separate orchestration surfaces. V3 must use them as audit evidence, not copy their split.

## Ordered phases

### H0 — Contract and red gates

- Lock Hub v1 request/response nodes, four independent branch axes, resources, mainline edges,
  verification map, Wiki, and compile-fail/source red fixtures.
- Freeze P6 against Relay/continuation/protocol expansion.
- Gate provider-family branches, dynamic hooks, Server shortcuts, alternate exits, owner fallback,
  and immutable-interval logic.

### H1 — Typed skeleton and static registry

- Add opaque node types and one owning adjacent builder per edge.
- Add closed static hook registry and deterministic startup validation.
- Register explicit `not_implemented` hooks for every branch not yet implemented.
- No Provider transport or live endpoint switch in this phase.

### H2 — P6 Direct hook migration

- Move existing Responses Direct semantics behind Hub v1 hooks.
- Preserve one Router hit for routed requests and Target-local candidate selection.
- Preserve generic Responses Provider, Error01-06, Debug side channel, Dry Run no-network transport,
  JSON/SSE projection, and Server framing.
- Run positive/negative equivalence tests before switching the endpoint.

### H3 — Sole-entry cutover and old-chain deletion

- Switch `/v1/responses` to Hub v1 only.
- Prove controlled-upstream JSON/SSE/reselection/exhaustion/Dry Run through Hub v1.
- Physically delete old P6 lifecycle types/builders/maps after red gate proves they cannot revive.
- No fallback or runtime toggle to the deleted path.

### H4 — Remote continuation hooks

- Implement remote binding commit, immutable locator storage, scope validation, pinned target
  resolution, and same-provider/model continuation.
- Do not save/restore local Chat Process context.
- Provider unavailability is explicit; no cross-provider reselection or local-owner fallback.

### H5 — Local continuation and Relay hooks

- Implement response Chat Process save and next request Chat Process restore.
- Enforce the immutable interval and four-axis classification.
- Relay uses the existing request/response nodes and response exit; no topology change.

### H6 — Additional protocol hooks

- Register generic Anthropic, generic Gemini, and OpenAI Chat input/wire/raw/client hooks.
- Provider instances reference protocol/capability declarations only.
- No provider-family branches or skeleton changes.

## Definition of done for the contract phase

- Design, resource map, mainline map, verification map, Wiki, and architecture gate agree.
- New Hub v1 nodes/resources/edges are honestly `binding_pending`.
- Existing P6/V2 source evidence is linked without inventing V3 symbols.
- The gate rejects removal of the four axes, immutable interval, static registry, migration deletion
  plan, or no-fallback rule.
- No runtime implementation, Relay, continuation, provider config, install, or restart is claimed.
