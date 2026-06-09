# Pipeline Types Module

This legacy Host directory no longer owns Hub Pipeline data structures. Only
`external-types.ts` remains here for the still-live provider/runtime
compatibility surface used by `pipeline-interfaces.ts`.

Do not restore old `PipelineRequest`, `PipelineResponse`, provider config, or
transformation type barrels here. Current request/response/control/data
contracts belong to llmswitch-core Rust/native Hub Pipeline types. Host code
should import concrete `src/types/**` or native/core bridge contracts directly.
