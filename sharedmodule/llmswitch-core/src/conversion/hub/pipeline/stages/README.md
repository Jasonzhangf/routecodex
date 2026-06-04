# Hub Pipeline Topology Catalog

This directory is a historical migration index. New architecture work must use the canonical topology node contract from `docs/design/pipeline-type-topology-and-module-boundaries.md` and Rust contract help, not the old coarse stage skeleton.

## Current Nodes

- `HubReqInbound02Standardized`: client entry payload → standardized Hub request.
- `HubReqChatProcess03Governed`: Rust request-side chat-process/tool governance.
- `VrRoute04SelectedTarget`: Virtual Router target selection only.
- `HubReqOutbound05ProviderSemantic`: governed Hub semantics → provider semantic envelope.
- `ProviderReqOutbound06WirePayload`: provider runtime wire payload.
- `HubRespInbound02Parsed`: provider raw response → parsed Hub response.
- `HubRespChatProcess03Governed`: Rust response-side chat-process/servertool governance.
- `HubRespOutbound04ClientSemantic`: Hub response → client protocol semantics.
- `ServerRespOutbound05ClientFrame`: final guarded JSON/SSE client frame.

Legacy subdirectories can help trace migration history, but must not be used as new design entrypoints.
