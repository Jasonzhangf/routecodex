# Servertool Hook Mount Boundary Test Design

## Objective

Lock every servertool semantic transition behind the Rust standard hook
skeleton. Stopless is a registered servertool hook, not an independent
lifecycle or a protocol/continuation repair path.

## Lifecycle Contract

```text
response provider truth
  -> HubRespChatProcess03Governed
  -> ServertoolRespHook skeleton
  -> hook registry/scheduler
  -> registered hook handler
  -> response semantic finalization
  -> canonical continuation save
  -> immutable transport/store interval
  -> canonical continuation restore
  -> ServertoolReqHook skeleton
  -> hook registry/scheduler
  -> registered hook handler
  -> HubReqChatProcess03Governed
  -> provider-facing request
```

The interval from canonical save through canonical restore is data-preserving.
It may perform transport, persistence, release, and non-destructive scope
validation only. It must not identify a servertool, parse CLI output, rewrite
history, generate guidance, inject schema, infer terminal state, or repair tool
pairs.

## White-Box Cases

1. Hook registration validates direction, exact phase, adjacent nodes, owner,
   requiredness, priority, order, and effect kind.
2. Scheduling is deterministic by `priority -> order -> id`.
3. Duplicate hook ids and conflicting effect kinds fail fast.
4. A disabled required hook fails fast; a disabled optional hook emits a no-op
   event.
5. Stopless is registered under the servertool skeleton and has no standalone
   runtime entry from Hub Pipeline, codec, continuation, handler, SSE, inbound,
   or outbound surfaces.
6. The response skeleton runs before canonical continuation save.
7. The request skeleton runs only after canonical continuation restore.

## Module Black-Box Cases

1. A missing/invalid stop schema reaches the response skeleton, invokes the
   registered stopless hook, and produces the client CLI projection.
2. The next request first restores continuation truth, then the request
   skeleton consumes CLI result state and emits one ordinary user continuation.
3. The final provider request contains the system stop schema and ordinary user
   continuation, but no stopless tool identity, CLI pair, internal marker, or
   structured private feedback.
4. A real user turn resets stopless state and is preserved verbatim.
5. A non-stop response resets the consecutive stop budget.
6. The third consecutive missing/invalid stop passes the original stop through
   without projecting a fourth CLI turn.

## Negative Architecture Cases

The gate must turn red when any fixture:

1. parses stopless CLI output in req_inbound, codec, continuation store/restore,
   response bridge, handler, SSE, or resp_outbound;
2. generates stopless guidance or injects stop schema in those forbidden
   surfaces;
3. calls a stopless runtime handler directly from Hub orchestration instead of
   the standard skeleton;
4. registers a stopless lifecycle entrypoint outside the servertool registry;
5. performs any servertool semantic mutation between
   `ChatProcRespContinuation07CanonicalSaved` and
   `ChatProcReqContinuation03CanonicalRestored`;
6. omits the gate or its red fixture from package/build wiring.

## Project Black-Box

After focused Rust and architecture gates pass:

1. build the native hotpath;
2. run stopless request/response blackboxes against the built artifact;
3. install the global package;
4. restart the aggregate instance once with `routecodex restart --port 5555`;
5. verify health/version on ports `4444`, `5520`, `5555`, and `10000`;
6. replay the recorded 5555 stopless sequence and verify repeat progression,
   reset behavior, third-stop pass-through, and provider-facing transparency.

## Known Gap Before Implementation

The current source still has stopless-specific response orchestration in
`hub_pipeline_lib/engine.rs` and stopless history/guidance logic in Responses
conversation/codec and req_inbound normalization surfaces. The architecture
gate must be proven red against those live violations before the owner
refactor.
