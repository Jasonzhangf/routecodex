# Metadata / Request Isolation Plan

## 目标与验收标准

### 目标

将 `metadata` 收敛为入口到 provider 发出前的内部控制语义 carrier，和真实 provider request body / provider SDK options 完全隔离。

### 验收标准

- provider 出站真实 request body 中不出现 top-level `metadata`。
- provider SDK options 中不从 `body.metadata` 派生上游 metadata/options。
- Hub Pipeline / Rust outbound 构造不再从 `payload.metadata.context` 回填 provider wire payload。
- 内部控制语义仍可在 pipeline、router、runtime、snapshot 中读取，但只通过 runtime carrier / side-channel 传递。
- 无 fallback、无双路径补偿、无静默吞错；发现 metadata 出口违规必须 fail-fast 或测试红灯。

## 范围与边界

### In Scope

- 审计和修复 provider 出站 payload 构造路径。
- 收敛 Anthropic、OpenAI SDK transport、Responses direct/passthrough、Gemini、Qwen、GLM 相关 provider 出口。
- 收敛 Rust outbound format build 中从 `metadata.context` 回填业务 payload 的路径。
- 增加 metadata 泄露红测与 provider-request snapshot 验证。
- 保留 debug/snapshot metadata，但明确其不是 provider wire payload。

### Out of Scope

- 不改 provider auth、quota、health、retry 语义。
- 不改真实用户请求 payload 的业务字段语义。
- 不做 provider-specific 特例来绕过 Hub Pipeline / Virtual Router 规则。
- 不引入 fallback sanitizer 作为唯一保障；修复应在唯一真源出站构造点完成。

## 设计原则

1. `metadata` 是内部控制语义，不是 provider request 的一部分。
2. provider outbound boundary 必须有单一门禁：任何真实发送体和 SDK options 不得消费 `body.metadata`。
3. runtime carrier 使用非枚举 symbol / context side-channel；禁止再把 carrier merge 回 request body。
4. Rust runtime 为 Hub Pipeline 语义真源；TS 只保留薄壳和边界调用。
5. debug/snapshot 可记录 metadata，但必须和 `data/body` 分离。

## 修复清单路径

### P0：已确认违规点

1. `src/client/anthropic/anthropic-protocol-client.ts`
   - 当前问题：`OpenAIChatProtocolClient` 已删除 `metadata` 后，该文件又恢复 top-level `metadata` 到 Anthropic body。
   - 修复方向：删除恢复 `metadata` 的逻辑；若 Anthropic-gated proxy 需要用户级合法字段，必须先定义显式 provider wire 字段，不得借用内部 metadata。

2. `src/providers/core/runtime/vercel-ai-sdk/openai-sdk-transport.ts`
   - 当前问题：`body.metadata` 被映射到 `openaiProviderOptions.metadata`。
   - 修复方向：禁止从 `body.metadata` 派生 provider options；保留 `prediction` 等真实 provider wire 字段处理。

3. `src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-request-exec.ts`
   - 当前问题：`rawBody.metadata` 被复制到 Anthropic SDK request。
   - 修复方向：删除 `metadata` 复制；保持 body 与 provider SDK request 隔离。

4. `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_outbound_format_build.rs`
   - 当前问题：`build_openai_responses_request` / `build_openai_chat_request` 等从 `format_envelope.payload.metadata.context` 回填 `input/chatMessages/tools`。
   - 修复方向：禁止 outbound builder 读取 `payload.metadata.context` 生成 provider wire payload；需要的 canonical payload 必须在进入 outbound builder 前以显式业务字段存在。

### P1：边界加固点

5. `src/providers/core/runtime/provider-request-shaping-utils.ts`
   - 当前职责：统一调用 protocol client / profile body builder。
   - 加固方向：在此处增加 provider outbound boundary assert：返回 body 不得包含 top-level `metadata`；该 assert 只能 fail-fast，不做修补 fallback。

6. `src/providers/core/runtime/responses-provider.ts`
   - 当前状态：direct/passthrough 已删除 top-level `metadata`，但还要覆盖 submit_tool_outputs / direct SSE / JSON send 路径红测。
   - 加固方向：在 `sanitizeResponsesProviderOutboundBody` 前后建立明确 invariant；不得靠 sanitizer 掩盖上游污染。

7. `src/client/openai/chat-protocol-client.ts`、`src/client/gemini/gemini-protocol-client.ts`、`src/providers/profile/families/glm-profile.ts`、`src/providers/profile/families/glm-profile.ts`
   - 当前状态：主路径已删除或不恢复 metadata。
   - 加固方向：补测试防回归，确保后续 provider profile 不重新引入 metadata。

### P2：类型和文档收口

8. `src/providers/core/runtime/provider-runtime-metadata.ts`
   - 当前状态：非枚举 symbol carrier 是正确方向。
   - 收口方向：文档化“只能 internal side-channel，不得 merge 到 body”。

9. `sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.ts`
   - 当前状态：live Hub envelope 类型仍承载内部 `metadata?: JsonObject`；旧 0-consumer `types/chat-schema.ts` 已物理删除，禁止复活第二套 schema。
   - 收口方向：保留内部 envelope metadata，但标注生命周期边界；provider wire schema 不得复用这些字段。

10. `docs/ARCHITECTURE.md` 或独立设计文档
   - 收口方向：追加 metadata lifecycle 规则：入口可读、pipeline 可用、provider send 前必须隔离。

## 技术方案

### 1. 明确 carrier 分层

- Internal carrier：`ProviderRuntimeMetadata` / context metadata / Rust envelope metadata。
- Wire payload：provider request body / provider SDK args / upstream HTTP body。
- Snapshot payload：debug data + separated metadata。

### 2. 删除违规注入

- 删除 Anthropic body metadata 恢复。
- 删除 OpenAI SDK provider options metadata 映射。
- 删除 Anthropic SDK request metadata 复制。
- 删除 Rust outbound builder 对 `payload.metadata.context` 的 provider wire 回填依赖。

### 3. 增加边界断言

- 在 provider outbound body 构造完成后 assert：`metadata` 不存在。
- 断言失败必须抛显式错误，禁止 silent delete 作为最终手段。
- 已知 legacy sanitize 函数只能作为协议格式 sanitizer，不作为 metadata 泄露兜底。

### 4. 调整测试快照

- provider-request snapshot 应断言：`data/body.metadata === undefined`。
- snapshot root 允许存在独立 `metadata` 字段，表示 debug context。
- SDK transport 单测断言 options 不包含 metadata。

## 风险与规避

- 风险：某些 Anthropic-gated proxy 之前依赖 `metadata.user_id`。
  - 规避：不能继续借用内部 metadata；若确有 provider 合法字段需求，单独建显式 wire 字段并用测试证明。

- 风险：Rust outbound builder 依赖 `metadata.context` 修复缺失 canonical payload。
  - 规避：先找到 canonical payload 生成真源，把 required fields 前移到业务 payload；不能在 outbound 末端从 metadata 补。

- 风险：只靠 strip/sanitize 会掩盖上游污染。
  - 规避：新增 fail-fast invariant，测试必须定位污染源。

## 测试计划

### 定向单测

- OpenAI chat client：metadata 不出 body。
- Gemini client：metadata 不出 body。
- Anthropic client：metadata 不出 body，且不恢复内部 metadata。
- OpenAI SDK transport：`providerOptions.metadata` 不由 body metadata 生成。
- Anthropic SDK exec：request 不复制 rawBody metadata。
- Responses provider direct/passthrough：metadata 不出 body。
- Qwen/GLM profile：profile build 后无 top-level metadata。

### Rust 测试

- `hub_req_outbound_format_build`：包含 `payload.metadata.context` 的输入不得把 metadata 或 context-derived fields 偷渡到 provider payload。
- Hub Pipeline outbound：metadata 只能留在 envelope/internal result，不能出现在 provider request body。

### 集成 / snapshot

- provider-request snapshot：`data.metadata` 不存在；snapshot root `metadata` 可存在。
- Anthropic / OpenAI SDK / Responses direct 三条 representative path 各跑一条 provider-request snapshot。

### 静态红线

- grep 红线：provider outbound / SDK transport 中禁止 `body.metadata -> provider options`、`rawBody.metadata -> request.metadata`、`payload.metadata.context -> wire payload`。

## 实施步骤

1. 写红测覆盖 P0 三类泄露点。
2. 修 Anthropic protocol client，删除 metadata 恢复。
3. 修 OpenAI/Anthropic SDK transport，删除 body metadata 到 provider options/request 的映射。
4. 修 Rust outbound builder，不再从 `payload.metadata.context` 生成 provider wire payload。
5. 加 provider outbound boundary assert，fail-fast 暴露残余泄露。
6. 补 Responses/Qwen/GLM/Gemini/OpenAI regression tests。
7. 更新架构文档，明确 metadata 生命周期边界。
8. 跑定向测试、Rust 测试、provider-request snapshot 验证。

## 完成定义（DoD）

- 所有 provider outbound body / SDK options 不含内部 metadata。
- 所有内部 pipeline 控制语义仍可通过 runtime carrier 正常工作。
- 红测覆盖 P0 泄露点并转绿。
- 文档明确 metadata 生命周期：入口可读、内部可用、provider 发出前隔离。
- 无 fallback、无 provider-specific 旁路、无静默删改真实业务 payload。

## 2026-06-01 补充：请求/响应闭环与隔离要求

### 新增目标

metadata 必须是无状态、短生命周期、闭环内控制语义：

- 请求入口创建或读取 metadata。
- 请求处理、路由、provider outbound 前内部消费 metadata。
- provider 发出前 wire payload 与 metadata 完全隔离。
- 响应处理可读取当前请求闭环内 metadata 完成转换、snapshot、servertool 判定。
- 请求/响应闭环结束后，当前闭环 metadata 必须释放，不得成为跨请求、跨响应、跨端口、跨 session 的持久状态。

### 生命周期边界

1. **Inbound Request Scope**
   - metadata 来源限于当前入站请求、端口上下文、session 上下文、runtime side-channel。
   - 不得读取其他端口、其他 session、其他 requestId 的 metadata。

2. **Pipeline Scope**
   - metadata 只作为控制语义输入：routeHint、entryEndpoint、stream intent、servertool/clock/web_search 控制、snapshot 标签等。
   - metadata 不得被混入 canonical business payload。

3. **Provider Outbound Boundary**
   - provider HTTP body / SDK request / provider options 不得携带内部 metadata。
   - 任何从 metadata 派生 provider wire payload 的路径都必须被删除或改为显式业务字段真源。

4. **Response Scope**
   - 响应阶段只能读取同一 requestId / pipelineId 的 metadata。
   - 响应转换完成后不得把 metadata 注入 client response body；debug snapshot 可在独立字段记录。

5. **Closeout Scope**
   - 一个请求/响应闭环完成后，metadata carrier 必须从临时 context 中释放。
   - 禁止把闭环 metadata 写入全局 singleton、provider runtime persistent state、port-shared cache、session-shared cache。

### 端口隔离

- metadata 必须绑定当前 port/server instance context。
- 5520 / 5555 / 10000 等端口的 metadata 不得互读、互写、复用。
- provider health、quota、runtime config 等持久状态不是 request metadata；不得把 request metadata 写入这些持久文件或跨端口状态。

### Session 隔离

- metadata 必须绑定当前 session / conversation scope。
- `sessionId` / `conversationId` 只能作为当前闭环控制索引，不得把一个 session 的 metadata 作为另一个 session 的请求输入。
- sticky/session routing 可读取 normalized session identifiers，但不得保存整包 metadata。

### 污染防线

- 禁止 metadata -> request body。
- 禁止 metadata -> provider SDK options。
- 禁止 metadata -> client response body。
- 禁止 metadata -> persistent provider/runtime state。
- 禁止跨 port / session / requestId 复用 metadata 对象引用。

### 新增修复清单

11. `src/providers/core/runtime/http-request-executor.ts`
    - 当前职责：构造 requestInfo、执行 provider request、写 provider snapshot。
    - 加固方向：确保 `context.metadata` 仅传给 snapshot 独立 metadata 字段；发送体和 headers/options 不得引用 metadata 对象；执行完成后不把 metadata 存入长生命周期对象。

12. `sharedmodule/llmswitch-core/src/bridge/routecodex-adapter.ts`
    - 当前职责：构造 conversion envelope metadata。
    - 加固方向：metadata 必须绑定 requestId / endpoint / port context，不能复用上一次 envelope 对象；响应方向 envelope 不得继承无关请求 metadata。

13. `sharedmodule/llmswitch-core/src/conversion/runtime-metadata.ts` 与 Rust `shared_metadata_semantics.rs`
    - 加固方向：runtime metadata 只允许在当前 carrier 中读取；clone/ensure 操作不得形成跨闭环全局状态。

14. `src/debug/snapshot-store.ts` / provider snapshot writer
    - 加固方向：snapshot metadata 是观测数据，不得被后续真实请求当作 runtime metadata 恢复，除非显式 replay 工具路径；replay 必须标记为 replay scope。

### 新增测试计划

- 闭环隔离：两个连续请求带不同 metadata，第二个 provider-request 不得出现第一个 metadata。
- 端口隔离：不同 port/serverId 下相同 sessionId metadata 不互相污染。
- Session 隔离：同端口不同 sessionId metadata 不互相污染。
- Response 隔离：响应 body 不出现请求 metadata；snapshot root metadata 允许存在但不进入 response data。
- 对象引用隔离：metadata 对象修改不影响后续请求 context。
- Replay 隔离：debug replay 使用 snapshot metadata 时必须显式 replay scope，不进入正常 live path。

## 2026-06-01 入口 handler 收口补充

### 新发现违规点

12. `src/server/handlers/chat-handler.ts`
    - 问题：入口读取 `payload.metadata.mockSampleReqId` 作为 mock 控制值，且 pipeline body 沿用原始 `payload`，top-level `metadata` 可继续进入 Hub Pipeline。
    - 修复：`mockSampleReqId` 不再从 body metadata 派生；`stripRequestBodyMetadataForPipeline` 在 handoff 前剥离 body metadata，只把 request metadata 放入 internal carrier。

13. `src/server/handlers/messages-handler.ts`
    - 问题：入口读取 `pipelineBody.metadata.mockSampleReqId`，并把含 metadata 的 body 传给 pipeline。
    - 修复：删除 body metadata 控制读取；handoff 前剥离 top-level metadata。

14. `src/server/handlers/responses-handler.ts`
    - 问题：submit_tool_outputs 会把 `session_id` 写回 `payload.metadata`，随后同一 payload 进入 pipeline body；同时仍读取 `payload.metadata.mockSampleReqId`。
    - 修复：session/resume scope 只放 metadata carrier；不再写回 body metadata；pipeline body 剥离 top-level metadata。

15. `src/server/handlers/images-handler.ts`
    - 问题：images 入口把 client `payload.metadata` 合并进 chat pipeline body 的 `metadata` 字段。
    - 修复：image generation 控制语义改为显式 `providerImageGeneration` 字段；client metadata 只进入 carrier，不进入 body。

### 新增验证

- `tests/server/handlers/handler-utils.metadata.spec.ts`：覆盖 `stripRequestBodyMetadataForPipeline`，确保原请求 metadata 仍保留给 carrier，但 pipeline body 不含 metadata。
- `tests/server/handlers/handler-metadata-boundary.spec.ts`：覆盖 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/images/generations` 四个入口，确认 body metadata 不进入 pipeline body，控制语义只在 metadata carrier。
- `tests/red-tests/no_provider_body_metadata_control.test.ts`：红线范围扩到 server handlers，禁止入口恢复 body metadata 控制读取。

### 已执行验证

```bash
npm run jest:run -- --runTestsByPath tests/red-tests/no_provider_body_metadata_control.test.ts tests/server/handlers/handler-utils.metadata.spec.ts tests/server/handlers/handler-metadata-boundary.spec.ts --runInBand --forceExit
```

结果：3 suites / 7 tests passed；随后 metadata 定向回归扩展到 12 suites / 67 tests passed。

## 2026-06-01 响应 / replay / snapshot 收口补充

### 新发现违规点

16. `sharedmodule/llmswitch-core/src/sse/json-to-sse/event-generators/responses.ts`
    - 问题：Responses JSON -> SSE 的 `createResponsePayload` 会把 `response.metadata` 投射到 `response.created` / `response.in_progress` / `response.completed` client SSE payload。
    - 修复：client SSE response payload 不再输出 `metadata`；内部 metadata 只能留在 carrier / snapshot root。

17. `sharedmodule/llmswitch-core/src/sse/sse-to-json/responses-sse-to-json-converter.ts`
    - 问题：Responses SSE -> JSON native materializer 仍需确保 provider SSE `data.metadata` / `responsePayload.metadata` 不会进入 client JSON `response.metadata`。
    - 修复：native materializer 不聚合或恢复 response metadata；provider event metadata 不进入 client JSON body。

18. `src/server/runtime/http-server/direct-passthrough-payload.ts`
    - 问题：direct passthrough replay 优先使用 `metadata.__raw_request_body` 时，会把 raw body 的 top-level `metadata` 恢复进 provider wire payload。
    - 修复：direct raw/body clone 使用 wire payload clone，统一剥离 top-level `metadata`，避免 replay/snapshot 观测数据回流 live path。

19. `src/server/handlers/responses-handler.ts`
    - 问题：Responses request context 可能持久化原始 `payload`，其中包含 client body metadata。
    - 修复：`responsesRequestContext.payload` 和 capture context payload 改为剥离后的 `pipelineBody`；session scope 保留在 carrier 字段，不进入持久 payload。

### 新增验证

- `tests/sharedmodule/responses-sse-metadata-boundary.spec.ts`：覆盖 Responses JSON->SSE 与 SSE->JSON 两个响应方向，确认 client response payload 不含 internal/provider metadata。
- `tests/server/runtime/http-server/direct-passthrough-payload.spec.ts`：覆盖 replay/raw payload direct 路径，确认 `metadata.__raw_request_body.metadata` 不会回到 provider wire body。
- `tests/debug/snapshot-store-port-isolation.red.spec.ts`：补 provider-request snapshot 验证，确认 snapshot root metadata 允许存在但 `payload.data.metadata` 不存在，端口命名空间隔离仍成立。
- `tests/server/handlers/handler-metadata-boundary.spec.ts`：补 Responses persisted request context 验证，确认持久 context payload 不含 request body metadata。
- `tests/red-tests/no_provider_body_metadata_control.test.ts`：红线扩展到 Responses SSE/JSON response 生成器，禁止 `response.metadata` / `data.metadata` / `responsePayload.metadata` 投射到 client response body。

### 已执行验证

```bash
npm run jest:run -- --runTestsByPath tests/red-tests/no_provider_body_metadata_control.test.ts tests/server/handlers/handler-utils.metadata.spec.ts tests/server/handlers/handler-metadata-boundary.spec.ts tests/sharedmodule/responses-sse-metadata-boundary.spec.ts tests/server/runtime/http-server/direct-passthrough-payload.spec.ts tests/debug/snapshot-store-port-isolation.red.spec.ts tests/providers/core/runtime/provider-runtime-metadata.isolation.spec.ts tests/client/anthropic-protocol-client.spec.ts tests/providers/core/runtime/provider-request-shaping-utils.metadata-boundary.spec.ts tests/providers/core/runtime/vercel-ai-sdk-openai-transport.spec.ts tests/providers/core/runtime/vercel-ai-sdk-anthropic-transport.spec.ts tests/providers/runtime/responses-provider.direct-passthrough.spec.ts tests/server/runtime/http-server/executor/usage-aggregator.spec.ts tests/unified-hub/shadow-runtime-compare.errorsamples.spec.ts tests/providers/mock-provider-runtime.spec.ts --runInBand --forceExit
```

结果：15 suites / 76 tests passed。

```bash
cargo test -p router-hotpath-napi hub_req_outbound_format_build --lib
```

结果：13 tests passed；存在既有 Rust warnings。
