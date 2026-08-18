# V3 Gemini Codec Characterization

## 边界

本页只描述 native Gemini codec 的 characterization。它不注册 Hub hook，不连接 Server、Runtime kernel、Provider transport、continuation、Relay 或 SSE Transport Core。Gemini Runtime wiring 由 `v3.gemini_relay_runtime_integration` 单独拥有；codec characterization 本身不证明 live/provider/global 可用。

```mermaid
flowchart LR
  A[V3GeminiClientInput01Raw] --> B[V3GeminiHubRequest02Semantic]
  B --> C[V3GeminiProviderWire03Payload]
  D[V3GeminiProviderRaw04Response] --> E[V3GeminiHubResponse05Semantic]
  E --> F[V3GeminiClientProjection06Semantic]
```

## 合同

- JSON request/response 保留原 payload 语义。
- `functionResponse.name` 必须引用此前声明的 `functionCall.name`。
- 错误显式失败；不修复、不重排、不 fallback。
- SSE 输入是已分帧的单个 candidate event JSON；不解析字节，不 materialize stream。
- RouteCodex 内部 side-channel 字段不可进入协议 payload。

## Review checklist

- [ ] focused Rust tests 通过
- [ ] source architecture gate 通过
- [ ] mutation red fixtures 全部拒绝
- [ ] map/manifest 节点 ID 一致
- [ ] 无 runtime wiring 或 hook registration
