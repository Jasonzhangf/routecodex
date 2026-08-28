# V4 configuration parity plan

## Objective

Close the first product gap identified by the 2024-08-24 audit: compile the
selected V3 7777 and 4444 configuration semantics into deterministic,
secret-free V4 manifests without making V4 runtime depend on V3. The live V4
profile uses the `routecodex_v3_4444` projection on `127.0.0.1:5520`.

## Owner and boundary

- Owner: `routecodex-v4-config`.
- Allowed: V4 authoring schema, typed V3-import fixture, validation, canonical
  ordering, manifest digest, config differential gates.
- Forbidden: V3 runtime imports/calls, runtime route fallback, provider transport,
  request/response payload changes, and handler-side config repair.

## Ordered slices

1. Define typed V4 product configuration envelope for provider catalog,
   auth-handle, protocol, model capability, route group/pool/match/priority and
   error policy declarations.
2. Add explicit, read-only V3 7777/4444 fixture importers; no live V3 config is
   read by V4 startup.
3. Compile and publish deterministic V4 manifest with all declarations retained.
4. Add paired positive/negative config tests and V3/V4 normalized differential
   gate.
5. Hand the manifest contract to the router and provider owners. Do not claim
   runtime parity until those consumers use the new fields and live replay is
   differential.

## Completion signal

This plan is complete only when the config differential gate reports zero
unexplained omissions for the selected 7777/4444 fixtures and the resulting manifests
is consumed by V4's real startup path. It does not by itself close router,
provider, protocol, health, continuation, tool governance or release parity.
