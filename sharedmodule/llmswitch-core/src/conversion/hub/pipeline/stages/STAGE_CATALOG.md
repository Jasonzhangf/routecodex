# Hub Pipeline Topology Catalog

| Contract Node | Owner | Purpose | Protocols |
|------|----------|---------|-----------|
| `HubReqInbound02Standardized` | req inbound adapter | Parse entry payload, preserve raw semantics, bind scoped metadata carrier. | all hub protocols |
| `HubReqChatProcess03Governed` | Rust chat-process governance | Request-side tool governance, history/tool normalization, chat-process policy. | all hub protocols |
| `VrRoute04SelectedTarget` | Rust Virtual Router | Classify/select route target only; never patch payload. | all hub protocols |
| `HubReqOutbound05ProviderSemantic` | req outbound codec | Encode governed Hub semantics into provider semantic envelope. | all hub protocols |
| `ProviderReqOutbound06WirePayload` | provider runtime codec | Build provider wire JSON; internal metadata must be absent. | provider-specific |
| `ProviderRespInbound01Raw` | provider transport | Capture upstream provider raw response/SSE. | provider-specific |
| `HubRespInbound02Parsed` | resp inbound parser | Parse provider raw response into Hub response semantics. | all hub protocols |
| `HubRespChatProcess03Governed` | Rust chat-process governance | Response-side tool harvest, servertool followup orchestration, response governance. | all hub protocols |
| `HubRespOutbound04ClientSemantic` | resp outbound projection | Project Hub response semantics to client protocol. | all client protocols |
| `ServerRespOutbound05ClientFrame` | server response writer | Emit final JSON/SSE client frames after projection guard. | all client protocols |

> 旧 `stages/*` 目录只保留为历史迁移索引；当前架构真源是上表的拓扑节点名与 Rust contract help。
