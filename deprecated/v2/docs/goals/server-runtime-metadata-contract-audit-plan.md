# Server Runtime Metadata Contract Audit Plan

## 1. 目标

审计并改造 Server Runtime，使 server adapter / handler / direct passthrough / response projection 全部遵守 Hub/VR 节点 contract 与 `Meta*` carrier 生命周期：

- server 入口只捕获当前请求事实和 metadata carrier，不把 `metadata` 留在 pipeline normal body。
- direct passthrough / provider body / SDK options / client response body 禁止内部 metadata。
- server 侧不得重建 Hub/VR 工具治理、路由语义或 provider-specific 修补。
- 每个 server 改造点必须有唯一 owner、红测、在线 contract/help 查询步骤和 live/focused 验证。

## 2. 当前证据

| 区域 | 当前代码证据 | 初判 |
|---|---|---|
| Chat handler | `src/server/handlers/chat-handler.ts` 读取 body metadata，`stripRequestBodyMetadataForPipeline(payload)` 后把 metadata merge 到 `ctx.executePipeline.metadata` | 方向正确，但 metadata merge 仍是泛型 bag，需收口到 server-side MetaReq01/02 builder/help |
| Messages handler | `src/server/handlers/messages-handler.ts` 同样捕获 request body metadata，并写 `__raw_request_body` | 高风险：raw body snapshot 进入 metadata，必须证明 direct replay / live path 不恢复 top-level metadata |
| Handler utils | `stripRequestBodyMetadataForPipeline` 静默剥离 body.metadata；`sanitizeClientPipelineMetadata` 只删除 `routeHint` | 入口剥离是必要隔离，但目前缺少显式 contract/help 与字段白名单；静默 delete 容易掩盖违规来源 |
| Direct passthrough | `src/server/runtime/http-server/direct-passthrough-payload.ts` 已对 direct provider body metadata fail-fast | 已符合禁止出口，但需保留红测和 server module help |
| Response projection | `sendPipelineResponse` / `handler-response-utils.ts` 是 client response body/SSE 最后出口 | 需审计是否有 metadata/error/snapshot carrier 混入 client body/SSE frame |
| Error projection | `respondWithPipelineError` / `writeStartedSsePipelineError` | 只能进入 client-visible error projection，不得吞成 success truth 或携带 internal metadata |

## 3. 违规/风险清单

### S1：Server metadata 入口仍是泛型 bag

- 风险：`mergePipelineMetadata(requestBodyMetadata, internalMetadata)` 允许客户端 metadata 字段进入 runtime carrier，当前只删除 `routeHint`。
- 改造方向：新增 server module help / contract，定义 `ServerReqInbound01ClientRaw -> MetaReq01EntryCaptured -> MetaReq02RuntimeCarrier` 的字段白名单。
- 红测：客户端 body metadata 中除允许字段外的 route/runtime/provider control 不得进入 pipeline metadata；违规字段应 fail-fast 或被明确拒绝，不能静默 sanitizer。

### S2：`__raw_request_body` 可携带 metadata 回流 direct replay

- 风险：handler 把原始 body 放入 metadata `__raw_request_body`，direct replay 若恢复 raw body 可能把 `metadata` 带回 provider body。
- 当前保护：direct passthrough clone 时发现 raw body metadata 会 fail-fast。
- 改造方向：server contract 声明 `__raw_request_body` 只能用于 debug/direct replay guard，不是 normal live payload；direct replay 保持 fail-fast，不改成删除。
- 红测：`metadata.__raw_request_body.metadata` 进入 direct passthrough 必须报错；正常 raw body 无 metadata 时 payload 语义不变。

### S3：入口剥离 `body.metadata` 缺少可查询 help

- 风险：后续 agent 只看到 handler 静默剥离，可能误以为 metadata 是 normal payload 清洗项，而不是 carrier 边界。
- 改造方向：新增 `describeServerRuntimeModuleHelpJson` 或把 server adapter 模块纳入 `describeHubPipelineModuleHelpJson` 的 `server.req_adapter` module。
- 红测：每个 server adapter module help 必须列出 owner、allowed metadata fields、red tests、forbidden exits。

### S4：client response / SSE 出口缺少 metadata carrier guard 审计

- 风险：Hub/Provider response 中若混入 `metadata`、`Meta*`、`ErrorErr*`、snapshot carrier，server response projection 可能直接发送给 client。
- 改造方向：在 response projection owner 增加 fail-fast guard 或已有 guard 的 contract 化说明；禁止“删除 metadata 后发送”。
- 红测：client JSON/SSE body 发现 top-level `metadata` / `MetaReq*` / `MetaResp*` / internal `__rt` 必须 fail-fast 或投影到 error chain，不得作为 success payload。

### S5：server error projection 与 ErrorErr* 链未统一在线说明

- 风险：HTTP error mapper / route error hub 可能将 provider/runtime internal details 暴露给 client body，或把 provider/runtime error 当 success response。
- 改造方向：定义 server error projection module help：只消费 `ErrorErr06ClientProjected`，输出 client-visible error；internal metadata/auth/requestContext 不进 public details。
- 红测：`http-error-mapper-provider-not-available-details` 类测试扩展到 ErrorErr carrier / metadata / auth / requestContext。

## 4. 分阶段改造

### Phase Server-A：Server module help 只读落地

- 新增 server runtime module help contract：`server.req_adapter`、`server.direct_passthrough`、`server.response_projection`、`server.error_projection`。
- NAPI/TS help 可在线查询 owner、allowed fields、forbidden exits、red tests、debug flow。
- 不改变 live 行为。

### Phase Server-B：入口 metadata 白名单与 fail-fast

- 将 `readRequestBodyMetadata` / `mergePipelineMetadata` 从泛型 merge 改为显式 builder。
- 只允许当前闭环字段进入 `MetaReq01/02`；高风险 route/provider/runtime control 字段 fail-fast。
- 保持 body handoff 不含 `metadata`。

### Phase Server-C：response/client 出口 guard

- 审计 `sendPipelineResponse`、SSE frame build、error response build。
- 对 success body/SSE frame 中的 internal metadata / Meta* / Error* / Snapshot* carrier 建 fail-fast guard。
- 红测证明 client-visible payload 不被静默 sanitizer。

### Phase Server-D：server error projection contract

- server error projection 只消费统一 Error chain 投影。
- internal metadata/auth/requestContext 仅用于日志/snapshot，不进入 public error details。
- 红测锁住 provider/runtime internal details 不泄漏。

## 5. Debug 流程

1. 先查在线 help：server 模块查 server/module help；Hub/VR 查 `describeHubPipelineModuleHelpJson` / `describePipelineModuleHelpJson(moduleId)`。
2. 定位红测：server adapter、direct passthrough、response projection、error projection 各自有对应 red/focused tests。
3. 确定唯一 owner：handler 入口、direct payload builder、response projection、error projection 四类不能互相补偿。
4. 先红后改：新增或调整红测证明违规会失败，再改唯一 owner。
5. 红测绿后验证在线结果：help 输出、focused Jest、provider/client payload、direct replay、SSE/JSON projection。
6. 记录证据：`note.md` 记录命令和唯一范围；已验证结论进入 `MEMORY.md`。

## 6. 初始验证命令

- `npm run jest:run -- tests/server/handlers/handler-utils.metadata.spec.ts tests/server/runtime/http-server/direct-passthrough-payload.spec.ts --runInBand`
- `npm run jest:run -- tests/server/utils/http-error-mapper-provider-not-available-details.spec.ts --runInBand`
- `npm run jest:run -- tests/red-tests/no_provider_body_metadata_control.test.ts tests/red-tests/hub_pipeline_meta_error_carrier_contract.test.ts --runInBand`
- `git diff --check`

## 7. 完成定义

- server 每个 contract 模块有在线 help：adapter、direct passthrough、response projection、error projection。
- server metadata 入口不再是泛型无约束 merge；字段 owner、阶段、释放规则可查询。
- direct/provider/client/error 出口发现 internal metadata/carrier 时 fail-fast，不 silent delete。
- 红测覆盖 server 入口、direct replay、client JSON/SSE、error projection 四个边界。
