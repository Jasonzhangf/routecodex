# ProviderComposite 设计（兼容层内聚到 Provider）

本设计将“Compatibility 兼容层”内聚为 Provider 节点的协议敏感子插件（compat-subnode），在出站/返回两侧做强类型守卫，统一使用 BasePipeline 注入的 runtime metadata（虚拟路由结果）作为唯一真理来源。

## 目标与原则

- 仅按协议类型划分 Provider：`openai-chat`、`openai-responses`、`anthropic-messages`（预留 `gemini-chat`）。
- 兼容层内聚：ProviderComposite 在 Provider 内部调用 compat 子插件；Host 流水线不再显式编排 compatibility 节点。
- 协议守卫（Fail Fast）：入/出两侧验证 `providerType → providerProtocol` 的映射；任何形状漂移立即报错。
- 工具治理边界：工具解析/修复/收割仅在 llmswitch-core 的 process 链路，compat 子插件严格“最小字段修剪/映射/黑名单”。
- SSE 边界：Provider 对上游可用 SSE，但对 Host 一律返回 JSON；客户端方向的 SSE 仅在 llmswitch-core 的 sse 节点族出现。

## 背景：runtime metadata 统一输入

- BasePipeline 在构建 request/response context 时，将虚拟路由回写的 `providerType`/`providerProtocol`/`providerKey`/`routeName`/`target` 等以不可枚举属性写入请求体。
- 模块：`src/modules/pipeline/modules/provider/v2/core/provider-runtime-metadata.ts`
- 读取：`extractProviderRuntimeMetadata()`（BaseProvider 已缓存最近一次 metadata，并在日志/错误中心附带字段）。

## 新拓扑（出站与返回）

```
output/* → Provider.preprocessRequest(compat.request) → HTTP Provider → Provider.postprocessResponse(compat.response) → response/*
```

说明：
- Host 侧流水线不变；compat 被 Provider 内部的 ProviderComposite 执行。
- Responses 上游使用 SSE；Provider 解析为 JSON 再返回 Host。

## 类与文件

- 新增（Provider 内）：
  - `src/modules/pipeline/modules/provider/v2/composite/provider-composite.ts`
  - `src/modules/pipeline/modules/provider/v2/composite/compat/openai-compat-aggregator.ts`
  - `src/modules/pipeline/modules/provider/v2/composite/compat/{responses,anthropic,gemin i}.ts`

- 复用（保持原路径）：
  - 现有 `src/modules/pipeline/modules/provider/v2/compatibility/*` 模块作为旧实现，按需由 openai-compat-aggregator 适配调用（GLM/LM Studio/iFlow）。

## 协议守卫与自动加载

- 运行时映射（唯一来源：BasePipeline 注入）：
  - `openai → openai-chat`
  - `responses → openai-responses`
  - `anthropic → anthropic-messages`
  - `gemini → gemini-chat`
- 验证点：
  - 入站：`in.protocol` 与 `runtime.providerProtocol` 以及 `map(runtime.providerType)` 必须一致，否 则 `ERR_PROTOCOL_MISMATCH`。
  - compat.request/response 不得改变协议形状，否则 `ERR_COMPAT_PROTOCOL_DRIFT`。

## OpenAI 协议族家族聚合器

- 基于 `providerId/providerKey` 选择最小家族差异：
  - `glm` → 复用 `GLMCompatibility`（最小清理、1210/1214、末条 tool 回显清噪）。
  - `lmstudio` → 复用 `LMStudioCompatibility`（最小字段映射）。
  - `iflow` → 复用 `iFlowCompatibility`（OpenAI 形状，OAuth 于 Provider 层处理）。
  - `qwen` → 默认走最小路径（保持 OpenAI 形状），不启用旧 `qwen-compat` 的“input/parameters”改形状逻辑。
  - 其他 → passthrough/minimal。

## 与 BaseProvider 的集成

- Chat 协议 Provider（`ChatHttpProvider`，原 `OpenAIStandard`）在以下两处调用：
  - `preprocessRequest` 末尾：`compat.request`
  - `postprocessResponse` 封装前：`compat.response`
- Responses/Anthropic Provider 可按需接入（初期保持 passthrough）。

## 错误模型与快照

- 错误：
  - `ERR_PROTOCOL_MISMATCH`：协议守卫失败（含 `requestId/providerKey/providerType/providerProtocol/routeName`）。
  - `ERR_COMPAT_PROTOCOL_DRIFT`：compat 改变协议形状。
  - `ERR_UNSUPPORTED_PROVIDER_TYPE`：未注册协议族。
  - `ERR_PROVIDER_HTTP`：HTTP 层错误（保留）。
- 上报路径：Compat/Provider 每次捕获异常时必须调用 `emitProviderError()`（封装在 `provider-error-reporter.ts`），将错误统一转换为 `ProviderErrorEvent` 并提交给 sharedmodule/llmswitch-core 的 `providerErrorCenter`，同时调用 `errorHandlingCenter.handleError()`。虚拟路由器依赖这些事件执行熔断，禁止吞掉任何异常或在本地兜底。
- 快照：
  - `compat-pre/compat-post`（request/response）、`provider-request/provider-response/provider-error`；均脱敏，best-effort。

## Provider 类型对齐（type-only）

- Provider 仅按协议类型划分：`openai`、`responses`、`anthropic`、`gemini`。
- Factory 按类型创建：
  - `openai` → Chat 协议 Provider（当前类：ChatHttpProvider）；
  - `responses` → ResponsesHttpProvider（上游 SSE→JSON 解析）；
  - `anthropic` → AnthropicHttpProvider；
  - `gemini` → 预留。
- 旧配置兼容（规范化）：
  - 若发现 `providerType` ∈ {`glm`,`qwen`,`iflow`,`lmstudio`}，运行时规范化为 `openai` 并记录告警；品牌保留在 `providerId` 或 `extensions.oauthProviderId`。
  - 不在 `llmswitch-core` 内判断品牌，品牌差异仅由 compat 聚合器处理（最小清理）。

## 迁移与兼容

- 配置：将旧 `providerType: 'qwen'|'glm'|'iflow'|'lmstudio'` 规范化为 `providerType: 'openai'`，并通过 `providerId`/`extensions.oauthProviderId` 表达家族；保留警告日志。
- Qwen：默认走 OpenAI 兼容端点 `/v1/chat/completions`；如需 native wire，需新增协议 id 与 codec，不能在 `openai-chat` 协议下改形状。

### 配置示例（OAuth 品牌）

```json
{
  "type": "openai-standard",
  "config": {
    "providerType": "openai",
    "baseUrl": "https://portal.qwen.ai/v1",
    "auth": { "type": "oauth" },
    "extensions": { "oauthProviderId": "qwen" },
    "models": ["qwen3-coder-plus"]
  }
}
```

### 运行期元数据（runtime metadata）

ProviderComposite 与 Hook/HTTP 层依赖 `BasePipeline` 回写的元数据：

```ts
{
  requestId, pipelineId, routeName,
  providerId, providerKey,
  providerType, providerProtocol,
  target: { model, providerType, providerKey, ... }
}
```

上述字段作为请求体的不可枚举属性注入（attachProviderRuntimeMetadata），Provider/Composite 通过 extractProviderRuntimeMetadata 读取。

## 测试计划

- 协议守卫：错配触发 `ERR_PROTOCOL_MISMATCH`；家族聚合器若改形状触发 `ERR_COMPAT_PROTOCOL_DRIFT`。
- GLM 回归：tools 严格字段清理、1210/1214、非流式响应黑名单。
- LM Studio / iFlow：OpenAI 形状不变；OAuth 流程（iFlow）在 Provider 层。
- Qwen：保持 OpenAI 形状直连。
- Responses：上游 SSE → JSON，对内一律 JSON。

### 建议的测试入口

- 构建：`npm run build`
- 蓝图回归：`npm test -- tests/pipeline/blueprint-regression.test.ts --runInBand`
- 协议守卫单测：新增 `tests/provider/provider-composite-guards.test.ts`（建议，见测试文档）

## 执行步骤（本次提交范围）

1) 添加 ProviderComposite 与 openai 聚合器骨架文件；
2) 在 Chat 协议 Provider（`chat-http-provider.ts`）植入 compat.request/compat.response 调用；
3) Factory 由 `protocol-first` 选择 Provider（保持与旧配置兼容的规范化通道）；
4) 回归：`npm test -- tests/pipeline/blueprint-regression.test.ts --runInBand`。
