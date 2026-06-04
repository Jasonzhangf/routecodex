# Topology Integration Notes

1. New work must enter through the canonical chain: `HubReqInbound02Standardized → HubReqChatProcess03Governed → VrRoute04SelectedTarget → HubReqOutbound05ProviderSemantic → ProviderReqOutbound06WirePayload`.
2. Response work must return through: `ProviderRespInbound01Raw → HubRespInbound02Parsed → HubRespChatProcess03Governed → HubRespOutbound04ClientSemantic → ServerRespOutbound05ClientFrame`.
3. StageRecorder and timing labels must use canonical node names or node-derived labels; ad-hoc legacy segment names are not design truth.
4. Metadata, error, debug, and snapshot data must stay in side-channel carrier chains and never become provider wire payload or client response body.
5. Tests must assert node ordering and boundary guards from the Rust contract help and `tests/red-tests/*` topology contracts.
