# Pipeline Types Module

This legacy Host directory no longer owns Hub Pipeline data structures. Only
`external-types.ts` remains here for the still-live provider/runtime
compatibility surface used by `pipeline-interfaces.ts`.

`external-types.ts` only keeps `ErrorHandlingCenter`, `DebugCenter`, and
`DebugEvent` shims for server bootstrap compatibility.

Do not restore old `PipelineRequest`, `PipelineResponse`, provider config,
module abstraction, HTTP client, config manager, logger, dispatch center, or
transformation type barrels here. Current request/response/control/data
contracts belong to llmswitch-core Rust/native Hub Pipeline types. Host code
should import concrete `src/types/**` or native/core bridge contracts directly.
