# Kimi K2.5 Multimodal (Images / Video)

## Upstream contract (Moonshot)

Kimi K2.5 accepts OpenAI-chat style multimodal content parts, including:

- Images: `{ type: "image_url", image_url: { url: "data:image/<type>;base64,..." } }`
- Video: `{ type: "video_url", video_url: { url: "data:video/<type>;base64,..." } }`

RouteCodex/llmswitch-core treats this as an **inline multimodal** model and will not run the legacy `:vision` detour when the routed model is `kimi-k2.5` (unless `forceVision` is explicitly set).

## Inline asset resolve (feature-flagged, default off)

When enabled, llmswitch-core will resolve local/remote image/video URLs into `data:*;base64,...` before sending the request upstream.

Config lives under `virtualrouter.providers.<providerId>.models.<modelId>.multimodal.inlineAssetResolve`:

```json
{
  "enabled": false,
  "includeImage": true,
  "includeVideo": false,
  "maxBytes": 10000000,
  "timeoutMs": 15000,
  "allowRemote": true,
  "allowFile": true
}
```

Notes:

- Default is **off**; no URL/file downloading happens unless `enabled: true`.
- Video input is only processed when `includeVideo: true`.
- Outbound snapshots redact `data:*;base64,...` strings to avoid huge recordings.

