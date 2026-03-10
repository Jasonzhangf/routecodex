# Hub Pipeline 使用指南

Hub Pipeline 是现在唯一的路由/转换编排入口，负责把 HTTP 载荷规整到标准 Chat 语义、运行工具治理、交给 Virtual Router 做路径选择，再把结果映射回客户端协议。本文总结如何初始化、调用以及热更新 Hub Pipeline，帮助 Host 层彻底替换掉旧的 Super Pipeline。

## 组件关系

- **bootstrapVirtualRouterConfig**：将用户配置/blueprint 规范化为 `VirtualRouterConfig`，并返回 provider runtime 供 Host 初始化 SDK。
- **HubPipeline**：承载入站→处理→路由→出站的完整链路。依赖 `VirtualRouterConfig`，内部持有 `VirtualRouterEngine`。
- **Provider Runtime**：仍由 Host 维护；Hub Pipeline 只输出 `target`（providerKey/outboundProfile/processMode），Host 根据 runtime map 发送请求。

```
用户配置 ──┐
          ├─ bootstrapVirtualRouterConfig ──▶ { virtualRouter, targetRuntime }
Secret/Vault ─┘
                                 │
                                 ▼
                      const pipeline = new HubPipeline({ virtualRouter })
                                 │
HTTP 请求 ──▶ pipeline.execute({ endpoint, payload, metadata }) ──▶ providerPayload + routing info
```

## 初始化

```ts
import { HubPipeline } from 'llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.js';
import { bootstrapVirtualRouterConfig } from 'llmswitch-core/src/router/virtual-router/bootstrap.js';

const artifacts = bootstrapVirtualRouterConfig(userConfig);
const hubPipeline = new HubPipeline({ virtualRouter: artifacts.config });

// Host 自行缓存 artifacts.targetRuntime 映射，用于初始化 OpenAI/Anthropic/Gemini 客户端。
```

- `userConfig` 支持 `virtualrouter` 根节点或直接提供 `providers/routing`。
- Hub Pipeline 不依赖 secrets；只需要 Virtual Router 的结构化配置。

## 执行一次请求

```ts
const result = await hubPipeline.execute({
  endpoint: '/v1/chat/completions',
  payload: {
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Say hi' }
    ],
    stream: false
  },
  metadata: {
    providerProtocol: 'openai-chat', // 可选，默认由 entry endpoint 解析
    processMode: 'chat',             // chat | passthrough
    stream: false                    // Host 是否期望 SSE
  }
});

// result 包含：
// - standardizedRequest / processedRequest：入站/治理后的 Chat 语义
// - providerPayload：应该发送给选中 provider 的 JSON（或 SSE readable）
// - routingDecision / routingDiagnostics：Virtual Router 选择详情
// - target：{ providerKey, providerType, outboundProfile, processMode }
// - nodeResults：inbound / process / outbound 阶段的快照元数据
```

Host 拿到 `providerPayload` 后，配合 `targetRuntime[target.providerKey]` 就可以向实际 Provider SDK 发起 HTTP 调用。

## 支持的 endpoint

- `/v1/chat/completions`、`/v1/responses`、`/v1/messages`（Anthropic）以及扩展的 `/v1beta/models/*`；
- SSE/JSON 自动检测：Hub Pipeline 默认会把上游流合成为 JSON，再在 outbound 阶段统一决定 SSE 与否；
- Passthrough：当 metadata/processMode 或路由 profile 标记为 passthrough 时，会跳过 chat-process。

## 热更新 Virtual Router

```ts
hubPipeline.updateVirtualRouterConfig(nextArtifacts.config);
```

- 只需在管理端重新运行 `bootstrapVirtualRouterConfig`。
- Hub Pipeline 会刷新内部 `VirtualRouterEngine`，下一次 `execute` 自动生效。

## 迁移注意事项

1. **不再有 `SuperPipeline` 导出**：Host 必须改为引用 `HubPipeline`。
2. **Provider runtime**：Hub Pipeline 不暴露 `getProviderRuntimeMap()`；请依赖 `bootstrapVirtualRouterConfig` 的返回值。
3. **测试脚本**：原来的 `scripts/tests/super-pipeline-*` 已删除，可改用 `test/hub/*.spec.ts` 或自定义集成测试。
4. **SSE**：默认统一走 `defaultSseCodecRegistry`；若需要完全直通，请在 metadata 中指定 `processMode: 'passthrough'` 并确保路由 profile 支持。

以上流程覆盖了 HTTP Server → Hub Pipeline → Provider 的完整交互，可直接作为 Host 层迁移手册。***
