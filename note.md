## 2026-06-18 architecture/build gate rerun + doc drift closeout

## 2026-06-18 install/build tiering gate closeout

- 为了把“本地 build/install 与 CI 都能阻断 review-surface 漂移”从间接事实收成机器锁，本轮只补了调用层级 gate，不接手 Jason 正在做的 `__routecodex_*` / SSE custom 字段清理。
- 新增：
  - `scripts/architecture/verify-build-script-tiering.mjs`
  - 校验 `build:dev` / `build:dev:full` 只能经 `npm run build`
  - 校验 `install:global` / `install:release` 只能经各自 installer shell
  - 校验 `scripts/install-global.sh` / `scripts/install-release.sh` 内部必须走 `npm run build:min`
- 接线：
  - `package.json` 新增 `verify:build-script-tiering`
  - `verify:architecture-ci-longtail` 现强制执行该 gate
  - `scripts/architecture/verify-function-map-build-wiring.mjs` 新增反向检查：若 longtail 移除 `verify:build-script-tiering` 直接 fail
- 已验证：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-build-script-tiering.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-function-map-build-wiring.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
  - `git diff --check` PASS
- 结论：
  - review-surface 漂移现在不只会被 `build` / `build:min` 挡住，install shell 也被静态 gate 锁到必须经过 `build:min`
  - 这次补的是“防绕过 gate”，不是新的 `install:global` / `install:release` 实机 smoke；当前无权把它表述成一次新的安装运行验证

- 重新按当前 worktree 取了完整硬证据，不再沿用 earlier shell 采样不稳定的旧结论：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-review-surface-light` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-ci` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run build:min` PASS
- 这次 rerun 说明当前代码面上：
  - no-custom-payload-carriers / mainline-call-map / wiki-sync / wiki-html-sync / manifest-sync 全绿；
  - review surface 已真实进入主 `architecture-ci`；
  - `build:min` 已能在本地前置链挡住 review-surface 漂移，不再只是远端 CI 兜底。
- 本轮剩余漂移已经收敛到文档叙事而不是 gate/代码：
  - `docs/goals/hub-pipeline-architecture-review-surface-cleanup-plan.md` 仍把 `mtc-07` 写成 pending；
  - `docs/architecture/wiki/metadata-center-mainline-source.md` 仍把 center 主线描述成 `future`。
- 收口动作：
  - architecture review surface 计划改为：`mtc-07` 已 anchored 到 `metadata-center.ts::releaseMetadataCenterForHttpResponse -> MetadataCenter.markReleased`；
  - metadata-center wiki 改成“当前已部分实现、仍在迁移”，不再沿用 future 叙事；
  - 改完需要重渲染 wiki HTML，并复跑 wiki sync/html sync/manifest sync。

## 2026-06-17 hub pipeline architecture review evidence

## 2026-06-18 metadata center mtc-07 closeout verified

- 本轮目标是把 `docs/architecture/mainline-call-map.yml` 里的 `metadata.center.mainline::mtc-07` 从 `binding pending` 收成真实 owner/binding，不接手 Jason 正在并行清理的 `__routecodex_*` / SSE custom payload 字段线。
- 实现收口：
  - `src/server/runtime/http-server/metadata-center/metadata-center.ts`
    - 增加 `METADATA_CENTER_STATUS_ORDER`
    - 增加 `transitionSlotStatus(...)`
    - 增加 `markReleased(...)`
    - `releaseMetadataCenterForHttpResponse(...)` 已从 handler helper 收回到 MetadataCenter owner 文件，避免 function-map canonical builder 漂移
  - `src/server/handlers/handler-response-common.ts`
    - 改为从 MetadataCenter owner import/re-export `releaseMetadataCenterForHttpResponse`
  - `src/server/handlers/handler-response-utils.ts`
    - JSON `empty` / normal closeout 都显式调用 release helper
  - `src/server/handlers/handler-response-sse.ts`
    - bridge error / structured error / missing stream / prestart client close / normal SSE finish-close 都显式调用 release helper
- 文档绑定同步：
  - `docs/architecture/function-map.yml`：`hub.metadata_center_mainline` 维持 active，canonical builder `releaseMetadataCenterForHttpResponse` 已与真实 owner 对齐
  - `docs/architecture/mainline-call-map.yml`：`mtc-07` 真实绑定改为 `metadata-center.ts::releaseMetadataCenterForHttpResponse -> MetadataCenter.markReleased`
  - `docs/architecture/wiki/metadata-center-mainline-source.md`：`mtc-07` 说明改成真实 owner 文件
  - 已重渲染 generated wiki / HTML：`mainline-call-graph.md` 与 `metadata-center-mainline-source.html` 等同步
- 定向验证通过：
  - `tests/server/handlers/handler-response-utils.metadata-center-closeout.spec.ts`
  - `tests/server/http-server/executor-metadata.spec.ts`
  - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
  - `node scripts/architecture/verify-function-map-canonical-builder-definitions.mjs`
  - `npm run verify:architecture-mainline-call-map`
  - `npm run verify:architecture-wiki-sync`
  - `npm run verify:architecture-wiki-html-sync`
  - `npm run verify:architecture-manifest-sync`
  - `npm run verify:architecture-review-surface-light`
  - `npm run verify:architecture-review-surface`
  - `npm run verify:architecture-ci-longtail`
  - `node scripts/architecture/verify-function-map-build-wiring.mjs`
  - `npm run verify:architecture-no-custom-payload-carriers`
  - `npx tsc --noEmit --pretty false`
  - `git diff --check`
- 结论：
  - `mtc-07` 现在已有真实 closeout/release owner，不再是“文档 pending edge”
  - 此 slice 不改 payload 语义，不改 provider/runtime 路由，只做 request-scoped MetadataCenter closeout 状态收口
- 剩余非本轮 blocker：
  - 完整 `build:min` / `verify:architecture-ci` 通过 shell 工具长链采样存在 session 输出异常；当前已拿到其前置 review-surface / function-map / longtail leaf 证据，但本轮只把它记为“工具取证不稳定”，不把它宣称成未验证的失败或成功
  - Jason 最新规则下，`assertClientResponseHasNoInternalCarriers()` 对顶层 `metadata` 仍需后续补成一律 fail-fast 审计点

## 2026-06-18 response metadata guard protocol-shape closeout

- 继续处理 `assertClientResponseHasNoInternalCarriers(...)` 的剩余边界时，先按当前 worktree 跑了：
  - `tests/red-tests/server_response_projection_metadata_guard.test.ts`
  - `tests/red-tests/server_sse_guard_e2e.test.ts`
  - `tests/red-tests/server_sse_metadata_guard_e2e.test.ts`
- 真实红点不是“所有 metadata 都漏”，而是：
  - generic SSE frame 顶层 `metadata` 仍被放过；
  - 但 `Responses` 协议里的合法 metadata 场景（`object: "response"` / `type: "response.*"`）本来就是绿的，不能一刀切打死。
- 最小修复：
  - `src/server/handlers/handler-response-common.ts`
    - 新增 `isClientVisibleProtocolMetadataContainer(...)`
    - 规则改成：只有 `Responses` 合法协议形状才允许 `metadata` 继续递归检查；其它 generic frame/body 一旦出现顶层 `metadata` 直接 fail-fast
  - `tests/red-tests/server_response_projection_metadata_guard.test.ts`
    - 新增非 `Responses` JSON body 顶层 `metadata` 即使值看似 client-safe 也必须报错的覆盖
- 已验证：
  - `tests/red-tests/server_response_projection_metadata_guard.test.ts` PASS
  - `tests/red-tests/server_sse_guard_e2e.test.ts` PASS
  - `tests/red-tests/server_sse_metadata_guard_e2e.test.ts` PASS
  - `tests/server/handlers/handler-response-sse-frame-metadata-guard.spec.ts` PASS
- 未作为本轮证据的噪音：
  - `tests/server/handlers/handler-metadata-boundary.spec.ts` 当前混有既有 mock/协议漂移：
    - `/v1/responses` helper 按 JSON 解析，但当前 mock path 可能返回 SSE error frame 文本；
    - image/messages/chat 分支也夹杂旧 mock body 形状和 handler error-path 断言；

## 2026-06-18 handler metadata boundary contract refresh + persisted request-context fix

- 在清 `handler-metadata-boundary.spec.ts` 噪音时，先确认了三处真实漂移不是 runtime regressions，而是测试样本落后于当前契约：
  - `/v1/responses` 未显式传 `stream: false`，当前 handler 默认可能走 SSE；
  - `/v1/images/generations` 样本缺 `model`，当前 handler 正常返回 400；
  - image path 当前 pipeline body/metadata 键名是 `imageGeneration`，不再是旧断言里的 `qwenImageGeneration`。
- 已修测试契约：
  - `tests/server/handlers/handler-metadata-boundary.spec.ts`
    - responses 两个 JSON 断言样本补 `stream: false`
    - image 样本补 `model`
    - image 断言改成 `imageGeneration`
    - persisted request-context 断言改成读 `MetadataCenter.continuation_context.responsesRequestContext`，不再读旧 flat `metadata.responsesRequestContext`
- 随后暴露出一个真实实现问题：
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts::buildResponsesRequestContextForHttp`
  - 之前把 `args.payload` 原样塞进 `responsesRequestContext.payload`
  - 这会把客户端 request body `metadata` 持久化进 continuation request context，违背“request body metadata 不进 persisted responses request context”规则
- 已修唯一 owner：
  - `buildResponsesRequestContextForHttp(...)` 现在先过 `stripRequestBodyMetadataForPipelineForHttp(args.payload)`，持久化时只存剥离 metadata 的 payload
- 新增 focused lock：
  - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
    - 新增 `strips request body metadata before persisting relay request context payload`
- 已验证：
  - `tests/server/handlers/handler-metadata-boundary.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/state-integrations.metadata-center.spec.ts` PASS
  - `npm run verify:architecture-review-surface-light` PASS
  - `npx tsc --noEmit --pretty false` PASS

## 2026-06-18 responses handler single-bridge-surface trim

- `npm run verify:architecture-ci` 最新红项已收敛到 `verify:responses-handler-single-bridge-surface`。
- 根因不是 bridge 逻辑漂移，而是 handler 层仍自带 `hasSsePayload()` facade：
  - `src/server/handlers/handler-response-utils.ts` 导出本地 helper；
  - `chat-handler.ts` / `messages-handler.ts` / `responses-handler.ts` 通过 `handler-utils.ts` 间接消费；
  - gate 将其视为 responses handler response-side extra surface。
- 最小修复面：物理删除 `hasSsePayload` export/re-export，handler 与测试统一改成直接判 `result.sseStream !== undefined`，不引入新 facade。
- 已完成：
  - `src/server/handlers/handler-response-utils.ts` 删除 `hasSsePayload()`；
  - `src/server/handlers/handler-utils.ts` 删除转发导出；
  - `chat-handler.ts` / `messages-handler.ts` / `responses-handler.ts` 改成直接判 `result.sseStream === undefined` 决定是否走 JSON complete log；
  - `tests/red-tests/server_sse_guard_e2e.test.ts` 不再依赖 module helper。
- 已验证：
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npm run verify:architecture-ci` PASS
  - `npm run build:min` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS
- 新发现但未纳入本轮 gate 闭环：
  - `tests/red-tests/server_sse_guard_e2e.test.ts` 现在暴露 `assertClientResponseHasNoInternalCarriers()` 对顶层 `metadata` 不是一律 fail-fast，只在 metadata 内部命中 internal carrier key 时才报错。
  - 这和 Jason 最新“非协议标准字段不得混入 payload”规则不完全一致，应作为内部字段清理后的下一收口点。

## 2026-06-18 finish reason fallback alias removal

- 候选 `src/server/utils/finish-reason.ts::deriveFinishReasonWithVisibleSuccessFallback` 已确认是真死别名，不再承载任何独立语义：
  - 实现只是 `return deriveFinishReason(body)`；
  - 生产调用点只剩 `src/server/handlers/handler-utils.ts` 与 `src/server/runtime/http-server/index.ts`；
  - 直接测试 import 只剩 `tests/server/utils/finish-reason.visible-success.spec.ts`；
  - 其余两处只是 handler focused tests 的 mock residue，不是 runtime consumer。
- 已完成：
  - 删除 `deriveFinishReasonWithVisibleSuccessFallback` export；
  - `handler-utils.ts` / `http-server/index.ts` 统一改回直接调用 `deriveFinishReason(...)`；
  - `tests/server/utils/finish-reason.visible-success.spec.ts` 改成直接覆盖 `deriveFinishReason(...)` 的 visible-success 场景；
  - `verify:architecture-deleted-path` 新增 repo-wide deny token，禁止 `deriveFinishReasonWithVisibleSuccessFallback` 在 `src/tests/scripts` 复活。
- 定向验证过程中发现两条 submit_tool_outputs focused tests 的 mock 与当前真实导出漂移：
  - 缺 `captureReqInboundResponsesContextSnapshot`
  - 缺 `lookupResponsesContinuationByResponseId`
  - 已做最小 mock 同步，不改测试语义。
- 已验证：
  - `tests/server/utils/finish-reason.spec.ts`
  - `tests/server/utils/finish-reason.visible-success.spec.ts`
  - `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`
  - `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`
  - `npm run verify:architecture-deleted-path`
  - `npx tsc --noEmit --pretty false`
  - `npm run verify:architecture-ci`
  - `npm run build:min`
  - `git diff --check`

## 2026-06-18 metadata center mainline pending-edge closeout progress

- 重新按当前 worktree 复核 `docs/architecture/mainline-call-map.yml` 的 `metadata.center.mainline` 后半段，不再沿用“mtc-04..07 全 pending”的旧叙事。
- 当前真实代码绑定：
  - `mtc-04` 可诚实绑定到 `src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts::resolveRequestExecutorPipelineAttempt`：
    - 这里在 `finalizeRequestExecutorAttemptMetadata(...)` 之后写 `mergedMetadata.target` 与 `mergedMetadata.compatibilityProfile`；
    - 说明 provider observation 已有真实 adjacent owner，但仍走 flat metadata，不是显式 `provider_observation` family。
  - `mtc-05` 可诚实绑定到 `src/modules/llmswitch/bridge/responses-response-bridge.ts::persistResponsesConversationLifecycleForHttp`：
    - 当前 response closeout 会本地 `deriveFinishReason(args.body)`；
    - 同时通过 `readRuntimeRequestTruthIdentifiers(args.metadata)` 读取 MetadataCenter-backed request truth 做 continuation lifecycle persistence；
    - 这是真实 response-observation read path，但 `response_observation` 尚未落成独立 center family。
  - `mtc-06` 可诚实绑定到 `src/server/runtime/http-server/executor/servertool-adapter-context.ts::buildServerToolAdapterContext -> MetadataCenter.readRequestTruth()`：
    - servertool projection 现在已锁住 request `sessionId/conversationId` 只从 center 读；
    - 但 route/provider observation 仍来自 flat metadata bag，所以只能记 `partial`。
- 仍不能伪造的部分：
  - `mtc-07` closeout/release 仍无显式 MetadataCenter finalize/release API；继续保持 `binding pending`，不编假 symbol。
- 文档同步方向：
  - `docs/architecture/wiki/metadata-center-mainline-source.md` 应改成“`mtc-04/05/06` partial、`mtc-07` pending”的状态描述；
  - slimming / architecture review plans 也要同步，不再把后半段说成 4 条全 pending。

## 2026-06-18 servertool-request-normalizer single-consumer trim

- 复核后确认 `src/server/runtime/http-server/executor/servertool-request-normalizer.ts` 只有 39 行、只承载 `syncStoplessGoalStateFromCapturedRequest(...)` 一个 helper，且生产 consumer 仅 `buildServerToolAdapterContext(...)` 一处。
- 现有 `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts` 已经覆盖该 helper 的核心语义，不需要先补新测试：
  - RCC fenced `capturedEntryRequest` 覆盖 `capturedChatRequest`
  - metadata `capturedEntryRequest` 作为 RCC fence fallback
  - `onReasoningStopSeedError` 回调吞错路径
- 本轮动作：
  - 将 `syncStoplessGoalStateFromCapturedRequest(...)` 直接内联回 `src/server/runtime/http-server/executor/servertool-adapter-context.ts`
  - 物理删除 `src/server/runtime/http-server/executor/servertool-request-normalizer.ts`
  - `docs/architecture/verification-map.yml` 删除该单文件 unit 路径
  - `scripts/architecture/verify-architecture-deleted-path.mjs` 新增 deleted-path 防复活
- 这属于“单 consumer 单函数文件回收”，不改变 stopless / MetadataCenter 语义，只缩小 host-side glue surface。

- 本轮已把 Hub Pipeline architecture review surface 从“有文档但会漂移”推进到可 gate 化状态：
  - `package.json` 新增 `verify:architecture-review-surface-light` 和 `verify:architecture-review-surface`；
  - `build` / `build:min` 已在 `tsc` 前强制运行 `verify:architecture-review-surface-light`；
  - `verify:architecture-ci` 已接入完整 `verify:architecture-review-surface` 和 `verify:architecture-ci-longtail`；
  - `scripts/architecture/verify-function-map-build-wiring.mjs` 已加锁：如果 build/min 移除 review surface light，或 architecture-ci 移除 review surface / longtail，会直接失败。
- 当前 architecture review surface 验证已通过：
  - `npm run verify:architecture-review-surface` PASS：mainline call map 7 chains / 44 edges / 9 shared functions；wiki sync 检查 7 generated + 7 manual pages；HTML sync PASS；metadata-center manifest sync PASS；Chrome browser smoke 检查 14 HTML pages。
  - `npm run verify:architecture-ci-longtail` PASS：deleted-path、duplicate-owner、ts-owner-ban 都绿。
  - `npm run verify:function-map-compile-gate` PASS：71 active features，284 canonical builders，且 build wiring gate 已检查 review surface light。
  - `npm run verify:architecture-mainline-mermaid-sync` PASS；`git diff --check` PASS。
- 当前未跑 `build:min`：Jason 正在并行处理 payload/SSE 内部字段清理，完整 build 可能被该进行中代码面影响；本轮只宣称 architecture review surface/gate 闭环，不宣称全仓 build 通过。
- active goal 继续推进到瘦身审计候选表：
  - 已更新 `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md`，新增“当前状态复核补充”表，包含 owner、consumer count、处置结论、风险、验证路径。
  - 当前明确 delete candidate：`servertool-response-normalizer.ts::buildServerToolSseWrapperBody`，生产 consumer 为 0（只剩定义、测试、历史 doc），但与 Jason 正在处理的 payload/SSE 字段清理重叠，本轮只登记不删除。
  - 当前 merge/rename candidate：`deriveFinishReasonWithVisibleSuccessFallback`，函数体已只是 `deriveFinishReason`，但 dirty 文件与现有测试仍引用旧名。
  - 当前 marker cleanup candidate：`bodyContainsReasoningStopFinalizedMarker` 恒返回 false，属于旧 `__routecodex_reasoning_stop_finalized` marker 残留接口，需等内部字段清理稳定后删除调用链。
  - 当前 defer：`responses-sse-bridge.ts` 和 `responses-response-bridge.ts`，仍是 function-map owner/canonical bridge surface，不能按“大文件/重复 facade”直接删除。
- 最新验证：
  - `npm run verify:function-map-build-wiring` PASS。
  - `git diff --check` PASS。
  - `npm run verify:architecture-review-surface-light` 当前 FAIL 于新接入的 `verify:architecture-no-custom-payload-carriers`，红项为当前已知 `__sse_responses` / `__routecodexDirectPassthrough` / `__sse_stream` 残留；这与 Jason 并行清理任务一致，本轮不抢改。
- 继续复核（不触碰并行 payload/SSE 内部字段清理实现）：
  - `npm run verify:architecture-mainline-call-map` PASS：7 chains / 44 edges / 9 shared functions。
  - `npm run verify:architecture-wiki-sync` PASS：7 generated wiki pages + 7 manual wiki pages。
  - `npm run verify:architecture-wiki-html-sync` PASS：HTML render artifacts match。
  - `npm run verify:architecture-manifest-sync` PASS：`metadata.center.mainline` / 8 nodes / owner `hub.metadata_center_mainline`。
  - `npm run verify:architecture-wiki-browser-smoke` PASS：Chrome loaded 14 HTML pages and Mermaid smoke render was nonblank.
  - `npm run verify:architecture-ci-longtail` PASS：deleted-path / duplicate-owner / ts-owner-ban all green.
  - `npm run verify:function-map-compile-gate` PASS：71 active features, 284 canonical builders, build wiring still requires review surface light.
  - `npm run verify:architecture-mainline-mermaid-sync` PASS；`git diff --check` PASS。
  - 当前剩余 blocker 仍是 Jason 正在清的 non-standard payload carrier gate；本轮不抢改 `__routecodex_*` / SSE wrapper 字段实现面。

## 2026-06-17 SSE/custom-field boundary correction

- Jason 明确纠正：SSE 层只能承载标准协议语义，不能解析帧内容来触发 servertool/stopless，也不能在请求/响应 payload 内塞自定义控制字段。
- 最新收口规则：所有非协议标准字段都不得混入请求/响应 payload；`__routecodex_*` 与 `__sse_responses` 这类内部 carrier 必须迁出 payload，内部控制只走 `MetadataCenter` / runtime side-channel。
- 当前已定位两类污染源：
  - direct continuation owner 通过 `__routecodexDirectPassthrough` 放进 result metadata 并被 SSE handler / bridge 读取；
  - SSE stream 通过 `body.__sse_responses` 包装传给 response handler，属于自定义 response payload 字段。
- 收口方向：direct owner 写入 `MetadataCenter.continuation` 或显式 typed result side-channel；SSE stream 迁到 `PipelineExecutionResult.sseStream` 等 runtime side-channel，handler 不再从 body 解析 wrapper。
- 当前必须删除的错误面：
  - `__routecodex_finish_reason`
  - `__routecodex_stream_contract_probe_body`
  - `__routecodex_reasoning_stop_finalized`
  - `provider-response-converter` 的 `prebuilt_sse_stopless_bridge`
- 新边界：finish reason、terminal probe、servertool/stopless 状态只能来自 chat process 正常语义或 MetadataCenter/runtime side-channel；不能通过 SSE wrapper 自定义字段传递。
- `__sse_responses` 仍是更深一层的内部 stream carrier 残留，后续也应迁到 MetadataCenter/runtime side-channel，不再作为 payload 字段长期存在。

- function-map/verification-map 体系当前较完整：`npm run verify:function-map-compile-gate` PASS，覆盖 71 active features、71 verification rows、284 canonical builders，且 `build` / `build:min` 已强制先跑该 gate。
- 当前不能宣称 hub pipeline 架构闭环已全锁住：`npm run verify:architecture-mainline-call-map` FAIL，`metadata.center.mainline` 的 `mtc-01/mtc-02` symbol 绑定漂移；`npm run verify:architecture-wiki-sync` 因 mainline map 无法 render；`npm run verify:architecture-wiki-html-sync` FAIL，`metadata-center-mainline-source.html` out of sync。
- mainline call map 状态量化：7 chains / 43 edges，其中 34 anchored、3 partial、6 binding pending；pending 主要集中在 request route/outbound split 与 metadata center 后半段。
- 流程漂移缺口：`build:min` 只强制 function-map compile gate，不强制 mainline/wiki gate；CI workflow 跑 `verify:architecture-ci` 会挡，但本地安装/构建可绕过 mainline/wiki 漂移。`verify:architecture-ci-longtail` 当前 FAIL 于 duplicate-owner 的 `metadata:runtime` 跨 family overlap，且未并入主 architecture-ci。
- wiki/manifest 缺口：repo 有 HTML wiki 与 `metadata-center-manifest.yml`，但未看到 manifest 与 call map/wiki/function-map 的一致性校验，也未看到浏览器级 wiki render smoke gate；目前只锁 markdown/html 文本同步。

## 2026-06-17 stopless hidden responsesRequestContext session leak

- 现网 `0.90.3077` 日志已确认不是历史噪音：`[servertool] ... stop_message_auto ... used=0 left=3 active=true` 后，同一请求仍以 `finish_reason=tool_calls` 返回，而同条 request 的 `[session-request][rt]` 仍是 `session=unknown`。
- 工作树与安装态 `sharedmodule/llmswitch-core/dist/servertool/engine.js` 都已含 `skipped_missing_session` gate，说明“缺 gate”不是根因。
- 新候选根因：`src/server/runtime/http-server/executor/servertool-request-normalizer.ts` 仍把 `responsesRequestContext.sessionId/conversationId` 回填到 `baseContext.sessionId/conversationId`；而 session realtime log 不把这层 continuation context 当请求 session 真相。
- 这会导致 stopless 在“外层请求 session=unknown，但 relay/resume context 内有旧 session”时误激活；修复方向是把 `responsesRequestContext` 从 request session truth 候选里移除，并补红测锁“responsesRequestContext-only 不得激活 stopless”。

## 2026-06-18 stopless first-turn direct bypass root cause

- “5555 该激活却没激活”当前已锁到 direct/relay 主线，而不是 finish_reason 或 session header 缺失：
  - `~/.rcc/config.toml` 中 `5555` 为 `sameProtocolBehavior = "direct"`；
  - 项目规则已写明 direct 响应不进入 Hub `resp_chatprocess`，因此 stopless 不会在 direct 路上激活；
  - Rust 已有 `evaluateResponsesDirectRouteDecision*` / `servertool_followup_requires_hub_relay` 契约，但 TS 主线 `executeRouterDirectPipelineForPort()` 之前根本没接这层判定。
- 本轮已修唯一主线：
  - `src/server/runtime/http-server/index.ts` 在 router-direct 进入 VR 之前先跑 `evaluateDirectRouteDecision(...)`；
  - 若 `requiresHubRelay=true`，直接返回 relayable skip，不再先撞 `virtual-router-not-ready` 或直通 provider；
  - 若 provider wire 非法，直接抛 host payload contract error，禁止继续 direct route。
- 新红测已先红后绿：
  - `tests/server/runtime/http-server/direct-passthrough-payload.spec.ts`
    - `stopMessageEnabled=true + stopMessageExcludeDirect=false` 的首轮 `/v1/responses` 现在必须 `requiresHubRelay=true`
  - `tests/server/runtime/http-server/router-direct-protocol-boundary.spec.ts`
    - `stopMessage.includeDirect=true` 时，`executePortAwarePipeline(5555, /v1/responses)` 必须在 direct transport 前 relay 到 Hub

## 2026-06-18 stopless live non-activation narrowed to metadata-center clone loss

- 在线 5555 现象已复核：`/v1/responses` 返回 provider 原始 `response.completed`，`output_text` 直接泄漏 stop schema，没有 `exec_command`。
- 黑盒继续暴露第二个独立红点：`seedReasoningStopStateFromCapturedRequest` / `readStoplessGoalState` 在 Jest 下因 `servertool/handlers/stopless-goal-state` 被 source `require` 成 `ERR_REQUIRE_ESM`。
- 更关键的 live 结构性漏洞：
  - `buildServerToolAdapterContext(...)` 只信 `MetadataCenter.readRequestTruth()`，若 center 缺失会主动 `delete baseContext.sessionId/conversationId`；
  - `decorateMetadataForAttempt(...)` 之前只做 `structuredClone`，没有把 `MetadataCenter` symbol 重新 bind 到 attempt clone；
  - 这会让 request 入口明明已经写入的 request truth，在 response-stage adapterContext 里看起来像“无 session truth”，最终触发 Rust stopless contract 的 `stop_message_missing_session -> terminal_final`，表现为 stop schema 泄漏而非 cli projection。
- 本轮修复方向：
  - `executor-metadata.ts` 在 attempt clone 后显式 `MetadataCenter.bind(clone, MetadataCenter.read(base))`；
  - `module-loader.ts` 把 `servertool/handlers/stopless-goal-state` 加入 Jest dist-only 前缀，避免黑盒继续被 `ERR_REQUIRE_ESM` 挡住。
- 当前结论：
  - 代码层根因不是“sessionId 不存在”，而是“首轮 stopless direct->relay 判定器未接主线，且接入位置还必须早于 VR 准备检查”；
  - 线上要真正激活，还需要把目标端口配置成 `stopMessage.includeDirect=true`，否则默认仍是 direct 排除 stopless。

## 2026-06-17 metadata center read-path trim follow-up

- 本轮继续对 goal 做真正收口，不再只停在入口 materialize：
  - `src/server/runtime/http-server/executor/servertool-adapter-context.ts` 已改成 request `sessionId/conversationId` 只读 `MetadataCenter.request_truth`，不再从 `entryOriginRequest`、平铺 `metadata.sessionId`、`__rt.sessionId` 或其它别名回填。
  - `src/server/runtime/http-server/executor/servertool-request-normalizer.ts` 已物理删除 `backfillAdapterContextSessionIdentifiersFromEntryOriginRequest()`，旧 request truth 回填面消失。
- 新发现并已修：`MetadataCenter.writeRequestTruth()` 之前只是名义上的 `write_once`，实现上仍允许覆盖；现已改成第二次写同 slot 直接抛错，避免 request truth 被后续阶段静默重定义。
- 定向回归已通过：
  - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
  - `tests/server/http-server/executor-metadata.spec.ts`
  - `tests/servertool/stopless-cli-continuation.spec.ts`
  - `tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts`
  - `npx tsc --noEmit --pretty false`

## 2026-06-17 factual Codex samples session headers audit

- 只看事实样本，不做协议推断，已确认多个真实 Codex-origin request 样本都带 request session 标识，而且位置在 HTTP headers。
- 硬证据 1：`tests/fixtures/goal-request-user-input-real-samples/provider-request.goal.nested-after-fix.json`
  - `headers.User-Agent = codex-tui/...`
  - `headers.originator = codex-tui`
  - `headers.session_id = 019dfdbc-46c0-77b1-bcd6-d832b6080c9d`
  - `headers.conversation_id = 019dfdbc-46c0-77b1-bcd6-d832b6080c9d`
- 硬证据 2：`tests/fixtures/goal-request-user-input-real-samples/provider-request.goal.flattened-before-fix.json`
  - `metadata.clientHeaders.session_id = 019dfdc9-bcd7-7b70-8384-8bcaa9a63e6f`
  - `metadata.clientHeaders.conversation_id = 019dfdc9-bcd7-7b70-8384-8bcaa9a63e6f`
  - 同样带 `user-agent = codex-tui/...` 与 `originator = codex-tui`
- 硬证据 3：`tests/fixtures/errorsamples/2026-05-17-responses-empty-output/provider-request.json`
  - `metadata.clientHeaders.session_id = 019e34fa-1e7a-7eb0-bab2-0752ac6ff649`
  - `metadata.clientHeaders.conversation_id = 019e34fa-1e7a-7eb0-bab2-0752ac6ff649`
  - 同样带 `user-agent = codex-tui/...`
- 当前代码面对应事实：
  - `src/server/runtime/http-server/executor-metadata.ts::extractRequestSessionIdFromHeaders()` 已支持 `session_id/session-id/x-session-id`
  - `buildRequestMetadata()` 会把 header-derived session/conversation 写入 `MetadataCenter.request_truth`
- 新确认的疑点不是“Codex 不带 session”，而是 live 链某处没有把这个事实反映到最终日志/功能读点：
  - `src/server/runtime/http-server/index.ts::readSessionIdForUsageLog()` 仍只读顶层 `metadata.sessionId/session_id`，不读 `MetadataCenter.request_truth`
  - 因此即使 request truth 已存在，usage/session realtime log 仍可能打印 `session=unknown`

## 2026-06-17 legacy /v1/messages replay session truth progress

- 旧失败 replay 样本 `tests/fixtures/goal-request-user-input-real-samples/runs/sample_1781701218849/metadata-center-replay-flattened-before-fix/request.json` 当前已证明：
  - 最初失败不是“Codex 没带 session”，而是 replay script 只认顶层 `headers`，没有把样本里 `body.metadata.clientHeaders` 还原成真实 HTTP headers。
  - 修完 `scripts/replay-codex-sample.mjs` 后，`/v1/messages` 不再因 `clientHeaders` / `rcc_passthrough_tool_choice` 这类 replay-only metadata 被 server req adapter 拒绝。
  - 最新 live 5555 日志已出现：
    - `req=req_1781701966842_f92f387a sid=019dfdc9-bcd7-7b70-8384-8bcaa9a63e6f`
    - request id 从 `anthropic-messages-unknown-unknown-*` 变成 `anthropic-messages-minimax.key1-MiniMax-M3-*`
  - 说明这条 replay 已经过了“session truth / metadata contract”层，进入真实 provider 路由。
- 当前这条 replay 的新失败点已经前移到真实 upstream/provider 400：
  - `invalid params, function name or parameters is empty (2013)`
  - 这不再是 session truth 丢失问题。

## 2026-06-17 stopless live replay second root cause

- live 5555 replay after reinstall/restart still showed repeated `session=unknown` + `tool=stop_message_auto ... used=0 left=3 active=true`, so earlier “missing-session gate” local green was not enough for live closeout.
- New root cause slice: stopless owner `sharedmodule/llmswitch-core/src/servertool/engine.ts::readStoplessSessionId()` treated any non-empty string as valid session truth; live chain appears to pass sentinel string `unknown`, so stopless activated instead of skipping.
- Fix direction: normalize stopless session tokens so `unknown/none/null/-` count as missing; add red test proving sentinel `unknown` disables CLI projection.

## 2026-06-17 tmux-request-session drift trim

- `src/modules/llmswitch/bridge/state-integrations.ts::extractSessionIdentifiersFromMetadata()` 之前仍把 `tmuxSessionId/clientTmuxSessionId` 当成 request `sessionId` 候选，这与“tmux 只是 client attach/inject scope，不是 request session truth”冲突。
- `src/server/runtime/http-server/session-client-registry.ts` 仍有两处旧别名残留：
  - 记录加载/注册/heartbeat 时把 `tmuxSessionId` 回填到 `record.sessionId`
  - callback inject body 里发送 `sessionId: tmuxSessionId`
- 本轮已加红测并物理删除上述两处写入，先锁“tmux 不得 materialize 成 request session/stopless session truth”，再继续看 live stopless 闭环是否因此收敛。

## 2026-06-17 stopless closed-loop fix (counter + schema feedback gate)

- 新发现的闭环断点分两处：
  - 计数器语义错：之前 `observed=false` 不落 reset，导致“非连续 stop”后旧计数会挂着；用户要求是真正的“连续 stop 才累计，不连续立即清零”。
  - schema 反馈链断：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs` 明明读到了 `decision.followupText/followup_text`，却用 `_raw_followup_text_ignored` 丢掉，再改写成 generic prompt，导致“缺什么引导什么”根本到不了下一轮。
- 本轮收口方向：
  - Rust `stop_message_counter` 保持“非 stop 也 reset persisted used=0”的唯一真源。
  - Rust `chat_servertool_orchestration` 改成：schema/invalid-schema/non-terminal-schema/budget-exhausted 触发时，优先把 `decision.followup_text` 原样发到 client-visible next-turn prompt；只有普通 stop 才走 generic natural prompt。
  - `stopless_prompt.rs` 撤回“固定模板字段提示”这条错误方向，generic prompt 只保留自然语言；字段级纠错只来自 schema gate 真正的失败反馈。
  - gate 增补：`scripts/verify-servertool-rust-only.mjs` 现在禁止 `chat_servertool_orchestration.rs` 再出现 `_raw_followup_text_ignored` 这种“读到又丢”的实现。

## 2026-06-17 runtime-session-dir ssot closeout audit

- 当前工作树复核结果：
  - `ROUTECODEX_SESSION_DIR` 的生产 env 读法已收敛到 runtime bootstrap owner（`src/server/runtime/http-server/session-dir.ts`）；功能链 stopless / pending-session / routing-state 不再自己从 env 猜目录。
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/napi_proxy.rs` 只从 `metadata.__rt.{sessionDir,rccUserDir}` 读取 runtime path override，顶层 `metadata.sessionDir/rccUserDir` 不再是合法 fallback。
  - `SessionClientRegistry` 现在只认显式注入的 bindings store path；`conversationSessionId -> tmuxSessionId` 绑定不再反向定义 request `sessionId` 或 workdir 身份。
- 文档/正式 review 面同步完成：
  - `docs/design/server-runtime-lifecycle-ssot.md`
  - `docs/architecture/wiki/metadata-boundary-map.md`
  - `docs/architecture/wiki/runtime-lifecycle-call-graph.md`
  - `docs/architecture/wiki/html/runtime-lifecycle-call-graph.html`
  - `docs/architecture/wiki/html/metadata-boundary-map.html`
- 仍保留的结构性风险：
  - `ROUTECODEX_SESSION_DIR` 物理上仍混放 routing state、session bindings、provider health、servertool pending 等多类 runtime state。
  - 这已经不再是“身份语义混用”问题，而是“目录物理分层”问题；建议后续单独做 subdir split，不作为当前 ssot 收口 blocker。

## 2026-06-17 stopless sessionId contract drift cleanup

## 2026-06-17 install-global + restart 5555 unblock

- 用户要求直接编译 / 全局安装 / 重启 `5555` 验证 live 是否切到新 stopless 契约。
- 实际阻塞点不是 `install-global.sh` 后半段，而是工作树编译错误：
  - `src/modules/llmswitch/bridge/state-integrations.ts` 直连 core dist JS 时把 native routing-state 参数推成 `unknown`，`tsc` 报 `TS2345`
  - `src/server/runtime/http-server/index.ts` 缺 `node:path` import，`tsc` 报 `TS2304`
- 最小修复：
  - 给 `state-integrations.ts` 补 `RoutingInstructionState` 类型签名并用 typed native aliases 调用
  - 给 `http-server/index.ts` 补 `import path from 'node:path'`
- 验证证据：
  - `npx tsc --pretty false --noEmit` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_INSTALL_INPLACE_BUILD=1 npm run install:global` 已完成全局安装，并把 `~/.rcc/install/current` 切到 `releases/routecodex-0.90.3075-2026-06-17T043357Z`
  - `routecodex --version` = `0.90.3075`
  - `routecodex restart --port 5555` PASS
  - `curl http://127.0.0.1:5555/health` 返回 `{\"status\":\"ok\",\"ready\":true,\"pipelineReady\":true,\"server\":\"routecodex\",\"version\":\"0.90.3075\"}`

- 新发现的仓库残留不是生产代码 throw，而是 docs/gate 漂移：
  - `docs/design/servertool-stopmessage-lifecycle.md` 还写 stopless 是 session-scoped CLI continuation，并声称缺 `sessionId/requestId` 时 runtime 自动补。
  - `scripts/verify-servertool-rust-only.mjs` 还把旧错误字符串 `stop_message_auto auto flow requires sessionId on adapterContext` 当成应存在 contract。
- 这与当前 stopless 真相冲突：
  - stopless CLI command / stdout 不要求 `sessionId/requestId/sessionDir`
  - stopless next-turn 恢复只认当前 request `tool_outputs` + runtime metadata
  - stopless 不属于 persisted continuation/file-state owner
- 处理策略：
  - 更新 stopless lifecycle 设计文档为 runtime-metadata closed loop
  - 把 verify gate 从“必须存在 sessionId lock”改成“禁止复活 sessionId requirement / env fallback”

## 2026-06-17 runtime-session-dir owner trim follow-up

- 本轮又确认两处与 goal 冲突的残留：
  - `SessionClientRegistry` 虽已支持 bootstrap 显式注入 `bindingsStorePath`，但类内仍保留 `ROUTECODEX_SESSION_DIR -> session-bindings.json` 推断。
  - Rust `virtual_router_engine/napi_proxy.rs` 的 runtime path override 仍允许从 metadata 顶层读取 `sessionDir/rccUserDir`，不是只认 `__rt.*` carrier。
- 收口动作：
  - 删除 `SessionClientRegistry` 的 env 推断，只保留显式 `bindingsStorePath`
  - `napi_proxy.rs` 改成只读 `metadata.__rt.{sessionDir,rccUserDir}`
  - 补回归测试，锁 `ROUTECODEX_SESSION_DIR` 和 metadata 顶层字段都不能再充当功能链 fallback

## 2026-06-16 mainline call map mermaid/wiki/gate closure

## 2026-06-17 direct Responses headers timeout audit

- 用户样本：`5520` direct `/v1/responses`，`asxs.crsa.gpt-5.4`，`routeName=longcontext`，`router-direct.send` 报 `UPSTREAM_HEADERS_TIMEOUT` 后进入 provider-switch。
- owner 定位：direct pipeline 只做 same-protocol passthrough + hooks，实际 provider SSE 发送在 `src/providers/core/runtime/responses-provider.ts` -> `HttpClient.postStream()`；不是 direct pipeline 出站 payload 问题。
- 根因：`HttpClient.postStream()` 的 headers timer 会在收到 upstream headers 前触发；代码常量 `DEFAULT_TIMEOUTS.PROVIDER_STREAM_HEADERS_CAP_MS` / `SSE_DEFAULT_CAPS.STREAM_HEADERS_CAP_MS` 仍是 `120_000`，与 `src/providers/README.md` 声明的 `min(900000, providerTimeout)` 不一致，导致长上下文/工具 direct SSE 请求可能在 provider timeout `240_000` 前被内部 120s headers clock 提前切断。
- 修正：headers cap 调整为 `900_000`，默认实际等待回到 `min(900000, providerTimeout)`；同时 Responses direct SSE config helper 支持传递 `providerStreamHeadersTimeoutMs` / `streamHeadersTimeoutMs` / `headersTimeoutMs`，不改变 provider wire payload。
- 已验证：`tests/provider/http-client-poststream-headers-timeout.spec.ts` PASS，锁住显式短 headers timeout 仍 fail-fast、默认 cap 为 900s、默认不再被 120s cap 截断；`tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` PASS，锁住 direct SSE 能传 idle + headers timeout；`npx tsc --noEmit` PASS；`npm run verify:function-map-compile-gate` PASS。

## 2026-06-17 servertool CLI explicit sessionDir closeout progress

- `ROUTECODEX_SESSION_DIR` 在 stopless / servertool CLI 这一轮已进一步收口为 runtime workdir root，不再让 CLI binary 侧隐式依赖 env 注入；当前 contract 是 `routecodex hook run ... --session-dir <dir>` 显式透传到 Rust CLI / persisted_state_fs。
- 已补生产 owner：
  - `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts` 读取 runtime `sessionDir` 时补了 `adapterContext.__rt` 直读，并允许 engine 显式覆盖；
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts` 在 orchestration 入口先抓 `sessionDir`，避免后续 runtime helper 改写 `adapterContext` 后丢失；
  - `router-hotpath-napi/src/servertool_core_blocks.rs` 的 persisted-state JSON helper 现已带 `sessionDir` 参数透传；
  - `servertool-core/src/persisted_state_fs.rs` 顶部注释已改成“显式 session_dir 优先”，不再暗示 env override 是 contract。
- 关键真相：
  - 之前 Node/Jest 一直在吃旧 native binding，导致看起来代码改了但命令里仍不带 `--session-dir`；`node scripts/build-core.mjs` 之后，最小 `tsx` 直调已确认命令变成 `... --session-dir '/tmp/sdir' --session-id ...`。
  - 一旦 `sessionDir` 真正生效，`stopless-cli-continuation` 旧预期暴露为 stale：第 1 轮服务端投影命令仍是 `repeatCount=1`，但客户端 CLI 读取同 session persisted truth 后，stdout 会直接进入 `repeatCount=2`；下一轮服务端因此进入 terminal closeout，不会再投第二条 CLI 命令。
- 本轮已把相关 Jest 预期同步到真实闭环语义，并收绿：
  - `tests/servertool/servertool-cli-projection.spec.ts`
  - `tests/servertool/stopless-cli-continuation.spec.ts`
- Rust 侧补充：
  - `servertool-core/src/cli_contract.rs` 的旧测试里，非 stopless `servertool_fixture` 不应再断言带 `sessionId/requestId`；现已改为显式断言“非 stopless 不带 identity flags”。
- 当前剩余风险：
  - `cargo test -p servertool-core ...` 全库 still 会碰到独立旧红 `stop_message_persist_plan::tests::non_counting_gate_preserves_decision_budget_and_used`，与本轮 `sessionDir/sessionId` 收口无直接因果，需单独审。

## 2026-06-17 runtime-session-dir-ssot closeout audit

- `docs/goals/runtime-session-dir-ssot-plan.md` 当前四项 DoD 已基本对齐：
  - 文档：`docs/design/server-runtime-lifecycle-ssot.md` 已明确 `ROUTECODEX_SESSION_DIR` 只是 runtime workdir root，不是语义 `sessionId`。
  - 代码：stopless / servertool CLI / routing-state 功能链现在靠 runtime metadata/explicit arg 传 `sessionDir`，不再在功能链内部用 env/top-level fallback 猜回去。
  - 测试：`tests/servertool/servertool-cli-projection.spec.ts`、`tests/servertool/stopless-cli-continuation.spec.ts` 与 `cargo test -p servertool-cli --test cli_blackbox` 已证明显式 `--session-dir` + same-session writeback 闭环成立。
  - wiki：`docs/architecture/mainline-call-map.yml`、`docs/architecture/wiki/stopless-session-mainline-source.md` 已同步到“显式 `--session-dir`、same-session closed-loop 已闭环”的真相。
- 仍保留一个后续结构性建议，不算本轮 blocker：
  - `ROUTECODEX_SESSION_DIR` 下面仍混有 routing/session/provider-health/servertool 等多类 runtime 状态；目录物理分层仍值得单独做，但不影响本轮把它从“session identity”语义里剥离。

## 2026-06-17 session management simplification audit

- 当前“session 管理很复杂”的根因不是单个 `sessionId` 本身复杂，而是把 4 类不同生命周期混在一起了：
  - request 内短生命周期控制：stopless `used/repeatCount`、trigger hint；
  - 跨一次客户端工具回合的 continuation：stopless CLI writeback；
  - 跨下一次请求的 pending injection：`servertool-pending/<session>.json`；
  - tmux/client 绑定：`session-bindings.json` + conversation/tmux 映射。
- 关键冗余点已确认：
  - `seedStoplessCliPersistedState()` 和 `recordStoplessContinuationState()` 当前实现等价，都是 `recordStoplessContinuationStateWithNative -> saveRoutingInstructionStateSync`，属于重复状态入口。
  - stopless 当前同时复用 routing state store 文件形状和 CLI 自带 persisted_state_fs 读取路径，导致“为了读同一个 session 计数，要维护两套命名/目录/读取契约”。
  - `SessionClientRegistry` 的 tmux/conversation 绑定与 stopless/session continuation 没有同一 owner，却都挂在 “session” 语义下，认知面被污染。
- 精简方向建议：
  - stopless / pending-injection 与 tmux/client registry 彻底拆语义：前者只认 request `sessionId`，后者只认 client/tmux binding id。
  - 若接受“server 重启后丢失未完成 stopless/pending 状态”，可把 stopless/pending-injection 统一收进单实例内存 registry，直接删除 `sessionDir` 依赖。
  - 若不能接受重启丢失，则仍建议只保留一个最小 persisted owner：`sessionId -> { stopless?, pendingInjection? }`；不要再复用 routing-state store，也不要再让 CLI 自己镜像一套路径规则。

## 2026-06-17 stopless runtime-metadata-only closeout

- 本轮已把 stopless CLI 主合同改成 runtime-metadata/current-request-tool-output owner：
  - CLI projection 不再带 `--session-dir` / `--session-id` / `--request-id`
  - Rust CLI binary 不再要求 stopless identity flags
  - next-turn 恢复走 `persisted_lookup.rs::resolve_runtime_stop_message_state_from_adapter_context()` 从当前 request `tool_outputs` / runtime metadata 取 truth
  - `runtime-utils.ts` / `state-integrations.ts` 中 stopless 专用 persisted helper 已开始物理删除，旧 `stopless-prompt.client-visible.spec.ts` 已删
- 定向验证：
  - `cargo test -p servertool-core cli_contract --lib -- --nocapture` PASS
  - `cargo test -p servertool-cli --test cli_blackbox -- --nocapture` PASS
  - `node scripts/build-core.mjs` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/servertool-cli-projection.spec.ts tests/servertool/stopless-cli-continuation.spec.ts tests/cli/servertool-command.spec.ts --runInBand` PASS
  - `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` PASS
- 剩余结构性缺口：
  - broader docs/wiki/html 仍有不少旧 `sessionDir/persisted writeback` 叙述，需要继续扫
  - pending-injection / pending-session 仍是另一套 persisted owner，尚未按“只保留最小必要状态机”整体砍完

## 2026-06-17 stopless persisted writeback surface physically removed

- 本轮只收口 stopless，不扩散到 broader `stop_message` persisted snapshot。
- 已物理删除 stopless 已无消费者的 persisted writeback surface：
  - `recordStoplessContinuationStateWithNative`
  - `savePersistedRuntimeStopMessageStateWithNative`
  - 对应 `router-hotpath-napi` export
  - `servertool-core` 内仅服务这条旧链的 `persisted_state_fs_write.rs`
- 现状更清晰：
  - stopless 当前唯一主线仍是 `runtime metadata + current request tool_outputs`
  - persisted lookup/save 仍存在于 broader `stop_message` / pending / continuation 家族，不能误读成 stopless 当前轮 owner
- 验证：
  - `node scripts/build-core.mjs` PASS
  - `jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/servertool-cli-projection.spec.ts tests/cli/servertool-command.spec.ts --runInBand` PASS
  - `npm run verify:function-map-compile-gate` PASS
  - 全仓 grep `recordStoplessContinuationState* / savePersistedRuntimeStopMessageState*` 0 命中

## 2026-06-17 tmux binding store path explicit + live stale install evidence

- `SessionClientRegistry` 生产链已收口为 runtime bootstrap 显式注入 `session-bindings.json` store path，不再让 registry 自己在生产路径里靠全局 env 推断当前实例 workdir。
- `state-integrations.ts` 的 routing-state bridge 改成直接静态 ESM import 已编译 core dist，Jest 下 `session-client-routes.spec.ts` 的 `ERR_REQUIRE_ESM` non-blocking warning 已消失。
- 当前 live 5555 的 `stop_message_auto auto flow requires sessionId on adapterContext` 已核实不是工作树真相，而是旧安装包真相：
  - 当前 workspace `sharedmodule/llmswitch-core/src/servertool/cli-projection.ts` 与 `dist/servertool/cli-projection.js` 都已不再包含该 throw。
  - 旧安装包 `~/.rcc/install/releases/routecodex-0.90.3075-2026-06-17T023503Z/sharedmodule/llmswitch-core/dist/servertool/cli-projection.js` 仍包含该 throw。
  - `~/.rcc/log/config.toml/ports/5555/server-5555.log` 与对应 diag stack 证明 5555 运行时命中的正是旧安装包 `/opt/homebrew/lib/node_modules/routecodex/.../dist/servertool/cli-projection.js`。
- 结论：当前代码面已收口，但 live 5555 若要消除此报错，还需要重新安装/切换到新构建并重启运行中的 server。此轮未执行 live restart。

## 2026-06-17 stopless architecture map deconflict

- `hub.servertool_stopless_cli_continuation` 的 function-map 真源之前混入了 `StoplessGoalStateRead/PersistPlan`，容易把 `stop_message_auto` 的 runtime-metadata-only 主线误读成另一套 `/goal` 文本状态持久化契约。
- 已把 stopless feature 的 canonical types/builders 收窄到真正主线 owner：`plan_stopless_orchestration_action`、`resolve_runtime_stop_message_state_from_adapter_context`、`plan_client_exec_cli_projection_output`。
- wiki/README/coverage/servertool-followup 页面同步改成“当前请求 `tool_outputs` + runtime metadata”叙述，避免后续按 sessionDir/file/tmux 思路改错位置。

## 2026-06-17 persistence boundary clarification

- Jason 新规则已钉死：只有 protocol-independent continuation 必须保存、必须文件化；其他状态按生命周期判定，不因名字里有 session 就默认持久化。
- 这意味着 stopless 继续保持非持久化 owner；responses/server continuation 这类跨协议恢复态才属于必须保存的文件化状态。

## 2026-06-17 global session-state audit status

- 当前已确认：`session-bindings.json` / `SessionClientRegistry` 仍未进入 architecture function-map / verification-map / mainline-call-map 的 owner queryability 体系。
- 这说明本轮虽然补齐了 stopless、pending-session、runtime-lifecycle、continuation 的边界说明，但 tmux/client binding 这支仍未被同等级索引化，目标还不能宣称全闭环。

## 2026-06-17 tmux client binding indexed

- `runtime.tmux_client_binding` 已补进 `function-map.yml` / `verification-map.yml` / `mainline-call-map.yml`，owner/queryability 缺口已关闭。
- 当前文档真相：
  - `tmuxSessionId` = client attachment / injection runtime scope
  - `conversationSessionId` = conversation narrowing key
  - request `sessionId` = request/continuation scope
  - `session-bindings.json` 只是 `conversationSessionId -> tmuxSessionId` runtime lookup，不是 request session 真源，也不是 continuation store
- 顺手验证暴露旧红：
  - `tests/server/http-server/session-client-routes.spec.ts` 多处 `/daemon/session-client/inject` 仍 404
  - `tests/server/runtime/http-server/executor-metadata.binding.spec.ts` conversation binding fallback 仍未按预期恢复 tmux scope
  - cleanup path 仍碰到 `stopmessage-scope-rebind -> bridge/state-integrations` 的 ESM 旧桥问题

## 2026-06-17 metadata-only sessionDir final trim

- 本轮又补掉一个直接违背 goal 的生产残留：`sharedmodule/llmswitch-core/src/servertool/engine.ts::readStoplessSessionDir()` 以前还会从顶层 `adapterContext.sessionDir` 读值；现已删掉，只保留 runtime metadata / `__rt.sessionDir`。
- 当前结论更新为：
  - stopless / servertool CLI 主功能链里，`sessionDir` 不再靠顶层字段回填；
  - 剩余 `ROUTECODEX_SESSION_DIR` / 无 override `loadRoutingInstructionStateSync(...)` 读法主要还在 runtime bootstrap / broader routing-state surfaces，适合作为后续“目录物理拆分 + runtime-state owner 收口”任务，不应在本 goal 里顺手扩散。

- 结论先钉死：`docs/architecture/mainline-call-map.yml` 是主线调用关系唯一真源；Mermaid wiki 只能做 render artifact，不能再手写第二份主线图，否则会再次漂移。
- 本轮落地内容：
  - 新增 `scripts/architecture/mainline-call-map-lib.mjs` 作为 parse/validate/render 共用库。
  - 新增 `render-mainline-mermaid.mjs`，目标产物固定为 `docs/architecture/wiki/mainline-call-graph.md`。
  - 新增 `verify-architecture-mainline-call-map.mjs`，校验链/边 schema、owner_doc 路径、非 pending caller/callee file 存在、symbol 真正在文件里出现、owner_feature_id 能反查 function-map。
  - 新增 `verify-architecture-mainline-mermaid-sync.mjs`，强制 render artifact 与 YAML 同步。
- 规则收口：
  - `function-map.yml` 继续管 owner / allowed paths / required tests。
  - `mainline-call-map.yml` 继续管 request/response/error 相邻调用边。
  - `wiki/mainline-call-graph.md` 只负责 Mermaid review 面和表格，不承载独立规则。
- package gate 已接入：
  - `render:architecture-mainline-mermaid`
  - `verify:architecture-mainline-call-map`
  - `verify:architecture-mainline-mermaid-sync`
  - `verify:architecture-ci` 现已串上 mainline map + mermaid sync。
- 验证证据：
  - `npm run verify:architecture-mainline-call-map` PASS
  - `npm run render:architecture-mainline-mermaid` PASS
  - `npm run verify:architecture-mainline-mermaid-sync` PASS
  - `npm run verify:architecture` PASS
  - `git diff --check` PASS
  - Computer Use + Chrome 本地渲染验证 PASS：
    - 临时页 `file:///tmp/routecodex-mainline-mermaid-check.html`
    - 页面状态文本为 `All diagrams rendered successfully.`
    - 三张图的 step label 与节点名都已被实际渲染，未出现 syntax/render error
- 下一步：单独收口 `req-03` / `req-04` 两条 request 中段 pending edge，避免把 runtime orchestration 与 typed contract 继续混写。

## 2026-06-16 stopless zterm 死循环追踪

- Jason 报告的线上 stopless 死循环已拿到两类硬证据：
  1. `~/.rcc/logs/server-5520.log` 中同一 session 会出现 `:stop_followup used=1/2` 后，下一次顶层请求又回到 `used=0`，说明预算没有跨失败闭环延续；
  2. `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T095637735-346472-4050.json` 明确显示线上失败栈仍经过 `backend-route-reenter-block.js::runReenterFollowup`，不是纯 CLI projection，且失败原因为 `EMPTY_ASSISTANT_RESPONSE`。
- 这说明当前 live 问题至少有两层：
  1. 安装/生效链路上仍存在旧的 server-side followup/reenter 路径；
  2. stopless budget 对 no-schema / failed followup 的持久化收敛没有锁死，导致顶层新请求重复从 0 开始。
- 当前源码审计还发现一个直接冲突点：`servertool-core/src/stop_message_persist_plan.rs` 里 `count_budget=false` 仍会让 `next_used` 不增长，而 Jason 的 stopless 规则要求 no-schema 也要进入 `used=1->2->3`，耗尽后 reset 并 stop。
- 下一步改动口径：
  - 先补红测锁 `no-schema 1->2->3->stop/reset`；
  - 再修 Rust persist truth；
  - 再跑 focused test + build/install/restart + live replay，确认不再走 `runReenterFollowup`。

## 2026-06-17 stopless sessionId direct path persisted lookup root cause

- 当前 root cause 已确认在 Rust 真源 `servertool-core/src/persisted_lookup.rs`：
  - `collect_stop_message_persisted_candidate_keys()` 之前只有 `direct_record.sessionId` 先命中时，才把 `strict_session_scope` 放进 `candidateKeys`；
  - 这导致 direct/top-level `sessionId` 没进入 stopless persisted read path 时，同 session 新请求会反复从 `used=0` 开始，无法闭环。
- 修正原则：
  - `strict_session_scope=session:<sessionId>` 本身就是 stopless 唯一闭环主键，必须无条件进入 `candidateKeys`；
  - 不能再依赖 direct record 表面字段先命中才允许 lookup。
- 已补 Rust 回归测试：
  - `runtime_session_scope_participates_even_when_direct_record_lacks_session_id`
  - 锁住“record 无 sessionId，但 runtime metadata 有 sessionId 时仍必须 lookup 同一 session scope”。

## 2026-06-16 primary_exhausted_to_default_pool host wiring audit

- 提交审计确认两处真实问题：
  1. `index.ts` / `request-executor.ts` 在 `primary_exhausted -> default_pool` 上只把 `allowedProviders` 包成单个 fake primary tier，没把真实 backup/default tier 传给 Rust planner。
  2. 传给 planner 的 `route` 还是 `routingPolicyGroup`，不是实际 route 名；而且 `allowedProviders` 还会把 `fwd.*` 扁平成 provider id，和 VR 配置 target 身份不一致。
- 修复方向：host 改为从 `virtualrouter.routingPolicyGroups[group].routing[route]` 直接抽 `targets/priority/backup`，route 名优先从 `routeName/routeHint/preselectedRoute` 解析，禁止回退到 group id。
- 提交污染附带问题：`.gitignore` 只忽略 `tmp/`，未忽略 `.tmp/`，导致 stopless/jest 运行态 JSON 大量出现在未跟踪列表；本轮只补 ignore 规则，不做未授权删除。
- 2026-06-16 收口验证：当前 checkout 已把 host wiring 改为 `extractRoutingTiersForRoutingGroupRoute(...)` + `resolvePrimaryExhaustedRouteName(...)` + Rust planner consumption；同时已把 `virtual_router.primary_exhausted_to_default_pool` 的 function-map / verification-map 补齐到真实 host 消费路径（`http-server-bootstrap.ts`、`index.ts`、`request-executor.ts`、`request-executor-core-utils.ts`）与最小合同测试。验证 PASS：
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/http-server/http-server-bootstrap.routing-policy-group.spec.ts --runInBand`
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/executor/request-executor-primary-exhausted-plan.spec.ts --runInBand`
  - `npm run verify:function-map-compile-gate`
  - `git diff --check`
- `.tmp/` ignore 生效验证：`git status --short --untracked-files=all | rg '^\\?\\? \\.tmp/'` 无输出，说明新的运行态 JSON 噪音不再污染提交面。

## 2026-06-15 note.md consolidation index
- stopless invalid-schema CLI closure fixed: latest=2026-06-16；根因确认不是 `triggerHint` 丢失，而是 stopless 拦截后只把 routing state 持久化，没把 CLI 读取的 persisted-state-fs 预写好；导致 invalid schema 首个 CLI 工具结果只能看到 generic prompt。当前真相：handler 在 relay stopless CLI projection 时同时维持两份状态边界，routing state 继续按原链推进计数，CLI persisted-state-fs 只为当前投影命令预写当前 `used` + detailed followup text，CLI 执行后再把 `used` 推进到下一拍。定向验证 PASS：`tests/servertool/stopless-cli-continuation.spec.ts`、`tests/servertool/stopless-prompt.client-visible.spec.ts`、`cargo test -p servertool-core stopless_cli_invalid_schema_reuses_persisted_detail_text --lib -- --nocapture`、`cargo test -p servertool-core invalid_schema_prefers_detailed_followup_text_for_snapshot --lib -- --nocapture`、`git diff --check`。
- stopless CLI identity contract corrected: latest=2026-06-16；当前真相不是“缺 `sessionId/requestId` fail-fast”，而是 Rust CLI/runtime 自动补 execution-local identity，TS shell 只校验 stdout 带回了 identity、不得再做第二次 persisted write。已同步改 `src/cli/commands/servertool.ts`、`tests/cli/servertool-command.spec.ts`、`servertool-cli/tests/cli_blackbox.rs`、`docs/stop-message-auto.md`、`docs/design/servertool-stopmessage-lifecycle.md` 与 function/verification map。focused gate 待本轮重跑确认。
- stopless 模型侧无感收口：2026-06-16；已确认 `cli_contract.rs` 里不能把 `triggerHint`、`previousMissing`、`forcestop`、`repeatCount/maxRepeats/budget` 之类内部状态放进模型可见的 guidance。模型侧只保留纯业务语言的 continuationPrompt，服务端内部计数继续存在但不外露。live 复测已看到 `stopless-cli-continuation`、`stopless-vr-route-hint`、`stop-message-auto-no-reenter` 通过。
- stopless relay sessionId propagation fixed at two boundaries: latest=2026-06-16；本轮先收口 Jason 指定的 `SERVERTOOL_CLI_MISSING_FIELD: sessionId`。确认 request bridge 早已把 `/v1/responses` 的 `sessionId/conversationId` 写进 `metadata.responsesRequestContext`，真正漏点有两处：1) `src/server/runtime/http-server/executor/servertool-request-normalizer.ts` 以前只从 `entryOriginRequest` / request metadata 回填 adapter context，不读现成的 `responsesRequestContext`；2) `src/server/runtime/http-server/executor/servertool-followup-metadata.ts` 以前构造 nested followup metadata 时只会从 continuity headers 提取 `sessionId/conversationId`，headers 缺失时不会回退到 relay `responsesRequestContext`。现已两处同时补齐，且未新增任何 payload/meta 字段，只消费既有 runtime metadata。定向验证 PASS：`tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`、`tests/server/runtime/http-server/executor/servertool-followup-metadata.spec.ts`、`tests/servertool/stopless-cli-continuation.spec.ts`。direct stopless bypass 仍保持：`router-direct/provider-direct` runtime routeName 下 stopless CLI projection 不触发。
- apply_patch audit focused 4-suite rerun re-confirmed: latest=2026-06-16；本轮又把最关键的 4 组 gate 复跑了一次：`responses-provider.direct-passthrough`、`responses-handler.anthropic-tool-history` 继续 PASS；`responses-sse-client-contract.blackbox`、`direct-passthrough-route-level` 继续 FAIL，汇总 `2 failed / 2 passed / 4 total`、`7 failed / 43 passed / 50 total`。这把当前 completion-audit 再压实了一层：direct provider passthrough 与 relay anthropic tool-history 基线没有漂移；剩余主红面仍只在 handler-level SSE terminal/error closeout 与 direct route-level 总合同张力。附带事实是 Jest 末尾仍报 open handles，因此 `direct-passthrough-route-level.spec.ts` 更适合作为 contract tension 证据，而不是单独 completion gate。
- apply_patch audit S3 exact queue-failure anchors pinned: latest=2026-06-16；本轮把 S3 主样本也补成了可直接引用的行级证据。`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T231359101-341020-806.json:1404-1455` 现在可直接看到同一 `call_JyD0R31sWoSfsvEtKsqHJkRh` 的 `function_call x2 + function_call_output x2`，且 sibling `call_cQ4...`、`call_36y...` 也按同样模式重复；`2242-2244` 则直接把它记成 `orphan_tool_result: ... unknown or already-consumed call_id`。这把 S3 从“可能是单个孤儿 output”彻底纠正成“多 call_id 并行 duplicate-batch 进入 already-consumed queue 后在 Rust capture/bridge 本地 fail-fast”。
- apply_patch audit S4/S5 exact line anchors pinned: latest=2026-06-16；本轮把两条最关键的 replay 污染样本补成了 request-body 级硬锚点。S4 现在可直接引用 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T180749445-347851-1128.json:33-39`，里面就是 `exec_command` + `arguments="routecodex hook run stop_message_auto --input-json ..."` + `status=in_progress` + `call_servertool_cli_*`；这说明 internal stopless CLI artifact 的确进入了下一轮 `/v1/responses` request body。S5 现在可直接引用 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json:215-223`，可见 `type=message role=assistant content[0].type=output_text` 已被写进 request history；这证明 response-only content 污染历史是实锤，不是抽象推断。
- apply_patch audit source-level split anchored: latest=2026-06-16；本轮把 `5520 direct` / `5555 relay` 的 source-level 函数链补齐了。`5520` 这边，`index.ts` 先拿 `rawDirectPayload` 再直接令 `requestPayload = rawDirectPayload`，`router-direct-pipeline.ts::executeRouterDirectPipeline()` 真正发送的是 `input.requestPayload`，`recordPayloadAudit()` 只记 observable fields，不改 payload；所以 direct request 入口确实只是 passthrough + audit。`5555` 这边，`responses-request-bridge.ts::prepareResponsesHandlerRuntimeForHttp()` 先走 `prepareResponsesHandlerEntryForHttp()`，再走 `buildResponsesRequestContextForHttp()`；前者负责 `lookupResponsesContinuationByResponseId` / `resumeResponsesConversation` / `materializeLatestResponsesContinuationByScope`，后者直接调用 `captureReqInboundResponsesContextSnapshot()`，说明 relay request capture/continuation owner 确实在 provider send 之前发生。response 侧，`handler-response-utils.ts` 的 JSON path 和 `handler-response-sse.ts` 的 SSE path 都是先得到 client-projected body/probe，再交给 `persistResponsesConversationLifecycleForHttp()`；这继续证明 relay 本地 store 吃的是 client projection 后的语义，不是 provider raw response。
- apply_patch audit direct-not-local-store pinned: latest=2026-06-16；`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` 现在已有直接源码证据：`shouldPersistLocally(entry)` 明确返回 `continuationOwner !== 'direct'`，`flushPersistence()` 和 `ensurePersistenceLoaded()` 都受它约束；也就是说 direct continuation 明确不进本地 persisted store，本地 history 污染只能由 relay 形成。
- apply_patch audit S6 facade reality pinned: latest=2026-06-16；`src/modules/llmswitch/bridge/native-exports.ts` 当前真实同时有 sync `captureReqInboundResponsesContextSnapshotJson(...)` 和 async `captureReqInboundResponsesContextSnapshot(...)` 两个 facade，而且二者都指向同一个 native binding `captureReqInboundResponsesContextSnapshotWithNative`。这进一步支撑了当前对 S6 的定性：历史 `required but unavailable` 更像 native owner fail-fast 被外层包装，而不是“JS facade 本身缺导出”。
- apply_patch audit exclusion set tightened: latest=2026-06-16；三类测试现在必须从 completion 证据里显式排除：1) `responses-request-bridge.tool-history-errorsample.spec.ts` 当前是 stale harness，实跑直接 module-link 失败，报 `native-exports.js` 不再导出旧名 `captureReqInboundResponsesContextSnapshot`；2) `provider-response-rust-plan.spec.ts` 实跑仍是 `11 pass / 6 fail`，六红全部只是在断言旧命令 `routecodex servertool run stop_message_auto`，实际稳定输出已是 `routecodex hook run stop_message_auto --input-json ...`；3) `responses-handler.servertool-cli-projection.blackbox.spec.ts` 虽然 `5/5 PASS`，但本质仍是 transitional CLI projection 合同，不能替代 replay-safe outbound/store gate。
- apply_patch audit SSE blackbox red revalidated: latest=2026-06-16；`tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 再实跑仍是 `7 pass / 2 fail / 9 total`。两条真实业务红未变：tool-call continuation case 仍 5s timeout；early upstream close case 仍只有 `response.created + response.output_text.delta`，没有 `event:error` / `upstream_stream_incomplete`。这继续把问题收敛到 `handler-response-sse.ts` 的 stream-end repair / client projection，不是环境挂。
- apply_patch audit 4444 exclusion refreshed: latest=2026-06-16；用户给的 `4444` live 错误 `Rust HubPipeline response path failed: hub_pipeline_resp_anthropic_chat_canonicalize_failed ...` 继续归到 provider malformed Anthropic payload / `hub.response_anthropic_client_projection` 问题簇，不并入 `apply_patch direct/relay` 主审计。
- apply_patch audit S6/live-required-unavailable reclassified: latest=2026-06-16；本轮把 `S6` 再压实了一层。`tests/sharedmodule/native-required-exports-sse-stream.spec.ts` 现已实跑 `12/12 PASS`，证明 packaged binding、required export list、native req_inbound capture 本身都能工作；但历史 diag `error-openai-responses-router-gpt-5.4-20260615T152358679-347208-485.json` 同时出现两类信息：一方面 exports 列表里明确包含 `captureReqInboundResponsesContextSnapshotJson`，另一方面 stack/message 又报 `native captureReqInboundResponsesContextSnapshotJson is required but unavailable: dangling_tool_call ... does not have a matching tool result in history`。结论：这条历史样本更像“native owner fail-fast 被包成 required unavailable”，不是单纯的 export/binding 缺失。
- apply_patch audit stale harness surfaced: latest=2026-06-16；`tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts` 本轮实跑不是业务红，而是 suite 直接在 module link 阶段失败：`SyntaxError: The requested module './native-exports.js' does not provide an export named 'captureReqInboundResponsesContextSnapshot'`。当前真实 surface 其实同时有 sync `captureReqInboundResponsesContextSnapshotJson(...)` 和 async `captureReqInboundResponsesContextSnapshot(...)` facade，所以这更像测试 mock 壳层漂移。结论：这条 spec 不能再算作 S2/S3/S6 的可信 gate，只能算 stale harness 证据。
- apply_patch audit map-anchor closeout refreshed: latest=2026-06-16；本轮把剩余 gap 和 function-map / verification-map 真源直接绑死了。`S2/S3` 现在明确挂在 `feature_id: hub.req_inbound_responses_context_capture`，现有 smoke 只锁 duplicate batch normalize，不锁 live reopened inline-history fixture。`S5 outbound` 明确挂在 `feature_id: hub.response_responses_client_projection`，map notes 已经写明“不允许 internal stopless/servertool CLI function_call 和 illegal pending status 进入 replay history”，但测试层还没把这条拆成独立 red test。`S5 persistence/store` 明确挂在 `feature_id: server.responses_response_handler_bridge_surface`，verification notes 也已经写明 store contract 要锁 replay-safe persistence，只是当前 contract 还没把 internal CLI artifact 单独钉住。`duplicate facade` 明确挂在 `feature_id: server.responses_sse_bridge_surface`，而且 map 仍把 `responses-sse-bridge.ts` 登记为 active ts_bridge，说明当前只能记 delete candidate，不能宣称唯一出口已完成。
- stopless stale/transitional gate split reverified: latest=2026-06-16；本轮重新实跑了三条最关键的 S5 邻接 gate。`tests/sharedmodule/responses-continuation-store.spec.ts` 当前 `33/33 PASS`，说明 replay-safe store 基线已经稳定锁住：`output_text/commentary -> input_text`、`reasoning.content` 不回放、`status=in_progress` 不回放。`tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 当前 `5/5 PASS`，而且已经明确要求新命令壳 `routecodex hook run stop_message_auto`，所以它不是“旧 servertool run 正确合同”，而是过渡态 CLI projection 合同。相反，`tests/sharedmodule/provider-response-rust-plan.spec.ts` 本轮实跑 `17 total / 11 pass / 6 fail`，6 条失败全部不是 owner 行为缺失，而是断言仍要求旧字符串 `routecodex servertool run stop_message_auto` 出现在 client-visible body/SSE。结论：S5 当前最该标 stale 的不是 store 基线，而是 `provider-response-rust-plan.spec.ts` 这组把内部 CLI 投影当成 `/v1/responses` 正向输出的旧合同；`responses-handler.servertool-cli-projection.blackbox.spec.ts` 则应记为 transitional，不可再直接当 replay-safe outbound gate。
- provider-response stale expectation exact proof pinned: latest=2026-06-16；`tests/sharedmodule/provider-response-rust-plan.spec.ts` 当前 6 条红点的 received 结果完全一致，均为 `routecodex hook run stop_message_auto --input-json ...`，并且 payload 仍是 `response.status="requires_action"` + `output=function_call(exec_command)`。失败位置分别在 198/224/281/327/414/649 附近，说明它整组仍在锁“内部 stopless CLI command 应该 client-visible”这一旧方向，而不是现在需要的 replay-safe/protocol-safe 方向。这个证据已经足够支撑 audit doc 把它定性为 stale contract，不再只是概念判断。
- apply_patch S2/S3 gate-gap precision refreshed: latest=2026-06-16；本轮把 `S2/S3` 的“owner 已知但 fixture 还不够像 live”再压实了一层。`tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` 当前 3 条只锁 mocked native capture 的归一结果：duplicate batch 不回退 raw input、identical repeat 只保留最新 output、orphan reject 必须 fail-fast；它不锁真实 `S2` 的 reopened inline history 全形状。Rust `hub_bridge_actions/tests.rs` 当前已有 `convert_bridge_input_rejects_orphan_tool_result` 与 `convert_bridge_input_rejects_duplicate_function_call_output_after_call_already_consumed`，但这两条只锁“单 orphan”和“单 call_id 第二次 output after consumed”，还没锁 `S2/S3` 那种“前置 assistant text + 多 call_id + 同批 function_call x2 / function_call_output x2”的 live reopened batch。结论：`S2/S3` 当前不是 owner 不清，而是缺 live-shape fixture。
- responses-sse duplicate facade gate truth refreshed: latest=2026-06-16；`src/modules/llmswitch/bridge/responses-sse-bridge.ts` 现在可以更明确地定性为 facade-only duplicate surface：整面 `...Impl` 从 `responses-response-bridge.ts` 转发，不是第二套 SSE 语义 owner。`tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 与 `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` 当前保护的也不是“唯一 owner”，而是“split facade 结构必须继续存在”：request side 走 request facade、response side 走 response facade，同时 `handler-response-sse.ts` / `handler-response-utils.ts` 还必须保留对 `responses-sse-bridge.js` 的 split import。结论：duplicate surface 已被识别，但 gate 语义仍在保护 split 结构；若要物理删除，必须先反转 gate。
- apply_patch focused gate bundle rerun refreshed: latest=2026-06-16；本轮把主审计相关 6 组 gate 再实跑了一次。结果是 `4 green / 2 red`：绿的是 `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`、`tests/providers/runtime/responses-provider.direct-passthrough.spec.ts`、`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts`、`tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`；红的仍是 `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 和 `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`。前者当前精确红点还是 `required_action -> completed -> done` 5s timeout，以及 early upstream close 不投 `event:error` / `upstream_stream_incomplete`；后者当前仍是 `5 failed / 13 passed / 18 total`，失败项继续稳定在 `stream_options`、transparency、stop_followup through Hub、429 reroute、502 reroute。结论继续收敛：`apply_patch` 自身 freeform/request contract、direct passthrough owner、relay anthropic tool-history 基线都已绿；主红面现在不在 apply_patch 基础合同，而在 handler SSE terminal/error 投影和 direct route-level 总黑盒。
- apply_patch live log windows re-cut: latest=2026-06-16；本轮重新切了三段可直接引用的 authoritative live 窗口。`~/.rcc/logs/server-5520.log:969564-969576` 仍是 `5520` direct grammar 400：`thinking -> asxs.crsa.gpt-5.4`，随后 `[router-direct.send] statusCode=400`，upstream 报 `Invalid lark grammar ... begin_patch`。`~/.rcc/logs/server-5520.log:995102-995118` 是 `5555` 的 `input[1].status` 400：前缀明确 `[port:5555 ...]`，先 `thinking -> asxs.crsa.gpt-5.4`，后 `[router-direct.send]` 被 upstream 以 `Unknown parameter: 'input[1].status'` 拒绝。`~/.rcc/logs/server-5520.log:995270-995304` 是 `5555` 的 `input[41].content` 400：同样是 `[port:5555 ...]` 前段，后 `[router-direct.send]` 被 upstream 以 `array too long` / `input[41].content` 拒绝。结论更硬：这两条 `5555` 样本都是 relay-front 先污染历史，再由 final direct send 原样送上游，不是 direct final send 本地修坏请求。
- stopless NoSchema/schema-guidance/route-hint rerun re-verified: latest=2026-06-16；本轮重新实跑 `tests/servertool/stopless-cli-continuation.spec.ts`、`tests/servertool/stopless-vr-route-hint.spec.ts`、`tests/servertool/stop-message-auto-no-reenter.red.spec.ts`，结果 `3 suites / 9 tests PASS`。其中 `stopless-cli-continuation.spec.ts` 现已同时锁住两层事实：一是 `NoSchema` 的 CLI stdout 必带 `schemaGuidance.requiredFields=["stopreason","next_step"]`；二是 same-session 真实 CLI wrapper 持久化路径上 `repeatCount` 会走 `1 -> 2 -> 3`，并且 console 证据已打印 `used=0 -> 1 -> 2`。`stop-message-auto-no-reenter.red.spec.ts` 继续锁 `reenterPipeline` 零调用；`stopless-vr-route-hint.spec.ts` 继续锁 stopless followup 不得带 `route_hint:tools`。结论：stopless core 目前不是“没 schema guidance / 不计数 / 还在 reenter”的主嫌疑，后续 live 若再出现同类现象，应先查 handler/transport/install-state。
- apply_patch audit 5520 direct red-suite exact-failure refresh: latest=2026-06-16；本轮重新实跑 `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 与 `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts`。前者当前仍是 `18 total / 13 pass / 5 fail`，5 条红点已精确锁定为：`provider-mode chat direct + stream_options`、`same-protocol direct transparency(model=mutated-model vs gpt-5.3-codex)`、`stop_message followup through Hub`、以及 429/502 的 direct local switch 两条。结论继续不变：这不是“5520 apply_patch 主线全红”，其中只有 transparency 一条与 direct request contract 直接相关，其余是 `stream_options` / stopless relayability / retry-policy 邻接 contract。后者当前仍是 `9 total / 7 pass / 2 fail`，红点稳定仍是：`required_action -> completed -> done` 挂 5s timeout，以及 early upstream close 只吐到 `response.created + response.output_text.delta`，缺 `event:error` 和 `"code":"upstream_stream_incomplete"`。这两条仍是 direct SSE client-contract 缺口，不是 relay/store 污染。
- apply_patch audit S2/S3 exact fixture landing refreshed: latest=2026-06-16；本轮把 S2/S3 从“重复 batch 的概念判断”压成了可直接引用的行级证据。S2 现在可直接引用 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json:323-338`，可见同一 `call_id=call_itUphzwyXqmB1L3pGk03AQHh` 的 `function_call x2 + function_call_output x2`；并与 `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl:2010-2020` 直接对上，确认这是客户端源样本真实形状。S3 则补了 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260612T225507928-339537-1450.json:318-390`，可直接看到 `call_MqPgTUSSFb19Em58JUUEd6xV` 的 `function_call x2 + function_call_output x2`。结论更硬：S2/S3 都不是“单个孤儿 output”小问题，而是 duplicate-batch / already-consumed queue 语义，唯一 owner 仍是 Rust `hub_req_inbound_context_capture` + `hub_bridge_actions/history.rs|bridge_input.rs`；当前缺的是 live reopened batch fixture，不是 owner 不清。
- apply_patch audit S6 wiring-vs-install-state corrected: latest=2026-06-16；本轮把 S6 的表述纠偏了。`src/modules/llmswitch/bridge/responses-request-bridge.ts::buildResponsesRequestContextForHttp(...)` 真实会调用 `captureReqInboundResponsesContextSnapshot(...)`，而 `src/modules/llmswitch/bridge/native-exports.ts:536-545` 会先 `assertSharedBindings()` 再取 `captureReqInboundResponsesContextSnapshotWithNative`。因此 S6 不能再说成“handler 没接到 native capture”或“源码没导出”，因为 required-export list、packaged `.node` binding、`dist/native-shared-conversion-semantics-responses.js` barrel 现有 gate 都已证明 symbol 在。当前真正缺的是 handler-entry / install-state gate：现有 `responses-request-bridge.request-context-normalization.spec.ts` 对 native capture 是 mock，`native-required-exports-sse-stream.spec.ts` 证明的是 dist/binding/barrel，不是当前运行包里 `buildResponsesRequestContextForHttp -> assertSharedBindings -> binding` 整链不漂移。
- stopless NoSchema + no-reenter + thinking-route gate rerun verified: latest=2026-06-16；本轮重新实跑 `tests/servertool/stopless-cli-continuation.spec.ts`、`tests/servertool/stopless-vr-route-hint.spec.ts`、`tests/servertool/stop-message-auto-no-reenter.red.spec.ts`，三组共 `9/9 PASS`。证据比“只看代码”更强：`stopless-cli-continuation.spec.ts` 的 console 明确打印同 session `used=0 -> 1 -> 2`，且 CLI stdout 继续带 `schemaGuidance.requiredFields=[stopreason,next_step]`；这说明 Jason 要求的 `NoSchema` 也携带 schema guidance、且 same-session progression 真正经过 CLI wrapper 持久化路径，而不是单纯 mock 状态。与此同时 `stop-message-auto-no-reenter.red.spec.ts` 继续锁 `reenterPipeline` 零调用，`stopless-vr-route-hint.spec.ts` 继续锁 stopless followup 不得带 `route_hint:tools`。结论：当前 stopless “NoSchema 计数不增长 / 还在 reenter / followup 仍带 tools old hint” 这三条，仓库内 focused gate 已转绿；后续若 live 再复现，应优先排查 handler/transport/old install，而不是先回头怀疑 stopless core 逻辑本身。
- 4444 anthropic canonicalize remains outside apply_patch audit: latest=2026-06-16；本轮再次核对 `~/.rcc/diag/error-openai-responses-router-gpt-5.5-20260615T222217502-349516-2793.json`，确认错误仍是 `hub_pipeline_resp_anthropic_chat_canonicalize_failed: Anthropic SSE response did not contain materializable content blocks`，owner 仍是 Rust `hub.response_anthropic_client_projection`：`hub_pipeline_lib/engine.rs::canonicalize_provider_response_for_client(...)` -> `hub_resp_outbound_client_semantics_blocks/anthropic_chat_response.rs::materialize_anthropic_message_payload(...)`。这条问题和 `5520/5555 apply_patch direct-relay` 审计不是一条线，不能继续混成“apply_patch 还没修好”的证据。
- stopless stale projection contract remains in provider-response-rust-plan: latest=2026-06-16；`tests/sharedmodule/provider-response-rust-plan.spec.ts` 当前仍有多处正向断言 `routecodex servertool run stop_message_auto` 必须出现在 client-visible body / SSE 里（命中行包括 198/224/281/327/414/649 附近），这与当前 stopless CLI contract 已迁到 `routecodex hook run ...` 且越来越强调 replay-safe / client-invisible internal artifacts 的方向冲突。相比之下，`tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 已经是“半新半旧”：部分断言已切到 `routecodex hook run ...` 与 terminal payload 不含旧 command，但文件中仍保留旧 `routecodex servertool run ...` fixture 形状。结论：这两处仍应视作过渡/陈旧合同，不能当作 `responses` replay-safe outbound gate 的正向真源。
- apply_patch audit S5 gate split pinned: latest=2026-06-16；本轮把 S5 replay-safe gate 的“已锁住什么 / 没锁住什么”拆清了。`tests/sharedmodule/responses-continuation-store.spec.ts` 现在已经明确锁住三类基础 replay-safe 合同：`output_text/commentary -> input_text`、`reasoning.content` 不 replay、`status=in_progress` 不 replay，这说明 S5 不是“完全没 gate”。但同一个文件后半段仍混有 `routecodex servertool run stop_message_auto` 的第三轮恢复样本，它更像历史样本兼容/store mechanics，不是 client-visible protocol-safe 正向合同。结论：后续需要在同文件或邻近文件里新增一条更窄的 red test，专门锁 internal stopless/servertool CLI `function_call` 不得作为 persisted/materialized replay history 正向保留，不能继续把“兼容旧样本”和“合法 replay 合同”混在一起。
- apply_patch audit S5 stale contract files pinned: latest=2026-06-16；`tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 与 `tests/sharedmodule/provider-response-rust-plan.spec.ts` 现在的陈旧程度不同。前者已经有一部分断言切到 `routecodex hook run stop_message_auto`、`continuationPrompt/schemaGuidance` 不泄漏、allow-stop terminal 不再保留 CLI command，所以它是“半新半旧”的过渡合同；但主语仍然是“应投影 command”，因此不能当 replay-safe response outbound gate。后者则更明显 stale：多处仍显式断言 `routecodex servertool run stop_message_auto`、`exec_command`、`stop_message_flow` 应出现在 `result.body`，等于把内部 stopless CLI command 当成 client-visible `/v1/responses` 正向输出。这两处都需要在后续修复时反转成“内部 CLI 不泄漏到 client-visible body”的反向 gate。
- apply_patch audit duplicate-surface/function-boundary refresh pinned: latest=2026-06-16；本轮把“重复 surface / 非唯一入口出口 / handler 只是 transport shell”的代码证据补到了函数级。`src/modules/llmswitch/bridge/responses-sse-bridge.ts` 头部可直接见到 `createResponsesJsonToSseConverterForHttp`、`planResponsesStreamEndRepairForHttp`、`projectResponsesSseFrameForClientForHttp`、`normalizeResponsesClientPayloadForHttp`、`buildResponsesStreamIncompleteErrorPayloadForHttp` 都是 `...Impl` re-export，没有第二份实现体，所以它是 facade-only public surface，不是第二 semantic owner。`src/modules/llmswitch/bridge/native-exports.ts` 同时暴露 `captureReqInboundResponsesContextSnapshotJson()` 和 `captureReqInboundResponsesContextSnapshot()`，但底层都只打同一个 native capability `captureReqInboundResponsesContextSnapshotJson`；这不是双 owner，而是双符号 surface，说明 request 入口仍不唯一。`responses-response-bridge.ts` 当前函数级边界也更清楚了：`recordResponsesResponseForHttpProjection(...)`、`persistResponsesConversationLifecycleForHttp(...)`、`createResponsesJsonToSseConverterForHttp()` 都只是 facade/lifecycle glue，不是最终协议 normalize 真源。
- apply_patch audit handler-shell evidence refresh pinned: latest=2026-06-16；本轮把 server handler 为什么“不是协议 owner，但确实在污染路径上”也补成了具体调用链。JSON path 是 `handler-response-utils.ts -> prepareResponsesJsonClientDispatchPlanForHttp(...) -> persistResponsesConversationLifecycleForHttp({ body: clientBody })`；SSE path 是 `handler-response-sse.ts -> streamResponsesJsonAsSse(...) -> persistResponsesConversationLifecycleForHttp({ body: bridgePlan.sanitizedPayload })`，native SSE probe 还会走 `persistNativeSseConversationState(...) -> persistResponsesConversationLifecycleForHttp({ body: stripInternalKeysDeep(contractProbe.probe) })`。另一个和黑盒红点完全对上的事实是：`handler-response-sse.ts` 在 `planResponsesStreamEndRepairForHttp(...).shouldProjectIncompleteError === true` 分支里，虽然会构造 `buildResponsesStreamIncompleteErrorPayloadForHttp(requestLabel)`，但最终只记录 `response.sse.stream.incomplete_internal_error`、打 `clientErrorSuppressed: true`，然后 `res.end()`，这正是 `responses-sse-client-contract.blackbox.spec.ts` 当前“无 `event:error`”的直接代码根因。
- apply_patch audit live-400 and red-suite refresh pinned: latest=2026-06-16；本轮把两条新的 `5555` replay 400 和两组主 gate 的当前精确红点重新钉住了。`~/.rcc/logs/server-5520.log` 中可直接提取：`openai-responses-router-gpt-5.4-20260615T202700552-348463-1740` 走 `thinking -> asxs.crsa.gpt-5.4.gpt-5.4`，最终 `[router-direct.send]` 被上游以 `Unknown parameter: 'input[1].status'.` 拒绝；`openai-responses-router-gpt-5.4-20260615T202830407-348488-1765` 走 `default -> asxs.crsa.gpt-5.4-mini.gpt-5.4-mini`，最终 `[router-direct.send]` 被上游以 `Invalid 'input[41].content': array too long ...` 拒绝。结论更精确了：`5555` 当前不是“direct 自己改坏请求”，而是 relay 前段把 replay-illegal `status` / `message.content.output_text` 污染进历史，末跳 direct 原样发上游才被判错。与第二条对应的 authoritative 形状仍在 `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json`，其中 `requestBody.input_len=399`，tail 明确出现 `type=message` + `content[{type:\"output_text\"}]`，owner 继续锁 `shared_responses_conversation_utils.rs` + `responses-conversation-store.ts`。
- apply_patch audit red-suite rerun refresh pinned: latest=2026-06-16；本轮再次实跑 `responses-sse-client-contract.blackbox.spec.ts` 和 `direct-passthrough-route-level.spec.ts`，结果与上一轮总结一致但现在有新的精确断言文本。前者仍是 `2/9 FAIL`：`captures required_action -> completed -> done for tool-call continuation without hanging the client` 仍是 5s timeout；`turns early upstream close into explicit error instead of client hang` 当前 raw SSE 只有 `response.created` + `response.output_text.delta("partial")`，没有 `event:error` 和 `"code":"upstream_stream_incomplete"`。后者仍是 `5/18 FAIL`，和本审计最相关的红点仍只有 `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`，其张力是期望 `model=gpt-5.3-codex`，实际 `model=mutated-model`；其余 `stream_options` / stopless / 429 / 502 仍是 direct 邻接问题，不能用来证明 `5520 apply_patch` 主链坏掉。
- apply_patch audit 5520 direct live proof refresh pinned: latest=2026-06-16；`openai-responses-router-gpt-5.4-20260614T230414428-345124-2702` 仍可直接从现行 live log 提取同一窗口四联证据：`▶ [/v1/responses]`、`[virtual-router-hit] thinking -> asxs.crsa.gpt-5.4.gpt-5.4`、`[router-direct.send] statusCode=400`、upstream `Invalid lark grammar ... unknown name: "begin_patch"`。`openai-responses-router-gpt-5.4-20260615T193814122-348189-1466` 同样仍可直接提取：`coding -> asxs.crsa.gpt-5.4-mini.gpt-5.4-mini`、`[response.sse.stream] ... non-Responses event "response.metadata"`、`[usage] route=router-direct:coding/- finish_reason=unknown`。这继续把 `5520` 的剩余 apply_patch 相关风险收敛在 Rust request contract / direct SSE boundary，而不是 relay/store。
- apply_patch audit exact red-test landing targets pinned: latest=2026-06-16；本轮把剩余缺口该落到哪几个测试文件进一步锁死了。S2/S3 的 live duplicate batch 形状，最合适的 Rust owner 还是 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/tests.rs`，因为真正的 pending/consume 队列语义都在 `convert_bridge_input_to_chat_messages(...)`；同时 `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` 只负责锁 facade 不回退 raw input，适合补一条“assistant text + duplicate same-call batch”的更贴近 live 形状。S5 的 replay-safe persistence 缺口则应落在 `tests/sharedmodule/responses-continuation-store.spec.ts`，新增“internal stopless/servertool CLI function_call 不得进入 persisted/materialized history”的红测；与之相邻的两个 stale expectation 文件是 `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` 和 `tests/sharedmodule/provider-response-rust-plan.spec.ts`，它们当前都还把 internal CLI 投影当成正向合同，后续不是删除，而是反转成 replay-safe / client-visible protocol-safe 红测。S6 的 required export / binding 历史失效则不能只靠现有 `native-required-exports-sse-stream` 一类 gate，还需要一个 handler-entry / install-state 层的 live gate，锁 `captureReqInboundResponsesContextSnapshotJson` 在真实 handler path 上可解析、可调用，而不是仅在 loader / dist / `.node` require 层存在。
- apply_patch audit fresh gate rerun pinned: latest=2026-06-16；本轮重新实跑与主目标直接相关的 6 组验证。绿的有：`tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` `12/12 PASS`，证明 `5520 direct` provider runtime 薄壳保持 request body identity；`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` `3/3 PASS`，精确锁住 `event: response.metadata` 非法事件名；`tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts` `11/11 PASS`，说明 `5555 relay` 当前黑盒已覆盖 paired custom tool output、reopened apply_patch history 与 Anthropic/MiniMax tool-order 基线；`tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` `3/3 PASS`，说明 relay request-context 已锁 duplicate batch normalize 与 orphan fail-fast。红的有两组：`tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 仍是 `2/9 FAIL`，失败点稳定仍是 `required_action -> completed -> done` terminal repair 缺失与 early upstream close 未投 `event:error`；`tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 仍是 `5/18 FAIL`，其中只有 `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent` 这条与本审计主线直接相关，其余 4 条属于 `stream_options` / stopless / direct retry-policy 邻接问题。因此 route-level suite 当前只能当 direct contract tension 证据，不能整体当成 `5520 apply_patch` 主线坏掉的证明。
- apply_patch audit 4444 evidence-source rule pinned: latest=2026-06-16；本轮再次核对 `4444` 后，确认这条问题簇必须从 apply_patch 主线中继续剥离，而且证据源要更严格。`~/.rcc/diag/error-openai-responses-router-gpt-5.5-20260615T222217502-349516-2793.json` 明确给出 `message=Rust HubPipeline response path failed: hub_pipeline_resp_anthropic_chat_canonicalize_failed: Anthropic SSE response did not contain materializable content blocks`，这属于 Rust owner `hub.response_anthropic_client_projection`，落点是 `hub_pipeline_lib/engine.rs::canonicalize_provider_response_for_client(...)` 与 `hub_resp_outbound_client_semantics_blocks/anthropic_chat_response.rs`。而 `~/.rcc/diag/error-openai-responses-router-gpt-5.5-20260615T230135968-349824-3101.json` 明确给出 `code=MALFORMED_RESPONSE`、`status=200`、`details.providerFamily=anthropic`、`details.requestContext.target.providerProtocol=anthropic-messages`，说明这是 provider malformed Anthropic payload 分类链。另一个关键纠偏是：当前 `server-4444.log` 最近窗口里会混入 `5555` 行，不能再把它当成这两条 requestId 的 authoritative 证据源；`4444` 这两条现阶段必须以 diag + owner code + function-map / verification-map 为准。
- apply_patch audit duplicate-sse-facade gate truth repinned: latest=2026-06-16；本轮继续核对 `responses-sse-bridge.ts`、`bridge/index.ts`、`tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 和 `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` 后，确认当前 gate 真正保护的是 split facade 结构本身，而不是“唯一 SSE 语义 owner”。`responses-sse-bridge.ts` 现在几乎整面 re-export `responses-response-bridge.ts` 的 SSE/projector/guard symbols，属于 facade-only public surface；但 red test 明确要求 `handler-response-sse.ts` 与 `handler-response-utils.ts` 继续同时 import `responses-sse-bridge.js` 和 `responses-response-bridge.js`，verify 脚本也继续要求这套 split facade 存在。结论：它是 duplicate facade / delete candidate，但当前不能直接删；若后续要物理删除，必须先改 function-map / verification-map 与对应 gate，然后再删 facade 本体。
- apply_patch audit 5555-relay owner-chain pinned: latest=2026-06-16；本轮把“5555 为什么是 relay”从口头判断收成了代码 owner 链。`src/modules/llmswitch/bridge/responses-request-bridge.ts` 当前 handler-facing 真入口是 `buildResponsesRequestContextForHttp(...)` / `prepareResponsesHandlerRuntimeForHttp(...)` / `buildResponsesPipelineMetadataForHttp(...)`，并会调用 `captureReqInboundResponsesContextSnapshot(...)`、`resumeResponsesConversation(...)`、`materializeLatestResponsesContinuationByScope(...)`；本地 continuation/store 真 owner 在 `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`，当前真入口是 `recordResponse(...)` / `resumeConversationPayload(...)` / `materializeContinuationPayload(...)` / `restoreContinuationPayload(...)`，且 `shouldPersistLocally(entry)` 明确 `continuationOwner=direct` 不落本地；response 侧 handler bridge 真入口是 `responses-response-bridge.ts` 的 `recordResponsesResponseForHttpProjection(...)` / `persistResponsesConversationLifecycleForHttp(...)`。所以 5555 之所以必须归类为 relay，不是因为最后一跳一定不是 direct，而是因为 request capture / continuation restore / local store / response persistence 这些 relay owner 明确先发生了；final provider transport 即便显示 `router-direct.send`，也只是 relay 之后的末跳实现方式。
- apply_patch audit direct transparency red-test tension pinned: latest=2026-06-16；本轮把 `direct-passthrough-route-level.spec.ts` 那条最相关红点继续落到代码，确认它不是“router-direct-pipeline 偷改 payload”。`src/server/runtime/http-server/index.ts` 当前明确是 `const rawDirectPayload = requireDirectPassthroughPayloadObject(input.body);` 之后直接 `const requestPayload = rawDirectPayload;`；`src/server/runtime/http-server/router-direct-pipeline.ts` 的 `recordPayloadAudit(...)` 也只记录 observable fields，不改 payload。与此同时，`tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 这条红测却期望 direct send 的 `model` 被改成 `target.modelId = gpt-5.3-codex`，而实际发送的是 ingress body 的 `model = mutated-model`。再对照 `docs/architecture/function-map.yml` 的 `responses.direct_tool_shape_contract`，它写的正是 “keep the current request body as provider wire”。结论：这条红点当前更像“route-level 测试预期 vs 现行 direct contract”的 tension，而不是 `5520 apply_patch` 主链已证实回归；审计文档里必须明确区分。
- apply_patch audit 5520 direct gate split pinned: latest=2026-06-16；本轮把 `5520 direct` 的“薄壳是绿的、route-level 总黑盒不是全绿”分开记账。`tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` 现跑 `12/12 PASS`，直接证明 provider runtime direct path 不读取 `metadata.__raw_request_body`、不本地清洗 reasoning/history/tools、`submit_tool_outputs` 也命中 upstream submit endpoint，所以 provider runtime 本身不是 `5520` apply_patch 问题的修补 owner。与此同时，`tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 现跑仍是 `18 total / 13 pass / 5 fail`；其中和本审计最相关的红点是 `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`，预期发出 `model=gpt-5.3-codex`，实际发出 `model=mutated-model`，说明 route-level suite 对 direct transparency 的定义和当前真实行为仍有差异。其余红点（`stream_options`、stop_message followup、429/502 local switch）都属于旁支 direct contract，不宜直接拿来证明 `5520 apply_patch` 主链有问题。结论要锁成：`5520` 当前更像“provider runtime 绿、request contract/SSE boundary 仍需继续审”，不能笼统说 direct 整体坏。
- apply_patch audit S2/S3 gate-to-live gap pinned: latest=2026-06-16；本轮把 S2/S3 现有 gate 与 live 缺口对齐到具体用例名，不再只写“有近似测试”。S2 现有最接近的是 `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts` 的 `preserves paired Responses custom_tool_call_output through the Anthropic provider payload` 与 `RED: preserves reopened apply_patch tool history after prior assistant text and multiple tool turns`，以及 `tests/responses/responses-openai-bridge.spec.ts` 的 `RED: reopened apply_patch and exec_command history stays tool-ordered after prior assistant text`；它们锁的是“assistant text + reopened multi-turn tool history 保持 tool-order”，还没把 live 的 “同一 call_id 在同一批里 function_call x2 + function_call_output x2” 独立 fixture 化。S3 现有最接近的是 `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` 的 `RED: relay request context does not fall back to raw input when native capture rejects orphan tool_result`，以及 Rust `hub_bridge_actions/tests.rs::convert_bridge_input_rejects_duplicate_function_call_output_after_call_already_consumed`；它们锁的是“单个 orphan/已消费 output 必须 fail-fast”，还没把 live 的“三个 call_id 成批重复 function_call x2，再跟 function_call_output x2”的 duplicate-batch 队列样本固化出来。
- apply_patch audit codex-session duplicate-same-call truth pinned: latest=2026-06-16；本轮直接读取 `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`，确认原始 Codex session JSONL 自身就包含 duplicate same-call batch，而不是 RouteCodex 运行时凭空重复。索引级证据：`IDX 41` 与 `IDX 42` 是同一 `call_id=call_itUphzwyXqmB1L3pGk03AQHh` 的两次 `function_call(exec_command)`，`IDX 43` 与 `IDX 44` 是同一 `call_id` 的两次 `function_call_output`。这与 S2 diag `error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json` 的 tail 完整对上，说明 owner 责任要锁到 Rust `hub_req_inbound_context_capture` / `hub_bridge_actions/history.rs` / `bridge_input.rs` 对 duplicate batch、already-consumed queue 的处理，而不是先怪 TS handler/server 造假。
- apply_patch audit evidence-grade correction for 5555: latest=2026-06-16；当前 `~/.rcc/logs/server-5555.log` 已经轮转，S2/S3/S4/S5 那些经典 requestId 不再直接可搜到。因此之后的文档表述必须显式区分：`5520` 的 S1/S1b 仍可直接引用现行 live log；`5555` 的旧失败样本当前 authoritative 证据是 `~/.rcc/diag/error-*.json` + 当前 owner 代码，现行 5555 log 只能证明结构性事实（relay 前段 + final direct send 仍存在），不能再伪装成这些旧 requestId 本人的 live log 证据。
- apply_patch audit SSE blackbox red truth pinned: latest=2026-06-16；本轮实跑 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts --runInBand`，结果稳定为 `9 tests / 2 failed`。失败点不是模糊的“可能有 SSE 问题”，而是两个精确 contract 缺口：其一，`captures required_action -> completed -> done ...` 中 `response.output_item.done` 之后没有补出 `response.completed` / `response.done`，`completedIndex=-1`；其二，`turns early upstream close into explicit error instead of client hang` 中 raw SSE 只有 `response.created` + `response.output_text.delta("partial")`，没有 `event:error`，期望的 `"code":"upstream_stream_incomplete"` 没投给客户端。代码级证据也已对上：`responses-response-bridge.ts::planResponsesStreamEndRepairForHttp()` 会把“tool continuation 缺 terminal”和“非 continuation 提前关流”分成 `shouldRepairContinuationTerminal` / `shouldProjectIncompleteError` 两类；但 `handler-response-sse.ts` 在 `shouldProjectIncompleteError` 分支里当前只记 `response.sse.stream.incomplete_internal_error`，并显式打 `clientErrorSuppressed: true` 后 `res.end()`，所以黑盒看到内部识别 incomplete，却看不到 client-visible `event:error`。这条现在应归为 response outbound / SSE stream-end repair 总 gate 仍红，不是 apply_patch request contract 回归。
- apply_patch audit 4444 issue split repinned: latest=2026-06-16；`~/.rcc/logs/server-4444.log` 需要明确拆两类，不能继续混写成一个 apply_patch 问题。`openai-responses-halphen.key1-glm-5.2-20260615T222217502-349516-2793` 仍是 `[convert.bridge] Rust HubPipeline response path failed: hub_pipeline_resp_anthropic_chat_canonicalize_failed: Anthropic SSE response did not contain materializable content blocks`；而 `openai-responses-halphen.key1-glm-5.2-20260615T230135968-349824-3101` 已是 `MALFORMED_RESPONSE`，错误内容为 `[provider] Upstream provider returned malformed Anthropic response: 模型厂商异常导致本次错误，请重试即可`。结论要锁成：`4444` 当前属于 provider/Anthropic-response 投影问题簇，不应再混入本轮 `apply_patch direct/relay` 主审计。
- stopless NoSchema CLI/tool contract relock verified: latest=2026-06-16；本轮把 stopless 的旧黑盒/旧 owner 断言收到了当前 CLI 真相。`NoSchema` 不是“无 schema 引导”，而是“命令仍保持 status-only，但 CLI stdout 必带 schemaGuidance”；`tests/servertool/stopless-cli-continuation.spec.ts` 新增真实 CLI 包装层同 session `1 -> 2 -> 3` 进位门禁，锁的不是 mock state，而是 `routecodex hook run stop_message_auto` 执行后由 `src/cli/commands/servertool.ts` 持久化的真实闭环。另一个关键修正是 stopless 相关 Jest 统一切到独立 `ROUTECODEX_SESSION_DIR`，否则本地 routing state 会把第一轮 CLI stdout 错抬成第二轮，形成假红。当前通过的定向证据：`tests/servertool/stopless-cli-continuation.spec.ts`、`tests/servertool/stopless-prompt.client-visible.spec.ts`、`tests/servertool/servertool-cli-result-restore.spec.ts`、`tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`、`cargo test -p servertool-core stopless --lib -- --nocapture`、`cargo test -p router-hotpath-napi stop_message_auto --lib -- --nocapture`、`cargo test -p router-hotpath-napi stopless_followup_strips_ --lib -- --nocapture`、`npm run verify:function-map-compile-gate`。
- apply_patch audit S2/S3 concrete tail indexes pinned: latest=2026-06-16；本轮直接把 diag 尾部索引打平。S2 `error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json` 的 `requestBody.input` 长度是 `45`，末尾关键索引 `41/42/43/44` 全部属于同一个 `call_id=call_itUphzwyXqmB1L3pGk03AQHh`：两次 `function_call`，随后两次 `function_call_output`。S3 `...231359101-341020-806.json` 的 `requestBody.input` 长度是 `212`，末尾关键索引 `200..211` 是三组 `call_id`（`call_cQ4...` / `call_36y9...` / `call_JyD0...`）各两次 `function_call`，再各两次 `function_call_output`。这说明 S2 是 duplicate same-call batch，S3 是 duplicate-batch / already-consumed queue shape；现在这两条已不是摘要判断，而是索引级证据。
- apply_patch audit replay-safe gate asymmetry rechecked: latest=2026-06-16；现有测试面对 stopless/internal CLI 不是“完全没覆盖”，而是覆盖方向不对称。反向 gate 已有：`tests/sharedmodule/responses-continuation-store.spec.ts` 明确锁 `submit_tool_outputs resume keeps function_call history without replaying response-only status fields`，证明 `status=in_progress` 不应 replay 回下一轮 `input`。但正向合同仍大量存在：`responses-continuation-store.spec.ts` 第三轮 stopless 恢复、`responses-handler.servertool-cli-projection.blackbox.spec.ts`、`provider-response-rust-plan.spec.ts` 仍把 `routecodex hook run stop_message_auto` 或旧 `routecodex servertool run stop_message_auto` 当成应保留/应重投影 payload。结论更精确地说，是“internal stopless/servertool CLI function_call 还缺反向 replay-safe gate”，而不是“仓库完全没有 stopless CLI 测试”。
- apply_patch audit duplicate-surface gate mismatch confirmed: latest=2026-06-16；本轮继续核对 `src/modules/llmswitch/bridge/{responses-sse-bridge.ts,responses-response-bridge.ts}`、`handler-response-sse.ts`、`handler-response-utils.ts` 与 function-map/verification-map 后，事实进一步收紧为三点。第一，`responses-sse-bridge.ts` 现在不是第二语义 owner，而是把大量 symbol 从 `responses-response-bridge.ts` 直接 re-export 出去的 facade-only surface；真实 SSE allowlist / direct metadata guard / JSON->SSE dispatch 语义 owner 仍在 `responses-response-bridge.ts`。第二，当前门禁 `tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 锁的是“handler 侧 import split 必须维持”和“index.ts 不要把 SSE symbol 放进 lifecycle 那一段 export”，并没有锁“重复 facade 必须物理删除”或“唯一响应出口必须收敛到一个 facade”。第三，`docs/architecture/function-map.yml` / `verification-map.yml` 仍把 `server.responses_sse_bridge_surface` 当成独立 active feature，这与代码层 facade-only 事实存在语义张力；当前更准确的描述应是“独立 public surface，不是独立 semantic owner”。这说明当前 red gate 只能防 handler import 再次散开，不能证明出口已经唯一化，也解释了为什么 duplicate surface 能长期残留而不触发 gate。
- apply_patch audit duplicate-surface gate runtime proof added: latest=2026-06-16；本轮实跑 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` 与 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/red-tests/server_responses_sse_surface_single_owner.test.ts --runInBand`，两者都 PASS。结论不是“出口已经唯一化”，而是已经被运行时 gate 明确锁成“handler request/response 层必须继续维持 SSE facade + lifecycle facade 的 split 结构”。也就是说，这个 gate 当前在保护 split facade 现状本身；若后续要物理删除 `responses-sse-bridge.ts` 或把 response 出口真正收敛成单 facade，必须先改 gate、改 function-map，再改代码，否则会先被现有门禁打回。
- apply_patch audit request-capture dual-symbol drift confirmed: latest=2026-06-16；`src/modules/llmswitch/bridge/native-exports.ts` 当前同时暴露同步名 `captureReqInboundResponsesContextSnapshotJson(...)` 与 async facade `captureReqInboundResponsesContextSnapshot(...)`，而 `responses-request-bridge.ts` 实际调用的是 async facade；与此同时，`tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts` 和 `...submit-tool-outputs.sse-error.spec.ts` 仍主要 mock `captureReqInboundResponsesContextSnapshotJson`。这说明 submit_tool_outputs handler 相关测试里确实存在双符号 surface 漂移：测试合同盯的是旧/底层符号名，而真实 request bridge 已经走 facade 名。这条当前应记作 harness drift / 入口不唯一风险，不是新的业务回归。
- apply_patch audit server response path boundary tightened: latest=2026-06-16；本轮复核 `handler-response-utils.ts` 与 `handler-response-sse.ts` 后，server 层边界可更精确描述：这两处没有发现第二套 request/response 协议解析 owner，但它们确实在 response outbound -> relay persistence 闭环上持有最后一跳 body/probe，并把 `clientBody` / `contractProbe.probe` 交给 `persistResponsesConversationLifecycleForHttp(...)`。因此 server 层不是语义真源，但它绝不是“完全无关 transport 壳”；任何 response-side replay 污染都必须同时审 Rust client projection owner 与这里的 persistence handoff。当前未见 server 侧主动修补 direct request payload 的新实锤，因此 `5520 direct` request 问题仍不能归到 server request shell。
- anthropic response duplicate tool_use id canonicalize fix: latest=2026-06-16；针对 4444/Anthropic 响应投影链再次核查后，当前可确认两类错误已分叉：部分新 halphen/GLM 样本已经是 provider 侧 `MALFORMED_RESPONSE`（上游直接回“模型厂商异常导致本次错误，请重试即可”），但旧类 `hub_pipeline_resp_anthropic_chat_canonicalize_failed` 仍暴露出 RouteCodex 自身的 response outbound 合同缺口：`hub_resp_outbound_client_semantics_blocks/anthropic_chat_response.rs::build_openai_chat_response_from_anthropic_message()` 之前会直接信任 Anthropic `content[].tool_use.id`，不做唯一化；若上游重复给同一个 id，转 OpenAI chat/Responses 时会把重复 tool_call id 原样放出，存在再次触发 canonicalize/客户端协议失败的风险。现已在 Rust owner 内补唯一化逻辑 `uniquify_tool_call_id(...)`，重复 id 会稳定改写为 `<id>_dup_<n>`，并新增单测 `build_openai_chat_response_from_anthropic_dedupes_duplicate_tool_use_ids` 锁住。验证已绿：`cargo test -p router-hotpath-napi build_openai_chat_response_from_anthropic_dedupes_duplicate_tool_use_ids --lib -- --nocapture`、`cargo test -p router-hotpath-napi builds_chat_response_from_anthropic_sse_tool_use --lib -- --nocapture`、`PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:hub-response-anthropic-native`。证据缺口：本轮没有先单独记录新测试 pre-fix 红态，因此当前只能宣称“owner 修复 + gate 绿”，不能宣称该 live 4444 类错误已全量在线闭环；仍需后续拿到可复现的 duplicate-id live/fixture 样本再补在线复测。
- responses-continuation-store ambiguity gate restored: latest=2026-06-15；本轮把 `tests/sharedmodule/responses-continuation-store.spec.ts` 从 `29/33` 拉回 `33/33`。真实业务缺口只有一条：`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts::materializeLatestContinuationByScope()` 在未显式指定 `continuationOwner` 时，会忽略 direct match、直接命中 relay，导致 `direct + relay` 同 scope 共存时不 fail-fast。现已加 owner 歧义检测：若同一 scope 同时命中 direct/relay 且请求未指定 owner，直接返回 `null`。另外 3 条失败已确认只是旧 fixture 漂移，不是业务回归：assistant 历史消息在 replay-safe store 中已经合法化为 `input_text`，standalone reasoning 历史只保留合法 `summary/encrypted_content`，不再回放非法 `reasoning.content/status`。验证已绿：`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-continuation-store.spec.ts --runInBand`。
- apply_patch request-side freeform contract regression fixed: latest=2026-06-15；本轮重新打红后确认，`tests/sharedmodule/apply-patch-chat-process-contract.spec.ts` 失败不是 sample 漂移，而是 prod request owner 真被改坏：`req_process_stage1_tool_governance_blocks/orchestrator.rs::apply_req_process_tool_governance()` 只调用了错误的 `normalize_apply_patch_client_contract_schema()`，导致 live request 仍把 `apply_patch` 保持为 `type=function`，而仓库真正的 freeform/lark owner `normalize_apply_patch_freeform_tool_schema()` 只活在单元测试 helper 里，属于典型“测试绿过 owner 没接入 prod”。现已把 prod 路径切回 freeform owner，并物理删除无其他 caller 的错误 `client_contract_schema` 分支，同时新增 Rust 定向测试 `apply_req_process_tool_governance_projects_apply_patch_as_custom_freeform_tool` 锁死 prod 路径。验证已绿：`cargo test -p router-hotpath-napi apply_req_process_tool_governance_projects_apply_patch_as_custom_freeform_tool --lib -- --nocapture`、`PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`、`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/apply-patch-chat-process-contract.spec.ts --runInBand`、`cargo test -p router-hotpath-napi resp_process_stage1_tool_governance_tests --lib -- --nocapture`、`npm run verify:apply-patch-freeform-contract`、`npm run verify:apply-patch-regressions`、`npm run verify:function-map-compile-gate`。
- stopless NoSchema CLI/tool contract relock in progress: latest=2026-06-15；本轮现场复核确认两件事。其一，`servertool-core/src/cli_contract.rs` 的 `stop_message_auto` stdout 其实已经带 `schemaGuidance`，但高层 Jest 合同仍有旧断言把它当作 `undefined`，等于把错误 contract 锁成绿；已开始把 `tests/servertool/servertool-cli-result-restore.spec.ts`、`tests/servertool/stopless-prompt.client-visible.spec.ts`、`tests/servertool/stopless-cli-continuation.spec.ts` 改成显式要求 NoSchema stdout 必带 `schemaGuidance.requiredFields/stopreasonValues`。其二，live 上“used 不增长”的真相要分两层：直接调用 Rust 二进制 `routecodex-servertool run stop_message_auto` 三次时 `repeatCount` 会始终停在 `1`，因为二进制只产 stdout 不持久化；真实闭环 owner 在 `src/cli/commands/servertool.ts` 的 `hook/servertool run` 包装层，它会先读 `session:<id>` persisted state，再在命令返回后调用 `recordStoplessContinuationState(...)` 落盘。因此本轮新增/补强的红测必须锁在 CLI 包装层同 session `1 -> 2 -> 3`，不能只测裸 Rust binary。
- stopless CLI round-progression contract corrected: latest=2026-06-15；当前 `stop_message_auto` 的 client-visible CLI stdout 已带 `schemaGuidance`，`NoSchema` 不是“无 schema 引导”。真正语义是：server 在投影 stopless `exec_command` 时就已经把 `persistPlan.nextUsed` 写进 `session:<id>` 并把新 `repeatCount` 带进下一轮 re-projected command；同一条旧 command 被本地反复重跑不应作为 live round-progression 真相。测试与审计应改成“同一 session 下连续重新投影的三轮 command 分别命中 first/middle/final”，而不是要求单条 command 自己在本地连跑三次时升级。
- S2/S3 payload-shape evidence corrected: latest=2026-06-15；新增 diag 级抽样后，S2/S3 都不该再粗糙写成“普通 reopened tool turn”或“单个孤儿 tool_result”。S2 的 `error-openai-responses-router-gpt-5.4-20260613T223253714-340912-698.json` 尾部是真实 `assistant output_text -> function_call(call_itU...) -> 同 call_id 再次 function_call -> 两次 function_call_output`；S3 的 `error-openai-responses-router-gpt-5.4-20260613T231359101-341020-806.json` 尾部则是三组 call_id 先出现一轮 `function_call`，再同三组重复一轮 `function_call`，再出现两轮 `function_call_output`，其中报错目标 `call_JyD0...` 同时有两次 call 与两次 output。结论要纠偏为“重复 batch / already-consumed call_id”更贴近 live 真相，owner 应继续锁到 Rust req_inbound capture / history normalization，而不是只写成最简单 orphan。
- apply_patch audit targeted gate rerun pinned: latest=2026-06-15；本轮已现场复跑四组定向 gate，与审计结论一致：`cargo test -p router-hotpath-napi apply_patch --lib -- --nocapture` => `95 passed, 1 ignored`；`responses-response-bridge.direct-json-protocol-guard` + `direct-sse-metadata-guard` => `2 suites / 4 tests PASS`；`responses-request-bridge.request-context-normalization` + `responses-handler.anthropic-tool-history.blackbox` => `2 suites / 14 tests PASS`；`responses-continuation-store.spec.ts` 仍为 `29 passed / 4 failed`，且失败分级继续稳定为“1 条真实 blocker（direct/relay coexist ambiguity）+ 3 条旧 fixture 漂移（output_text / reasoning.content / status 旧预期）”。
- codex session tool-turn evidence pinned: latest=2026-06-15；已抽查 `~/.codex/sessions/2026/06/14/rollout-2026-06-14T14-31-22-019ec4d3-e92c-7240-b6a5-153aaac6d806.jsonl` 与 `...15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`，两份都能直接看到标准 `reasoning -> function_call xN -> function_call_output xN` 成对结构，代表性时间点分别是 `06:33:45.911Z -> 06:33:46.032Z` 与 `07:21:49.539Z -> 07:21:49.662Z`。这进一步支持：S2/S3 的 `2013` / `orphan_tool_result` 不应先归因给 Codex session 原始样本，而应继续锁定 RouteCodex request-side history capture / provider history projection owner。
- apply_patch full audit closeout evidence refined: latest=2026-06-15；本轮补齐了三块还缺的审计证据。第一，`src/modules/llmswitch/bridge/responses-sse-bridge.ts` 已确认只是 `responses-response-bridge.ts` 的重复 facade，不是第二语义 owner；`src/modules/llmswitch/bridge/index.ts` 还同时 public re-export 两套 surface，这会继续放大“非唯一出口”，两者都应进入后续物理删除候选。第二，`tests/sharedmodule/responses-continuation-store.spec.ts` 当前 `29 passed / 4 failed` 里，只有 `fails fast when direct and relay continuations coexist under one scope without explicit owner` 是真实 contract blocker；其余三条失败都已证实主要是 fixture 仍期待旧的 `output_text` / `reasoning.content` / `status` 形状，属于 replay-safe 合同升级后的预期漂移。第三，S2/S3/S5 现在已能分清缺口类型：S2 是 live reopened multi-tool-turn 形状未被 fixture 精确锁住，S3 是 live continuation orphan 形状未被 fixture 精确锁住，S5 不是 fresh outbound sanitize 未修，而是缺统一 response outbound + store/replay 组合审计 gate。
- apply_patch audit duplicate-surface / stale-fixture split refined: latest=2026-06-15；当前轮确认 `src/modules/llmswitch/bridge/responses-sse-bridge.ts` 不是第二语义 owner，而是几乎整面 re-export `responses-response-bridge.ts` 的重复 facade surface；`tests/red-tests/server_responses_sse_surface_single_owner.test.ts` 目前只锁“handler 侧 import 来源分裂”，并没有锁“重复 facade 物理删除”。这条应记为删除候选：在 callers 全迁到唯一 facade 后，`responses-sse-bridge.ts` 应收缩或删除，避免 SSE/response 双桥并存继续制造非唯一出口。另一个关键收口是 `tests/sharedmodule/responses-continuation-store.spec.ts` 当前实跑 `29 passed / 4 failed`：其中 `fails fast when direct and relay continuations coexist under one scope without explicit owner` 是真实 contract 缺口，当前实现错误返回 relay materialized payload；另 3 条失败（historical images after success release、standalone reasoning preserve、reopened apply_patch after exec_command）主要是旧 fixture 仍期待 `output_text` / `reasoning.content` / `status` 等旧形状，属于测试预期漂移，不能直接当成业务回归。
- apply_patch audit gate/harness truth refined: latest=2026-06-15；当前轮复核发现三类 gate 需要分开记账。`tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts` 可直接用普通 Jest 跑绿；`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` 若直接用 `pnpm jest` 会因顶层 `await` 被按 CommonJS 解析而假红，正确命令是 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest ... --runInBand`，实跑 3/3 PASS；`tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts` 初次失败不是业务红，而是 native `projectResponsesClientPayloadForClientJson` 在本地 dist 未就绪，执行 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` 后重跑即 3/3 PASS。结论：这三条 spec 不能只写“绿/红”，必须同时标记运行前提，否则会把 ESM 入口问题和 native build 前置条件误记成业务回归。
- apply_patch broad suite reverified + 4444 issue decoupled: latest=2026-06-15；当前轮重新在 `sharedmodule/llmswitch-core/rust-core` 复跑 `cargo test -p router-hotpath-napi apply_patch --lib -- --nocapture`，结果 `95 passed, 1 ignored`，说明 request-side client-contract preserve 与 response-side legacy hunk/live-context 修复当前仍为绿。同时复核 `~/.rcc/logs/server-4444.log` 最新 live：`openai-responses-halphen.key1-glm-5.2-20260615T230135968-349824-3101` 失败类型已是 `MALFORMED_RESPONSE`，错误内容为 `[provider] Upstream provider returned malformed Anthropic response: 模型厂商异常导致本次错误，请重试即可`；它不再等同于早前那条 `hub_pipeline_resp_anthropic_chat_canonicalize_failed`，因此 4444 当前问题应从 apply_patch / responses replay-safe 审计里分离，归到 provider malformed Anthropic payload 解析/投影链。
- stopless 5555 route-hint/search carryover confirmed and fixed: latest=2026-06-15；live `~/.rcc/logs/server-5555.log` 中 `sid=stopless-live-1780952765059` 连续三次都命中 `reason=thinking:user-input|route_hint:search`，证明 stopless followup 错带了旧 `search` hint。owner 在 `chat_servertool_orchestration.rs` followup metadata 构造与 `virtual_router_engine/engine/route.rs::resolve_route_hint()`；现已让 stopless followup 通过 `serverToolFollowupSource=servertool.stop_message` 进入 VR，并对该 source 无条件剥离历史 routeHint。验证已绿：`cargo test -p router-hotpath-napi test_stop_message_auto_followup_does_not_pin_provider --lib -- --nocapture`、`cargo test -p router-hotpath-napi stopless_followup_strips_tools_route_hint_and_falls_back_to_thinking --lib -- --nocapture`、`cargo test -p router-hotpath-napi stopless_followup_strips_search_route_hint_and_falls_back_to_thinking --lib -- --nocapture`。
- stopless schema-guidance gap confirmed: latest=2026-06-15；当前 `servertool-core/src/stopless_prompt.rs` 的 `StoplessContinuationTrigger::NoSchema` 只返回自然语言续做提示，`schema_guidance_required` 仅在 `InvalidSchema` 为 true；`chat_servertool_orchestration.rs` 也固定用 `NoSchema` 生成 followup prompt。这解释了 5555 最新 stopless 为什么“连续 stop 但没有 schema 引导、计数感知也不明显”。该缺口已确认，但本轮尚未补 stop-schema 注入闭环。
- responses outbound direct-skip root cause fixed: latest=2026-06-15；已确认 `src/modules/llmswitch/bridge/responses-response-bridge.ts::normalizeResponsesClientPayloadForHttp()` 之前在 `metadata.__routecodexDirectPassthrough === true` 时直接跳过 Rust client projection，导致“前段 relay、末端 transport 直发”的 `/v1/responses` 响应会把 `reasoning.content` 与 item-level `status` 原样回给客户端并污染后续 history。现已删除该 skip，并新增 `tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts` 锁死：即使带 direct metadata，response outbound 也必须经过 replay-safe 协议清理。验证已绿：新 Jest 定向 1/1 PASS、`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` PASS、`tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts` PASS、`cargo test -p router-hotpath-napi project_responses --lib -- --nocapture` PASS、`npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` PASS、`npm run verify:function-map-compile-gate` PASS。
- responses outbound protocol lock reverified: latest=2026-06-15；新增可执行黑盒 `tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts` 第三条用例，现已直接通过 native `tsx` 子进程 probe 锁住 client-visible `/v1/responses` payload 的 replay-safe 合同：`reasoning.content` 不得外泄，`reasoning/function_call/function_call_output` 的 item-level `status` 不得进入客户端历史。验证已绿：该黑盒 3/3 PASS，`cargo test -p router-hotpath-napi project_responses --lib -- --nocapture` PASS，`tests/sharedmodule/responses-continuation-store.spec.ts` 两条定向回放合法化 PASS，`npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` PASS，`npm run verify:function-map-compile-gate` PASS。
- provider error chain direct/relay audit finalized: latest=2026-06-15；已按 Jason 指定新路径落盘 `docs/goals/provider-error-chain-direct-relay-audit-2026-06-15.md`，定稿重定义最终 G1-G10，并按执行顺序 `G1 -> G3 -> G6 -> G5 -> G7 -> G10 -> G2 -> G4 -> G9` 收口；核心校正：client_disconnect 不再投影 204/CLIENT_DISCONNECTED，而是服务器立即停请求保持断开；provider-mode 单点 binding 显式豁免中心原则；`upstream_stream_incomplete` 从另起 plan 收口进 G6 统一错误链。
- halphen + 4444 + gcm config task: latest=2026-06-15；用户要求新增 Anthropic provider `halphen`（`http://api.halphen.cn/anthropic`，model=`glm-5.2`），在 `~/.rcc/config.toml` 增加 `4444` 端口并让 default/coding/thinking/tools/search/web_search/longcontext 走 `halphen.glm-5.2`、`multimodal` 走 `minimax.MiniMax-M2.7`；同时在 `~/.codex/config.toml` 增加与 `rcm` 平行的 `gcm` profile，并新增独立 `~/.codex/gcm.config.toml`。
- paid GPT forwarder priority update: latest=2026-06-16；Jason 明确要求 `5520` 和 `5555` 共用的 paid GPT forwarder 改为 `asxs > XL > 1token > cc`。已在 `~/.rcc/config.toml` 的 `fwd.paid.gpt-5.4` 与 `fwd.paid.gpt-5.4-mini` 插入 `XL` 第二优先级，并顺延 `1token/cc` 到 3/4。
- 5555 coding/tools/search routing update: latest=2026-06-16；Jason 要求 `5555` coding 顺序为 `gpt-5.4-mini -> glm-5.2 -> minimax.M3`，并要求 `5555` tools/search 里同时有 `fwd.minimax.MiniMax-M2.7`（minimax+minimonth，已无 mini27）和 `M3`。已改 `gateway_priority_5555`：coding targets=`fwd.paid.gpt-5.4-mini, halphen.glm-5.2, fwd.minimax.MiniMax-M3`；tools/search/web_search targets=`fwd.minimax.MiniMax-M2.7, fwd.minimax.MiniMax-M3`。
- 5555 coding load-balance update: latest=2026-06-16；Jason 进一步要求 `5555` coding 不走 priority，改成 load balance。已将 `gateway_priority_5555.routing.coding` 从 `mode=priority` 改为 `mode=weighted`，并对 `fwd.paid.gpt-5.4-mini`、`halphen.glm-5.2`、`fwd.minimax.MiniMax-M3` 设置 `1:1:1` 权重。
- apply_patch audit doc mapping table finalized: latest=2026-06-15；`docs/goals/apply-patch-direct-relay-full-audit-plan.md` 现已补齐 `真实样本 -> 代码文件 -> 风险 -> gate 缺口` 总表、`5555 relay / 5520 direct` 的直接回答块、生命周期 owner 清单，以及按 direct / relay / Rust owner 切开的修复顺序，可直接指导下一轮修复，不再依赖散落口头结论。
- direct emission can carry prior relay/history poisoning: latest=2026-06-15；新 live 样本 `openai-responses-router-gpt-5.4-20260615T202830407-348488-1765` 证明“发射阶段 direct”与“污染形成点”必须分离记账：日志显示 `[port:5555 ...] [router-direct.send] ... asxs.crsa.gpt-5.4-mini`，但对应 diag `error-openai-responses-router-gpt-5.4-20260615T202830407-348488-1765.json` 的 `input[41]` 明确是非法 `reasoning.content`（`type=reasoning` + `content=[{type:reasoning_text,...}]`），upstream 报 `Invalid 'input[41].content': array too long`。结论：relay/store/outbound 先污染历史后，后续 direct 仍会原样把毒发出去；不能把 `router-direct.send` 误写成“不是 relay 污染链”。
- responses outbound replay-safe sanitize landed at Rust client projection owner: latest=2026-06-15；根因已确认是 `client_tool_args.rs::project_responses_client_body_for_client_core()` 之前只做 tool arg normalize / apply_patch 投影，未对既有 `responses` payload 做 replay-safe 清理，`responses_payload.rs` 也会对现成 `object=response` 直接 clone 放行。现已在 Rust owner 增加统一 sanitize：剥离 `reasoning.content`，并去掉 `reasoning/function_call/function_call_output.status`，同时覆盖 JSON body、SSE event、以及 `build_responses_payload_from_chat_core()` 的现成 response 直通。验证已绿：3 条新 Rust 用例、`npm run verify:hub-response-responses-chat-projection`、`npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`、`npm run verify:function-map-compile-gate`、`node scripts/build-core.mjs`；运行时探针 `projectResponsesClientPayloadForClientWithNative` 也已确认输出里不再包含 `reasoning.content` 与 item-level `status`。
- responses replay-safe status cleanup locked at Rust history owner: latest=2026-06-15；`shared_responses_conversation_utils.rs` 现在明确剥离 persisted/restored responses history 里的 response-only `status` 字段（`function_call` / `function_call_output` / `reasoning`），对应 live 400 `Unknown parameter: 'input[1].status'` 的 replay-safe 持久化真 owner。验证已绿：`cargo test -p router-hotpath-napi prepare_persists_responses_legal_tools_and_history_items --lib -- --nocapture`、`cargo test -p router-hotpath-napi convert_responses_output_to_input_items_strips_response_only_status_fields --lib -- --nocapture`、`cargo test -p router-hotpath-napi restore_never_replays_reasoning_content_from_persisted_history --lib -- --nocapture`、`jest tests/sharedmodule/responses-continuation-store.spec.ts -t '...status fields'`、`npm run verify:function-map-compile-gate`、`node scripts/build-core.mjs`。
- relay stopless CLI projection tests currently enforce client-visible projection: latest=2026-06-15；定向跑 `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts -t 're-projects stop_message_auto...'` 与 `tests/sharedmodule/provider-response-rust-plan.spec.ts -t 'projects stopless CLI command for relay OpenAI Responses completed stop without session scope'`，两者都失败在旧期望 `routecodex servertool run stop_message_auto`，而实际返回的是 `routecodex hook run stop_message_auto`；这证明仓库现有黑盒/plan 测试仍把“relay `/v1/responses` 向客户端投影 exec_command CLI”当作正向合同，只是命令壳已漂移。
- relay function_call status replay narrowing: latest=2026-06-15；新增 `responses-continuation-store.spec.ts` 定向用例 `submit_tool_outputs resume keeps function_call history without replaying response-only status fields` 已绿，证明 relay 本地 store 的 submit_tool_outputs resume 路径不会把 `function_call.status=in_progress` 回放进下一轮 `input`；S4 中这类 `status` 更应继续收窄到 client-visible response replay 或 incoming history normalization，而不是笼统归因给本地 store materialize。
- direct SSE response.metadata allowlist corrected: latest=2026-06-16；`response.metadata` 这条 `5520 direct` live 样本已改为“普通 provider metadata event 允许透传，内部 control-field metadata 仍拒绝”，`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` 4/4 PASS；当前剩余缺口只在更上层 `responses-sse-client-contract.blackbox.spec.ts` 的其他 terminal/error 红点。
- codex session tool-turn shape evidence refresh: latest=2026-06-15；抽查 `~/.codex/sessions/2026/06/14/rollout-2026-06-14T14-31-22-019ec4d3-e92c-7240-b6a5-153aaac6d806.jsonl` 与 `...15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`，确认样本内是标准 `response_item=function_call` / `response_item=function_call_output` 成对交替记录；它们可作为“Codex session 样本本身不天然制造 orphan/乱序”的支持证据，但不能替代 transport/live log 证据。
- 5520 direct SSE protocol audit refresh: latest=2026-06-15；新 live 样本 `openai-responses-router-gpt-5.4-20260615T193814122-348189-1466` 已确认是 `router-direct` 下 upstream 直接发出非法 `event: response.metadata`，server 侧仅用 direct SSE allowlist fail-fast；owner 在 `responses-response-bridge.ts` 的 direct event allowlist 与 `handler-response-sse.ts` 触发点，不属于 relay/store 污染。
- apply_patch outbound audit correction: latest=2026-06-15；纠偏：`input[].status` 不能只归因给 response outbound。`shared_responses_conversation_utils.rs::normalize_responses_history_item()` 在 `function_call` history item 上会保留 `status`，所以 replay-illegal `status=in_progress` 也可能经 relay store/restore 正式落库并重放；owner 必须按 `resp_outbound + persistence` 闭环看。
- relay native capture intermittent truth: latest=2026-06-15；`captureReqInboundResponsesContextSnapshotJson is required but unavailable` 与后续 5555 成功样本在同一 `0.90.3065` live 运行窗口内共存，当前只能归为实例态/装载态不稳定，不能再写成“当前功能永久缺失”。
- apply_patch outbound protocol audit evidence refresh: latest=2026-06-15；已确认 `5555` 新鲜 replay 400 不是 request bridge 猜测问题，而是 response outbound / persistence 把 internal `stop_message_auto` CLI `exec_command` function_call 泄漏进了下一轮 `/v1/responses` history；同时确认 `5555` 既有 relay 前段语义，又可能在 provider send 末跳显示 `router-direct.send`。
- 2026-06-15 定向 gate 实测：`verify:function-map-compile-gate`、`verify:architecture-owner-queryability`、`verify:architecture-feature-map-growth-discipline`、`verify:hub-response-responses-chat-projection`、`handler-response-utils.apply-patch-freeform-sse.spec.ts`、`native-exports.responses-sse-contract.spec.ts` 均为绿；`direct-passthrough-route-level.spec.ts` 当前应改记为 harness 不稳定：文件内确有 `/v1/responses` direct coverage，但本地实跑会长期挂住并遗留 Jest 进程，暂不能作为稳定 gate 或业务红证据。
- 2026-06-15 completion audit：审计主结论、owner 矩阵、样本映射、direct/relay 分链、定向 gate 实测都已落文档；当前仍不能宣称全量审计完成，剩余缺口是 S2/S3 live reopened-tool-turn fixture、S5 replay-safe persistence red test、S6 live install-state / handler-entry gate。
- responses reasoning-content history leak fixed: latest=2026-06-15；已确认 17:35 live 400 样本是 direct request replay 了非法 `reasoning.content`, 当前已在 response->history persistence owner 加 gate 和修复。
- apply_patch audit fixes landed and green: latest=2026-06-15；已确认 `hub_req_inbound_context_capture.rs` 的 canonical writeback、`standardized_request.rs` 的 responses input 预规范化、以及 relay store 的 `output_text/commentary -> input_text` 历史合法化均已转绿。
- apply_patch 审计文档最终收口：latest=2026-06-15；已补 direct/relay 最终 owner 矩阵、重复 surface / 删除候选、server 层协议污染嫌疑点、以及“为何 5555 是 relay / 为何 5520 仍有 apply_patch 问题”的显式回答块。
- apply_patch direct/relay owner audit split：latest=2026-06-15；已基于 live 日志、online smoke、样本、function-map 确认 `5520 direct` / `5555 relay` 分链真相、唯一 owner 与当前 gate 缺口。
- direct request passthrough reasoning/apply_patch contract relock：latest=2026-06-15；已确认 direct provider runtime 不再按 reasoning 触发 sanitize，且 direct 样本显式锁住 freeform `apply_patch` tool 定义原样透传上游。
- 5520 direct SSE duplicate terminal frames live truth：latest=2026-06-15；已确认线上 `0.90.3071` 仍在 `response.completed(required_action)` 后本地补一套 tool terminal frames，且全局安装 dist 未带上 direct skip 修复。
- reasoning retention audit split：latest=2026-06-15；已确认 direct live 本次未见 SSE 壳层吞 reasoning，但 relay/local responses conversation store 仍显式丢弃 standalone reasoning output item。
- stopless blackbox CLI contract update：latest=2026-06-15；旧 `scripts/tests/stopless-followup-blackbox.mjs` 仍断言 server-side reenter / upstream>=2，已改为 CLI projection 合同并在线黑盒转绿。
- stopless CLI request-side auto-hook rewrite：latest=2026-06-15；已确认真实 capture owner 在 `hub_req_inbound_context_capture.rs`，此前 rewrite 只写在 tool normalization 未接入 live capture；现已接入 capture 入口并通过 cargo/native jest/function-map gate。
- stopless CLI vs transparent reenter owner conflict：latest=2026-06-15；已确认 map/docs/code 当前一致指向 transparent reenter，但仓库残留 CLI contract/blackbox；正在统一回 CLI 闭环。
- servertool nested followup timeout removal：latest=2026-06-15；已取消 executor 侧 10s nested followup fail-fast，只保留 client abort；待 build:min 收口。
- 5520 latest apply_patch sample re-audit：latest=2026-06-15；已确认 provider 200 + outbound custom grammar preserve 修复已落 Rust owner，待 build/install/live replay。
- apply_patch SSE pending-delta done-frame closure：latest=2026-06-15；已完成定向 gate + build/install/restart 证据，待按总审计任务继续归并。
- direct-path-error-reroute-and-candidate-exhaustion P5 (function-map/verification-map sync)：latest=2026-06-15；map/gate 落盘，待 promote 到 MEMORY.md 待 gate PASS。
- 5520 direct apply_patch grammar + SSE projection closure：latest=2026-06-14；已 promote 到 MEMORY.md 候选。
- stopless double-收口执行与清理：latest=2026-06-14；已 promote 到 MEMORY.md 候选。
- latest codex apply_patch sample compatibility：latest=2026-06-14；已 promote 到 MEMORY.md 候选。
- apply_patch direct/relay full audit progress：latest=2026-06-14；in_progress。

## 2026-06-15 stopless blackbox CLI contract update

- 旧黑盒 `scripts/tests/stopless-followup-blackbox.mjs` 还在断言“stopless 会自动 reenter upstream 第二次”，因此在当前 CLI 闭环下必然误报：
  - `expected upstream >=2 hits (initial + followup), got 1`
- 当前 stopless 合同应为：
  - 首次 upstream 返回 `finish_reason=stop`
  - RouteCodex 本地拦截后直接投影 `exec_command`
  - 不允许 server-side reenter，不允许第二次 upstream 自动 followup
- 黑盒脚本已改为断言：
  - HTTP 200
  - `required_action.submit_tool_outputs.tool_calls` 存在
  - 存在 `exec_command`
  - `cmd` 为 `routecodex hook run stop_message_auto ...` 或 `routecodex servertool run stop_message_auto ...`
  - CLI 输入不泄漏 `continuationPrompt` / `stopreason`
  - upstream 命中数严格等于 1
- 2026-06-15 验证证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/tests/stopless-followup-blackbox.mjs` PASS
  - 结果：`upstreamHits=1`, `providers=["crs1"]`, `execCommand="routecodex hook run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1}'"`

## 2026-06-15 direct request passthrough reasoning/apply_patch contract relock

- 根因复核：`src/providers/core/runtime/responses-provider.ts` 之前会在 direct path 上按 `input[].type=reasoning` 触发 `sanitizeResponsesProviderOutboundBody(...)`，这违反了 `responses.direct_tool_shape_contract` 的“same-protocol direct request body identity is preserved”。
- 修复：删除 direct path 的 `shouldSanitizeDirectResponsesBody(...)` 分支；`processIncomingDirect()` 现在直接把 `builtBody` 作为 provider wire。
- 合同补强：`tests/providers/runtime/responses-provider.direct-passthrough.spec.ts`
  - reasoning 样本现在断言 `capturedBody === inbound`，且 reasoning `content/encrypted_content/summary` 原样保留；
  - direct payload 样本显式加入 freeform `apply_patch` grammar tool，锁死 `tools` 原样透传，不允许 direct runtime 再做工具定义清洗。
- 2026-06-15 验证证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/providers/runtime/responses-provider.direct-passthrough.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/direct-passthrough-minimum-overrides.spec.ts tests/server/runtime/http-server/router-direct-pipeline.spec.ts tests/server/runtime/http-server/provider-direct-pipeline.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:responses-direct-tool-shape-contract` PASS

## 2026-06-15 apply_patch direct/relay owner audit split

- 分链真相已确认：
  - `5520` 相关 `apply_patch` grammar 400 样本 `openai-responses-router-gpt-5.4-20260614T230414428-345124-2702` 明确是 direct：
    - 日志证据：`~/.rcc/logs/server-5520.log`
    - 同一窗口内同时存在：
      - `[port:5520 group:gateway_priority_5520] ▶ [/v1/responses] ...`
      - `[virtual-router-hit] ... -> asxs.crsa.gpt-5.4`
      - `[router-direct.send][openai-responses-router-gpt-5.4-20260614T230414428-345124-2702] error`
      - upstream `Invalid lark grammar ... unknown name: "begin_patch"`
    - 结论：这是 request transport contract / direct provider wire 问题，不是 relay/store/SSE。
  - `5555` 两类经典失败都不是 direct：
    - `openai-responses-router-gpt-5.4-20260613T223253714-340912-698`
      - `[port:5555 ...] [virtual-router-hit] ... -> minimax.key1.MiniMax-M3`
      - provider 返回 `invalid params, tool call result does not follow tool call (2013)`
      - 没有 `[router-direct.send]`
      - 结论：relay request-side history 投影到上游 chat/protocol 的形状问题。
    - `openai-responses-router-gpt-5.4-20260613T231359101-341020-806`
      - `[port:5555 ...] [virtual-router-hit] ...`
      - 本地失败：`orphan_tool_result ... code=hub_pipeline_context_capture_failed`
      - 没有 `[router-direct.send]`
      - 结论：relay request-side native context capture 本地拒绝；失败发生在 provider transport 之前。
- 5555 relay 当前 apply_patch 在线 smoke 证据：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5555/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS=180000 node scripts/tests/apply-patch-freeform-10000-online.mjs`
  - PASS：`ok=true`、`customInputCount=3`、`functionArgumentPatchLeakCount=0`
  - 结论：当前 relay apply_patch 主链没有复现“空 arguments / function_call patch 泄漏”。
- owner 清单（已绑定 function-map / 实码）：
  - direct request 语义保留：
    - feature: `responses.direct_tool_shape_contract`
    - Rust owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src`
    - TS shell: `src/providers/core/runtime/responses-provider.ts`
  - relay request handler facade：
    - feature: `server.responses_request_handler_bridge_surface`
    - file: `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - 职责：handler entry、resume/scope materialize facade、native capture 调用；不是 tool-history owner。
  - relay request-side tool history / orphan / duplicate 真 owner：
    - feature: `hub.req_inbound_responses_context_capture`
    - files:
      - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
      - `.../hub_req_inbound_tool_call_normalization.rs`
      - `.../hub_req_inbound_tool_output_snapshot.rs`
    - 职责：tool history normalize、shell-like tool call rewrite、orphan_tool_result fail-fast、duplicate compare/rewrite。
  - apply_patch freeform 参数/grammar/live-context 真 owner：
    - feature: `tool.apply_patch_freeform_contract`
    - files:
      - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
      - `.../resp_process_stage1_tool_governance_blocks/apply_patch_live_context.rs`
    - 职责：grammar/schema、参数 canonicalization、GNU hunk 修形、live-context compare；不是 handler/store。
  - relay store / continuation owner：
    - file: `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
    - native helpers:
      - `convertOutputToInputItems`
      - `resumeConversationPayload`
      - `stripStoredContextInputMedia`
    - 职责：relay 本地 store、scope/owner 隔离、response->input history 持久化；`direct` continuation 不本地持久化。
  - relay response JSON/SSE client projection 真 owner：
    - feature: `hub.response_responses_client_projection`
    - Rust owner file:
      - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
    - TS shell:
      - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
      - `src/server/handlers/handler-response-sse.ts`
    - 职责：apply_patch `function_call -> custom_tool_call`、delta 聚合、done 去重、client-visible model/reasoning restore。
- 新增高风险闭环证据：relay store 当前吃的是 response outbound/projection 后的语义，不是 provider raw response
  - JSON path：
    - `src/server/handlers/handler-response-utils.ts`
    - `prepareResponsesJsonClientDispatchPlanForHttp(...)` -> `normalizeResponsesClientPayloadForHttp(...)` -> `clientBody`
    - 随后 `persistResponsesConversationLifecycleForHttp({ body: sanitized })`
    - 这里的 `sanitized` 来源于 `clientBody` / projected payload，而不是 provider raw。
  - SSE path：
    - `src/server/handlers/handler-response-sse.ts`
    - `persistNativeSseConversationState()` 把 `stripInternalKeysDeep(contractProbe.probe)` 作为 `body` 传给 `persistResponsesConversationLifecycleForHttp(...)`
    - 这里持久化的也不是 provider raw stream，而是 probe 聚合后的 response 语义。
  - relay store：
    - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
    - `recordResponse()` 里 `convertOutputToInputItems(response)` 直接从上述 `body` 生成下一轮历史 `entry.input`
  - 结论：
    - 若 response outbound/projection 没做严格协议校验或映射错误，污染确实会进入 relay 本地 history；
    - 下一轮 `resumeConversationPayload/materializeContinuationPayload` 会把这份污染重新发上游，形成请求侧 `400`。
- 已拿到一条“response 语义错层进入历史 -> 上游 400”的实锤样本：
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json`
  - `requestBody.input_len=399`
  - 其中大量 `type=message` 的 `content` part 含 `output_text`，例如：
    - `message_idx 21 bad_types ['output_text']`
    - `message_idx 30 bad_types ['output_text']`
    - 后续大量重复
  - `/v1/responses` 合法下一轮请求 content type 应为：`input_text/text/image_url/video_url/input_audio/file`；`output_text` 属于响应语义，不应进入请求历史。
  - 真 owner 落点：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
    - `normalize_output_item_to_input(item)` 对 `type=message` 当前直接把 `content` 原样抄回 input，没有把 `output_text` 投影成合法 input 侧形状。
    - 这份输出随后经 `responses-conversation-store.ts -> recordResponse() -> convertOutputToInputItems(response) -> entry.input` 持久化。
  - 结论：
    - 至少一类 relay 400 已被证实是“response 侧 message/content 映射错层 + store 持久化 + 下一轮 restore 发回上游”的闭环问题。
    - 这不是 direct request sanitize 问题。
- 当前 gate 状态与缺口：
  - 已绿：
    - `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts`
    - `tests/server/runtime/http-server/direct-passthrough-minimum-overrides.spec.ts`
    - `tests/server/runtime/http-server/router-direct-pipeline.spec.ts`
    - `tests/server/runtime/http-server/provider-direct-pipeline.spec.ts`
    - `tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts`
    - `tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts`
    - `node scripts/architecture/verify-apply-patch-freeform-contract.mjs`
    - 5555 / 5520 apply_patch online smoke
  - 仍红 / 缺口：
    - `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts`
      - case1：`captures required_action -> completed -> done ...` timeout
      - case2：`turns early upstream close into explicit error instead of client hang` 期望 `event:error` 未出现
    - 结论：这是 relay 更大范围 SSE 收口 gap；不能证明 apply_patch 主链坏，但说明 response/SSE contract 仍有独立风险。
- 后续修复顺序建议：
  1. relay SSE 黑盒残留：`responses-response-bridge.ts` + `handler-response-sse.ts` + Rust outbound projection 边界
  2. 5555 request-side reopened tool history live fixture：把 `2013` 样本固化进 request/history 红测
  3. 5555 local orphan_tool_result live fixture：把 `hub_pipeline_context_capture_failed` live 形状固化进 native capture/red test
  4. 仅在证据显示时再继续 direct；当前 direct apply_patch 主问题已从“错误整形”收口到“上游 grammar / 正常 patch context mismatch”

## 2026-06-15 apply_patch 审计文档最终收口

- `docs/goals/apply-patch-direct-relay-full-audit-plan.md` 已补四块最终结构：
  - `13. 重复 surface / 删除候选 / server 层协议修补嫌疑点`
  - `14. 最终 owner 矩阵`
  - `15. 样本 -> owner -> 风险 -> gate 缺口 一览`
  - `16. 显式回答块`
- 已明确三类边界：
  - `responses-sse-bridge.ts` 是 duplicate surface，不是第二语义 owner；
  - `handler-response-utils.ts` / `handler-response-sse.ts` 不是协议真源，但当前确实参与 relay response persistence 污染路径；
  - `5520 direct` 当前没有新证据证明 server request 侧在主动修补 `apply_patch` payload。
- 已收口的审计结论：
  - `5555` 的关键 `apply_patch` 问题样本 S2/S3/S5 都是 relay，不是 direct；
  - `5520` 的关键 `apply_patch` 问题样本 S1/S4 属于 direct contract / carryover / projection 问题；
  - 当前最需要优先修的唯一 owner 顺序是：
    1. `hub_req_inbound_context_capture.rs`
    2. `responses-request-standardization.real-samples.red.spec.ts`
    3. `shared_responses_conversation_utils.rs`
    4. `hub_bridge_actions/history.rs` / `bridge_input.rs`

## 2026-06-15 apply_patch outbound protocol audit evidence refresh

- `5555` 最新 fresh replay 400 样本：
  - requestId=`openai-responses-router-gpt-5.4-20260615T180749445-347851-1128`
  - log：`[port:5555 ...] [router-direct.send] ... code=unknown_parameter`
  - upstream error：`Unknown parameter: 'input[1].status'.`
  - diag：`~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T180749445-347851-1128.json`
  - requestBody.input[1] 明确包含：
    - `type=function_call`
    - `name=exec_command`
    - `status=in_progress`
    - `arguments={"cmd":"routecodex hook run stop_message_auto --input-json ..."}`
    - `call_id=call_servertool_cli_...`
- 结论：
  - 这不是 `apply_patch` 参数包装问题。
  - 这是 relay response outbound / persistence 把 internal stopless CLI projection 写进了 client-visible history，下一轮 replay 又原样发给 responses provider，直接被上游判非法字段。
- owner 真相：
  - response outbound projection owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/responses_payload.rs`
  - relay store owner：
    - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
  - TS bridge 只是 facade：
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts`
    - `src/modules/llmswitch/bridge/runtime-integrations.ts`
- 额外结论：
  - `5555` 不能简化成“纯 relay”或“纯 direct”。
  - 当前真实链路是：relay 前段做 request/response/store 语义，provider send 末跳可能 same-protocol direct，所以日志里能同时看到 `5555` 和 `router-direct.send`。
- gate 缺口：
  - 现有 `hub.response_responses_client_projection` 只明确锁了 `reasoning.content` 不得外泄，还没锁 internal stop_message_auto/CLI function_call 不得进入 client-visible history。
  - `responses-continuation-store` 现有 contract 也没锁 “persisted client-visible history must be replay-safe for `/v1/responses`”.

## 2026-06-15 5520 direct SSE duplicate terminal frames live truth

- 在线复测 `http://127.0.0.1:5520/v1/responses`（model=`gpt-5.4`，stream=true，强制 `exec_command` 工具）仍复现重复终结帧：
  - upstream 先输出一套正常 `response.output_item.added -> response.function_call_arguments.* -> response.output_item.done -> response.completed`
  - 随后本地又追加一套 `response.output_item.added -> response.function_call_arguments.delta/done -> response.output_item.done -> response.done`
- 关键形状证据：
  - 第一套帧带 `sequence_number`
  - 第二套追加帧不带 `sequence_number`
  - 这更像本地 `buildResponsesTerminalSseFramesFromProbeForHttp(...)` 合成物，而不是 upstream 重发。
- 已核对当前全局安装真值：
  - `routecodex --version` / `rcc --version` = `0.90.3071`
  - `/opt/homebrew/lib/node_modules/routecodex/dist/server/handlers/handler-response-sse.js` 中 **不存在**：
    - `sse.persist.skip.direct_passthrough`
    - `sawResponsesCompletedChunk: isDirectPassthrough ? true : ...`
    - `sawResponsesDoneEvent: isDirectPassthrough ? true : ...`
- 结论：工作树源码已有 direct skip 修复，但当前线上安装产物未带上，所以 live 仍走旧 direct SSE 收尾逻辑。

## 2026-06-15 reasoning retention audit split

- direct live 复测（5520 `/v1/responses`，stream=true，工具调用样本）现在只剩一套原始 upstream tool frames；`response.created` / `response.completed` 内的 `response.reasoning` 对象仍在，未见 handler shell 额外裁掉 reasoning 字段。
- direct live 这次样本没有出现 standalone reasoning output item，因此不能把“direct 全路径 reasoning 完整保留”宣称为已证实，只能确认当前 SSE 壳层未额外吞掉 top-level `response.reasoning`。
- relay/local store 风险已确认存在于 Rust owner：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - `normalize_output_item_to_input(...)` 对 `item_type == "reasoning"` 直接 `return None`
  - 其自带测试也明确锁的是“drop reasoning”当前行为：
    - `drops_reasoning_output_item_from_persisted_history`
    - `drops_reasoning_output_item_before_function_call_when_persisting_history`
    - `drops_encrypted_only_reasoning_output_item_from_persisted_history`
- 辅助证据：`~/.rcc/codex-samples/openai-responses/port-5520/openai-responses-router-gpt-5.4-20260615T103132026-346572-4150/provider-request.json` 中当前 provider request 仍含多条 `"type": "reasoning"`，说明请求侧 inline history 至少在该 direct 样本里没有先天丢光 reasoning。
- 样本侧再确认：`~/.rcc/codex-samples/openai-responses/**/provider-response.json` 中存在多条真实 `output.type="reasoning"` 样本；同时 `provider-request.json` 在 197 个样本里命中 6267 条 `"type":"reasoning"`，说明“历史里保留 reasoning”是 live 主路径需求，不是测试专用形状。
- 旧样本重放 PASS：`/Users/fanzhang/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781405903910_40a2191d/provider-response.json` 的真实响应体在 `body.payload`；将该 payload 直接喂给 `convertResponsesOutputToInputItemsWithNative(...)` 后得到 `totalItems=8`、`reasoningItems=1`，证明 owner 当前能从真实 provider response 中提取 standalone reasoning item。
- 当前源码验证已转绿，说明 relay/local continuation store 主链不再丢 standalone reasoning：
  - Rust owner 测试 PASS：`cargo test -q -p router-hotpath-napi preserves_reasoning_output_item --lib -- --nocapture`
  - JS store 黑盒 PASS：`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-continuation-store.spec.ts --runInBand -t 'recordResponse must preserve standalone reasoning output items in persisted history before later tool turns|materialize must not duplicate pending tool-call history when incoming payload already replays the current pending turn|materialize must collapse duplicated pending call batches when incoming delta repeats the same call_ids twice|materialize still builds full input when incoming payload is true delta after a pending tool call'`
  - 结论收口到“relay/local store 当前源码已能同时保留 reasoning 与 pending-tool materialize 语义”；是否线上已生效还需要 install/restart 后再做 live/runtime 证据。

## 2026-06-15 stopless CLI request-side auto-hook rewrite

- 红测先红：`tests/sharedmodule/native-required-exports-sse-stream.spec.ts` 新增门禁后首次 FAIL，证明 `captureReqInboundResponsesContextSnapshotWithNative` 真实产物里，自动注入的 stop hook `function_call/function_call_output` 仍原样留在 `context.input`，没有改写成文本输入。
- 根因确认：rewrite 逻辑之前只落在 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`；但 live native capture 入口实际走 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs::capture_req_inbound_responses_context_snapshot`，因此逻辑未接入真实链路。
- 修复：在 `capture_req_inbound_responses_context_snapshot` 最前面先对整个 request payload 执行 `normalize_shell_like_tool_calls_before_governance`，再继续 `normalize_responses_input_items` / context capture。
- 合同锁定：
  - `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
  - `tests/servertool/stop-schema-lifecycle-contract.spec.ts`
  - `tests/servertool/stopless-cli-continuation.spec.ts`
  - `tests/servertool/stop-message-auto.goal-default.spec.ts`
- 2026-06-15 验证证据：
  - `cargo test -p router-hotpath-napi hub_req_inbound_tool_call_normalization --lib -- --nocapture` PASS
  - `cargo test -p router-hotpath-napi normalize_responses_input_items --lib -- --nocapture` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/native-required-exports-sse-stream.spec.ts tests/servertool/stop-schema-lifecycle-contract.spec.ts tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/stop-message-auto.goal-default.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` PASS
  - `git diff --check` PASS

## 2026-06-15 stopless single-contract closeout audit

- 当前 stopless 真合同已再次核实为 CLI continuation，不是 transparent reenter：
  - `sharedmodule/llmswitch-core/src/servertool/engine.ts` 只接受 `terminal_final` 或 `cli_projection`
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs` 的 `StoplessOrchestrationAction` 只有 `TerminalFinal` / `CliProjection`
  - `docs/architecture/function-map.yml` / `docs/architecture/verification-map.yml` 的 `feature_id: hub.servertool_stopless_cli_continuation` 也明确锁 `must project client-visible exec_command` 且 `must not call reenterPipeline`
- 已物理删除冲突的透明续轮旧合同文件：
  - `tests/servertool/stopless-sessionid-transparent.spec.ts`
  - `docs/goals/stopless-sessionid-transparent-plan.md`
  - `docs/goals/stopless-sessionid-transparent-goal-prompt.md`
- `scripts/verify-servertool-rust-only.mjs` 已补 gate：若上述 transparent 文件复活，直接 fail `stopless-no-reenter-contract`
- 2026-06-15 focused gates PASS：
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/stop-schema-lifecycle-contract.spec.ts tests/servertool/servertool-cli-projection.spec.ts tests/sharedmodule/native-required-exports-sse-stream.spec.ts --runInBand`
  - `cargo test -q -p servertool-core stopless --lib -- --nocapture`
  - `node scripts/verify-servertool-rust-only.mjs`
  - `npm run verify:function-map-compile-gate`
  - `git diff --check`
- 黑盒证据 PASS：
  - `node scripts/tests/stopless-followup-blackbox.mjs`
  - 结果：`upstreamHits=1`、`providers=["crs1"]`、`execCommand="routecodex hook run stop_message_auto --input-json '{\"flowId\":\"stop_message_flow\",\"maxRepeats\":3,\"repeatCount\":1}'"`
  - 证明当前 stopless 是 client-visible CLI 投影，且不会 server-side followup/reenter，也不会把 `continuationPrompt` / `stopreason` 泄漏进命令字符串。

## 2026-06-15 apply_patch SSE pending-delta done-frame closure

- 当前 live 指向的问题是：Responses SSE 在 `apply_patch` 工具调用的终结帧里，若上游只给 `call_id` 且 `arguments=""`、甚至省略 `name`，客户端会收到空工具调用，形成“apply_patch 空回复”。
- 唯一 owner 修复点：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - owner feature: `hub.response_responses_client_projection`
- 修复要点：
  - `response.output_item.added` 的 `apply_patch` function_call 现在不再透传给客户端；
  - `response.output_item.done` / `response.function_call_arguments.done` 若终结帧参数为空，则回退使用 `pending_apply_patch_argument_deltas[call_id]`；
  - `apply_patch` 判定不再只依赖 `name=apply_patch`，而是 `name==apply_patch || state.apply_patch_call_ids.contains(call_id)`，兼容 done 帧丢 `name`；
  - 终结后清理 `pending_apply_patch_argument_deltas` 与 `apply_patch_call_ids`，避免重复发射。
- 新增/覆盖红测：
  - `project_responses_sse_frame_for_client_uses_pending_apply_patch_delta_when_done_has_empty_arguments`
  - `project_responses_sse_frame_for_client_uses_pending_apply_patch_delta_when_done_omits_name`
- 2026-06-15 验证证据：
  - `cargo test -q -p router-hotpath-napi project_responses_sse_frame_for_client_uses_pending_apply_patch_delta_when_done_omits_name --lib -- --nocapture` PASS
  - `cargo test -q -p router-hotpath-napi project_responses_sse_frame_for_client_uses_pending_apply_patch_delta_when_done_has_empty_arguments --lib -- --nocapture` PASS
  - `cargo test -q -p router-hotpath-napi project_responses_sse_frame_for_client --lib -- --nocapture` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts --runInBand` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-apply-patch-freeform-contract.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` PASS
  - `routecodex --version` / `rcc --version` = `0.90.3068`
  - `curl -fsS http://127.0.0.1:{5555,5520,10000}/health` 全部 `status=ok ready=true pipelineReady=true version=0.90.3068`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5520/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS=180000 node scripts/tests/apply-patch-freeform-10000-online.mjs` PASS
    - `ok=true`
    - `customInputCount=4`
    - `functionArgumentPatchLeakCount=0`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5555/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS=180000 node scripts/tests/apply-patch-freeform-10000-online.mjs` PASS
    - `ok=true`
    - `customInputCount=4`
    - `functionArgumentPatchLeakCount=0`
  - `git diff --check` PASS

## 2026-06-14 stopless double-收口执行与清理

- 用户要求两步同时收口：(1) stopless 状态 key 严格走 `sessionId`（之前吃 `tmuxSessionId` / `conversationId` / `stopMessageClientInjectScope` fallback）；(2) stopless 对客户端无感（不再投影 `exec_command` / `stop_message_auto` / `routecodex servertool run`，模型只感知普通 user input）。

- 已物理删除的死代码（不允许以"不接入"代替删除）：
  - `servertool-core::cli_contract::StopMessageCliProjectionSeedInput` / `StopMessageCliProjectionSeed` / `plan_stop_message_cli_projection_seed` + 6 个相关 Rust tests
  - 6 个 stopless seed helper：`read_stop_message_followup_text` / `looks_like_stop_schema_guidance` / `read_stop_message_assistant_stop_text` / `read_stop_message_loop_number` / `read_js_nonnegative_u32` / `read_runtime_metadata_from_execution` / `read_assistant_stop_text_from_chat`（仅 `collect_text_from_content_parts` 保留，无引用方）
  - `servertool_core_blocks::plans_stop_message_cli_projection_seed_via_servertool_core_bridge`
  - `StoplessOrchestrationAction` 去掉 `'cli_projection'`，只留 `terminal_final` | `followup_mainline`
  - `native-servertool-core-semantics::planStopMessageCliProjectionSeedWithNative` + `StopMessageCliProjectionSeed*` TS interface
  - `native-router-hotpath-required-exports.{ts,js}::planStopMessageCliProjectionSeedJson`
  - `router-hotpath-napi::lib::plan_stop_message_cli_projection_seed_json`
  - `servertool/engine.ts::buildStopMessageCliProjectionResult` + `planStopMessageCliProjectionSeedWithNative` import + `if (stoplessPlan.action === 'cli_projection')` 分支
  - `tests/servertool/stop-message-auto.spec.ts`（旧 spec 全部按已删 CLI 投影写，物理删除并由新 spec 接管）
  - `scripts/verify-servertool-rust-only.mjs` 里的 `checkStopMessageCliProjectionSeedRustOwner` + `hub.servertool_stopless_cli_projection_seed` 注册 + 6 条 `planStopMessageCliProjectionSeed*` 断言 + `stop-visible-text-thin-shell` 里残留的 `planStopMessageCliProjectionSeedWithNative` 断言

- 新 spec 接管：`tests/servertool/stopless-sessionid-transparent.spec.ts`（5/5 PASS），覆盖：
  - `resolveStateKey` 严格 `session:sessionId` 或 `requestId`（无 sessionId）
  - stopless 走 `reenterPipeline`，最后一条 message 是普通 `user` role 文本
  - `result.chat`（client-visible） 不出现 `exec_command` / `stop_message_auto` / `routecodex servertool run`
  - 不同 `sessionId` 不串状态（`requestId` 不同 + `result.chat` 不同）
  - 嵌套 reenter 多轮都保持 transparent

- 关键决策：
  - `verification-map.yml` 的 `hub.servertool_stopless_cli_projection_seed` 改为 `hub.servertool_stopless_transparent_continuation`，notes 写透明续轮 + sessionId-only + focused gates
  - 旧 `hub.servertool_cli_projection`（generic CLI projection）保留不动，因为它仍服务 `servertool_fixture` 等 generic client-exec 路径
  - reenterPipeline 内部 body 是"发回普通 user input"（包含 stopless 引导文案）是合理的——那是发给 followup pipeline 的输入，**不是** client-visible；断言收口到 `result.chat` 才检查 projection token

- Gate 证据：
  - `cargo test -p servertool-core stopless --lib -- --nocapture` 29 PASS
  - `cargo test -p servertool-core persisted_lookup --lib -- --nocapture` 37 PASS
  - `cargo test -p router-hotpath-napi --lib` 编译干净
  - `verify:servertool-rust-only` ALL PASS
  - `verify:function-map-compile-gate` ALL PASS
  - `tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit` clean
  - `node --experimental-vm-modules jest tests/servertool/ --runInBand` 83/83 PASS
  - `git diff --check` clean

- 剩余未完成：build:min / install:global / restart / live `/v1/responses` probe 证明 stopless 真实链路上 client 端没有 `exec_command` / `stop_message_auto` / `routecodex servertool run` 暴露。需在 NODE 22 下做。

## 2026-06-14 latest codex apply_patch sample compatibility

- 最新真实失败样本锁定在 `~/.rcc/codex-samples/openai-responses/port-5555/openai-responses-router-gpt-5.4-20260614T175359964-343454-1032/provider-request.json`。
- 根因已确认：不是 `apply_patch` 工具缺失，也不是 `input`/`patch` alias、绝对路径、shell wrapper 这类旧兼容点；真正缺口是 GNU 行号 hunk header 带 inline context trailer（如 `@@ -94,6 +94,7 @@ mod shared_tool_mapping;`）在 Rust normalize 后仍残留为不可执行 header，最终命中 `apply_patch verification failed: Failed to find context ...`。
- 唯一 owner 修复点：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/apply_patch_live_context.rs`
  - 新增 `extract_unified_hunk_inline_context(...)`
  - 新增 `rebuild_line_number_hunk_to_apply_patch_context(...)`
  - 行为：当 live-context 重建拿不到完整上下文时，把 GNU 行号 hunk 重写成 canonical `@@`，并把 header trailer 提升为真实 context 行；只修形状，不猜语义。
- 红测/门禁：
  - Rust 定向红测：`test_validate_apply_patch_arguments_repairs_line_number_hunk_with_inline_context_trailer`
  - JS/native matrix：`sharedmodule/llmswitch-core/scripts/tests/apply-patch-native-regression-matrix.mjs` 新增真实样本等价 case，并更新旧 GNU hunk 预期为 canonical `@@`。
- 验证证据：
  - `cargo test -p router-hotpath-napi test_validate_apply_patch_arguments_repairs_line_number_hunk_with_inline_context_trailer --lib -- --nocapture` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node sharedmodule/llmswitch-core/scripts/tests/apply-patch-native-regression-matrix.mjs` PASS
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` PASS
  - 对真实样本直接跑 `validateApplyPatchArgumentsWithNative(...)`：
    - add-file patch `ok=true repaired=true`
    - 两个失败的 `Update File` patch 现在都被规整成 `@@` 形状，`ok=true repaired=true`，且不再保留 `@@ -94,6 +94,7 @@ ...` / `@@ -60,6 +60,7 @@ ...` 这类不可执行 header。
- 边界：当前证据证明“最新 codex sample 的补丁形状兼容”已修；尚未宣称整个 direct/relay apply_patch 闭环全部完成。

## 2026-06-14 apply_patch direct/relay full audit progress

## 2026-06-14 5520 direct apply_patch grammar + SSE projection closure

- 新增 live 失败样本不是 `apply_patch aborted` 本身，而是 direct apply_patch grammar 真源错误：
  - 23:04:28 / `openai-responses-router-gpt-5.4-20260614T230414428-345124-2702`
  - `router-direct.send` 直连 asxs.gpt-5.4 返回 `HTTP 400`
  - upstream 明确报错：`Invalid lark grammar ... unknown name: "begin_patch"`
- 结论：此前 request-side Rust owner 与 online smoke 都只发了一行截断 grammar：`start: begin_patch hunk+ end_patch`，缺失 `begin_patch/end_patch/hunk/...` 规则；这会在严格校验 grammar 的 direct Responses upstream 上直接失败。
- 唯一 owner 修复：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
  - `normalize_apply_patch_freeform_tool_schema(...)` 现在发完整 canonical Lark grammar，而不是截断的一行。
- 同步收敛的 gate/fixture：
  - `scripts/tests/apply-patch-freeform-10000-online.mjs`
  - `scripts/architecture/verify-apply-patch-freeform-contract.mjs`
  - `tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts`
  - `tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts`
  - Rust test fixtures in `hub_pipeline_types/tool_surface_contract.rs` / `hub_chat_envelope_validator.rs` / `hub_resp_outbound_client_semantics_tests.rs`
- 本轮 green 证据：
  - `cargo test -q -p router-hotpath-napi normalize_apply_patch_freeform_tool_schema --lib -- --nocapture` PASS
  - `cargo test -q -p router-hotpath-napi project_responses_sse_frame_for_client --lib -- --nocapture` PASS
  - `node scripts/architecture/verify-apply-patch-freeform-contract.mjs` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/native-exports.responses-sse-contract.spec.ts tests/sharedmodule/apply-patch-freeform-client-projection.blackbox.spec.ts tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts --runInBand` PASS
  - `node scripts/build-core.mjs` PASS
  - `git diff --check` PASS
- live 安装/重启/在线复测：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` PASS
  - `routecodex --version` / `rcc --version` = `0.90.3065`
  - `127.0.0.1:5555/5520/10000 /health` 全绿
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5520/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS=180000 node scripts/tests/apply-patch-freeform-10000-online.mjs` PASS
    - `ok=true`
    - `functionArgumentPatchLeakCount=0`
    - `input` 为原始 patch 文本
    - 证明 5520 direct 现在线上不会再被残缺 grammar 400 卡死，也不会把 apply_patch 回投成 JSON-wrapped function arguments。

- 当前配置真相（2026-06-14 实时读取）：
  - `~/.rcc/config.toml` 与 `/Volumes/extension/.rcc/config.toml` 中，`5520` 与 `5555` 均配置为 `sameProtocolBehavior = "direct"`。
  - 结论：`5555 是 relay` 不能当作当前静态真相，只能针对具体历史 live 样本按实际 route 判定。

- 5520/5555 direct/relay 判定边界（代码）：
  - `src/server/runtime/http-server/index.ts`
    - 若 `responsesResume.continuationOwner === 'relay'`，即使端口是 `sameProtocolBehavior=direct`，也会跳过 router-direct，进入 relay `executePipeline(...)`。
    - 其余 router-mode direct 先走 `executeRouterDirectPipelineForPort(...)`；仅当 `isRouterDirectRelayableSkip(reason)` 命中，才回到 relay。
  - `src/server/runtime/http-server/router-direct-pipeline.ts`
    - TS 壳只做同协议判定 + passthrough send，不做 payload 改写。
  - `src/server/runtime/http-server/direct-passthrough-payload.ts`
    - direct route decision 仅包一层 native `evaluateResponsesDirectRouteDecisionNative(...)`。

- direct 是否会被强制打回 relay（Rust 真源）：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
    - `requiresHubRelay=true` 的明确原因目前包括：
      - `servertool_followup_requires_hub_relay`
      - `stop_message` / followup metadata / CLI result
    - 另有 provider wire 显式拒绝：
      - `function_call_output` 含 `content` 时返回 `providerWireValid=false`，不会直接走 relay，而是 direct host contract fail-fast。
  - 结论：历史上 `5555` 某些样本之所以是 relay，必须证明命中了 `relay_owned_responses_continuation` 或 `requiresHubRelay`，不能只看端口号。

- apply_patch 当前 owner 真相（代码）：
  - 请求侧工具声明治理 owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
    - `normalize_apply_patch_freeform_tool_schema(...)` 当前会把 `apply_patch` 统一改成 `type=custom + format=grammar(lark)` freeform 工具。
  - 请求侧历史/存储/去重 owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
    - `normalize_tool_parameters(...)` 对 `apply_patch` 直接保留 raw value；
    - `normalize_tool_output_text_for_storage(...)` 先去 transcript wrapper；
    - `canonicalize_tool_output_text_for_compare(...)` 对 `apply_patch` 再走 `normalize_apply_patch_output_text(...)`。
  - 响应侧客户端投影 owner：
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
    - 负责把 `apply_patch` 参数按客户端 spec/freeform 重新投影；当前存在 `normalize_apply_patch_freeform_input_for_client(...)` 与 function_call -> custom_tool_call 映射逻辑。
  - relay continuation/store owner：
    - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`

- live 错误样本映射（已有证据）：
  - 5520 direct 历史样本：
    - `~/.rcc/logs/server-5520.log`
    - 多处 `route=router-direct:*` 同时失败 `orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id`
    - 证明：5520 的问题不要求 relay 才会出现，direct 入口照样会在请求侧/上下文侧失败。
  - 5555 relay/非 direct 历史样本：
    - 用户给出的 2026-06-13/14 样本中出现 `search/gateway-priority-5555-priority-search -> minimax...`、`tools/gateway-priority-5555-priority-tools -> minimax...`
    - 且错误为 `invalid params, tool call result does not follow tool call (2013)` / `orphan_tool_result`
    - 现阶段结论：这是 Anthropic/MiniMax chat 历史投影与 tool_result 顺序问题，owner 更偏向 relay request-side history projection，而不是 direct passthrough body rewrite。

- 当前 gate / test 缺口（本轮实际执行证据）：
  - PASS：
    - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node sharedmodule/llmswitch-core/scripts/tests/apply-patch-freeform-tool-schema-passthrough.mjs`
  - 先前“Jest/ESM infra gap”结论需要修正：
    - 正确 runner 是 `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest ... --runInBand`
    - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`：在正确 runner 下 PASS（4/4）
    - `tests/sharedmodule/responses-continuation-store.spec.ts`：在正确 runner 下可执行，但有 1 条真实红测
      - 失败样本：`fails fast when direct and relay continuations coexist under one scope without explicit owner`
      - 现状：`materializeLatestResponsesContinuationByScope(...)` 返回了 relay continuation，不是 `null`
      - 结论：这不是 infra gap，而是 continuation owner 隔离的真实功能缺口
    - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`：在正确 runner 下可执行，但当前有 5 条真实失败，不是 runner 问题
      - `provider-mode chat direct does not synthesize stream=true when stream_options is present`
      - `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`
      - `router same-protocol direct relays stop_message followup through Hub before direct send`
      - `router-direct switches provider request-locally on recoverable 429 without entering relay`
      - `router-direct switches to alternative provider immediately for recoverable 502 when VR has another target`
  - 新结论：当前 audit 不能把 direct/continuation 关键 gate 统称为“Jest/ESM 挡住”。至少 `responses-continuation-store` 与 `direct-passthrough-route-level` 已经是可跑且真实为红。

- 5555 样本的 direct / relay / owner 进一步收敛（新增证据）：
  - `openai-responses-router-gpt-5.4-20260613T231359101-341020-806`
    - 日志：`~/.rcc/logs/server-5520.log` 中只有 `[virtual-router-hit]` 后直接失败，未出现 `[router-direct.send]`
    - diag：`message=orphan_tool_result...`，`code=hub_pipeline_context_capture_failed`
    - stack 直接落在：
      - `sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/hub-pipeline-execute-request-stage.js`
      - `sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/hub-pipeline.js`
    - 结论：这是 request-side Rust owner / Hub request stage 失败，不是 provider send，不是 direct passthrough body rewrite。
  - `openai-responses-router-gpt-5.4-20260614T111633597-342304-2090`
    - 日志：`~/.rcc/logs/server-5520.log` 明确出现 `[router-direct.send][openai-responses-router-gpt-5.4-20260614T111633597-342304-2090] error`
    - diag：`HTTP 400: No tool call found for function call output with call_id ...`
    - requestBody 形状只有：
      - `function_call_output`
      - 后接一条 `user: 继续`
    - 结论：这是 5555 direct 样本；失败点是裸 `function_call_output` 进入 direct upstream contract，不是 relay。
  - `openai-responses-router-gpt-5.4-20260613T223253714-340912-698`
    - diag `details.requestContext.providerProtocol = anthropic-messages`
    - provider=`minimax.key1.MiniMax-M3`，route=`tools`
    - request-side `responsesRequestContext.context.input` 形状统计：
      - `message=13`
      - `reasoning=4`
      - `function_call=14`
      - `function_call_output=14`
    - 结论：这是 Responses 历史投影后送往 Anthropic/MiniMax 的复杂 tool history 样本；2013 错误 owner 仍应优先锁到 relay/request-side history projection，而不是 5520/5555 端口静态语义。
  - `openai-responses-router-gpt-5.4-20260614T001441281-341104-890`
    - 与上条同类：`providerProtocol = anthropic-messages`，provider=`minimax.key1.MiniMax-M3`，route=`search`
    - 错误：`invalid params, tool call result does not follow tool call (2013)`
    - 结论：同类 owner，属于 Anthropic/MiniMax chat 历史 tool_result 顺序问题。

- 当前样本 -> owner -> 风险 分类（阶段性）：
  - 5555 / `231359101` / `orphan_tool_result`
    - owner 优先级：`responses-request-bridge.ts` -> Rust `hub_pipeline_blocks/responses_context.rs` -> Rust `hub_bridge_actions/bridge_input.rs`
    - 风险类型：request-side history / continuation materialize / orphan tool result contract
  - 5555 / `111633597` / `No tool call found for function call output`
    - owner 优先级：direct path input contract + upstream provider wire contract
    - 风险类型：direct request payload contract
  - 5555 / `223253714` / `001441281` / `2013 tool call result does not follow tool call`
    - owner 优先级：Responses -> Anthropic/MiniMax request-side history projection
    - 代码焦点：
      - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bridge_input.rs`
      - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/history.rs`
      - `src/modules/llmswitch/bridge/responses-request-bridge.ts`
    - 风险类型：tool call / tool result 顺序与聚合语义不符合 Anthropic/MiniMax

- 下一步修复顺序（按 owner / 风险排序）：
  1. shared Rust owner：先修 continuation owner 冲突
     - 证据：`tests/sharedmodule/responses-continuation-store.spec.ts` 真红
     - 目标：同一 scope 下 direct + relay 共存时，未显式指定 owner 必须 fail-fast，不得偷选 relay
     - owner：`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` 对应的 native/shared continuation owner 逻辑
  2. relay / request-side history owner：再修 `2013` 与 `orphan_tool_result`
     - 证据：
       - `231359101` 直接死在 `hub_pipeline_context_capture_failed`
       - `223253714` / `001441281` 被投影成 `anthropic-messages` 后触发 `tool call result does not follow tool call (2013)`
     - owner 优先级：
       - Rust `hub_bridge_actions/bridge_input.rs`
       - Rust `hub_bridge_actions/history.rs`
       - Rust `hub_pipeline_blocks/responses_context.rs`
       - TS 薄壳 `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  3. direct owner：最后修 direct input contract
     - 证据：`111633597` 明确出现 `[router-direct.send]`，且输入只有裸 `function_call_output`
     - 目标：direct 不做 repair，但必须把“非法 direct continuation/tool output 形状”在唯一 owner 处 fail-fast 并清晰投影，不能混成 relay/history 问题
     - owner：direct request contract / upstream request builder
  4. direct gate 收口
     - 证据：`tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 当前 5 红
     - 目标：把 direct 的透明性、stop_message followup、429/502 切候选行为锁回 gate

- continuation store 结论再锁一遍：
  - `continuationOwner=direct` -> 远程 owned continuation；只允许 same-protocol direct 续接；本地不做 store / materialize。
  - `continuationOwner=relay` -> 本地 store / materialize；只走 relay 恢复键。
  - 这条边界和当前 `responses-continuation-store.spec.ts` 的 direct-owned / relay-owned 设计一致；后续 audit 只按这个 owner 键判定，不再用端口名猜链路。

- 现有测试覆盖面审计（只读）：
  - `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`
    - 已覆盖：
      - 成对 `function_call x2 + function_call_output x2`
      - plain-text tool result 中提到 `image_url` / `video_url` 仍保持纯文本
      - paired `custom_tool_call_output`
    - 样本行为：
      - 通过 `findDanglingAnthropicToolUse(...)` 人工模拟 MiniMax/Anthropic 的 `2013 invalid params, tool call result does not follow tool call`
    - 未直接覆盖：
      - “assistant text + function_call xN + function_call_output xN + 后续再继续新的 assistant/tool turn” 这种更长的交错历史
      - direct/relay continuation owner 隔离
  - `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
    - 已覆盖 relay request-context 在 native capture 后：
      - 去重重复 tool batch
      - 相同 call 只保留最新 output
      - orphan_tool_result 时不回退 raw input
    - 未覆盖：
      - 真实 `submit_tool_outputs` / `scope_materialize` 贯穿到 provider payload 的整链
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
    - 设计上已覆盖 direct providerKey pin、direct-owned scope 不本地 restore、重复 pending batch collapse
    - 但当前受 Jest/ESM infra 挡住，未形成稳定可跑 gate
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
    - 已设计覆盖：
      - apply_patch 保持 freeform grammar tool
      - legacy servertool metadata 不应污染 apply_patch
      - server-side tool engine 不应本地执行 apply_patch
    - 但当前同样被 Jest/ESM infra 挡住

## 2026-06-14 apply_patch JSON 包装来源审计

- 当前截图里的 `apply_patch 必须 FREEFORM，不走 JSON 包装` 不是 5520/5555 server 生成，也不是上游 provider 响应文本；证据在 `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl`：
  - 先出现 assistant commentary 明确说“必须 FREEFORM”；
  - 紧接着同一 turn 的 `response_item.function_call name=apply_patch` 仍是 `arguments="{\"patch\":\"*** Begin Patch...\"}"`。
- 当前本地 `rtk` 插件只注入 `SessionStart` 标记 `[rtk-hook] SessionStart loaded; rtk PreToolUse active`，并仅匹配 `Bash|shell_command|exec_command`；它不匹配 `apply_patch`，不是 JSON 包装 owner。
- 唯一 owner 已锁到 Rust 请求侧工具治理：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
  - `normalize_apply_patch_freeform_tool_schema(...)` 会把 `apply_patch` 工具声明改写成 `parameters={ type: object, properties.patch: string, required:[patch] }`。
  - 这会直接把“freeform patch”暴露成“JSON object with patch string”，从而引导模型产出 `{"patch": ...}`。
- 响应侧 Rust 只是做客户端投影修正，不是请求包装来源：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - `normalize_apply_patch_freeform_input_for_client(...)` 会把 `{"patch":"..."}` 解开成原始 patch 文本；
  - 说明当前架构是“请求侧包成 JSON，响应侧再解开”，这与 `tool.apply_patch_freeform_contract` 的 freeform-only 规则冲突。

## 2026-06-14 5520 apply_patch aborted direct-vs-relay correction

- 需要把 “5520 上看到 apply_patch aborted” 和 “5520 direct 路径坏了” 分开。
- 已核实的 2026-06-14 20:55-20:57 +08:00 新样本：
  - `~/.rcc/codex-samples/openai-responses/ports/5520/minimax.key1.MiniMax-M3/req_1781441728506_e948897d`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/minimax.key1.MiniMax-M3/req_1781441741200_ba047af9`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/minimax.key1.MiniMax-M3/req_1781441825210_7f36944d`
- 这些样本的 `provider-request.json.body` 已确认是 Anthropic wire：
  - `url=https://api.minimaxi.com/anthropic/v1/messages`
  - `body.messages/system/tools/tool_choice`
  - `provider-response.json.body.mode = sse`
- 结论：上述 20:55 段样本不是 same-protocol OpenAI direct，而是 5520 入口下的 relay/transcoded provider path。不能把这组 aborted/工具异常直接当成 “5520 direct apply_patch 已坏” 的证据。
- 已核实的 5520 OpenAI direct 样本在 2026-06-14 10:52-11:52 +08:00：
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781405546109_99fb3fcc`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781408883004_23791382`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781409015880_a59f545d`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781409172431_8eef7ea9`
- 这些 direct 样本里：
  - `provider-request.json.body.tools[]` 对 `apply_patch` 已是 `type=custom + format={type=grammar,syntax=lark}`
  - 描述明确写着 `FREEFORM tool, do not wrap the patch in JSON`
  - `provider-response.json.body.mode = sse_passthrough`
- 结论：当前已验证的 5520 direct 请求面没有把 `apply_patch` 再降回 object schema；也没有证据证明 server 在 direct response path 把它投影成空参数。
- 仍存在的未闭环点：
  - `~/.codex/sessions/2026/06/14/rollout-2026-06-14T15-20-20-019ec500-bd15-7dd0-adc1-e9ecf7cd073a.jsonl` 里确实能看到客户端事件 `response_item.function_call name=apply_patch arguments=""` 与多次 `aborted`
  - 但这条客户端事件尚未被精确反向映射到一个“已证实是 5520 direct”的 requestId，因此目前不能把锅直接扣到 direct server path
  - 下一步要继续锁：同一 aborted turn 对应的 requestId / providerKey / path truth（direct 还是 relay）以及客户端工具 runtime 返回的原始结果

## 2026-06-14 apply_patch request-side JSON-wrap audit correction

- 之前 audit 里有一条结论需要撤回：**当前代码下**，请求侧 Rust owner 并没有把 `apply_patch` 再宣告成 `parameters={patch:string}` 的 object schema。
- 现行代码证据：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
  - `normalize_apply_patch_freeform_tool_schema(...)`
  - 当前真实输出是：
    - `type = "custom"`
    - `name = "apply_patch"`
    - `format = { type = "grammar", syntax = "lark", definition = "start: begin_patch hunk+ end_patch" }`
- 现行样本证据（5520 OpenAI direct）：
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781408883004_23791382/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781409015880_a59f545d/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/ports/5520/1token.key1.gpt-5.4/req_1781409172431_8eef7ea9/provider-request.json`
  - 这些样本里 `body.tools[]` 的 `apply_patch` 均已是 freeform grammar tool，描述也明确写 `FREEFORM tool, do not wrap the patch in JSON`
- 结论：
  - “当前 server/request-side owner 仍把 apply_patch 包成 JSON schema，从而引导模型产出 `{\"patch\": ...}`” 这条结论对当前 worktree **不成立**
  - 客户端 session 中出现的 `response_item.function_call name=apply_patch arguments=""` / `{"patch": ...}` 现象，还需要继续向下锁到：
    1. response/SSE 投影是否把 upstream `function_call.arguments` 空化；
    2. 客户端 tool runtime / hook 是否在本地 abort 后重写显示；
    3. 该 turn 对应的真实 requestId/path truth 是否其实不是 5520 direct

## 2026-06-14 direct passthrough gate truth

- 真实 gate 结果（Node 22 + vm modules）：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts --runInBand`
  - 结果：18 条里 13 绿，5 红；不是 infra 假红。
- 当前 5 个真红：
  1. `provider-mode chat direct does not synthesize stream=true when stream_options is present`
  2. `router same-protocol direct does not enter HubPipeline and keeps ingress payload transparent`
  3. `router same-protocol direct relays stop_message followup through Hub before direct send`
  4. `router-direct switches provider request-locally on recoverable 429 without entering relay`
  5. `router-direct switches to alternative provider immediately for recoverable 502 when VR has another target`
- 关键含义：
  - direct owner 的 gate 缺口是真实存在的，不能再归类为 Jest/ESM 问题；
  - 其中第 2 条直接说明 current direct payload transparency contract 被破坏，属于 `5520 direct` 审计必须保留的核心风险；
  - 第 4/5 条说明 direct candidate switching / local reroute 语义也未被现状锁住，后续修复顺序里必须单列 direct owner，而不是只盯 relay/history。

## 2026-06-14 build/install/restart evidence 0.90.3064 (function-map unblock pass)

- 本轮全局安装前的唯一阻塞已确认并修复：`verify:function-map-compile-gate` 因新增 feature `virtual_router.primary_exhausted_to_default_pool` 的 function-map owner/allowed_paths 定义不满足 owner gate 失败。
- 修复点只在文档 gate：
  - `docs/architecture/function-map.yml`
  - `docs/architecture/verification-map.yml`
- gate 复核通过：`PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate` 全绿，active features=65。
- 安装命令通过：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`
- 安装结果：
  - `routecodex --version` = `0.90.3064`
  - `rcc --version` = `0.90.3064`
  - managed restart 成功：`5555`
- 健康检查通过：
  - `127.0.0.1:5555/health` -> `status=ok ready=true pipelineReady=true version=0.90.3064`
  - `127.0.0.1:5520/health` -> `status=ok ready=true pipelineReady=true version=0.90.3064`
  - `127.0.0.1:10000/health` -> `status=ok ready=true pipelineReady=true version=0.90.3064`
- live `/v1/responses` 探针通过：
  - `5555` 返回 `HTTP=200`，`status=completed`，输出 `RCC_INSTALL_5555_OK`
  - `5520` 返回 `HTTP=200`，`status=completed`，输出 `RCC_INSTALL_5520_OK`
- 边界：本轮只证明 build/install/restart 与基础 Responses probe 正常；未在本条证据里宣称复杂 tool/reopen/apply_patch 链路已闭环。

## 2026-06-14 direct path 候选优先 + client_disconnect SSOT 校正锁盘

- 用户给定的 6 条 SSOT 校正要点（已锁入 `docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md` §0.5）：
  1. 唯一策略中心不变：VR policy + ProviderFailurePolicy + request-executor error action queue。
  2. direct path：payload/response passthrough 保留；error passthrough 删除。
  3. 候选优先：recoverable/unrecoverable/periodic_recovery 必须先回统一策略；候选耗尽才允许 ErrorErr06ClientProjected。
  4. secondary/default pool 扩池只能由 VR 显式建模；host/http-server/RequestExecutor 禁止本地 fallback。
  5. client_disconnect（含 upstream HTTP_499 + client abort request）必须在 error.provider_failure_policy 阶段前移识别；affectsHealth=false、不计 cooldown、不投影 provider 4xx。
  6. ErrorErr06ClientProjected 增加 policy exhausted / candidate exhausted 前置门。
- F1–F10 owner 表已锁入 plan §0.6：F1/F2 = `provider-failure-policy-impl.ts`；F4/F5 = `http-server/index.ts::router-direct / provider-direct`；F6 = `http-error-mapper.ts`；F8 仅在 Jason 决定支持 default pool 扩池时才动 VR。
- /goal 提示词（`docs/goals/direct-path-error-reroute-and-candidate-exhaustion-goal-prompt.md`）已重写为 Jason 原文"直接复制可用"版本。
- 偏差真相（不进入 MEMORY.md，只在本 note 与 plan §0.2）：
  - D1 `provider-direct-pipeline.candidate-exhaustion.spec.ts` 不存在；
  - D2 `index.ts:1752-1767` 仍保留 `suppressRouterDirectRetry` early-return 守卫；
  - D3 live replay 证据口径是"客户端收不到任何 499 / client abort request 错误体"，不是"收到 499"。
- 已知进展：4 个候选 spec 已 PASS（`pnpm exec jest` 16/0）；`tsc --noEmit` PASS；`verification-map.yml` 3 个 feature 的 `integration` 段已同步新 spec。
- 下一会话第一动作：执行 `/goal` 中"红测先红后绿"——D1 补 spec、D2 拆 guard、D3 重写 live 证据口径。

## 2026-06-14 responses req_inbound duplicated tool batch live sample
- 用户给的 5520 live 样本 `error-openai-responses-router-gpt-5.4-20260614T133516867-342765-343.json` 表面是 `native captureReqInboundResponsesContextSnapshotJson unavailable`，但真根因不是 native 导出缺失；离线重放确认内层错误是 `orphan_tool_result: ... unknown or already-consumed call_id`.
- 真实形状：同一个 `write_stdin` tool batch 被重复两次，`function_call` x4 + 同 call_id 再次 `function_call` x4，随后两批 `function_call_output`；第二批 output 文本与第一批不同，因此旧 req_inbound normalize 只去重 identical duplicate calls，却保留 distinct duplicate outputs，最终在 capture -> bridge_input_to_chat 阶段被判成 already-consumed call_id。
- 唯一 owner 修复点：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`。规则改为：仅当 identical duplicate `function_call` 已被去重时，同 call_id 的后续多个 `function_call_output` 收敛成最后一条；普通“单个 function_call + 多个不同 outputs”仍保持原行为。
- 验证证据：Rust owner tests green（新加 `normalize_responses_input_items_collapses_distinct_outputs_when_identical_call_batch_repeats`，旧负向 `keeps_distinct_duplicate_function_call_outputs` 仍绿）；`node scripts/build-core.mjs` 通过；同一旧样本离线 `captureResponsesContext(...)` 从报错转为成功，`inputLen 520 -> 448`；全局安装/重启后同一样本在线重放 `5520 /v1/responses` 返回 `200`，SSE `response.completed=1`、`response.done=1`、`event:error=0`。

## 2026-06-14 2+ 候选 5xx 切候选 live probe 边界

- 真实配置 (`~/.rcc/config.toml`) 显示 5520 / 5555 的每个 route 都只指向单一 forwarder（`fwd.paid.gpt-5.4-mini` / `fwd.paid.gpt-5.4`），forwarder 内部有 3 个真实 provider (asxs > 1token > cc)。
- `decideDirectRouterRetry` 的 `pool` 取自 `routingDecision.routePool`，目前携带的是 forwarder 级（不是 provider 级）。
- 因此"2+ 候选 + 1 provider 5xx 必须切到候选 2"在当前真实配置下不会以 router-direct 形式表达：`onProviderError` 看到的是同一 forwarder 内的 provider 错误，会走 retry_same_provider_once / exclude_and_reroute，但排除对象仍然是 forwarder 内部 target，不是 route 级的另一 forwarder。
- 真实运行日志里 `gateway_priority_5520` 14:58 之前确实存在大量 `router-direct.send status=502 -> provider-switch switch=exclude_and_reroute -> sdfv` 记录（参考 813308/813309/813310 等行号），证明 forwarder 内部 target 切候选一直工作正常；本轮 14:56 install 之后日志尚未观察到新切候选。
- 结论：本轮 plan 的"2+ 候选 5xx 切候选 live probe"已经以"forwarder 内部 target 切候选"形态在同时间窗内被反复验证，证据在 5520 日志；不要为了"对外 2+ 候选 forwarder"硬造 live probe——那是 P4 (default-pool 扩池) 的设计问题，不是本次 plan 范围。
- P4 选项保留为"A: VR 显式建模 primary_exhausted -> default_pool；B: 维持现状，primary exhausted 即 fail"由 Jason 拍板。

## 2026-06-14 2+ 候选 5xx 切候选 live 证据（本轮 14:56 install 之后）

- 5520 长上下文 `route=longcontext` → forwarder `fwd.paid.gpt-5.4`（asxs > 1token > cc）：
  - 14:58:34 `req=openai-responses-router-gpt-5.4-20260614T145834598-343106-684`
    - `directAttempt=1` provider=`asxs.crsa.gpt-5.4` `UPSTREAM_HEADERS_TIMEOUT`
    - `directAttempt=2` provider=`1token.key1.gpt-5.4` `429 PROVIDER_TRAFFIC_SATURATED`
    - 即同一 forwarder 内第一候选失败 → 切第二候选；切候选由本轮新增 `decideDirectRouterRetry` 驱动。
  - 15:14:42 `req=openai-responses-router-gpt-5.4-20260614T151442408-343217-795`
    - `directAttempt=1` provider=`asxs.crsa.gpt-5.4` `503 HTTP_503`
    - `[provider-switch] attempt=1/6 -> 2/6 provider=asxs.crsa.gpt-5.4 switch=exclude_and_reroute decision=provider_backoff_then_reroute policy=existing_exclusion backoffScope=provider stage=provider.send status=503 code=HTTP_503 backoff=0ms`
    - 即同 forwarder 内 `asxs` 仍被 `existing_exclusion` 锁定，decision 走 `provider_backoff_then_reroute` 跳过 asxs 进入下一候选。
- 5555 同样 forwarder 在 15:07 命中 `minimax.key1.MiniMax-M3` 完成请求（`openai-responses-router-gpt-5.4-20260614T150711393-343152-730`），证明长上下文 forwarder 当前在第二/第三候选上工作正常。
- 结论：本轮 install 之后 5520 longcontext 至少观察到 1 次 504→切 1token + 1 次 503→exclude_and_reroute，2+ 候选切候选行为由本轮新代码驱动并真实生效。P4 (default-pool 扩池) 仍保留为"primary exhausted -> default pool"是否在 VR 显式建模的设计点，由 Jason 拍板。

## 2026-06-14 note.md consolidation index
- Rule: same-topic entries use latest-wins. Older raw notes stay below as evidence, but current truth follows the newest verified timestamp for each theme.
- Responses continuation / direct / bridge: latest winner is 2026-06-13 request/response bridge closeout + continuation isolation correction/implementation. Earlier 2026-06-12 direct continuation/store root-cause notes are retained as evidence but superseded for current owner/gate truth.
- Function map / owner / gate: latest winner is 2026-06-13 function-map owner schema baseline landed + function-map audit check. Current baseline is 62 mapped features with explicit `owner_kind`/`owner_scope`; remaining gap is hidden-owner scan and warning cleanup, not schema absence.
- `~/.rcc` / provider config: latest winner is 2026-06-12 DF direct probe closed + XL runtime config truth corrected. Runtime/provider truth must be read from `~/.rcc/config.toml`, `~/.rcc/config.<provider>.toml`, and `~/.rcc/provider/<id>/config.v2.toml`, not repo `config/`.
- Servertool / stopless: latest winner is 2026-06-13 stopless schema closed-loop + live proof notes. Older “missing guidance / missing schema” hypotheses are superseded unless tied to a specific historical sample.
- Request-shape / apply_patch / replay workflow: latest winner is 2026-06-13 real-sample red-test + workflow closeout. Rule is now red test first, then green, then replay old real sample online.
- Build / install / restart / health: latest runtime evidence belongs to 2026-06-13 `0.90.3064` install/health/live checks. Earlier 0.90.305x install notes remain historical only.
- 2026-06-14 audit caveat: `verify:architecture-feature-map-growth-discipline` is currently RED with `server.responses_sse_bridge_surface: source anchor exists but function-map/verification-map entry missing` in `src/modules/llmswitch/bridge/responses-sse-bridge.ts`. This file is untracked and was added by an unrelated worker; the skill-routing task deliberately did not touch it. Treat the RED as out-of-scope evidence for this pass, not as a regression from the skill-routing work itself.
- 2026-06-14 continuation single-session failure audit: latest winner is the request-side scope-materialize duplication finding below. One session can fail while others continue because only that session's stored continuation history is polluted; current winner fix is in Rust `shared_responses_conversation_utils.rs` materialize owner, not provider/SSE base path.
- Promoted durable facts:
  - owner/gate triad + current owner-kind counts → `MEMORY.md` 2026-06-14 owner registry section
  - `~/.rcc` path/config truth → `MEMORY.md` 2026-06-14 rcc config section
  - note→MEMORY→skill routing rule → `MEMORY.md` 2026-06-14 note/memory/skill section

2026-06-14 audit caveat (recheck, same skill-routing pass): 当其它 worker 完成 `server.responses_sse_bridge_surface` 在 function-map / verification-map 的登记后，本任务最后一次 recheck 把 `verify:architecture-feature-map-growth-discipline` 跑回 GREEN（`ok - checked source feature anchors: 62`），`verify:function-map-compile-gate` 13/13 子 gate 全部 `ok`，active features 由 62 升到 63。`git diff --check` 干净。本次 skill-routing 任务的 verification matrix 全部 PASS，无 RED 残留。

2026-06-14 5520 native snapshot export false alarm audit
- User sample showed repeated 5520 `/v1/responses` failures: `[virtual-router-native-hotpath] native captureReqInboundResponsesContextSnapshotJson is required but unavailable`.
- Verified current installed truth has both layers needed:
  - packaged native binding exports `captureReqInboundResponsesContextSnapshotJson`;
  - packaged shared responses semantics barrel exports `captureReqInboundResponsesContextSnapshotWithNative`.
- Added gate in `tests/sharedmodule/native-required-exports-sse-stream.spec.ts` to assert the packaged `native-shared-conversion-semantics-responses.js` barrel still exports `captureReqInboundResponsesContextSnapshotWithNative`, so install-time barrel omissions fail in test instead of surfacing at live runtime.
- Live control probe on `127.0.0.1:5520/v1/responses` succeeded after verification: SSE emitted `RCC_5520_CAPTURE_OK`, `response.completed`, and `response.done`; no `captureReqInboundResponsesContextSnapshotJson` / `native shared bindings missing` error appeared in the probe output.
- Current judgment: the 12:17-12:20 error burst belongs to a pre-fix runtime/install state; current `0.90.3064` runtime no longer reproduces that failure class on fresh 5520 probes.

2026-06-14 responses reasoning history pollution root cause
- Root cause confirmed: pollution is not created by continuation `restore/materialize`; it is created earlier on the response-store write path:
  `response -> recordResponsesResponseForRequest(...) -> convertOutputToInputItems(response) -> entry.input`.
- For non-Responses upstream protocols projected back into Responses client output, reasoning remained client-visible as a legal `output[type=reasoning]` item, but the store layer then persisted that reasoning back into `entry.input`, allowing it to reappear on the next request as provider-wire-illegal history.
- Unique owner fixed in this pass: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - `convert_responses_output_to_input_items(...)` now drops `output[type=reasoning]` items from persisted history entirely instead of converting them into stored assistant history with `reasoning` / `reasoning_content`.
- Verified by targeted Rust tests:
  - `cargo test -p router-hotpath-napi drops_reasoning_output_item --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi drops_encrypted_only_reasoning_output_item_from_persisted_history --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi converts_required_action_tool_calls_to_pending_function_call_items --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi preserves_command_only_exec_command_when_converting_output_items --lib -- --nocapture`
  - `node scripts/build-core.mjs`
- Temporary validation-only unblocker: fixed unrelated borrow checker failure in `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs` so current Rust gates could compile. This was not the business fix owner.
- Remaining gap before claiming full closure: live replay of the exact 5555 historical sample that produced `Invalid 'input[119].content': array too long` has not been rerun yet after rebuild/install.

2026-06-14 responses continuation single-session failure
- User symptom: some sessions on `/v1/responses` continue normally, but one session's “续杯/继续” fails while others on the same ports/providers still succeed.
- Verified not a global provider outage: same time window had successful first-round responses; failure concentrated on continuation/materialize path only.
- Real failed diag `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260614T095427432-342020-1806.json` facts:
  - `requestBody` already has no `previous_response_id` / `response_id`, `store=false`, `stream=true`, `inputLen=151`;
  - duplicated tail block confirmed inside `input`: identical `function_call` call_ids at 134-137 and 138-141, then same `function_call_output` call_ids repeated at 142-145 and 146-149, followed by `message user: 继续`.
- Meaning: this sample is already the post-materialize polluted payload, so direct replay of that JSON still fails `captureReqInboundResponsesContextSnapshotWithNative(...)` with `orphan_tool_result`; replaying the already-corrupted payload bypasses the materialize owner and therefore is not proof against the fix.
- Unique owner repaired: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - materialize path now first strips leading replay of pending function calls in the suffix-overlap branch;
  - then collapses duplicated leading pending tool batches by `call_id`, so repeated `function_call`/`function_call_output` blocks do not get appended twice into full input.
- New red/green gate:
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
  - case name: `RED: materialize must collapse duplicated pending call batches when incoming delta repeats the same call_ids twice`
- Verified green after native rebuild:
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/sharedmodule/responses-continuation-store.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts --runInBand`
- Important boundary: the archived bad diag payload itself still fails native capture when replayed directly, which is expected because it is the already-poisoned post-materialize body. Live verification for the real fix must use a fresh continuation request path after rebuild/install, not raw replay of that corrupted `requestBody`.

2026-06-12 CLI multi-port host resolution
- 结论：`status --port <n>` / `restart --port <n>` 不能只沿用顶层 `httpserver.host`；多端口配置时必须按目标端口读对应 `[[httpserver.ports]]` 的 host，否则会把 10000 这类端口的健康探测和 restart 误导到 loopback。
- 证据：`tests/cli/status-command.spec.ts` 与 `tests/cli/restart-command.spec.ts` 新增定向回归已绿，覆盖 explicit `--port 10000` 不再 probe `127.0.0.1:10000`。
- 可复用动作：CLI 端口相关动作先解出 target port 的实际 host，再做健康探测/重启；不要把顶层 host 当所有端口的默认真源。

2026-06-12 stopless goal-state audit
- Current state: TS bridge state-integrations.ts still contains stopless sync/read/persist logic and native calls; stopless-goal-state.ts is not the only owner.
- Risk: worktree has many unrelated modified files from other work; must avoid broad edits.
- Next focus: create red tests that lock current mismatch / TS bridge dependency / persisted 503-reprobe residue, then repair only the unique owner path.
- Evidence to verify: sync/read/persist call chain, router-hotpath-napi bridge exports, health/selection/status behavior, and live/sample replay if possible.
2026-06-12 stopless bridge + persisted 503 closeout progress
- stopless focused Jest green: stopless-goal-state, state-integrations-stopless-goal.red, provider-startup-health-red.
- Rust health suite green: cargo test -p router-hotpath-napi --lib virtual_router_engine::health -- --nocapture.
- Selection residue identified: obsolete persisted reprobe test in selection.rs removed physically; re-running selection + required TS focused suites.

2026-06-12 CLI 10000 probe-host bug
- Root cause confirmed: `status --port 10000` and `restart --port 10000` could inherit top-level `httpserver.host=127.0.0.1` instead of the target `[[httpserver.ports]] host=0.0.0.0`, so CLI health probes could hit loopback and misidentify another local service as RouteCodex.
- Unique owner fixed: `src/cli/commands/port-group-resolver.ts` now resolves per-target host for multi-port configs; `src/cli/commands/status.ts` now uses that same per-port host resolution when `--port` is provided.
- Red tests added: `tests/cli/status-command.spec.ts` and `tests/cli/restart-command.spec.ts` now lock that `10000` explicit-target probes must not reuse top-level loopback host.
2026-06-12 provider-response hot-path log repair
- Audit blocker: provider-response slice tests were green, but unguarded console.log diagnostics remained in response conversion hot paths.
- Unique repair point: remove those diagnostics and their dedicated shape helper from provider-response/provider-response-converter; no response semantics changed.

2026-06-12 DF alias/canonical model audit
- Root cause confirmed in Rust VR bootstrap owner: `provider_bootstrap.rs` mixed declared `provider.models.<modelId>` and `aliases` into one `modelIndex.models`, while `routing/bootstrap.rs` and `build_provider_profiles()` treated route target third segment as final `model_id`. Result: client alias could leak into `targetRuntime.modelId` and upstream request `body.model`.
- Repair direction implemented in Rust owner only: split `ModelIndexEntry` semantics into canonical `models` plus `alias_to_model`; routing may accept alias input but must expand to canonical target key; provider profile/target runtime `modelId` must always be canonical provider model id.
- Verification in progress: focused Rust tests for `virtual_router_engine::provider_bootstrap` and `virtual_router_engine::routing::bootstrap`, then Node/tsc/install/restart/live 10000 replay with DF uppercase wire model + lowercase client alias config.
2026-06-12 executor 429 cross-pool reroute audit
- User-reported live failure: 5520 still surfaces upstream HTTP_429 to client before falling through layered route pools; expected behavior is keep rerouting until default pool is actually exhausted.
- Root cause narrowed to ErrorErr05 execution decision input, not provider runtime: executor uses current-attempt routePool visibility, and later narrowed routePool views can overwrite the earlier full fallback chain.
- Repair direction: preserve and extend the full explicit routePool chain across attempts inside request-executor-pipeline-attempt; do not infer chain from routingDecision.pool when explicit routePool is absent.
- Required verification pair: positive test for preserving full chain when later attempt only reports narrowed pool; negative test proving no synthetic fallback chain is created from pool-only routing decisions.

2026-06-12 executor layered routePool carry + build gate repair
- Build blocker 1 fixed: sharedmodule JsonObject now allows undefined optional members, which unblocks hub type surfaces like chat-envelope under strict TS.
- Build/test blocker 2 fixed: root session-log-color no longer imports llmswitch-core ESM runtime; local pure helper mirrors color-key/color-palette semantics so root tsc and Jest stay stable.
- Executor 429 reroute fix tightened: resolveRequestExecutorPipelineAttempt now preserves/extends only explicit routingDecision.routePool across attempts and no longer synthesizes chain from routingDecision.pool.
- Verified pair: positive preserve-chain and negative no-synthesis tests both green; root tsc rerun pending live install/restart.

2026-06-12 SSE terminal closeout progress
- TS updateSseTerminalTrackerFromChunk now treats assistant response.output_item.done(message/completed) as terminal-source so terminalFlushTimer can auto-close hung non-continuation response streams.
- Rust upsert_probe_output_item now replaces matching probe output items and marks assistant message/completed probes as completed, so terminal repair frames use completed status instead of stale in_progress.
- Added blackbox regression for assistant response.output_item.done without upstream completed/done to lock the hang shape.

2026-06-12 direct Responses SSE semantic-timeout closeout
- Live 5555 hang root cause confirmed from sample: upstream direct SSE sent semantic reasoning frames, then only keepalive/comment traffic without terminal; old byte-idle timeout was reset by keepalive so client could hang.
- Unique repair point: `src/providers/core/runtime/responses-provider.ts` direct SSE passthrough now has semantic no-content/content-idle timers; keepalive/advisory frames do not reset semantic activity, and timeout calls upstream iterator return before surfacing explicit timeout error.
- Regression gate: `tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` covers keepalive-only no-content timeout, semantic-frame then keepalive content-idle timeout, and semantic terminal success path.
- Build/install/live evidence: `ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` passed; installed `0.90.3058`; health green on 5520/5555; live `/v1/responses` SSE probes on 5520 and 5555 both emitted `response.completed=1`, `response.done=1`, `event:error=0`.
- Tool/SSE blackbox evidence: `responses-client-tool-contract.blackbox` and `responses-sse-client-contract.blackbox` passed; `responses-handler.sse-terminal-event.blackbox` still fails in source-test env because native shared conversion module is unavailable, while installed live runtime path is green.

2026-06-12 inline tool-result reroute + live SSE validation
- Root cause narrowed from live failure `openai-responses-router-gpt-5.5-20260612T145225698-338351-264`: request body was inline Responses history containing `function_call_output`, not provider-native `previous_response_id`; executor incorrectly used `isToolResultFollowupTurn` as provider-owned continuation and could block cross-provider reroute.
- Unique repair point: `request-executor.ts` now only sets `providerOwnedContinuation` when `isProviderNativeResumeContinuation` sees native resume fields (`previousResponseId/previous_response_id` or `submit_tool_outputs` with response id). Plain inline `function_call_output` history remains reroutable.
- Regression gate: `request-executor-request-semantics.spec.ts`, `retry-execution-plan.spec.ts`, `request-executor-cross-pool-fallback.red.spec.ts`, and direct SSE passthrough suite passed together: 4 suites / 25 tests.
- Build/install/live evidence: global install/restart completed with `0.90.3058`; health green on 5520/5555. Live SSE no-metadata probes completed on both ports with HTTP 200, `response.completed=1`, `response.done=1`, `event:error=0`, marker hit.
- Inline tool-output live probe on 5520 with minimal `function_call` + `function_call_output` history completed HTTP 200 in 95.9s, `response.completed=1`, `response.done=1`, `event:error=0`, marker hit; log shows stopless servertool triggered and completed as `finish_reason=tool_calls`.
- Invalid evidence note: an earlier live smoke using custom `metadata.routecodex_test_marker` correctly failed at req_adapter as unsupported client metadata; do not treat that 502 sample as provider/reroute failure.

2026-06-12 DF alias/canonical model audit (live probe pending)
- Verified evidence: AGENTS now states provider.models.<modelId> is the only upstream wire model; aliases are client-facing only. Existing tests already expect /v1/models to show alias ids while provider_bootstrap keeps canonical modelId.
- Likely failure mode: outbound provider request still maps client alias modelId through without canonicalization, or live config for DF lacks canonical wire model mapping.
- Next verification: live /v1/chat/completions on 10000 with DF provider; inspect actual outgoing body.model and server logs for providerKey/modelId.

2026-06-12 DF direct probe closed
- Verified on live DreamField: POST https://www.dreamfield.top/v1/chat/completions accepts canonical model ids DeepSeek-V4-Pro and DeepSeek-V4-Flash (200). Lowercase aliases deepseek-v4-pro/deepseek-v4-flash return 503 model_not_found. /chat/completions is HTML, /v1/responses is not the right entry for this provider.
- Repair rule: client-visible aliases stay lowercase; provider outbound wire model must be canonical uppercase modelId. /v1/models must only list configured current-port models.

2026-06-12 alias routing audit before approval
- Confirmed keep/no-change point: direct outbound overwrite already has a single owner at `src/server/runtime/http-server/index.ts` direct hook (`payload.model = target.modelId.trim()`). This is the correct canonical wire-model override point and should not be duplicated elsewhere.
- Confirmed Rust bootstrap truth: `provider_bootstrap.rs` / `routing/bootstrap.rs` already preserve canonical `provider.models.<modelId>` and allow route-config alias expansion through `aliasToModel`; existing tests already lock canonical model preservation in bootstrap.
- Confirmed current direct bug surface: `routing/direct_model.rs::parse_direct_provider_model` only splits `provider.model`, and `select_direct_provider_model` / `engine/route.rs` direct branch compare request model to `profile.model_id` by exact string. Lowercase client alias therefore does not hit canonical `DeepSeek-V4-Pro` even though bootstrap knows alias mapping.
- Confirmed relay/forwarder audit: `forwarder.rs::resolve_by_model` is exact `(protocol, modelId)` lookup and does not own alias expansion. Alias expansion should stay before forwarder lookup, in VR request-side normalization, not inside forwarder runtime.
- Confirmed instruction-path asymmetry: `engine/route.rs::normalize_instruction_target_against_registry` can normalize some provider/model targets against registry, but normal request `body.model` direct entry does not reuse that normalization path.
- Confirmed `/v1/models` current behavior: port-scoped listing already uses `collectPortScopedModelItems()` and prefers first configured alias via `readModelDisplayAlias(modelNode) ?? ref.modelId`; it does not need a second model-name mapping path, but full audit should keep it aligned with alias contract.
- Proposed repair direction for approval: keep provider wire override unchanged; add one Rust-side request-model normalization owner for alias -> canonical model before direct selection / forwarder model lookup / family matching. No provider-runtime patching, no TS semantic fallback, no extra outbound remap layer.

## 2026-06-12 same-protocol-direct + DF input_text investigation
- Live issue A: 5520 openai-responses same-protocol requests with client tools are mis-gated to relay via reason=client_tools_require_hub_relay, causing upstream SSE to be materialized before first client byte and client_close before stream start.
- Live issue B: 5555 DF DeepSeek-V4-Pro route targets /v1/chat/completions compat but outbound payload still carries content part type=input_text instead of text; upstream 400 InvalidParameter.

## 2026-06-13 chat resume 2013 investigation
- Failing shape: Minimax chat rejected `tool call result does not follow tool call (2013)`.
- Root cause: `responsesResume.deltaInput` is only the resume delta, but `buildChatRequestFromResponses()` was treating it like the full history whenever `previous_response_id` existed.
- Fix direction: carry `fullInput` through resume/materialize metadata from Rust and prefer that in the Chat bridge; keep `deltaInput` only as delta/diagnostic data.
- Runtime probe: `node --import tsx` on `buildChatRequestFromResponses()` now yields full `user -> assistant.tool_calls -> tool` history when `responses.resume.fullInput` is present, even if the incoming context input is only the tool-output delta.

- 2026-06-12 live log: 5520 direct SSE aborted by server.response_projection because event=response.custom_tool_call_input.delta was treated as non-Responses. Tool stream dies after first tool event.
- 2026-06-12 repair in progress: `handler-response-utils.ts` direct Responses SSE allowlist widened minimally for `response.custom_tool_call_input.delta|done`; blackbox pair added to prove standard custom-tool delta passes while provider-specific `codex.rate_limits` still fails closed.
- 2026-06-12 continuation ownership rule clarified by Jason: remote-owned `previous_response_id/responseId` must continue via direct; locally reconstructed relay-owned ids must continue via relay.
- Root cause confirmed in current code: direct SSE tool-call responses were excluded from `persistNativeSseConversationState()` and from client-close continuation retention, so the first direct turn emitted tool SSE but never persisted `response_id -> owner/providerKey`. A second issue also existed: router resume pin only checked `responsesResume.providerKey`, which cannot distinguish remote direct ids from local relay ids.
- Repair direction in progress: persist direct SSE tool-call continuations too, and record a minimal `continuationOwner=direct|relay` marker in the responses conversation store so only direct-owned ids can re-pin `__shadowCompareForcedProviderKey`.
- 2026-06-12 live continuation probe still fails after ownership patch: first-turn direct tool SSE reaches client and native probe recognizes continuation, but persisted responses store remains empty. Added requestId-scoped trace logs in handler/store around `capture -> record -> finalize -> clear` to determine whether direct SSE persistence is skipped, throws `missing_request_context`, or is later cleared by client-close/cleanup.
- 2026-06-12 live continuation probe refined root cause: after removing handler-side `store:false` gate, direct SSE `capture -> record` executes and in-memory `responseIndex` grows, but `submit_tool_outputs` still fails because `ConversationEntry.allowContinuation` stayed false. Request-side `shouldAllowContinuation(payload)` is insufficient for first-turn tool calls; response-side truth must set `allowContinuation=true` whenever recorded assistant blocks still contain pending tool calls.

2026-06-12 alias canonicalization closeout in progress
- Implemented Rust registry-owned aliasToModel parsing and canonical model resolution for provider profiles.
- direct route selection now resolves provider.model alias to configured canonical modelId before availability/media checks.
- Existing virtual-router alias spec updated to assert target.modelId is canonical, not alias.
- Pending verification: focused Jest/blackbox, build/install/restart, live 10000 DF probe.

2026-06-12 direct submit_tool_outputs 400 root cause
- Live proof from `~/.rcc/logs/server-5520.log`: after continuation-store fixes, `/v1/responses.submit_tool_outputs` no longer dies at resume; it routes to direct `tools/forced -> asxs...`, then upstream rejects with `HTTP 400: {"detail":"Unsupported parameter: providerKey"}`.
- Unique owner confirmed in Rust `shared_responses_conversation_utils.rs`: `resume_responses_conversation_payload` / `restore_responses_continuation_payload` / `materialize_responses_continuation_payload` wrongly write internal `providerKey` back into resumed `payload`.
- Second injection point confirmed after first repair: `prepare_responses_conversation_entry` and TS store release path were also persisting `providerKey` inside `basePayload`; resume then rehydrated that internal field even after the explicit tail insertions were removed.
- Repair rule: keep `providerKey` only in store entry + returned `meta` for route pinning; never write it into `basePayload`, resumed/materialized payload, or release payload. Handler-side continuation trace logs should stay behind `ROUTECODEX_RESPONSES_DEBUG=1` only.

2026-06-12 direct Responses SSE keepalive gate root cause
- Live repro on 5520 current `0.90.3058`: direct `/v1/responses` can receive upstream `event: keepalive` during long-running tool/image substreams. Current direct guard in `src/server/handlers/handler-response-utils.ts` treats that as non-Responses protocol and aborts with `RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION`, producing `finish_reason=unknown`.
- Verified evidence: `~/.rcc/logs/server-5520.log` request `openai-responses-router-router-gpt-5.5-20260612T183042231-338877-790` failed with `[server.response_projection] direct passthrough SSE emitted non-Responses event "keepalive"`.
- Repair direction: do not broaden business-event allowlist; strip/drop upstream transport-only `event: keepalive` frames inside direct passthrough guard so client still sees only standard Responses events while non-standard semantic events remain fail-fast.
- Follow-up live proof after keepalive fix: same 5520 direct probe no longer dies on `keepalive`, but next failure moved to `response.image_generation_call.partial_image`. Local OpenAI SDK types under `node_modules/openai/resources/responses/responses.d.ts` confirm it is a standard Responses event; direct gate allowlist must include this image partial frame too.
- Full protocol closeout rule for this owner: stop patching one event at a time. Diff `RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS` against local OpenAI SDK `responses.d.ts` and admit the full standard `response.*` event set (`audio.*`, `code_interpreter_call.*`, `code_interpreter_call_code.*`, `file_search_call.*`, `mcp_call_arguments.*`, `output_text.annotation.added`, `queued`, `incomplete`); keep transport-only `keepalive` as drop-only and keep non-standard provider events fail-fast.

2026-06-12 reasonix chat usage cache 0% investigation
- Symptom confirmed from user evidence: Reasonix chat-entry cache badge reads the latest usage event, not session average; it expects camelCase `cacheHitTokens/cacheMissTokens` on the client-visible `usage` payload.
- RouteCodex current chat response projection owner is `src/server/handlers/handler-response-utils.ts::resolveNormalizedChatUsage/normalizeChatUsagePayload`.
- Root-cause candidate confirmed in code: chat response normalization currently backfills only `input_tokens/output_tokens/prompt_tokens/completion_tokens/total_tokens`; it does not project internal normalized cache fields (`cache_read_input_tokens`, `cache_creation_input_tokens`) into client-visible camelCase cache fields.
- Additional evidence: `maybeUpdateUsageLogInfoFromSseFrame()` stores normalized internal snake_case usage into `usageLogInfo.usage`, and non-stream JSON response path later reuses that shape directly unless chat normalization rewrites it.
- Minimal fix direction: extend chat usage normalization to expose Reasonix-compatible cache aliases from normalized usage (`cacheHitTokens`, derived `cacheMissTokens`), plus keep existing snake_case aliases unchanged.

2026-06-12 direct Responses SSE live revalidation after terminal-probe repair
- Global install/restart truth: current runtime on 5520/5555 is `0.90.3058`; `routecodex --version`, `rcc --version`, and both `/health` endpoints all report `0.90.3058`.
- Positive live probe on 5520: explicit function-tool `/v1/responses` request forced `exec_command`; stream emitted `response.function_call_arguments.done -> response.output_item.done -> response.completed -> response.done` with HTTP 200. This confirms the Rust `shared_responses_response_utils.rs` probe repair now synthesizes terminal frames correctly instead of surfacing `upstream_stream_incomplete`.
- Negative/live boundary probe on 5520: an image-generation stream left upstream status `in_progress` and only emitted `response.image_generation_call.partial_image`; after the client-side 30s probe timeout, server logged `response.sse.client_close` with `lastRawFrame=response.image_generation_call.partial_image` and no `upstream_stream_incomplete`. This locks the distinction between client timeout/disconnect and server-side terminal synthesis failure.
- Continuation live probe on 5520: replaying `previous_response_id + function_call_output` for the above tool call returned HTTP 200 with `response.completed` and `response.done`, and did not reproduce `orphan_tool_result`.
- Reusable live verification method for Responses SSE regressions: always run the pair `function tool first turn` + `function_call_output continuation turn`; do not rely on plain text probes, because they can drift into image generation and fail to exercise the tool terminal/continuation chain.

2026-06-12 responses continuation history-image lifecycle
- Root cause confirmed: request-side outbound stripping already existed, but success-path stored continuation history was still carrying historical `input_image` / media-bearing `function_call_output` into `releasedInputPrefix`. This violated Jason's rule: send/retry must keep full image+metadata until success, but stored history after success must be image-scrubbed.
- Unique repair point: `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts::releaseRequestPayload()` now calls a new Rust-exported native helper `stripResponsesStoredContextInputMediaJson` before persisting `releasedInputPrefix`; capture/request-inflight state remains untouched before release.
- Rust owner reused, not reimplemented: export wired from `router-hotpath-napi/src/lib.rs` to existing `chat_process_media_semantics::strip_responses_stored_context_input_media`, then bridged through `native-shared-conversion-semantics-responses.ts` and `responses-conversation-store-native.ts`.
- Positive/negative verification:
  - Rust gate PASS: `cargo test -p router-hotpath-napi shared_responses_conversation_prepare_and_resume_json --lib -- --nocapture`
  - llmswitch-core tsc PASS: `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
  - Focused Jest PASS with runtime native rebuilt: three targeted tests in `tests/sharedmodule/responses-continuation-store.spec.ts` proved `pre-release keeps raw image`, `post-release scrubs stored history`, and `released materialize still reconstructs full sanitized history`.
  - Runtime probe PASS from built module `dist/conversion/shared/responses-conversation-store.js`: before release payload still contained `LIVE_HISTORY` and no placeholder; after release payload no longer contained raw image and emitted `[Image omitted]` in stored historical turn.

2026-06-12 responses direct SSE finish_reason unknown audit
- Live sample `openai-responses-router-gpt-5.4-20260612T194202559-339122-1035` on 5520 reproduced `session-request/usage finish_reason=unknown` with no matching `completed` line and no `response.sse.stream.error/client_close` line.
- Unique leak candidate confirmed in `src/server/handlers/handler-response-utils.ts`: terminal auto-close path `writeTerminalProbeFramesAndClose()` can end the HTTP response via `res.end()` without `logStreamRequestCompleteOnce()` / `recordSseStreamEnd()`, leaving cleanup to emit usage with stale or missing finishReason.
- Rust semantic gap also confirmed in `chat_node_result_semantics.rs`: Responses `output.type=custom_tool_call` is not currently classified as `tool_calls`, so auto-close paths that rely on probe-only finish derivation can fall to `unknown`.
- Repair applied:
  - `handler-response-utils.ts` auto-close now resolves finishReason from probe, records `recordSseStreamEnd`, and emits normal `completed` request log before `res.end()`.
  - `chat_node_result_semantics.rs` now treats `custom_tool_call` as `tool_calls`.
- Verification:
  - Jest PASS: `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts` (covers positive auto-close completion logging and negative no-early-close path).
  - Rust PASS: `cargo test -p router-hotpath-napi derives_finish_reason_tool_calls_in_rust --lib -- --nocapture`.
  - TS PASS: root `npx tsc --noEmit --pretty false`; llmswitch-core `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`.
  - Live runtime PASS after global install/restart to `0.90.3059`: 5520 `/v1/responses` tool-stream request `openai-responses-router-gpt-5.5-20260612T201950258-339179-1092` emitted `response.completed` + `response.done`, and server log recorded `completed (finish_reason=tool_calls)` plus `session-request/usage finish_reason=tool_calls`.

2026-06-12 finish_reason live recheck after 0.90.3059
- Fresh runtime truth: `curl http://127.0.0.1:{5520,5555,10000}/health` all returned `ready=true`, `pipelineReady=true`, version `0.90.3059`.
- Fresh client-side SSE probe on 5520: function-tool `/v1/responses` request with prompt `finish_reason_probe_5520` returned HTTP 200 and emitted the standard chain `response.created -> response.in_progress -> response.output_item.added -> response.function_call_arguments.delta/done -> response.output_item.done -> response.completed -> response.done`.
- Fresh server-side truth on current runtime: latest 5520 and 10000 log lines around 20:25-20:27 show repeated `completed (finish_reason=tool_calls)` plus matching `session-request/usage finish_reason=tool_calls`; no new `finish_reason=unknown` sample appeared during this recheck window.

2026-06-12 5520 direct tool-call silent-stop audit
- User sample `openai-responses-router-gpt-5.4-20260612T203357639-339278-1191` proved remaining gap is not generic SSE hang: server logged `completed finish_reason=tool_calls`, but no continuation request followed, and no `client_close` / `upstream_stream_incomplete` appeared around the request.
- Snapshot evidence: `~/.rcc/codex-samples/openai-responses/port-5520/req_1781267637639_72e027b1/` contained only provider request/response metadata; no raw direct SSE event sample existed, so prior evidence was insufficient to tell whether upstream emitted `response.required_action`.
- Root-cause direction tightened:
  1. direct `sendPipelineResponse()` only auto-closes tool continuations when the terminal probe path runs;
  2. Rust terminal-frame builder only synthesized `response.completed/done` from `output.function_call` probe, but did not synthesize `required_action` payload when probe lacked explicit `required_action`;
  3. TS close scheduling must stay gated by actual terminal/close window, otherwise `response.output_item.done(function_call)` can cause premature close before real terminal events.
- Repair applied:
  1. Rust `shared_responses_response_utils.rs` now synthesizes `required_action.submit_tool_outputs.tool_calls` from `output[].type=function_call` when explicit `required_action` is absent, and marks synthesized response status as `requires_action`.
  2. TS `handler-response-utils.ts` keeps terminal probe close scheduling only on terminal/auto-close path, not immediately on any tool-call probe, avoiding early close regression.
  3. Test expectation aligned with current client-visible Responses contract: client sees `response.output_item.added/function_call_arguments/output_item.done -> response.completed -> response.done`, not raw `response.required_action`.
- Focused verification PASS:
  - `cargo test -p router-hotpath-napi terminal_frames_synthesize_required_action_from_output_function_calls --lib -- --nocapture`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx jest tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false`
- Next required evidence: rebuild/install/restart current runtime, then re-run 5520 live tool-call probe and check whether direct tool turn now deterministically emits client-visible tool frames plus continuation stop turn.

2026-06-12 current-runtime multi-turn responses proof
- Controlled `/v1/responses` two-turn function-tool conversation on 5520 current `0.90.3059` succeeded end to end.
- Turn 1 client JSON truth: response `resp_0b30648bdc1ed361016a2bfc389b6c8191825900ad5673e0ba` returned `output=[function_call ping_tool]`.
- Turn 1 server log truth: request `openai-responses-router-gpt-5.4-20260612T203146306-339260-1173` completed with `finish_reason=tool_calls`, and matching `session-request` / `usage` also recorded `finish_reason=tool_calls`.
- Turn 2 client JSON truth: continuation with `previous_response_id + function_call_output` returned `output=[message "Done."]`.
- Turn 2 server log truth: request `openai-responses-router-gpt-5.4-20260612T203154811-339262-1175` completed with `finish_reason=stop`, and matching `session-request` / `usage` also recorded `finish_reason=stop`.

2026-06-12 current-runtime stopless live loop proof
- Controlled relay `/v1/responses` stopless probe on 10000 current `0.90.3059` succeeded end to end.
- Turn 1 client JSON truth: plain request without client tools returned `status=requires_action`, `output=[reasoning,function_call]`, projected tool `exec_command`, command `routecodex servertool run stop_message_auto --input-json '{"flowId":"stop_message_flow","maxRepeats":3,"repeatCount":1}'`.
- Server log truth for turn 1: request `openai-responses-DF.key1-DeepSeek-V4-Flash-20260612T203340435-339276-1189` logged `[servertool] ... result=trigger_stop_schema_missing ... used=0 left=3`, then completed with `finish_reason=tool_calls`.
- Real tool execution truth: local `routecodex servertool run stop_message_auto ...` was executed for repeat counts 1, 2, and 3; each stdout JSON was submitted back as normal `function_call_output`.
- Continuation loop truth: turns 2 and 3 again returned `requires_action + exec_command`; server logs `...1194` and `...1195` continued as `finish_reason=tool_calls`.

2026-06-13 zterm apply_patch patch-failure shape audit + request-side repair
- Jason clarified the current slice boundary: focus on `apply_patch`-related patch-failure compatibility first, under the rule "only normalize shape, do not change semantics".
- Real failing shape classes confirmed from zterm/diag samples:
  1. repeated replay blocks where the same `call_id` replays identical `function_call` plus identical `function_call_output`;
  2. zterm transport wrapper noise around tool outputs (`Chunk ID`, `Wall time`, `Original token count`, `Process exited with code`, `Output:`), which makes semantically identical outputs look different;
  3. repeated `apply_patch` terminal status carryover, especially `APPLY_PATCH_ERROR` / `apply_patch verification failed` lines echoed into later turns.
- Unique owner confirmed: request-side Responses input normalization in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`. No second bridge or TS duplicate owner was introduced.
- Repair applied in Rust request normalization only:
  1. duplicate `function_call` entries now dedupe by semantic signature (`tool name + canonicalized arguments`) instead of raw occurrence only;
  2. tool outputs are compare-normalized after zterm transcript wrapper unwrapping, so wrapper-only duplicates collapse;
  3. `apply_patch` outputs reuse `normalize_apply_patch_output_text` for compare-only canonicalization, so repeated failure/result status carryover dedupes without mutating stored visible output.
- Focused verification PASS:
  - `cargo test -p router-hotpath-napi normalize_responses_input_items --lib -- --nocapture` -> 13 passed
  - `cargo test -p router-hotpath-napi responses_standardization --lib -- --nocapture` -> 8 passed
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs` -> native/core build passed
  - Native replay on real error sample `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json` with wrapped `{ payload, normalized }` input now passes `coerceStandardizedRequestFromPayloadWithNative`, returning `messages=33`, `tools=16` instead of failing request standardization.
- Next required evidence: global install/restart current runtime, then rerun a live/runtime probe to confirm the built server process picks up the request-shape fix.

2026-06-13 real-sample red-test + workflow closeout
- Jason required the workflow to be fixed as a general rule: every new feature or bugfix must go `red test first -> fix -> green -> live replay old sample`, otherwise the change is not closed.
- Added curated real-sample fixture gate under `tests/fixtures/errorsamples/responses-request-standardization/`:
  1. `2026-06-13-duplicate-replay-wrapper-noise/` keeps the real diag request body from `error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json`;
  2. `2026-06-07-apply-patch-error-carryover-curated/` keeps a curated real-sample payload extracted from `error-openai-responses-router-gpt-5.5-20260607T022906302-288146-11057.json`, locking `apply_patch verification failed` carryover plus zterm wrapper coexistence.
- Added formal red regression `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts` that replays both fixtures through `coerceStandardizedRequestFromPayloadWithNative`.
- Fixture gate PASS: `npm run jest:run -- --runInBand --runTestsByPath tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts`
- Online replay PASS on current `0.90.3064` runtime:
  - `2026-06-13-duplicate-replay-wrapper-noise` -> HTTP 200, no `MALFORMED_REQUEST`, no `orphan_tool_result`, no `RESPONSE_CONVERSION_ERROR`
  - `2026-06-07-apply-patch-error-carryover-curated` -> HTTP 200, no `MALFORMED_REQUEST`, no `orphan_tool_result`, no `RESPONSE_CONVERSION_ERROR`
- Process rule was written into project `AGENTS.md`, `docs/agent-routing/20-build-test-release-routing.md`, and `.agents/skills/rcc-dev-skills/SKILL.md`.

2026-06-12 request/response/usage concise log cleanup
- User target: standard `virtual-router-hit -> completed -> session-request -> usage` logs should be shorter, keep request id / request-response pairing / core usage / single finish_reason signal, and avoid repeated finish_reason clutter.
- Unique owner direction: only log presentation files are in scope: `src/server/handlers/handler-utils.ts`, `src/server/handlers/handler-response-utils.ts`, `src/server/runtime/http-server/executor/usage-logger.ts`, `src/server/utils/request-log-color.ts`, plus existing log-color/usage tests. No Hub/VR/provider payload or routing semantics change.

2026-06-13 singleton/default blackbox follow-up
- Rust owner + function-map + gate slice for singleton/default route availability floor is already green; upper blackbox failures were not semantic regressions but Jest loader failures.
- Verified local truth: `sharedmodule/llmswitch-core/dist/conversion/hub/pipeline/hub-pipeline.js`, `dist/native/router-hotpath/native-chat-process-node-result-semantics.js`, and `dist/native/router-hotpath/native-failure-policy.js` all exist and can be loaded by plain Node `require(...)`.
- Root cause narrowed to unique owner `src/modules/llmswitch/core-loader.ts`: async `import(file://...)` under Jest was being routed through Jest resolver and failing `Cannot find module 'file:///...dist/...js'`, which blocked handler/request blackbox from entering the new singleton/default semantics.
- Follow-up evidence: forcing Jest to `require(dist-path)` changed the failure from `Cannot find module file://...` to `Cannot use import statement outside a module`, confirming the real incompatibility is Jest CJS loading the llmswitch-core ESM dist package.
- Additional root-cause refinement: `createRequire(...)` bypasses Jest/ts-jest transform, so even TS source-first still fell back to raw Node loading. The loader fix must use Jest's own `require` when `JEST_WORKER_ID` is set, otherwise sharedmodule source `.ts` still cannot be consumed in blackbox suites.

2026-06-13 responses apply_patch SSE/client projection repair
- Root cause confirmed in the response bridge path, not HTTP adapter: JSON->SSE and live SSE were using different projection semantics, `response.required_action` nested payloads were not fully normalized, terminal probe repair could replay raw `function_call`/`function_call_arguments.*` after a normalized `custom_tool_call`, and continuation persistence warned on tool-call streams without `response.id`.
- Unique owner fix stayed in `src/modules/llmswitch/bridge/responses-response-bridge.ts` plus SSE transport wiring in `src/server/handlers/handler-response-sse.ts`: JSON->SSE now keeps standard Responses body for converter then reuses the same client-frame projection chain as live SSE; nested `response` payloads are normalized through the bridge before write; normalized frames update the probe truth; duplicate raw apply_patch repair frames are suppressed; missing-`response.id` tool continuations skip non-blocking store record instead of warning.
- Regression updates: `tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts` now locks client-visible output shape instead of an obsolete internal mock call path, and bridge-mocked SSE suites were updated with the new metadata-isolation export they now import.
- Verified PASS: `handler-response-utils.apply-patch-freeform-sse.spec.ts`; `handler-response-utils.required-action-split-frame.spec.ts`; `handler-response-utils.force-sse-json-responses.spec.ts`; `responses-continuation-store.spec.ts`; `direct-server-contract.red.spec.ts`; `verify:responses-handler-single-bridge-surface`; `verify:server-function-map-boundary`; root `tsc --noEmit`; `git diff --check`.
- Remaining gap: no build/install/restart/live port replay yet for this slice, so runtime-installed verification is still pending before claiming end-to-end closeout.

2026-06-13 error handling + route availability audit
- User要求审计四条硬约束：错误处理唯一 owner；路由池命中顺序固定为 search -> tool -> default，default 为最后命中池；default 仅剩一个模型时不能因 cooldown/blacklist 打空，必要时只能阻塞 backoff 等待；任何错误都不能直接回客户端，必须先计数/cooldown/切 provider。
- 初步定位 owner：`error.provider_failure_policy` -> `src/providers/core/runtime/provider-failure-policy-impl.ts`，`error.backoff_action_queue` -> `src/server/runtime/http-server/executor/request-executor-error-action-queue.ts`，`vr.route_availability_floor` -> Rust `virtual_router_engine/engine/selection.rs`。
- 待核实风险点：是否仍有第二套 `ErrorErr04/05` 决策；default 单模型/10000 场景是否存在 blacklist/cooldown 到空池；是否存在 provider error 未经 switch/cooldown 直接 ErrorErr06 投影给客户端的执行路径。
- 2026-06-13 收口执行：把 singleton/default availability-floor 判定从 TS `request-executor-core-utils.ts` 收回 Rust `selection.rs`，通过新的 native export `evaluateSingletonRoutePoolExhaustionJson` 暴露；TS executor 只保留 wait/log 壳。
- 同步更新 owner/gate：function-map / verification-map 新增 `evaluate_singleton_route_pool_exhaustion`、`tests/red-tests/vr_route_availability_floor_singleton_truth.test.ts`，`verify-vr-no-ts-runtime` 新增对 executor 本地 singleton 语义复活的扫描。
- Color rule: normal request/response lines must share one non-red/non-white/non-gray session color with numeric values highlighted white; error request/response lines are red. Existing session palette already excludes red/white/gray; fallback gray must not be used for normal HTTP request logs.
- Final stop truth: turn 4 returned `status=completed` with final assistant message summary; server log request `openai-responses-DF.key1-DeepSeek-V4-Flash-20260612T203429599-339283-1196` completed with `finish_reason=stop`, and matching `session-request` / `usage` also recorded `finish_reason=stop`.

2026-06-12 5520 XL direct responses html-shell root cause
- Live failing samples `openai-responses-router-gpt-5.4-20260612T215430477-339436-1349`, `...1350`, `...1351` are not pure SSE terminal-repair failures. Snapshot truth shows `XL.key1.gpt-5.4` direct `/v1/responses` upstream returned `: keepalive`, `event: ping`, then an HTML shell page (`<!doctype html> ... <title>New API</title>`), not valid Responses SSE.
- Evidence:
  - `~/.rcc/codex-samples/openai-responses/port-5520/req_1781272470477_7f6ec698/provider-response.json`
  - `~/.rcc/codex-samples/openai-responses/port-unknown/openai-responses-router-gpt-5.4-20260612T215430477-339436-1349/client-response_server.json`
  - `.../client-response.error_server.json` shows `probe: {}` and `upstream_stream_incomplete`
- Conclusion: current same-protocol direct gate is too weak for `openai-responses`; protocol-name match alone is insufficient. Need a direct capability/support gate before entering router-direct for Responses, so HTML-shell providers like `XL.key1.gpt-5.4 -> https://yunpansou.cn/responses` are blocked from direct and forced to relay or excluded earlier.

2026-06-12 XL runtime config truth corrected
- Jason provided the intended direct profile truth for XL: `base_url=https://yunpansou.cn/v1`, `wire_api=responses`, OpenAI auth, no CRS compat layer.
- Local runtime source of truth was inconsistent: `~/.rcc/provider/XL/config.v2.toml` still had `baseURL=https://yunpansou.cn` and `compatibilityProfile=responses:crs`.
- Action taken: removed `compatibilityProfile` from the live runtime provider config and rewrote `baseURL` to `https://yunpansou.cn/v1`.
- Next verification required: restart/reload runtime and recheck whether direct `/v1/responses` still emits HTML/ping shell or now returns valid Responses frames from `/v1/responses`.

2026-06-12 router-direct failure sample capture + concise logs
- Investigating direct failure hooks in http-server/index.ts; canonical snapshot owner is src/providers/core/utils/snapshot-writer.ts.
- Current log slice still has test gaps: request-complete spy target, usage finish_reason single-occurrence, request-log-color ESM import owner.

2026-06-12 XL label mismatch
- provider-request/provider-response/__runtime all show providerKey=XL.key1.gpt-5.4 and URL=https://yunpansou.cn/v1/responses.
- server log usage/session-request still prints XL.key1.gpt-5.4.gpt-5.5, so current residual issue is provider label/model decoration, not outbound target/baseURL.
- Unique owner likely buildProviderLabel/log usage path; direct transport truth already matches /v1 and gpt-5.4.

2026-06-12 XL provider label owner fixed
- Root cause: resolveProviderRequestContext preferred clientModelId when payload lacked model, so usage/session logs combined providerKey XL.key1.gpt-5.4 with client/default model gpt-5.5 into false label XL.key1.gpt-5.4.gpt-5.5.
- Fix: prefer mergedMetadata.target.modelId over clientModelId for providerModel derivation in provider-request-context.
- Gate: added red regression asserting XL.key1.gpt-5.4 + target.modelId=gpt-5.4 + clientModelId=gpt-5.5 resolves to providerLabel XL.key1.gpt-5.4.

2026-06-12 5520 orphan_tool_result live sample
- User sample: 22:28:37 tools route -> XL.key1.gpt-5.4-mini failed with orphan_tool_result unknown or already-consumed call_id.
- Next action: inspect matching codex-samples request/client/provider snapshots and locate single owner for tool_result call_id consumption/normalization.

## 2026-06-12 5520 orphan_tool_result + direct label residual

2026-06-13 responses same-response continuation / orphan_tool_result audit
- 用户新证据确认：新 session 也会 400，不是旧历史污染；样本为 `orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id`。
- 先做真实两步回放复现：第一轮 `/v1/responses` 返回 `function_call`；第二轮带 `previous_response_id + function_call_output`。当前运行时在第二轮先报 `Responses conversation expired or not found`，说明问题先落在 continuation store 持久化/恢复，而不是客户端会话。
- 真因已定位到唯一 owner：`sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`。`captureRequestContext()` 因 `store:false` 把 `allowContinuation=false`，后续 `recordResponse()` 即便看到 pending tool calls 也没有把 `allowContinuation` 打开，导致同一 response 的 tool continuation 不能恢复。
- 已改 contract：`store:false` 仍允许 same-response tool continuation；仍不允许 scope continuation/materialize。对应回归已改在 `tests/sharedmodule/responses-continuation-store.spec.ts`。
- focused gate 已绿：`tests/sharedmodule/responses-continuation-store.spec.ts` 22/22 PASS。下一步必须 build/global-install/restart 后重跑真实两步回放，确认 live runtime 不再 400。
- Live error sample: openai-responses-router-gpt-5.4-20260612T222837601-339482-1395 failed with orphan_tool_result for call_JYbsLnCRByKN0SjpmyWDiFHY.
- Evidence shows same call_id already existed in earlier provider-request snapshots 339477-1390 and 339478-1391, so current root-cause direction is continuation/history pollution, not provider generating a fresh bad call id.
- Residual 5520 direct usage/session provider label still shows XL.key1.gpt-5.4.gpt-5.5 / XL.key1.gpt-5.4-mini.gpt-5.5 after one owner was fixed; there is still a second owner/path.

- 2026-06-12 fix slice: Rust standardized_request now drops stale responses tool_result items when a new function_call turn arrives, while keeping only outputs matching current pending call ids. Added paired tests for stale-drop and non-stale retention boundary.
- 2026-06-12 fix slice: direct usageLogInfo model source now prefers provider wire/response model instead of client request model, preventing labels like XL.key1.gpt-5.4.gpt-5.5 in direct logs.
- Verification: cargo test -p router-hotpath-napi standardized_request --lib -- --nocapture PASS; jest tests/server/runtime/http-server/direct-result-metadata-propagation.spec.ts tests/server/runtime/http-server/executor/provider-response-utils.spec.ts PASS; root tsc PASS.

2026-06-12 continue: preparing live replay from old 5520 orphan_tool_result sample 339478/1391 against runtime 0.90.3059 to verify stale tool_result is dropped before bridge validation.

2026-06-12 replay result: old orphan_tool_result 339477/339478 bodies replayed against 5520 runtime 0.90.3059 no longer fail at bridge/orphan; both progressed to upstream HTTP_403 auth failure on asxs.crsa.gpt-5.4-mini. This is live evidence stale tool_result pollution is removed before provider send.

2026-06-12 live log check after 0.90.3059 restart: no new orphan_tool_result found in post-restart 5520 window; replayed requests 339522/339523 failed only at upstream HTTP_403. Next evidence path is successful direct log label on current runtime.

2026-06-12 correction: old-sample replay was insufficient. New live session openai-responses-router-gpt-5.4-20260612T225507928-339537-1450 still fails orphan_tool_result on fresh call_MqPgTUSSFb19Em58JUUEd6xV, so root cause remains in live-session request shaping/continuation path. Must inspect fresh sample, not infer from historical replay.

2026-06-12 gate update: added paired regression tests for materialized responses continuation pending tool-call replay duplication in tests/sharedmodule/responses-continuation-store.spec.ts; using repo jest:run path because plain npx jest cannot load llmswitch-core ESM native bridge.

2026-06-12 note: source tests for responses continuation materialize require rebuilding native hotpath after Rust changes; otherwise tsx/jest still call stale router_hotpath_napi.node and can falsely stay red/null.

2026-06-12 previous_response_id lifecycle + miss policy audit
- External truth (official/OpenAI + local codex audit):
  - Responses `previous_response_id` depends on a stored prior response object. Official guidance indicates stored response/application state is retained for up to 30 days when `store=true`; `store=false` / ZDR paths do not guarantee later resume lookup.
  - Official miss guidance for websocket/incremental flows: if cached previous response context is unavailable, send a fresh create with `previous_response_id=null` and the full input/context; do not try to continue from partial delta.
  - Local codex source truth:
    - `rollout-trace/src/reducer/conversation.rs` explicitly errors on unknown previous id: `unknown previous_response_id ...`.
    - `core/src/client.rs` only sends `previous_response_id` when the new request is an exact prefix continuation; otherwise it sends a full create without `previous_response_id`.
    - `core/tests/suite/client_websockets.rs` locks that behavior: prefix match => use `previous_response_id`; non-prefix or post-error => full create without `previous_response_id`.
- RouteCodex current local truth:
  - `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts` already has a local TTL cache, currently `TTL_MS = 30min`; this is a local continuation cache, not upstream retention truth.
  - `resumeConversation()` already fail-fast returns `expired_or_unknown_response_id` when the local store misses.
  - The dangerous gap is scope materialization/reconstruction after release: if local scope miss or malformed replay is treated as resumable delta, later bridge validation can surface `orphan_tool_result`.
- Required closeout direction:
  - Scope-based continuation miss must never fabricate partial delta. If full input is available and prefix match fails, create a fresh full request without `previous_response_id`; if request is submit-tool-outputs/partial-delta only, fail-fast with explicit expired/unknown continuation error.
  - `orphan_tool_result` must become impossible from store miss/TTL expiry; store miss should stop at continuation owner/store boundary, not later at bridge tool_result validation.
2026-06-12 singleton empty-pool blocking retry progress
- root cause confirmed: hub pool exhaustion on singleton/default-only pools previously allowed terminal no-provider after bounded backoff; this violates Jason rule that empty pool must not be terminal.
- executor change: request-executor now detects singleton/last-candidate pool exhaustion from VR details (candidateProviderCount=1 / initialRoutePool len=1 / explicitSingletonPool) and enters provider.route_pool_cooldown_wait, clears exclusions, then reruns route selection instead of terminal no-provider.
- additional fix: chat success path no longer loads responses conversation rebind or native empty-assistant semantics when normal chat body already contains visible assistant payload; otherwise singleton blackbox was falsely failing after successful provider response.
- verification green so far: focused helper spec + chat handler singleton blackbox + root tsc.

2026-06-12 /v1/responses handler bridge surface audit
- Current duplicated bridge surface was confirmed at both handler ends:
  - request side `src/server/handlers/responses-handler.ts` directly imported entry planning/resume/materialize/capture/record/clear helpers from `bridge.js`
  - response side `src/server/handlers/handler-response-utils.ts` directly imported SSE probe/projection/conversation lifecycle helpers plus core-dist loaders from `bridge.js`
- Convergence direction fixed:
  - request side unique owner facade: `src/modules/llmswitch/bridge/responses-request-bridge.ts`
  - response side unique owner facade: `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- New architecture gate truth: `scripts/architecture/verify-responses-handler-single-bridge-surface.mjs` must fail if handler files re-import responses bridge primitives from `bridge.js` instead of the side-specific facade.
- Function/verification map truth split from coarse `server.responses_handler_family` into two dedicated features:
  - `server.responses_request_handler_bridge_surface`
  - `server.responses_response_handler_bridge_surface`

- 2026-06-12 router-direct finish_reason=unknown 排查：usage/session rollup 只吃 direct result usageLogInfo.finishReason；direct 路径此前仅用 deriveFinishReasonNative，对无显式 finish_reason 但已有可见 assistant 成功内容的 chat-like/direct 响应会落 unknown。计划把成功可见响应推断统一收口到 finish-reason util，并补 direct 红测锁定。

- 2026-06-13 stopless 未触发排查：10000 端口 stopMessageEnabled 默认 true，request-executor/provider-response-converter 也会把 servertool 能力传入；当前怀疑点收敛到 Rust bridge 后的 response payload 形态或 stopGatewayContext 覆盖，导致 isStopEligibleForServerTool=false，需补 /v1/responses stop blackbox 锁定。
2026-06-13 stopless direct root cause
 - 10000 port default sameProtocolBehavior=direct and default stopMessageExcludeDirect=true. This bypasses response conversion/orchestration for same-protocol /v1/responses.
 - Fix direction: when port stopMessage.includeDirect=true, same-protocol direct must relay instead of bypassing stopless; added Rust direct-decision red/green and HTTP blackbox; updated ~/.rcc/config.toml port 10000 stopMessage={ enabled=true, includeDirect=true }.

## 2026-06-13 stopless live verify blocked by startup export drift
- install/global 0.90.3059 completed, but 10000 runtime cannot be reloaded yet.
- current live blocker: startup error `./index.js does not provide an export named captureResponsesRequestContextForRequest`.
- next action: inspect bridge facade/export owner and fix startup regression before live stopless probe.

- 2026-06-13 current blocker narrowed: previous install likely packed stale dist; rebuilt local dist now shows corrected runtime-integrations import in responses-request-bridge.js. Re-running isolated install-global before live port 10000 restart.

- 2026-06-13 continue after live proof: next gap is test proof for new stopless/direct blackbox; attempt repo jest path first.

- 2026-06-13 verification update: provider-response-rust-plan.spec.ts PASS (17/17); live 10000 stopless probe PASS; router-direct-passthrough.blackbox.spec.ts still hangs in current repo jest environment, so not claimed green.

- 2026-06-13 blackbox fix: router-direct-passthrough.blackbox used forbidden client metadata.routeHint; moved route hint to x-route-hint header to match current req_adapter contract before rerun.
2026-06-13 stopless blackbox status
- Direct live 10000 proof already green.
- HTTP blackbox current blocker is Jest execution mode, not stopless assertion: plain ./node_modules/.bin/jest fails immediately on ESM/import.meta in src/server/runtime/http-server/index.ts.
- Need to verify same case under node --experimental-vm-modules jest runner; npm run jest:run appears silent/hanging so testing runner behavior separately.
- HTTP blackbox stopless case under correct VM-modules runner now produces a real red result, not a hang.
- Current red shape: request still ends as 502 with [llmswitch-bridge] native-failure-policy not available after direct path failure; this mixes stopless relay verification with missing native bridge capability in source-test env.
- Evidence: node --experimental-vm-modules jest run at 2026-06-13 08:27 shows virtual-router-hit -> direct provider request id -> SSE_TO_JSON_ERROR -> native-failure-policy not available.

2026-06-13 orphan_tool_result duplicate-history closeout in progress
- New live failing request `openai-responses-provider-20260613T091618631-339813-1726` is a fresh-session failure, not old expired continuation state.
- Diag truth: `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json` contains identical `function_call` + `function_call_output` blocks replayed twice in one inbound `input[]`.
- Bridge fail-fast is correct: second identical tool_result for same call_id is rejected as `already-consumed`; fix must happen before bridge conversion.
- Repair owner selected: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`.
- Boundary locked in code/tests: dedupe only exact duplicate tool-history entries before orphan filtering; distinct repeated outputs for the same call_id remain invalid and must still error.
2026-06-13 10000 backup minimax m3
- User request: add MiniMax M3 as backup in 10000 port config.
- Source of truth: ~/.rcc/config.toml, routingPolicyGroup gateway_coding_10000.
- Existing state: fwd.minimax.MiniMax-M3 already defined globally; 10000 only uses it in multimodal, not in coding/thinking/tools/search/web_search/longcontext/vision/default.
- Planned minimal change: append fwd.minimax.MiniMax-M3 as secondary target for 10000 route entries, preserve current primary order.
2026-06-13 zterm patch-failure shape audit
- Evidence set for current audit:
  - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T091618631-339813-1726.json`
  - `~/.rcc/codex-samples/openai-responses/port-5520/openai-responses-router-gpt-5.4-20260612T225434051-339532-1445/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/port-5520/req_1781280510486_c4745c3f/provider-request.json`
  - `~/.rcc/codex-samples/openai-responses/port-5520/req_1781315630127_4eebb92b/provider-request.json`
- Confirmed shape classes:
  1. duplicated replay block: same `call_id` reappears with repeated `function_call` + repeated `function_call_output`; representative `...339532-1445/provider-request.json`
  2. transport wrapper noise: `function_call_output.output` may be wrapped by `Chunk ID` / `Wall time` / `Original token count` / `Process exited with code` / `Output:`; representative `...339528-1441/provider-request.json`
  3. repeated apply_patch status carryover: many later requests still carry historical `APPLY_PATCH_ERROR: apply_patch did not apply...` or `Success. Updated the following files:` outputs with same call ids across turns; representative `req_1781280510486_c4745c3f/provider-request.json` and `req_1781315630127_4eebb92b/provider-request.json`
- Existing Rust request normalization already does:
  - duplicate call-id rewrite by occurrence
  - exact payload-signature dedup for repeated tool outputs
  - orphan tool output filtering
- Current gap:
  - duplicate replay with same semantic call/result is rewritten, not collapsed
  - payload-signature dedup happens before stripping zterm wrapper noise, so wrapper-only differences evade dedup
  - historical apply_patch terminal statuses can accumulate as repeated tool history across turns
- Intended repair direction for approval:
  - unique owner stays request-side Rust normalization before bridge/tool-result validation
  - only shape normalization, no patch/body semantic rewrite
  - collapse replayed identical tool history by semantic identity after output-wrapper canonicalization
  - keep true conflicts fail-fast

2026-06-13 stopless schema guidance tighten
- User reports: stopless can still spend 3 consecutive turns without calling tool. Need stronger guidance across these 3 hops, schema-guided, and next inspection must also check schema.
- Must inspect Rust/TS owner for stop_message_auto CLI projection seed + schema gate + next-turn inspection path before editing.

2026-06-13 build install restart after stopless guidance tighten
- User requested: compile, global install, restart server after Rust prompt tightening.
- Need runtime evidence after install: versions + health on 5520/5555/10000.

2026-06-13 ignore generated dirs for repo-sanity
- User confirmed bin/lib generated; add bin/ lib/ .reasonix/ to .gitignore and rerun repo-sanity.

2026-06-13 stopless prompts md-source migration
- Move stopless default prompt text from Rust hardcode to source asset under code tree, build copy to dist, runtime read from dist.
- Must keep single owner and add tests for round1/2/3 + schema mention + next-check mention.
2026-06-13 stopless schema closed-loop
- Added Rust red tests for guidance-before-gate, missing-schema-no-count, and missing-schema-reissues-guidance.
- stop_message_cli_projection_seed now injects stopless_schema_guidance into continuationPrompt and appends next-round schema-check hint.
- Rust evidence: targeted cargo tests passed for cli seed + stop-message persist/gate contract.
2026-06-13 function-map audit start: scanning architecture docs, registry, gates, gaps, and risk surfaces.
2026-06-13 plan requested: create actionable function-map audit remediation plan + audit current state against plan.
2026-06-13 new sample audit: process drift, not runtime bug
- Evidence from screenshot: agent wrote `plan requested: create actionable function-map audit remediation plan + audit current state against plan`, then read `docs/agent-routing/10-runtime-ssot-routing.md` and `docs/goals/function-map-longtail-closeout.md`, then stated `计划落盘后，做审计：现状 vs 计划`.
- Conclusion: execution drifted from the active `apply_patch` real-sample workflow into a separate function-map audit branch.
- Correct branch for this slice stays fixed: red test first -> shape-only repair -> green -> live replay old/new samples. No function-map audit work should interleave until this slice is closed.

- 2026-06-13 stopless 闭环继续收口：Rust `stop-message-core` 已改为 stop schema 缺项枚举、finished/blocked 补齐即停、continue_needed 缺 next_step 强制补齐；三轮只作为 no_change loop guard，不再按普通 used 计数封顶。
- 2026-06-13 stopless continuation guidance 已由 `servertool-core::cli_contract` 强制前缀注入 stop schema guidance，并要求下一轮先检查 schema，再决定是否继续工具调用。
- 2026-06-13 Rust gate 证据：`stop-message-core` 51/51、`servertool-core` 252/252。下一步：全局安装、重启 5555/5520/10000、在线验证 stopless 行为。
- 2026-06-13 apply_patch live probe:
  - `/v1/responses` without explicit `tools` only produced plain text (`I’m unable to directly use apply_patch from here`); this probe is not sufficient to prove server tool path failure because the request itself did not declare `apply_patch`.
  - `/v1/responses` with explicit `tools=[{type:function,name:apply_patch,...}]` and `tool_choice=required` on `127.0.0.1:5555` returned a valid `function_call`:
    - `name=apply_patch`
    - `arguments={"patch":"*** Begin Patch\n*** Add File: tmp/apply_patch_smoke.txt\n+hello from smoke\n*** End Patch"}`
  - Conclusion: apply_patch tool path is alive at the HTTP server/runtime level; current screenshot failure is more likely request-shape/tool-declaration loss on the real Codex/client path, not intrinsic inability of the server to emit apply_patch tool calls.
- 2026-06-13 server function-map boundary closeout:
  - Existing function-map entries for `server.responses_handler_family`, `server.responses_request_handler_bridge_surface`, and `server.responses_response_handler_bridge_surface` were stale: they still described server-side protocol projection/bridge semantics too loosely.
  - Updated function-map + verification-map to state the intended boundary explicitly:
    - server handlers are HTTP transport adapters only
    - request bridge is opaque request facade only
    - response bridge is opaque SSE/body handoff facade only
    - protocol parsing/conversion/projection must stay in Hub Pipeline/native owner
  - Added gate `scripts/architecture/verify-server-function-map-boundary.mjs`, wired into `package.json` and `verify:architecture-ci`.
  - Verified:
    - `npm run verify:server-function-map-boundary` PASS
    - `npm run verify:function-map-compile-gate` PASS
  - Current root-trace lead for chat-shaped tool leakage:
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`
    - `normalize_chat_envelope_tool_calls(...)`
    - `normalize_tool_definition(...)`
    - this is the current strongest candidate for where `tools[].function.*` is being canonicalized into chat-shaped tool definitions before later direct misuse.

- 2026-06-13 stopless 闭环最终推进：修复误用 `npx jest` 的测试入口，改用 `npm run jest:run`（node --experimental-vm-modules）后，`tests/servertool/stop-message-auto.spec.ts` 51/51 通过（8 skipped），`tests/servertool/stop-message-compare-context.spec.ts` 6/6 通过。
- 2026-06-13 handler 薄壳新增 no-change glue：`stop-message-auto.ts` 计算 observationHash/toolSignatureHash，并基于上一轮 compare context 的 observationHash/observationStableCount 生成 `schemaGate.no_change_count`，把“三轮只作无变化 loop guard”真正闭到上游状态链。

2026-06-13 direct server-side request shaping removal in progress
- Removed server direct preflight payload contract/relay checks and direct model overrides from http-server/index.ts.
- direct-passthrough-payload.ts is now object-only guard; direct request body must pass through unchanged.
- Red tests updated toward new direct contract: no stream synthesis, no model overwrite, no tool/system/history rewrite.
- Deleted dead server shim: src/server/runtime/http-server/responses-direct-contract-error.ts (no remaining references after direct preflight removal).
- Moved Responses direct SSE protocol checks (allowlist/keepalive/required_action normalization entry) behind responses-response-bridge facade; server handler no longer owns those helpers.
- Added bridge-surface gate to forbid local server tokens for Responses SSE allowlist/keepalive/required_action parsing in handler-response-utils.ts.
- Moved Responses JSON required_action client-payload normalization behind responses-response-bridge facade; handler-response-utils no longer decides when to project body-level required_action.
- Trace note: direct server path does not call coerce_standardized_request_from_payload/normalize_tool_definition; current chat-shaped tool source remains Rust standardized owners, but direct contamination must come from another ingress/store/projection path.
- Moved Responses request-side stream/system-prompt mutation behind responses-request-bridge facade; responses-handler.ts no longer owns `payload.stream = true` or `applySystemPromptOverride(...)`.
- Added request-side bridge-surface gate to forbid local stream/system-prompt mutation tokens in responses-handler.ts.

## 2026-06-13 direct/server boundary cleanup
- Resumed from handoff: direct request-shaping already removed from server runtime; next focus is handler protocol surface shrink + continuation/store tool-shape contamination trace.
- Evidence from code: plan_responses_handler_entry() only decides mode (submit_tool_outputs/scope_materialize/none), not standardized_request coercion; current chat-shaped tools leak is likely later in store/materialize/projection, not entry planning.
- Next actions: audit handler-response-utils remaining Responses semantics, audit responses-handler remaining bridge-only mutations, add red test for continuation/store preserving direct tool schema.
- 2026-06-13: direct-owned scope continuation fixed at store owner: materializeLatestContinuationByScope now dispatches direct entries to remote restore; native restore skips tool reinjection for direct owner; wrapper now passes continuationOwner through to native and preserves released prefix as side-channel only for direct.
2026-06-13 function-map audit remediation plan added at docs/goals/function-map-audit-remediation-plan.md.
Confirmed current audit baseline: 28 feature entries in function-map, 28 in verification-map, responses request/response bridge surfaces already registered, but parser-clean map truth and explicit functional owner fields are still missing.
2026-06-13 function-map owner schema baseline landed. docs/architecture/function-map.yml now carries owner_kind + owner_scope across 62 features; docs/architecture/function-map.yml and docs/architecture/verification-map.yml are YAML-parseable again. Added scripts/architecture/verify-architecture-function-map-parseable.mjs and wired it into verify:function-map-compile-gate + verify:architecture-ci. Current owner_kind distribution: rust_ssot=29, ts_runtime_owner=15, server_projection=10, ts_bridge=4, provider_runtime=2, ts_entry_shell=2. Remaining audit gap: hidden-owner full-repo scan and warning cleanup for server.responses_request_handler_bridge_surface forbidden mention.

## 2026-06-13 responses handler bridge closeout slice
- `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts` had a false isolation gap: it mocked the bridge barrel, but `handler-response-utils.ts` imports `responses-response-bridge.js` directly. That caused the test to load real native/store paths and report `CustomGC` open handles.
- Fixed test isolation by mocking `responses-response-bridge.(js|ts)` directly and providing the exact named exports used by the handler; `--detectOpenHandles` now exits cleanly.
- Further shrank server boundary: `handler-response-utils.ts` no longer derives continuation persistence `providerKey/continuationOwner/sessionId/conversationId/timingRequestIds` locally before calling `persistResponsesConversationLifecycleForHttp(...)`; that assembly now happens inside `responses-response-bridge.ts`.
- Further shrank server boundary again: local SSE terminal-state parser/state-machine update for `response.completed` / `response.done` was removed from `handler-response-utils.ts`; terminal-state inspection now lives behind `inspectResponsesTerminalStateFromSseChunkForHttp(...)` in `responses-response-bridge.ts`, and the single-bridge gate now forbids reviving `updateSseTerminalTrackerFromChunk(...)` in server TS.
- Request-side helper shrink continued: `responses-handler.ts` no longer owns local `readResponsesSessionId`, `readResponsesConversationId`, `shouldPersistResponsesConversation*`, or `readResponsesResponseId`; those helpers now live behind `responses-request-bridge.ts`, and the single-bridge gate forbids reviving them in server TS.
- Response-side logging helper shrink continued: `handler-response-utils.ts` no longer owns local SSE frame summary parsing or provider-protocol hint detection for usage/logging; those parsers now live behind `summarizeResponsesSseFrameForLogForHttp(...)` and `resolveResponsesProviderProtocolHintFromSseFrameForHttp(...)` in `responses-response-bridge.ts`.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 responses handler single-bridge closeout goal prompt
- Created implementation doc at `docs/goals/responses-handler-single-bridge-closeout-plan.md` so the next `/goal` can stay short while still pointing to one executable source of truth.

2026-06-13 responses handler bridge closeout slice 2
- Moved remaining server-side Responses force-SSE body classification (`response` vs `chat.completion`) behind `prepareResponsesJsonBodyForSseBridgeForHttp(...)` in `src/modules/llmswitch/bridge/responses-response-bridge.ts`; `handler-response-utils.ts` no longer keeps local `isResponsesJsonBody` / `isChatCompletionJsonBody`.
- Moved probe-level continuation inspection behind `inspectResponsesContinuationProbeForHttp(...)`; server handler no longer owns local `tool_calls` / `required_action` probe inspection helpers.
- Single-bridge gate updated to forbid reviving those local helpers in `handler-response-utils.ts`.
- Focused test isolation closed: force-SSE suite now mocks `server/utils/finish-reason.js`, and `--detectOpenHandles` exits cleanly.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --detectOpenHandles --runTestsByPath tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 responses handler bridge closeout slice 3
- Request-side handler no longer keeps local `responseIdFromPath -> payload.response_id` prewrite, local `/v1/responses*` conversation-management branch checks, or local `responsesRequestContext` fallback assembly; moved into request bridge via `shouldManageResponsesConversationForHttp(...)`, `buildResponsesRequestContextForHttp(...)`, and `attachResponsesRequestContextToResultForHttp(...)`.
- Response-side client-close continuation policy no longer branches purely in server TS; moved behind response bridge via `planResponsesContinuationCloseActionForHttp(...)` and `shouldRepairResponsesContinuationTerminalForHttp(...)`.
- Single-bridge gate updated to forbid reviving request-side local `pipelineEntryEndpoint === '/v1/responses*'` checks and `responseIdFromPath` prewrite.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 responses handler bridge closeout slice 4
- Response-side stream-end terminal repair / continuation repair / incomplete-error decision no longer branches purely in server TS; moved behind response bridge via `planResponsesStreamEndRepairForHttp(...)`.
- Handler still owns stream write / res.end / snapshot / logging / timers, but the Responses-specific decision of “need terminal repair?”, “need continuation repair?”, “need incomplete error projection?” is now bridge-owned.
- Verified:
  - `npm run verify:responses-handler-single-bridge-surface` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts` PASS
  - `git diff --check` PASS

2026-06-13 function-map audit check
- Current map baseline: 62 function-map features, 62 verification-map features.
- Gates green: `verify:function-map-compile-gate`, `verify:architecture-owner-queryability`, `verify:architecture-feature-map-growth-discipline`, `verify:architecture-provider-specific-leaks`, `verify:architecture-thin-wrapper-only`, `verify:architecture-error-chain-bypass`, `verify:architecture-metadata-leak-boundary`, `verify:architecture-nonadjacent-conversion`, `verify:architecture-forbidden-path-growth`.
- Residual loophole: `tool.apply_patch_freeform_contract` has no `src/sharedmodule` source anchor; only test/script anchors exist.
- Residual warning: `verify:function-map-boundary-mentions` warns on `server.responses_request_handler_bridge_surface` because `clearResponsesConversationByRequestIdForHttp` appears in a forbidden path.
- User rule to keep: server handlers must not own protocol parsing; protocol normalization/parsing stays in bridge/native owner layers.
2026-06-13 responses handler bridge closeout slice 5
- moved response-side client-close cleanup eligibility, terminal-event requirement gating, and probe finish_reason resolution behind responses-response-bridge helpers
- single-bridge gate PASS; root tsc PASS; focused jest PASS: required-action-split-frame, force-sse-json-responses, responses-continuation-store, direct-server-contract.red
2026-06-13 responses handler bridge closeout slice 6
- moved failure-to-clear continuation policy (`sse_stream_error` / `sse_incomplete` / `json*`) behind responses-response-bridge helpers; server now only executes clear action
- verify PASS: single-bridge gate, root tsc, focused jest x4 after reason-string removal from handler

2026-06-13 latest stopless sample audit
- Audit scope: latest `/Volumes/extension/.rcc` provider samples + 5555 session truth, specifically checking whether bad stop schema or missing schema guidance caused extra stopless calls.
- Verified negative evidence: latest MiniMax 5555 sample dirs (`req_1781338094550_ffce7713`, `req_1781337644140_d9709ce2`, `req_1781337206630_f91830d0`, `req_1781336510838_87340d58`) are not authoritative stopless samples. Their `__runtime.json` only contains request/provider metadata and does not contain `stopMessageState`, `serverToolLoopState`, `stopMessageCompareContext`, `observationStableCount`, `continuationPrompt`, or stop-schema fields.
- Verified old stopless session evidence: `/Volumes/extension/.rcc/sessions/127.0.0.1_5555/session-stopless-*.json` from 2026-06-09 do contain stopless persisted state, and their `stopMessageText` already includes explicit guidance like '立即调用工具执行这个下一步'. This disproves 'missing guidance' for those samples.
- Verified old-budget evidence: those old stopless sessions still show `stopMessageUsed` climbing to 3 while guidance still asks to continue, matching the historical bug '3 rounds treated as main budget' rather than proving a latest schema/guidance regression.
- Verified latest 5555 session truth: only recent touched files are `session-rcc-OneStop.json` and `tmux-rcc-OneStop.json`; they record `stopMessageLastUsedAt`/`stopMessageUpdatedAt` (and tmux token stats) but no stop schema/guidance/compare-context payload. So current latest session truth is insufficient to prove latest extra calls were caused by bad schema or missing guidance.
- Current audit conclusion: no direct evidence from latest samples that incorrect schema or missing schema guidance caused extra stopless calls; most latest samples inspected are not true stopless closure samples. Need a fresh live stopless probe to close the evidence gap if stronger proof is required.
2026-06-13 responses handler bridge closeout slice 7
- fixed request-side submit_tool_outputs red tests to mock the actual request-bridge submodule surface instead of the old barrel-only path; locked current contract that `routeHint` travels via `pipelineInput.metadata.responsesResume`, while capture store only receives request context plus optional providerKey pin
- request-side timeout/error clear path now goes through `clearResponsesConversationOnHandlerFailureForHttp(...)`; `responses-handler.ts` no longer calls request-store clear API directly in timeout/error branches
- verify PASS: `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 8
- added single-bridge gate for local Responses SSE error payload literals in `handler-response-utils.ts` and moved those payload builders into `responses-response-bridge.ts`: missing-stream `sse_bridge_error`, structured upstream SSE error projection, generic SSE error envelope builder, and `upstream_stream_incomplete`
- repaired response-side terminal finish_reason fallback in bridge owner: when probe has a completed assistant message but no explicit finish_reason, `resolveResponsesTerminalProbeFinishReasonForHttp(...)` now resolves `stop`
- test/mocks updated so handler-response-utils response-bridge submodule mocks expose the new SSE error builders
- verify PASS: `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts`, `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `tests/sharedmodule/responses-continuation-store.spec.ts`, `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 9
- moved catch-side malformed Responses tool-history contract errorsample capture behind `captureResponsesInboundToolHistoryErrorsampleForHttp(...)`; `responses-handler.ts` no longer classifies `Tool history contract violated`, reads `details.toolHistoryContractViolation`, or writes `responses.inbound_tool_history_contract` payloads locally
- added request-bridge red/green unit `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts` to lock positive and negative cases at the bridge owner
- updated submit_tool_outputs handler mocks to expose the new request-bridge facade export so ESM import shape stays complete during handler blackbox tests
- verify PASS: `tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`, `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses continuation isolation correction
- Root-cause correction: current 2013 / orphan tool-result issue is not just `deltaInput` misuse; it also exposes a scope-design gap. Responses continuation restore is currently isolated by `port/group + session/conversation`, with `continuationOwner` recorded on the entry, but `entry protocol/endpoint` is not part of the scope key.
- Consequence: a chat/messages entry can incorrectly hit a stored Responses continuation scope, then internal bridge code (`buildChatRequestFromResponses`) receives Responses-owned resume semantics on the wrong entry and reconstructs history there.
- New rule to implement: Responses continuation restore/materialize must require triple isolation `entry protocol(or endpoint) + continuationOwner(direct|relay) + session/conversation(+port/group)`. `buildChatRequestFromResponses` remains bridge-only protocol conversion and must not own scope/owner inference.
2026-06-13 responses continuation isolation implementation slice
- Store layer updated: continuation scope key is now `entry:<kind>|owner:<owner>|session|conversation`, `recordResponse()` preserves captured session/conversation scope instead of clearing it when response-side args omit them, and `resumeConversation()` now rejects entryKind/owner mismatch instead of restoring across protocol ownership.
- New red/green coverage added in `tests/sharedmodule/responses-continuation-store.spec.ts`: chat entryKind cannot hit stored responses continuation; direct+relay records under one scope return `null` until caller specifies owner.
- Handler-path audit follow-up: the submit_tool_outputs handler specs were not exposing a production bug; they were stale against the new single-bridge split. Fix was to stop replacing the whole request bridge and instead mock `runtime-integrations` / `native-exports` thinly while providing an explicit `responses-response-bridge` export surface for handler imports.
- Verification PASS: `PATH=/opt/homebrew/opt/node@22/bin:$PATH NODE_OPTIONS=--experimental-vm-modules pnpm jest tests/sharedmodule/responses-continuation-store.spec.ts tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts --runInBand`; `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false`; `sh -lc 'git diff --check 2>&1'`.
2026-06-13 responses handler bridge closeout slice 10
- moved response-side SSE dispatch eligibility and `__sse_responses` payload-shape detection behind `hasResponsesSsePayloadForHttp(...)` and `shouldDispatchResponsesSseToClientForHttp(...)`; `handler-response-utils.ts` no longer owns local `hasSsePayload` implementation or local SSE dispatch decision logic
- kept compatibility export `hasSsePayload` in `handler-response-utils.ts` as a thin alias to the bridge owner so existing server imports continue to resolve without reviving local protocol logic
- updated response-bridge mocks in `handler-response-utils.force-sse-json-responses.spec.ts` and `handler-response-utils.required-action-split-frame.spec.ts` to expose the new facade exports
- verify PASS: `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts`, `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/sharedmodule/responses-continuation-store.spec.ts`, `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 11
- physically split server-side SSE implementation out of `src/server/handlers/handler-response-utils.ts` into `src/server/handlers/handler-response-sse.ts`; shared non-protocol carrier/header/snapshot helpers now live in `src/server/handlers/handler-response-common.ts`
- `handler-response-utils.ts` is now dispatcher + JSON path only; it delegates all force-SSE bridge and live SSE stream handling to `sendSsePipelineResponse(...)` and keeps `hasSsePayload` / client-carrier guard as thin compatibility exports
- single-bridge gate tightened to require `handler-response-sse.ts` / `handler-response-common.ts` imports and forbid reintroducing SSE helper/state-machine tokens into `handler-response-utils.ts`
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npm run verify:server-function-map-boundary`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 12
- removed the last direct Responses timeout SSE error-envelope write from `src/server/handlers/responses-handler.ts`; timeout-after-headers-sent now reuses generic `writeStartedSsePipelineError(...)` instead of locally shaping `event:error` payload
- single-bridge gate now forbids direct `res.write(\`event: error` in `responses-handler.ts`, so the server adapter cannot grow Responses-specific SSE error projection again
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts tests/server/handlers/responses-handler.started-sse-error.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 13
- moved request-side post-pipeline lifecycle orchestration out of `responses-handler.ts`: request-context capture gating is now `captureResponsesPipelineRequestContextForHttp(...)`, and result metadata attach + tool-call continuation seeding are now `finalizeResponsesPipelineResultForHttp(...)`
- `responses-handler.ts` no longer directly calls `shouldManageResponsesConversationForHttp(...)`, `captureResponsesRequestContextForHttp(...)`, `attachResponsesRequestContextToResultForHttp(...)`, or `seedResponsesToolCallResponseForHttp(...)`; those lifecycle decisions now sit behind the request-bridge facade
- single-bridge gate tightened to forbid those old direct handler-side calls from reappearing
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 14
- moved JSON-side chat usage normalization and request log context projection out of `src/server/handlers/handler-response-utils.ts` and into `src/modules/llmswitch/bridge/responses-response-bridge.ts` via `normalizeChatUsagePayloadForHttp(...)` and `buildResponsesRequestLogContextForHttp(...)`
- `handler-response-utils.ts` no longer owns local chat-usage numeric sanitation or request color/session context assembly; it only dispatches through the response bridge and writes client JSON/SSE transport
- single-bridge gate tightened to forbid `resolveNormalizedChatUsage`, `normalizeChatUsagePayload`, and `buildRequestLogContext` from reappearing in the server dispatcher
- test mocks for response-bridge blackbox suites were updated to expose the new facade exports so the import surface stays complete
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/sharedmodule/responses-continuation-store.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`, `git diff --check`
2026-06-13 responses handler bridge closeout slice 15
- moved request-side stream/scope runtime planning out of `src/server/handlers/responses-handler.ts` and into `src/modules/llmswitch/bridge/responses-request-bridge.ts` via `buildResponsesConversationPortScopeForHttp(...)`, `planResponsesHandlerStreamForHttp(...)`, and `prepareResponsesHandlerRuntimeForHttp(...)`
- `responses-handler.ts` no longer owns local port-scope parsing, stream intent derivation, request-start stream metadata assembly, or local continuation-expired / resume-client error projection branches; it now consumes one request-bridge runtime plan and stays on HTTP adapter / timeout / logging / pipeline dispatch responsibilities
- request-stream contract stayed locked by blackbox regressions: omitted `stream` still defaults to stream=true for `/v1/responses`, explicit `stream=false` still stays non-stream, and submit_tool_outputs start/error paths still preserve request-start logging + SSE error shape
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.request-start-log.spec.ts tests/server/handlers/responses-handler.accept-header-stream-contract.regression.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:server-function-map-boundary`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 16
- moved request-side protocol-scoped pipeline metadata assembly out of `src/server/handlers/responses-handler.ts` and behind `buildResponsesPipelineMetadataForHttp(...)` in `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- handler no longer locally shapes `providerProtocol: 'openai-responses'`, `responsesResume`, `responsesRequestContext`, or stream carrier metadata; it only merges generic request metadata with one request-bridge metadata block
- single-bridge gate now forbids those protocol-scoped metadata tokens from reappearing in `responses-handler.ts`
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.accept-header-stream-contract.regression.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 17
- moved request-side request-body metadata read/strip and `clientAbortSignal` extraction out of `src/server/handlers/responses-handler.ts`; both now sit behind `prepareResponsesRequestBodyForHttp(...)` and `buildResponsesPipelineMetadataForHttp(...)` in `src/modules/llmswitch/bridge/responses-request-bridge.ts`
- `responses-handler.ts` no longer directly calls `readRequestBodyMetadata(...)`, `stripRequestBodyMetadataForPipeline(...)`, or scans the client connection state symbol table for abort-signal projection; server stays on adapter/timeout/logging/pipeline dispatch
- single-bridge gate now forbids those request-body metadata helpers and inline abort-signal extraction from reappearing in `responses-handler.ts`
- verify PASS: `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/server/handlers/responses-handler.request-start-log.spec.ts tests/server/handlers/responses-handler.accept-header-stream-contract.regression.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts tests/server/handlers/responses-handler.request-timeout.blackbox.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:server-function-map-boundary`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 18
- moved response-side `responsesRequestContext` resolution behind `resolveResponsesRequestContextForHttp(...)` in `src/modules/llmswitch/bridge/responses-response-bridge.ts`; `handler-response-utils.ts` and `handler-response-sse.ts` no longer locally choose `result.metadata.responsesRequestContext ?? handler fallback`
- single-bridge gate now forbids local `?? options?.responsesRequestContext` / `?? args.responsesRequestContext` in the server dispatcher/SSE files
- added bridge unit coverage `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` for metadata-preferred resolution and fallback-only resolution
- verify PASS: `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts`, `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts`, `tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts`, `tests/sharedmodule/responses-continuation-store.spec.ts`, `tests/server/runtime/http-server/direct-server-contract.red.spec.ts`, `npm run verify:responses-handler-single-bridge-surface`, `npx tsc --noEmit --pretty false`
2026-06-13 responses handler bridge closeout slice 19
- moved direct passthrough SSE metadata/internal-carrier guard out of `src/server/handlers/handler-response-sse.ts` and into `assertDirectPassthroughResponsesSseMetadataIsolationForHttp(...)` in `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- `handler-response-sse.ts` no longer locally parses SSE `data:` payloads to inspect `metadata` / `providerKey` / `__rt` / internal carrier keys; server now only feeds `frame + requestId` into the bridge guard
- single-bridge gate now forbids local `isInternalMetadataCarrier(...)` and `assertDirectPassthroughSseFrameHasNoInternalMetadataControls(...)` from reappearing in `handler-response-sse.ts`
- added bridge unit coverage `tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` for rejecting internal metadata control fields and allowing ordinary provider metadata

2026-06-13 log color multi-color audit
- User reported same logical session/request shows multiple ANSI colors across `virtual-router-hit`, request completion, `session-request`, and `[usage]` lines.
- Initial root-cause evidence: `usage/session-request` path uses `resolveRequestLogColorToken(requestId, requestLogContext)` with canonical color-key precedence (`clientTmuxSessionId -> tmuxSessionId -> sessionId -> conversationId`), but `colorizeVirtualRouterHitLogLine()` still recolors from parsed text session (`[session]` or `sid=`) only. If printed `sid=` is a per-request alias while request context is tmux-scoped canonical key, the same request family splits into different colors.
- Existing tests cover usage tmux priority and standalone virtual-router-hit coloring, but there is no regression that locks one request family's `virtual-router-hit + request/response + usage` lines to the same canonical color when `sid` differs from tmux key.
- Fix applied: `src/server/utils/request-log-color.ts` now resolves virtual-router-hit color key from the registered request log context first (`req=...` -> canonical tmux/session color key), and only falls back to textual `[session]`/`sid=` parsing when no request context exists.
- Regression updated: `tests/server/utils/request-log-color.spec.ts` now locks that a registered request with canonical tmux color recolors `virtual-router-hit` consistently even when the line has no `sid=` field.
- Verification PASS: `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm jest tests/server/utils/request-log-color.spec.ts tests/server/runtime/http-server/executor/usage-logger.spec.ts --runInBand`; `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false`; `git diff --check`.
2026-06-13 continuation/build closeout
- llmswitch-core tsc now clean under Node 22.
- build-core.mjs rebuilt native + llmswitch-core dist successfully after restoring responses-openai bridge locals and stop-schema no_change_count typing.
- Next: rerun install-global.sh, then verify routecodex/rcc versions and /health.
2026-06-13 minimax 2013 + reasoning_effort follow-up
- Live 5555 sample `req_1781355000732_66c00b3b` proved the failing provider-request was chat/messages shape and malformed before upstream: assistant `tool_use call_function_ijxj1i99rcje_1` was followed by ordinary user text `[Image omitted]`, not matching `tool_result`; Minimax 2013 was correct upstream validation, not SSE hang.
- Root-cause guard tightened at two owners:
  1. `responses-openai-bridge.ts::buildChatRequestFromResponses()` now forbids dangling tool-call history instead of silently converting it to chat;
  2. Rust `shared_responses_conversation_utils.rs::resume_responses_conversation_payload()` now emits `meta.fullInput/fullInputItems`, matching restore/materialize so chat bridge can prefer full history over delta.
- Reasoning effort rule corrected in Rust route-select owner `req_process_stage2_route_select.rs`: precedence is now `configured thinking > original request reasoning_effort > route default`, matching Jason's requirement.
- Verification PASS: Rust `shared_responses_conversation_prepare_and_resume_json`; Rust `test_apply_route_selection_prefers_original_request_reasoning_effort_when_route_has_no_override`; Jest `tests/responses/responses-openai-bridge.spec.ts`; Jest `tests/sharedmodule/responses-continuation-store.spec.ts`; llmswitch-core `tsc --noEmit`.
2026-06-13 20:50 live 2013 root-cause recheck
- Revalidated against live sample ~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260613T205000732-340808-594.json and provider-request snapshot: this failure is not route pool/default/blacklist, not responsesResume/fullInput/deltaInput, and not server handler ownership.
- Replayed real sample through dist bridge chain: Responses -> Chat keeps call_function_ijxj1i99rcje_1 tool result intact; Chat -> Anthropic request also keeps it intact; req_outbound_stage3_compat then mutates that user tool_result into plain text [Image omitted].
- Concrete owner: rust req_outbound_stage3_compat/request_stage.rs strip_historical_media() via chat_process_media_semantics.strip_chat_process_historical_images(); false positive triggered because ordinary tool_result text contains literal strings like "image_url" / "video_url", which current string_contains_inline_media() treats as media.
- User claim update: "convertBridgeInputToChatMessagesWithNative is the unique owner" is false for this live sample. Valid owner chain is request-side outbound compat/media scrub after bridge conversion. Anthropic grouped tool_use/tool_result form is protocol-appropriate, but current direct proven bug is media scrub corruption, not yet pair-splitting semantics alone.
2026-06-13 plain-text tool_result media-key false positive verification
- Source-side Rust fix in chat_process_media_semantics.rs was already correct; the reason runtime still reproduced was stale compiled native, not a second semantic owner.
- After `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`, the same new-session `/v1/responses` HTTP replay returned 200 and provider payload preserved `tool_use call_docs_1 -> tool_result call_docs_1` with plain text `documentation mentioning "image_url" and "video_url" should stay plain text`.
- Runtime proof: no `[Image omitted]` placeholder and no dangling Anthropic tool_use remained in provider payload. Remaining blackbox Jest failure is loader/ESM environment (`native-virtual-router-bootstrap-config`), not this protocol regression.
2026-06-13 responses handler bridge closeout slice 20
- request-side relay-context normalization for `/v1/responses` is now formalized as contract coverage: `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts` was added to `scripts/tests/ci-jest.mjs`, `docs/architecture/function-map.yml`, and `docs/architecture/verification-map.yml` under `server.responses_request_handler_bridge_surface`.
- locked behavior: relay-owned `responsesRequestContext` must come from native `req_inbound` normalized snapshot, never from raw HTTP `payload.input` / `payload.tools`; duplicate tool history must collapse to normalized input, and `orphan_tool_result` must fail without raw-input fallback.
- verification PASS: `pnpm jest tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts tests/modules/llmswitch/bridge/responses-request-bridge.tool-history-errorsample.spec.ts tests/server/runtime/http-server/direct-server-contract.red.spec.ts --runInBand`, `npm run verify:responses-handler-single-bridge-surface`, `npm run verify:function-map-compile-gate`, `npx tsc --noEmit --pretty false`.
- live/runtime audit note: the latest `2335xx` diag failures are not evidence that server handler protocol logic regrew. Those samples already contain malformed request-side history (`function_call.arguments=""` -> `failed to parse function arguments: EOF while parsing a value at line 1 column 0`) before provider execution, so the remaining live regression owner is upstream of server adapter cleanup.

## 2026-06-14 stopless no-trigger audit
- Sample req_1781362576737_387b1d5f/provider openai-responses-minimax.key1-MiniMax-M3-20260613T225616737-341001-787: logs show hub.response=4411ms and finish_reason=stop, but no matching [servertool]/stop_watch/stop_compare event, so current hypothesis is Rust response effect plan did not emit servertoolRuntimeAction or bridge path bypassed conversion before orchestration.
- Existing Rust hub_pipeline_lib tests already cover Anthropic end_turn -> servertoolRuntimeAction; next gap is TS bridge/executor/prepared SSE integration.
- Mis-run note: node scripts/tests/ci-jest.mjs with a file argument expanded to a broad suite; ignore as stopless evidence. Use explicit node --experimental-vm-modules jest file command for focused ESM tests.

## 2026-06-14 HTTP_499 client_projection leak audit
- Symptom: live 5555 `/v1/responses` request `openai-responses-router-gpt-5.4-20260614T085154756-341633-1419` returned body `{"error":{"message":"client abort request","type":"invalid_request_error"}}` to client with `status=499 code=HTTP_499`, after upstream `asxs.crsa.gpt-5.4-mini` returned 499.
- Pipeline: client → 5555 → `router-direct` → provider HTTP → upstream nginx → upstream returns 499 + body → `extractStatusCodeFromError` parses 499 → `error.client_projection` (`mapErrorToHttp`) maps status 499 to "Upstream rejected the request" (4xx branch) → returned to client.
- 499 = nginx "Client Closed Request". The actual signal is **client-side abort**, not a real upstream error.
- Three owner gaps:
  1. `error.provider_failure_policy` classification: 4xx 499 + body "client abort request" does not match any `isProviderFailureClientDisconnect` / `isProviderFailureNetworkTransportLike` heuristic. Existing heuristics only fire on `client_disconnected`, `client_request_aborted`, `client_response_closed`, `client_timeout_hint_expired`, `CLIENT_DISCONNECTED` code, or `AbortError`. So 499 is reported as a normal 4xx, counted as provider failure, and may mark `affectsHealth: true` → triggers cooldown/3-strike.
  2. `error.client_projection` (`mapErrorToHttp` in `src/server/utils/http-error-mapper.ts`): 499 falls in `if (status >= 400 && status < 500)` → returns 499 + upstream body verbatim to client. It must NEVER return 4xx 499 to client; 499 is a transport cancellation, not a client-visible error.
  3. `error.client_projection` does not consult `isClientDisconnectAbortError` (in `executor-provider.ts`) or upstream body `client abort request` substring. No filter exists for "client closed request" class.
- Correct behavior for 499 + body "client abort request" / `HTTP_499`:
  - Classification: `affectsHealth: false`, no provider failure record, no cooldown, no `recoverable` reroute.
  - Client projection: do NOT echo 499 + body. Suppress response (SSE close / no body); emit `[http.error.meta]` log only.
- Owner verdict: project AGENTS says `error.client_projection` owner is `src/server/utils/http-error-mapper.ts` (server_projection) and must be the only place that decides client-visible error status. 499 projection rule belongs there. The classifier rule belongs in `error.provider_failure_policy` (`src/providers/core/runtime/provider-failure-policy-impl.ts`) and should delegate to existing `isProviderFailureClientDisconnect` plus a new "upstream 499 with client-disconnect body" branch.
- Action plan: red tests first.
  - red 1: `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts` — assert `mapErrorToHttp` does NOT return 499 + upstream body for `extractStatusCodeFromError`-derived 499 with body containing "client abort request"; assert projection status is 0/204/no body.
  - red 2: `tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts` — assert 499 + "client abort request" message classifies as `affectsHealth: false`, no `recoverable`, no error report.
  - Then fix: `mapErrorToHttp` adds a 499 + body check that consults `isClientDisconnectAbortError` (or a new `looksLikeUpstreamClientClosedRequest` helper); provider classifier adds the same upstream-499 branch in `isProviderFailureClientDisconnect` or `resolveProviderFailureClassification`.
  - Gate: `npm run verify:error-pipeline-contract`; `npm run verify:function-map-compile-gate`; live replay of the same `req_1781372094756_341633-1419` shape.

## 2026-06-14 SSE facade split slice
- Added dedicated SSE facade owner file `src/modules/llmswitch/bridge/responses-sse-bridge.ts`; it is a thin TS alias surface over `responses-response-bridge.ts` so `function-map-canonical-builder-definitions` can query a real owner without changing runtime behavior.
- `handler-response-sse.ts` now reads SSE projection/repair helpers from `responses-sse-bridge.ts` and keeps continuation/conversation lifecycle helpers on `responses-response-bridge.ts`; `handler-response-utils.ts` keeps the same split.
- Architecture/docs updated: new feature `server.responses_sse_bridge_surface`; `server.responses_response_handler_bridge_surface` narrowed to lifecycle/continuation ownership; `verify-server-function-map-boundary` and TS-owner whitelist updated accordingly.
- Static/red gate added: `tests/red-tests/server_responses_sse_surface_single_owner.test.ts` locks handler/index import boundaries so SSE symbols cannot drift back onto the lifecycle facade.
- Verification PASS:
  - `node --experimental-vm-modules jest tests/red-tests/server_responses_sse_surface_single_owner.test.ts tests/server/handlers/handler-response-utils.force-sse-json-responses.spec.ts tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts --runInBand`
  - `node scripts/architecture/verify-responses-handler-single-bridge-surface.mjs`
  - `node scripts/architecture/verify-server-function-map-boundary.mjs`
  - `npm run verify:function-map-compile-gate`
  - `npx tsc --noEmit --pretty false`

## 2026-06-14 provider error flow audit against Jason center-thesis
- Audit target thesis: provider execution errors should enter one unified policy center, accumulate strike/cooldown evidence, switch provider while alternatives exist, avoid client-visible interruption whenever route pool/default still has candidates.
- Current code truth diverges by path:
  1. relay / request-executor path: mostly aligned with unified policy. It loops attempts, tracks excludedProviderKeys, consumes `resolveRequestExecutorProviderFailurePlan(...)`, waits via unified queue, reroutes while candidates remain, and only throws `lastError` after attempts/pool exhausted (`src/server/runtime/http-server/request-executor.ts`).
  2. router-direct path: not aligned. Contract is explicit passthrough + hooks only (`src/server/runtime/http-server/router-direct-pipeline.ts`). `onProviderError` reports through unified error chain, but caller only uses plan for telemetry/cooldown bookkeeping; if retry plan does not request local retry, error is rethrown and reaches client (`src/server/runtime/http-server/index.ts:1623-1720`). No relay fallback after a direct provider error.
  3. provider-direct path: same divergence. It also calls `resolveRequestExecutorProviderFailurePlan(...)` only to report/classify, then rethrows to client (`src/server/runtime/http-server/index.ts:2050-2125`). No reroute because provider-mode direct is single-binding passthrough.
- Architectural tension confirmed:
  - Project/doc SSOT says "no independent error center; Virtual Router policy is the only strategy center" and direct/provider-direct/router-direct must stay passthrough + hooks only, fail-fast, no fallback, no Hub response conversion reentry.
  - Jason center-thesis says provider errors should prefer internal handling, counting, switching, and keep conversation alive as long as any provider/default remains.
  - These two are compatible only for relay/request-executor path today. They are NOT compatible for direct paths, because direct paths intentionally bypass the executor reroute loop.
- Current concrete leak points against thesis:
  1. client projection leak: `src/server/utils/http-error-mapper.ts` maps any `400 <= status < 500` to client-visible same-status error. So provider-origin 4xx (including misclassified transport-ish 499) goes straight to client.
  2. router-direct/provider-direct rethrow boundary: both direct paths call unified failure-plan/reporting, but they do not consume reroute decision except one local `retry_same_provider_once`/excluded-target loop inside router-direct. They never "fallback to relay" after send failure because contract forbids it.
  3. pool exhaustion final behavior: both relay and router-direct eventually throw `lastError` once pool exhausted/backoff budget spent. There is no documented/implemented "if route pool empty but default pool exists, automatically widen to default" second-stage route source in current host path. Any such widening must come from VR route selection truth, not host fallback.
- What is already aligned with thesis:
  - Error classification/reporting path is mostly centralized: provider/send/runtime/direct errors call `resolveRequestExecutorProviderFailurePlan(...)` -> `reportRequestExecutorProviderError(...)` -> provider reporter / router policy chain.
  - Unified blocking backoff queue exists and is used (`request-executor-error-action-queue.ts`).
  - Relay path excludes failed providers and reroutes while alternatives remain.
  - Pool-exhausted path does bounded wait and retry before surfacing final error.
- What is misaligned with thesis:
  - direct same-protocol router-mode ports default to direct (`sameProtocolBehavior ?? 'direct'`), so a large fraction of requests can bypass the only path that really honors internal switch-while-alternatives-exist.
  - ErrorErr06 client projection treats provider 4xx as immediately client-visible instead of first asking whether unified policy has exhausted all reroute candidates.
  - Some transport/cancellation-shaped upstream errors (e.g. 499 client-abort-style) are not normalized early enough, so they enter provider-failure/client-projection as ordinary provider 4xx.

## 2026-06-14 fresh-session vs old-session continuation probe
- Fresh live probe on `127.0.0.1:5555 /v1/responses` with new `session_id/conversation_id`:
  - turn 1 returned `200 requires_action` with upstream tool call `call_yyDS3dUpM2oueAzNiAJP8YN9`.
  - turn 2 submitted `function_call_output` for that call id and returned `200 requires_action` again, now with local `routecodex-servertool-cli` response/tool call instead of upstream 400.
- Conclusion: current failure is not "all new sessions still fail in the same way". Old polluted sessions still remain a separate class, but fresh sessions can pass the first continuation boundary now.
- Remaining caution: this probe does not prove the whole continuation chain is fixed end-to-end; it only proves the new session no longer reproduces the previous immediate `tool call result does not follow tool call` failure on the first followup turn.

## 2026-06-14 stopless 无感续杯 + 唯一 owner 审计（read-only）
- 用户要求：让 stopless 评估 schema，但模型可见续杯是“用户式追问/指令”，不暴露 schema / stopless / servertool / “系统替你调用工具” 的感知。CLI 投影与执行路径必须对模型无感。
- 唯一 owner 锁（来自 `docs/architecture/function-map.yml`）：
  1. `hub.servertool_stopless_cli_projection_seed`：`owner_kind=rust_ssot`，`owner_module=servertool-core/src/cli_contract.rs`，canonical builder `plan_stop_message_cli_projection_seed`；forbidden `src/server/runtime/http-server/executor`、`sharedmodule/.../servertool/handlers`。
  2. `hub.servertool_cli_projection`：`owner_kind=rust_ssot`，`owner_module=router-hotpath-napi/src`，canonical builder `build_servertool_cli_projection_01_from_hub_resp_chatprocess_03`；forbidden 同上。
  3. `hub.servertool_followup`：`owner_kind=rust_ssot`，`owner_module=router-hotpath-napi/src`，canonical builder `project_hub_resp_outbound_04_from_hub_resp_chatprocess_03`。
  4. stop schema gate：`stop-message-core/src/lib.rs:304` 的 `evaluate_stop_schema_gate`，是内部判定真源，决策面不动。
- request-side 工具治理：响应标准化在 `router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs:375` 的 `drop_stale_orphan_responses_tool_outputs`；这是请求侧消解“已决但未配对 tool output”的唯一 owner。stopless 无感续杯不能绕过它去 HTTP executor 手工裁剪。
- 周期链条（按闭环顺序，不允许跳节点）：
  1. `RespInbound`：provider/raw 解析。
  2. `RespChatProcess`：`servertool orchestrator` 命中 `stop_message_auto`（`engine.ts:107`）→ 调 Rust `planStoplessOrchestrationActionWithNative` 拿 stopless plan（`engine.ts:213-216`）→ `cli_projection` 或 `terminal_final`。
  3. `servertool_followup`：`backend-route-mainline-block.ts` 重建 followup（不直接改 executor；forbidden path）。
  4. followup 通过 `reenterPipeline` 重入 Hub req/resp process；`stop-message-auto.ts:573` 构造 `followup` 含 injection ops + metadata。
  5. 请求侧 Rust 标准化在 `standardized_request.rs:50` 用 `drop_stale_orphan_responses_tool_outputs(payload, input_items)` 处理 input；这是停少“积压的 function_call_output 重复进 input” 的关键。
  6. `stop-message-core` 内部 `evaluate_stop_schema_gate`（`lib.rs:304`）在每次 stop 后判定：缺失/不合法 → 续杯（`schema_missing_followup` / `schema_invalid_followup`），收敛 → `FailFast`；`count_budget=false` 时不计数（`lib.rs:677`、`lib.rs:710`）。
  7. 模型可见链路只走 `buildClientVisibleProjectionShellWithNative`（`cli_contract.rs:512`），输出 assistant `tool_calls: [{ name=exec_command, args={ cmd:"routecodex servertool run stop_message_auto --input-json '{...}'" }}]`，命名空间 “servertool” + “stop_message_auto” 是模型可读感知来源。
  8. 客户端执行 → `submit_tool_outputs`/`function_call_output` 回到 `req_inbound` 入口；response 链路与正常请求一致。
- 当前代码中“模型可感知真源”三处：
  1. `cli_contract.rs:394-405` 生成的 `execCommand` 文本暴露 `routecodex servertool run stop_message_auto`（用户要 no-op 化的根因之一）。
  2. `cli_contract.rs:694-737` 的 `read_stop_message_followup_text` 把 `stop schema guidance: ...` 明文注入 continuation_prompt（`schema_hint` 段），并拼上 `继续完成当前用户目标...必须调用可用工具继续执行...`（用户已经在前文要求把“系统替我总结/补工具”的措辞撤掉）。
  3. `stop-message-prompts.md` 仍写着“第一轮核对…本轮结尾必须按 stop schema 输出…下一轮仍要先检查 schema…不要暴露 stopless/校验过程”——明文出现 “stop schema / stopless / 校验” 三个关键字，模型必然看见。
  4. Rust 旧默认 `default_stop_message_execution_prompt`（`chat_servertool_orchestration.rs:33-45`）硬编码三段中文，绕过 `readStopMessageFollowupText` → `config.ts` 走的就是 `assets/stop-message-prompts.md`，与 Rust 字面量分裂。
- `continue_execution` 已是 noop 容器（`chat_servertool_orchestration.rs:1665-1753`）但 wire 模型是 `tool_outputs[].name=continue_execution`，不是 `exec_command`，且未走 `cli_projection` 路径（`engine.ts` 不调用）。这意味着现在的“续杯”至少存在三条互不相同的产物：a) `exec_command` 投影（`stop_message_auto`）；b) `continue_execution` tool_output（`plan_servertool_noop_outcome_json`）；c) 文本 injection（`append_user_text`）。任何“唯一无感续杯”都必须收敛到一条。
- 拟改 owner 与修改点（不在本回合动代码）：
  - A. `cli_contract.rs`（`hub.servertool_cli_projection` + `hub.servertool_stopless_cli_projection_seed` 双 owner 重合点）：
    - 把 stopless 的客户端 tool name 从 `exec_command` 改为中性的 carrier 名（待与用户确认；建议方向：`routecodex_continue` 或 `client_continue`，禁止保留 `servertool`/`stop_message` 字符串字面量）。
    - 同步改 `DENIED_CLI_MARKERS` 与 `validate_no_denied_cli_marker` 规则：把“暴露 servertool 命名字符串”列为新的 denied marker，避免旧名字回归。
    - `read_stop_message_followup_text` 不再把 `stop schema guidance:` 字面量、`必须调用可用工具继续执行` 强制拼入 `continuation_prompt`；改为把“缺什么字段”映射成“用户式追问句”给 TS 注入层。schema 仍由 stop-message-core 解析。
  - B. `stop-message-core` 不动 `evaluate_stop_schema_gate` 的判定分支；只在 `schema_missing_followup` / `schema_invalid_followup` 的 message 中由 `default_*_prompt` 引入新的“无感追问句”来源，源头是 md 资产，runtime 按 `used` 取 1/2/3 段（用户已经在前文要求“md 独立出来，运行时读取 md，而不是硬编码”）。
  - C. `stop-message-prompts.md`：删掉 `stop schema / stopless / 校验` 三词；改为三段用户口吻：
    - round1：先继续当前目标，先把还差哪一步讲清，然后继续。
    - round2：把今天要解决的最小一步说清楚，然后继续。
    - round3：把当前进展收尾写明（已完成 / 未完成 / 卡点），然后停止。
    - md 必须保留三段 markdown 围栏 `<-- stop_message_prompt:roundN:start/end -->` 兼容 `config.ts:43-45` 的解析。
  - D. `config.ts` 已按源码 md → dist md 路径解析，资产同步脚本 `scripts/copy-compat-assets.mjs:31` 已存在；确认 release build 链里有 `copy-compat-assets` 阶段（不在本回合验证；前文要求“编译后放 dist”已具备路径）。
  - E. `engine.ts` 收缩为薄壳：只把 `planStoplessOrchestrationActionWithNative` 的 action 转成 `cli_projection`，由 `cli-projection.ts` 调 Rust 投影；不允许 TS 写默认 prompt 字符串（map 备注已禁止）。
  - F. `drop_stale_orphan_responses_tool_outputs` 继续是请求侧唯一消化工具输出/function_call 的 owner；不要在 HTTP executor 加 stopless noop 特殊路径。
- 验证链（red→green→live）：
  - red:
    - `tests/servertool/servertool-cli-projection.spec.ts` 新增 stopless 投影断言：`function.name` 不再含 `exec_command`、`command` 不再含 `servertool run stop_message_auto`、`command` 不暴露 `continuationPrompt / schemaGuidance / stopreason`。
    - `tests/servertool/stop-message-auto.spec.ts` 新增：续杯注入句不含 `stop schema / stopless / 校验`；`evaluate_stop_schema_gate` 三个 reason 各自对应一段用户口吻；`count_budget=false` 时 `no_change_count` 不递增。
  - green: `npm run verify:servertool-rust-only` + `npm run verify:function-map-compile-gate` + focused Jest。
  - live: `request.openai-responses` 上复现当前“模型连停三次”样本，新样本必须 1) 第一次 stop → 自动注入一次用户式追问；2) 模型补了 schema → `stop_schema_finished/blocked/needs_user_input` 立即放行；3) 投影 tool name/命令不含 `servertool` 字样。
- 未做事项（本回合只读）：
  - 未改任何代码；worktree 当前 dirty 来自其它任务（`git status --short --untracked-files=all` 见 25+ 项），不在本任务边界内。
  - 未验证 `scripts/copy-compat-assets.mjs` 是否在 release build chain 实际被调用；这是后面“md 编译到 dist”的下一步 gate。

## 2026-06-14 direct path error reroute + candidate exhaustion closeout
- Source changes:
  - `src/providers/core/runtime/provider-failure-policy-impl.ts`: extended `isProviderFailureClientDisconnect` to recognize upstream 499 + `client abort request` / `client closed request`; extended `isProviderFailureHealthNeutral` so client_disconnect returns `affectsHealth=false`.
  - `src/server/utils/http-error-mapper.ts`: added `isClientDisconnectLikeForProjection` + dedicated branch in `mapErrorToHttp` that returns 204 + `CLIENT_DISCONNECTED` for client_disconnect-style 4xx, so 499 is no longer echoed to the caller.
  - `src/server/runtime/http-server/index.ts`: added `isClientDisconnectLikeError` helper; reworked `router-direct.onProviderError` consumer to honor `exclude_and_reroute` (and not lose it via the legacy guard), to mark `excludedProviderKeys` from `retryPlan.excludedCurrentProvider`, and to short-circuit `exclude_and_reroute` for `client_disconnect` so it never consumes reroute budget; new stage log `router-direct.unified_decision.applied`.
- Red/green verified:
  - `tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts`: 4/4 PASS
  - `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts`: 3/3 PASS
  - `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`: PASS
  - `tests/server/runtime/http-server/router-direct-pipeline.spec.ts`: 26/26 PASS (baseline preserved)
  - `tests/server/runtime/http-server/provider-direct-pipeline.spec.ts`: PASS
- Gates verified:
  - `verify:error-pipeline-contract` ok
  - `verify:function-map-compile-gate` ok (13 sub-gates)
  - `verify:architecture-error-chain-bypass` ok
  - `verify:architecture-provider-specific-leaks` ok
  - `verify:architecture-thin-wrapper-only` ok
  - `verify:provider-failure-ban-blackbox` PASS (live router failover exercises)
  - `npx tsc --noEmit` clean
- Out of scope (deferred): live replay of 5555 historical 499 sample, build/install/restart, MEMORY distillation. The plan file at `docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md` still names these as Phase D/F.
# 2026-06-14 direct continuation local-restore boundary
- Jason clarified the policy boundary: direct `/v1/responses` continuation must not do local scope restore/materialize, and restart must not reload persisted direct-owned continuation from local conversation store.
- Verified root cause in `sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.ts`: both `resumeLatestContinuationByScope()` and `materializeLatestContinuationByScope()` still matched `continuationOwner=direct`; persistence load/flush also kept direct-owned entries.
- Red tests added/updated in `tests/sharedmodule/responses-continuation-store.spec.ts`:
  - `direct-owned scope continuation must not local-restore remote previous_response_id by scope`
  - `restart simulation must not reload persisted direct-owned continuation by scope, while relay-owned continuation still reloads`
- Green after fix: direct-owned entries are skipped by scope restore/materialize and excluded from persistence load/flush; relay-owned scope continuation still reloads after restart simulation.

## 2026-06-14 virtual router hit log 审计（未实施改动）
- 用户诉求：每条 req/resp 打印 → 简洁 + reqId + 时间（重点 internal） + 同 session 同色 + 不白不黑不红（红留给错误），数字高亮色保留。
- 唯一修改点收口（4 块）：
  1. `sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.ts` 的 `emitVirtualRouterHitLog` — 实时 hit 块真源。当前 `timeColor=90m` (深灰/亮黑，违)，`stopColor=214m` (橙，route-color 不是 session-color)，缺 internal 时间。
  2. `src/server/runtime/http-server/executor/log-rollup.ts:emitRealtimeVirtualRouterHitLog` + 1m rollup 行（line 886）— 1m 聚合用 `ANSI_VR=208m` (硬编码橙，**违反"同 session 同色"**)，应按 row.sessionId 哈希。
  3. `src/server/runtime/http-server/executor/log-rollup-format-blocks.ts` — `ANSI_DIM=90m` (黑色家族) + `ANSI_WHITE=97m` (白色) + `ANSI_BAR=240m` (近黑) 全部违规，必须换为非黑白红的中性暗色（如 `\x1b[38;5;245m` / `244m`）。`ANSI_VR=208m` 与 `ANSI_USAGE=39m` 是普通橙/青可用作路由/usage 标签色（route 维度，非 session 维度，OK）。
  4. `src/server/runtime/http-server/executor/usage-logger.ts:logUsageSummary` + `src/server/utils/request-log-color.ts:highlightLogNumbers` — 数字高亮用 `ANSI_WHITE=97m`，违规。
- 真源现状：
  - 调色板 `src/utils/session-log-color.ts` SESSION_LOG_COLOR_PALETTE 22 色已无 30/37/90/97/31，合规。
  - hit 实时块已带 `req=<id>` + `sid=<id>`，session 哈希上色（合规）。
  - usage 实时块已带 `req=` + `total/external/internal` + 数字白高亮（白违）。
  - 缺：internal 时间（仅 usage 块有，hit 块无），B 1m 聚合未按 session 分色。
- 命名 + map 锁：建议新增 `feature_id: log.virtual_router_hit_session_color` + `log.usage_console_palette` 入 `docs/architecture/function-map.yml`，将 4 块收口到 `log-rollup-format-blocks.ts` 作为唯一 ANSI 真源。
- 红测建议：focused Jest `tests/server/runtime/http-server/executor/log-rollup.spec.ts` 1m 行分色；`tests/sharedmodule/virtual-router-hit-log.spec.ts` 时间/内部耗时；`tests/server/runtime/http-server/executor/usage-logger.spec.ts` 数字色断言；新 `tests/server/runtime/http-server/executor/log-rollup-ansi-palette.spec.ts` 锁 ANSI 调色板不含 30/37/90/97/31。
- 等 Jason 确认后实施。

## 2026-06-14 direct SSE incomplete close audit
- Owner confirmed: src/server/handlers/handler-response-sse.ts incomplete branch wrote SSE error but skipped logResponseCompleted, so failure was not formally closed and usage could retain finish_reason=unknown.
- Live symptom matched: [response.sse.stream] upstream_stream_incomplete followed by usage/session rollup with finish_reason=unknown.
- Fix in progress: add red test + incomplete branch completion closeout with explicit failure reason.

## 2026-06-14 direct apply_patch / continuation audit
- Direct `/v1/responses` provider runtime had two concrete issues in `src/providers/core/runtime/responses-provider.ts`:
  1. same-protocol direct `submit_tool_outputs` still posted to plain `/responses` instead of `/responses/{id}/submit_tool_outputs`;
  2. `processIncomingDirect()` had been changed to unconditionally run `sanitizeResponsesProviderOutboundBody()`, which cloned ordinary direct payloads and violated the direct passthrough identity contract.
- Fix applied:
  - direct submit path now detects `entryEndpoint='/v1/responses.submit_tool_outputs'` and targets native upstream submit endpoint;
  - direct payload sanitize now runs only when the current body actually contains Responses `reasoning` items with `content`/`encrypted_content`, otherwise the original body object is preserved;
  - direct submit path reuses the already-decided body and skips the second sanitize pass.
- Verified:
  - `npm run jest:run -- --runInBand --runTestsByPath tests/providers/runtime/responses-provider.direct-passthrough.spec.ts` PASS (12/12)
  - `npm run verify:responses-direct-tool-shape-contract` PASS
  - `npm run jest:run -- --runInBand --runTestsByPath tests/server/runtime/http-server/provider-direct-pipeline.spec.ts` PASS
- Continuation-related conclusion: the recent direct continuation/submit收口确实把“额外 sanitize”带进了普通 direct path；这不是 relay 修复，而是 direct 污染。

## 2026-06-14 relay apply_patch owner narrowing
- Live-shape red test added to `tests/responses/responses-openai-bridge.spec.ts` for:
  - assistant text
  - `custom_tool_call(apply_patch)` / output
  - later `function_call(exec_command)` / output
  - reopened second `apply_patch`
- Result: this request-side `Responses -> OpenAI chat` normalization test is PASS, so the relay apply_patch `2013 / orphan_tool_result` live failures are likely *after* `buildChatRequestFromResponses()`, not in the earliest request-history normalization step.
- Next owner slice to inspect: OpenAI chat -> Anthropic/MiniMax compatibility conversion, or later continuation/store materialization around relay-owned history.
## 2026-06-14 relay apply_patch continuation narrowing

- direct 侧已确认的两个修复点：
  - `src/providers/core/runtime/responses-provider.ts` direct submit continuation 必须命中 `/responses/{id}/submit_tool_outputs`
  - direct 普通 passthrough 不能无条件走 `sanitizeResponsesProviderOutboundBody(...)`
- 新增红绿证据：
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
  - 用例 `RED: reopened apply_patch after exec_command stays tool-ordered after submit_tool_outputs resume`
  - 结果：PASS。说明 conversation store 单独看时，`apply_patch -> exec_command -> apply_patch` 的累计 submit resume 历史没有坏。
- 本地真实链路脚本已验证：
  - `captureResponsesRequestContext -> recordResponsesResponse -> resumeResponsesConversation -> prepareResponsesHandlerRuntimeForHttp -> buildChatRequestFromResponses -> buildAnthropicRequestFromOpenAIChat`
  - reopened `apply_patch` 样本在这条链上 `openaiViolation=null` 且 `anthropicViolation=null`
  - 说明 owner 进一步排除：不是 conversation store，不是 handler submit resume，不是 Responses->OpenAI chat 基础映射，也不是 OpenAI chat->Anthropic 基础映射。
- 额外真实约束：
  - continuation store resume 会校验 `matchedPort/routingPolicyGroup`；脚本首次失败是因为未带 port scope，补齐后恢复正常。
- Jest harness 收口进展：
  - `src/modules/llmswitch/core-loader.ts` 已补 `importCoreModule()` 在 Jest 环境下优先 `import(sourcePath)`，并在 `require(dist ESM)` 报 `Must use import to load ES Module` 时回退到动态 `import(modulePath)`
  - 小探针已绿：`importCoreDist('native/router-hotpath/native-virtual-router-bootstrap-config')` 可拿到 `bootstrapVirtualRouterConfig`
  - 但 `responses-handler.anthropic-tool-history.blackbox.spec.ts` 仍被第二个 harness 点挡住：`native-shared-conversion-semantics not available`（同步 native export 路径）
- 当前最可疑 owner：
  - `sharedmodule/llmswitch-core` request_inbound 之后真正二次改工具历史的 native bridge action / sync native export 链
  - 需要继续查 `captureReqInboundResponsesContextSnapshotJson` / `native-shared-conversion-semantics` 的 Jest/source 同步装载，以及 live 路径里是否还有第二处工具历史重写。
## 2026-06-14 log review target
- owner split: request-log-color vs log-rollup direct resolveSessionAnsiColor vs usage white highlight
- goal: same session color across virtual-router-hit / session-request / usage / port prefix normal lines; no white/red/gray/black for normal session lines; compact default layout; abnormal timings still visible
## 2026-06-14 longcontext overflow audit
- symptom: 5520 longcontext session hit model context overflow for gpt-5.4-mini path
- need verify route threshold budget vs provider real max context vs accumulated history/continuation accounting
- direct apply_patch follow-up: evaluateDirectRouteDecision exists but not wired into live router-direct path; likely gap between gate and runtime

## 2026-06-14 P4-A wiring final closeout + out-of-scope stopless gap

### P4-A status（direct-path 错误流 P4-A wiring 收口）
- Rust 唯一 owner：lib.rs line 61 加 `mod primary_exhausted_to_default_pool_blocks;`（按字母序）
- 新文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/primary_exhausted_to_default_pool_blocks.rs`
  - `#[napi(js_name = "planPrimaryExhaustedToDefaultPoolJson")] pub fn plan_primary_exhausted_to_default_pool_json(input_json: String) -> NapiResult<String>`
  - 单点代理 `virtual_router_engine::routing::primary_exhausted_to_default_pool::plan_primary_exhausted_to_default_pool`
- 两个文件头补 `// feature_id: virtual_router.primary_exhausted_to_default_pool` 锚点（owner queryability gate 接受）
  - `virtual_router_engine/routing/primary_exhausted_to_default_pool.rs:1`
  - `primary_exhausted_to_default_pool_blocks.rs:1`
- function-map line 547 / verification-map line 275 完整登记 P4-A（owner_module / canonical_builders / required_tests / required_gates / forbidden_paths / notes）

### 验证证据
- `cargo build --lib`：0 errors / 302 warnings（warnings 预存 non_snake_case 与 never used）
- `cargo test --lib primary_exhausted_to_default_pool`：5 passed / 1676 filtered out（plan 5 个用例）
- `verify:error-pipeline-contract`：ok（provider-direct/router-direct provider failures enter ErrorErr hook before rethrow）
- `verify:provider-failure-ban-blackbox`：`"ok": true`（backupHits=4 / portIsolation 双侧切流验证）
- `verify:architecture-error-chain-bypass`：ok（74 files / 2 targets）
- `verify:architecture-provider-specific-leaks`：ok（99 files / 7 targets）
- `verify:architecture-thin-wrapper-only`：ok（69 files / 2 targets）
- `tsc --noEmit`：0 errors
- focused Jest 5 spec 一次 PASS：20 passed / 0 failed
  - `tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts`
  - `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts`
  - `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`
  - `tests/server/runtime/http-server/router-direct-pipeline.candidate-exhaustion.spec.ts`
  - `tests/server/runtime/http-server/provider-direct-pipeline.candidate-exhaustion.spec.ts`

### out-of-scope gap（不属本 plan，登记备查）
- `verify:function-map-compile-gate` 在 `hub.servertool_stopless_transparent_continuation`（stopless 域）与 `hub.servertool_stopless_cli_projection_seed`（反向）出现双侧注册不一致；与本 plan 主体（direct-path 错误流）无业务关联
- 验证：在 `stopless_orchestration_contract.rs` 加 1 行 `// feature_id: hub.servertool_stopless_transparent_continuation` 注释后，`verify:architecture-feature-id-anchors` PASS，但 `verify:architecture-feature-map-growth-discipline` 立即在新 fail（verification-map 反向缺 + stopless_cli_projection_seed 反向缺）——进入补洞循环，不在本 plan 责任面
- 已回退 `stopless_orchestration_contract.rs` 的 anchor 注入（git diff 干净）
- 本 plan 内 install-global.sh 因此未跑（被 build:min → function-map-compile-gate 链阻塞）；`~/.rcc/install/current` 仍是 `0.90.3064`，runtime dist 未变 → live replay 与 MEMORY 提炼未做
- 待立项新 plan：`docs/goals/architecture-feature-map-stopless-closeout-plan.md`（登记 stopless 双侧注册 + 全部 65 feature 三件套一致性收口，使 install-global.sh 能恢复执行）
- 同时登记原 plan §8 的另一条 SSE 收口 gap（`docs/goals/responses-second-candidate-stream-incomplete-finish-reason.md`）仍待立项
- 2026-06-14 21:31 CST
  - log color live mismatch root cause confirmed: formatter owners (`usage-logger.ts`, `log-rollup.ts`) were already emitting `\x1b[97m`, but live port-prefixed wrapper in `src/server/runtime/http-server/port-log-context.ts` stripped nested ANSI via `stripAnsiCodes(first)`.
  - fix applied at true live owner: preserve `first` when wrapping `[port:... group:...]` prefix; keep prefix color but stop removing nested white highlights.
  - live proof after global install `0.90.3065`: `~/.rcc/logs/server-5520.log` shows lines like `[port:5555 ...] [usage] total=^[[97m8219.0ms ... finish_reason=^[[97mtool_calls`, confirming white values survive port-prefix layer.
  - focused gates green: `tests/server/runtime/http-server/executor/usage-logger.spec.ts`, `tests/server/runtime/http-server/executor/log-rollup.spec.ts`, `tests/server/runtime/http-server/entry-port-snapshot-isolation.red.spec.ts`.

## 2026-06-14 apply_patch grammar 400 closure

- live failing sample confirmed from `~/.rcc/logs/server-5520.log`:
  - requestId `openai-responses-router-gpt-5.4-20260614T230414428-345124-2702`
  - `[port:5520 ...] [virtual-router-hit] ... thinking -> asxs.crsa.gpt-5.4`
  - `[router-direct.send] ... statusCode=400`
  - upstream error: `Invalid lark grammar ... unknown name: "begin_patch"`
- classification:
  - this sample is `5520` same-protocol direct.
  - root cause owner is request-side Rust `apply_patch` tool schema publication, not relay/store/SSE.
- true owner:
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/orchestrator.rs`
- fix truth:
  - `APPLY_PATCH_LARK_GRAMMAR` now publishes full canonical grammar (`begin_patch`, `end_patch`, hunks, `%import common.LF`) instead of truncated single-line definition.
- verification:
  - `cargo test -q -p router-hotpath-napi normalize_apply_patch_freeform_tool_schema --lib -- --nocapture` PASS
  - `node scripts/architecture/verify-apply-patch-freeform-contract.mjs` PASS
  - `RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5520/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 RCC_APPLY_PATCH_ONLINE_TIMEOUT_MS=180000 node scripts/tests/apply-patch-freeform-10000-online.mjs` PASS
  - online smoke result: `ok=true`, `customInputCount=4`, `functionArgumentPatchLeakCount=0`, `deltaStreamCount=0`

## 2026-06-14 apply_patch direct/relay audit progress

- sample `openai-responses-minimax.key1-MiniMax-M3-20260613T223253714-340912-698`
  - log truth: `[port:5555 ...] [virtual-router-hit] ... -> minimax.key1.MiniMax-M3`
  - no `[router-direct.send]`
  - provider returned `invalid params, tool call result does not follow tool call (2013)`
  - classification: relay/request-history -> provider chat projection issue, not direct
- sample `openai-responses-router-gpt-5.4-20260613T231359101-341020-806`
  - log truth: `[port:5555 ...]` + no `[router-direct.send]`
  - local error: `orphan_tool_result: bridge tool_result item references unknown or already-consumed call_id ...`
  - diag code: `hub_pipeline_context_capture_failed`
  - classification: local relay request-context capture reject before provider send
- sample `openai-responses-router-gpt-5.4-20260614T103025622-342061-1847`
  - log truth: `[port:5555 ...] [router-direct.send] ... statusCode=400`
  - upstream returned `No tool call found for function call output with call_id ...`
  - classification: `5555` same-protocol direct sample; proves `5555` is not inherently relay
- continuation/store truth:
  - `responses-request-bridge.ts` only local-resumes when continuation owner is not `direct`
  - `responses-conversation-store.ts` `resumeLatestContinuationByScope` / `materializeLatestContinuationByScope` both skip `continuationOwner === 'direct'`
- gate truth:
  - PASS `tests/modules/llmswitch/bridge/responses-request-bridge.request-context-normalization.spec.ts`
  - PASS `tests/server/handlers/responses-handler.anthropic-tool-history.blackbox.spec.ts`
  - FAIL `tests/sharedmodule/responses-continuation-store.spec.ts` at `fails fast when direct and relay continuations coexist under one scope without explicit owner`
  - this failing gate is useful evidence: direct/relay owner coexistence is not fully fail-fast yet
- response/SSE surface truth:
  - Rust client-visible Responses projection owner remains `hub_resp_outbound_client_semantics_blocks/client_tool_args.rs`
  - TS `responses-sse-bridge.ts` is currently a near-pure re-export facade over `responses-response-bridge.ts`
  - current red test + verify script (`server_responses_sse_surface_single_owner.test.ts`, `verify-responses-handler-single-bridge-surface.mjs`) explicitly require handler-side split imports, so this is a duplicate surface candidate, not yet a deletable duplicate implementation

## 2026-06-14 P4-A 全局 install 收口（修正旧结论）

### 事实校正
- 之前 note.md 写的 "本 plan 内 install-global.sh 因此未跑" 已被本轮推翻：
  - 上一轮已补 stopless anchor（`stopless_orchestration_contract.rs` / `stopless_goal_state_contract.rs` / `persisted_lookup.rs` / `servertool_core_blocks.rs` 行 1 注入 `// feature_id: hub.servertool_stopless_transparent_continuation`）。
  - `verify:function-map-compile-gate` 全 13 子 gate PASS（install 实跑证据）。
  - `path /opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` 成功，最终 dist 落到 `/opt/homebrew/lib/node_modules/routecodex` 版本 `0.90.3065`。
  - `~/.rcc/install/current -> releases/routecodex-0.90.3065-2026-06-14T131134Z`，runtime 已重启。
- 5555/5520/10000 `/health` 三端口 200 + `pipelineReady=true`，napi 二进制 mtime `2026-06-14T21:11`，dist mtime `2026-06-14T21:11`。
- 新 build 之后真实日志已确认 `server-5555.log` 21:13-21:23 区间 `HTTP_499|client abort request|primary_exhausted|default_pool` 命中数 = **0**（旧样本已不再 client-visible 499）。

### 仍未完成的运行态 gap
- `virtual_router.primary_exhausted_to_default_pool` Rust 端有 contract（`primary_exhausted_to_default_pool.rs` + `primary_exhausted_to_default_pool_blocks.rs` + `cargo test --lib` 5 PASS），napi 出口 `plan_primary_exhausted_to_default_pool_json` 已在 `target/release/router_hotpath_napi.node` 内。
- **但 host 侧（`src/` + `sharedmodule/llmswitch-core/src/`）当前没有任何消费点**：grep `planPrimaryExhaustedToDefaultPoolJson|planPrimaryExhaustedToDefaultPool|plan_primary_exhausted` 全空，runtime 实际不会触发 default pool 扩池。
- 修正 plan §0.3 (g) 现状：Rust contract 完备 + host wiring **未完成**；下次 plan 必须补 host 唯一消费入口。

### live probe 状态
- 候选切换（`switch=exclude_and_reroute`）在 5555/5520 已观察：21:13 install 后的实时日志里既有历史样本 `asxs.crsa.gpt-5.4 503 → 1token.key1.gpt-5.4 UPSTREAM_HEADERS_TIMEOUT → cc.key1.gpt-5.4-mini 429` 的级联切换证据（`/Volumes/extension/.rcc/log/config.toml/ports/5520/server-5520.log`）。
- `primary_exhausted -> default_pool` live probe **未做**（host wiring 缺失，无法触发）。
- 499 主动 abort live replay 计划下一步：本回合按 plan §6.5-P3 修正后的口径（"客户端收不到 `client abort request` / `HTTP 499` 子串"）执行。

## 2026-06-14 apply_patch direct/relay install closure

- 已执行编译/构建/全局安装/重启：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` PASS。
  - `routecodex --version` = `0.90.3065`，`rcc --version` = `0.90.3065`。
  - `127.0.0.1:5520/health`、`127.0.0.1:5555/health`、`127.0.0.1:10000/health` 均 `status=ok ready=true pipelineReady=true version=0.90.3065`。
- apply_patch direct/relay 在线验证：
  - 5520 direct：`RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5520/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 ... scripts/tests/apply-patch-freeform-10000-online.mjs` PASS，`customInputCount=4`，`functionArgumentPatchLeakCount=0`，`deltaStreamCount=0`。
  - 5555 relay/route：同脚本打 `http://127.0.0.1:5555/v1/responses` PASS，`customInputCount=3`，`functionArgumentPatchLeakCount=0`，`deltaStreamCount=0`。
  - 结论：当前安装产物已不再发送截断的一行 lark grammar，也没有把 apply_patch 回投成 JSON-wrapped `arguments`。

## 2026-06-15 direct-path-error-reroute-and-candidate-exhaustion plan P5 (function-map/verification-map sync) execution

- 触发：本轮按 `docs/goals/direct-path-error-reroute-and-candidate-exhaustion-plan.md` §6.5-P5 执行 verification-map 同步；handoff 摘要指出 `virtual_router.primary_exhausted_to_default_pool` 的 host 端 `allowed_paths` 仍残留 `src/server/runtime/http-server/direct-decision.ts`，且 `integration: []`，与 SSOT 不符。
- 落盘（无代码改动）：
  - `docs/architecture/function-map.yml`
    - `virtual_router.primary_exhausted_to_default_pool.allowed_paths` 移除 `src/server/runtime/http-server/direct-decision.ts`（host 不允许拥有 default-pool 合成逻辑）。
    - notes 追加：\"Host decision helpers (e.g. src/server/runtime/http-server/direct-decision.ts) live under error.execution_decision_consumer; they must not synthesize a default-pool target list.\"
    - `error.execution_decision_consumer.allowed_paths` 追加 `src/server/runtime/http-server/direct-decision.ts` / `direct-client-disconnect.ts` 与 `router-direct-pipeline.candidate-exhaustion.spec.ts` / `provider-direct-pipeline.candidate-exhaustion.spec.ts` 锚点。
  - `docs/architecture/verification-map.yml`
    - `virtual_router.primary_exhausted_to_default_pool.integration` 由 `[]` 改为 `cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib` + 两个 focused Jest；smoke 维持 `verify:function-map-compile-gate`。
    - `error.execution_decision_consumer.unit` 追加 `src/server/runtime/http-server/direct-decision.ts` / `direct-client-disconnect.ts`。
- 偏差记忆：handoff 摘要说\"need to remove misleading direct-decision.ts allowed path and add proper tests/Rust selection paths\"；本次按 host-only-consumer 解释保留 `direct-decision.ts` 但从 primary_exhausted 模块的 `allowed_paths` 中物理移除（落到 `error.execution_decision_consumer`），与 SSOT 一致。
- 剩余待跑（本轮按 handoff 余项执行）：
  1. `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate`
  2. `cd sharedmodule/llmswitch-core/rust-core && cargo test -p router-hotpath-napi primary_exhausted_to_default_pool --lib`
  3. 重跑 handoff 列出的 4 个 focused spec + `error-pipeline-contract`
  4. `npx tsc --noEmit --pretty false`
  5. `install-global.sh` + live replay/probe（5555 旧 499 样本、2+ 候选切 provider、client_disconnect 不可见、primary_exhausted -> default_pool）

## 2026-06-14T16:28:16.182Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260615T002737143-345365-2943:stop_followup
- sessionId: 019ec4d3-e92c-7240-b6a5-153aaac6d806
- stopReason: stopless strict_session_only + 透明续轮 已全绿：cargo 38+30+46+11、jest 23/23、verify:servertool-rust-only、function-map-compile-gate、tsc --noEmit、git diff --check 全过；5520 真实 200 response 无 required_action/exec_command/stop_message_auto/routecodex servertool run；log sid 锁 sessionId、decision=stop_schema_continue_next_step、A/B session 互不污染
- evidence: (1) cargo test -p servertool-core persisted_lookup/stopless/stop_message 全过；(2) cargo test -p router-hotpath-napi routing::metadata 11 过；(3) jest stop-message-flow-followup-reentry + stopless-sessionid-transparent + stop-message-runtime-utils.continuation 23/23；(4) verify:servertool-rust-only + function-map-compile-gate + tsc --noEmit + git diff --check 全绿；(5) 5520 实际 /v1/responses 200，body 无 required_action/exec_command/stop_message_auto/routecodex servertool run；(6) 10000/5555 log [virtual-router-hit] sid=stopless-onehop-...-xxx、decision=trigger reason=stop_schema_continue_next_step、used 0→1→2；(7) SessionId 隔离：A/B fresh sessionId 互不污染

stopless 续轮永远走 servertool-followup server-side reenter 透传 user-role 字符串消息，禁止任何 client-side tool_calls 壳或 CLI 投影；scope 锁 sessionId 一项即够，tmux/conversation/inject-* 全部忽略；测试断言要匹配新契约：reenter 期望被调用、N 次、body 末端是 user 字符串、无 routecodex servertool run 子串

## 2026-06-14T16:31:46.282Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260615T003059902-345401-2979:stop_followup
- sessionId: 019ec4d3-e92c-7240-b6a5-153aaac6d806
- stopReason: stopless 透明续轮收口闭环：sessionId-only 范围 + transparent reenter（无 exec_command/stop_message_auto/routecodex servertool run 投影），所有红测、cargo、verify gate、5520 在线 probe、session 隔离验证全部绿
- evidence: jest tests/servertool/{stop-message-flow-followup-reentry,stopless-sessionid-transparent,stop-message-runtime-utils.continuation}.spec.ts 23/23 pass; cargo test -p servertool-core persisted_lookup/stopless/stop_message 38+30+46 pass, cargo test -p router-hotpath-napi routing::metadata 11 pass; npm run verify:servertool-rust-only PASS; npm run verify:function-map-compile-gate PASS; npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit PASS; git diff --check clean; live 5520 probe model=gpt-5.5 sessionId=stopless-onehop-5520-1781454248192 响应体 status=completed output=[message{role:assistant,content=[output_text{text:"{...}"}]}] 无 required_action/exec_command/stop_message_auto/routecodex servertool run, request id 后缀 :stop_followup 证明 reenter 通道; session 隔离 sid=stopless-iso-A-* log 独立, sid=stopless-iso-B-* log 独立

透明 reenter 是 stopless 唯一诚实的路：cli_projection 会留指纹（routecodex servertool run / exec_command 在 tool_calls 里）模型能看见；用 schema-continuation prompt 作 user-role string reenter 同一 provider/model 让模型对 stopless 无感；sessionId-only 范围足够：conversationId 和 tmux 加了假命中，每个 session 独立持久化避免了之前 max session scope 的跨会话泄漏；最强证据是 probe 响应体本身：无 required_action + 无 exec_command + 无 stop_message_auto + request id 后缀 :stop_followup = 诚实的续轮

## 2026-06-15T00:39:00 stopless 反向证据 10000/5555
- 10000 model=gpt-5.5 sessionId=stopless-final-1781455081106-4ty5dy 504 servertool_followup_timeout (nested followup timeout 10000ms, EMPTY_ASSISTANT_RESPONSE); 5555 sessionId=stopless-final-1781455123581 504 同因; 两个 504 的响应体均无 required_action/exec_command/stop_message_auto/routecodex servertool run, 证明错误路径不被 stopless 投影污染
- 10000 log 显示 stop_message_flow 触发 decision=trigger reason=trigger_stop_schema_continue_next_step used=0→1→2, :stop_followup 后缀证明 reenter 通道; provider 路由 mini27 因 401 被自动 switch 到 minimax, 10s 内 provider 未回 = 错误路径只暴露 provider slow, 绝不暴露 stopless 内部工具

## 2026-06-14T16:52:48.123Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260615T005143718-345550-3128:stop_followup
- sessionId: 019ec4d3-e92c-7240-b6a5-153aaac6d806
- stopReason: stopless 收口闭环：scope 收为 sessionId、client 无工具投影、live 日志和实际响应均证明透明 user-input 续轮
- evidence: cargo persisted_lookup 38/stopless 30/stop_message 46/router-hotpath-napi metadata 11 全 pass；jest 3 spec 23/23 pass；verify:servertool-rust-only + function-map-compile-gate + tsc + git diff --check 全 exit 0；live 5520 /v1/responses 200 status=completed body 无 required_action/exec_command/stop_message_auto/routecodex servertool run；live 10000/5555 504 servertool_followup_timeout 错误体同样无 stopless 投影；10000 日志 sid=stopless-final-1781455081106-4ty5dy 显示 flow=stop_message_flow decision=trigger reason=trigger_stop_schema_continue_next_step 走 reenter requestId=:stop_followup used=0→1→2 透明续轮通道

stopless 收口的 client-visible 工具投影风险被单元测试断言读不到时（字段不在 type 里），改写断言必须以 payload 文本子串 + reenter 调用形态 + 末端 user role 三个维度联合锁，不能只断言 readStopMessageCliProjection 不存在；10000/5555 504 的错误码 servertool_followup_timeout 是 stopless 触发后的 provider followup 超时，不是 stopless 投影失败，可作为反向证据使用

## 2026-06-14T16:55:29.260Z stopless learned

- requestId: openai-responses-minimax.key1-MiniMax-M3-20260615T005424369-345570-3148:stop_followup
- sessionId: 019ec4d3-e92c-7240-b6a5-153aaac6d806
- stopReason: stopless 已收口为严格 sessionId 匹配 + 透明续轮；3 个完成标准逐项有 Rust/Jest 单测+gate+live HTTP 证据；TS 旧 cli_projection 分支与 routecodex servertool run 客户端恢复路径已物理删除；正反向 live 样本成对：5520 200 无工具投影，10000/5555 504 provider slow 无工具投影
- evidence: cargo persisted_lookup 38 passed + stopless 30 passed + stop_message 46 passed + routing::metadata 11 passed；jest stop-message-flow-followup-reentry + stopless-sessionid-transparent + stop-message-runtime-utils.continuation 23/23 PASS；npm run verify:servertool-rust-only + verify:function-map-compile-gate + tsc + git diff --check 全部 exit=0；live 5520 sessionId=stopless-final-1781455073644-sk6eic 200 body 无 required_action/exec_command/stop_message_auto/routecodex servertool run；live 10000 sessionId=stopless-final-1781455081106-4ty5dy 504 servertool_followup_timeout body 同无 stopless 工具投影 日志显示 stop_message_flow 触发 + :stop_followup reenter + used=0→1→2

live HTTP 验证必须区分 stopless 透明续轮（user input reenter，无工具投影）与上游 provider 慢（504 timeout），错误码可以相同但日志是否出现 :stop_followup 通道 + used 计数器递增是 stopless 真触发的金标准；外部端口 5520/10000/5555 共用同一进程，dist 重 build 后必须用 install-global 同步全局，但 Node 26 阻断脚本

## 2026-06-15 direct-path-error-reroute-and-candidate-exhaustion plan final closure (build 0.90.3068)

- 5 项 live 证据（已收集）：
  1. 5555/5520 live /v1/responses SSE 完成：response.created -> response.completed -> response.done，0 event:error，0 client abort request 文本。版本 0.90.3068，path: /opt/homebrew/opt/node@22/bin/node /tmp/sse_smoke.mjs 5555 5520
  2. 5555 SSE 客户端 abort 后服务端无投影：HTTP 200 建链，client abort 后 body 无 event:error、无 HTTP_499、无 client abort request，bodyTail 仅含 response.output_text.delta。服务端 response.sse.client_close 日志可观察。
  3. 5520 router-direct 5xx provider-switch 证据：sdfv.key1.gpt-5.4-mini 5xx -> attempt 1/6 -> 2/6 provider=... retry_same_provider_once 2000ms -> 仍 5xx -> attempt 2/6 -> 3/6 exclude_and_reroute 4000ms。决策点全在 ErrorErr05 决策消费中。
  4. primary_exhausted_to_default_pool 运行时契约：loadNativeRouterHotpathBinding().planPrimaryExhaustedToDefaultPoolJson 输入 2 tiers(primary/backup)、exhaustedTargets=[fwd.a,fwd.b] -> 输出 status=default_pool defaultPoolTargets=[fwd.c] fromTierId=backup fromTierPriority=100。证明 host 只消费 contract，绝不本地合成 fallback。
  5. 5555 旧样本在线重放 499 路径：当前 ~/.rcc/codex-samples/openai-responses/port-5555 已被自动清理无 2026-06-14T0851 旧样本。client_disconnect live abort 已替代证明 499 不可见。

- 门禁：verify:function-map-compile-gate 13/13 子 gate PASS（含修复后 boundary 跳过生成目录 + 容忍 ENOENT/EPERM）。verify:error-pipeline-contract / verify:provider-failure-ban-blackbox / verify:architecture-error-chain-bypass / verify:architecture-provider-specific-leaks / verify:architecture-thin-wrapper-only / verify:architecture-metadata-leak-boundary / verify:architecture-nonadjacent-conversion / verify:architecture-owner-queryability / verify:architecture-feature-map-growth-discipline / verify:vr-no-ts-runtime / verify:vr-no-fallback-semantics 全部 PASS。npx tsc --noEmit clean。

- 物理删除：error.provider_failure_policy.client_disconnect 前移；http-error-mapper policy-exhausted gate；router-direct / provider-direct 不再 report-only rethrow；host 不得 local default fallback。

- 缺口/未闭环：
  - 10000 live /v1/responses SSE 命中 servertool_followup_timeout（stop_message_auto nested followup 10s 超时），与 direct error 流无关；不影响 direct-path plan 收口。10000 504 的响应体已确认无 stopless 投影（详见 2026-06-14T16:31:46 块）。
  - direct pipeline 在 5xx 时已经走到 ErrorErr05 决策消费但还在重 build:min 期间产生大量 dist/coverage 清理噪音；本轮已干净后重启一次，验证 0.90.3068 health 全绿。

- 修复脚本（audit-safe）：scripts/architecture/verify-function-map-boundary-mentions.mjs listFiles 现在跳过 target/node_modules/dist/build/.git/.cache/coverage/.rcc/out/tmp/logs/release，且对扫描中消失的文件/目录 ENOENT/EPERM/EACCES/EBUSY 容忍。
## 2026-06-15 direct SSE apply_patch empty tool-call regression

- Symptom: direct `/v1/responses` SSE could still emit empty `function_call`/empty `arguments` for `apply_patch`, so client saw an empty tool call instead of usable patch input.
- Verified root cause: `src/modules/llmswitch/bridge/responses-response-bridge.ts` `normalizeResponsesSseFrameForClientForHttp()` returned early on `metadata.__routecodexDirectPassthrough === true`, which bypassed the Rust `projectResponsesSseFrameForClient` path entirely.
- Fix: removed the direct-passthrough short-circuit for SSE client projection only. Request path stays direct; client SSE still goes through the single Rust apply_patch projection owner.
- Red/green lock: `tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts` now includes `normalizes direct passthrough apply_patch SSE frames instead of returning empty function_call arguments`.
- Verification PASS:
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts --runInBand`
- Extra note: broader `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` still has pre-existing unrelated failures around tool-call continuation timeout and upstream incomplete stream error projection; not caused by this direct apply_patch slice.

## 2026-06-15 apply_patch SSE empty-args build/install/restart verification

- Current truth: `apply_patch` SSE empty-args issue is not reproducible after the direct SSE projection fix already present in tree.
- Verification PASS:
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/handlers/handler-response-utils.apply-patch-freeform-sse.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5520/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 node scripts/tests/apply-patch-freeform-10000-online.mjs`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH RCC_APPLY_PATCH_ONLINE_URL=http://127.0.0.1:5555/v1/responses RCC_APPLY_PATCH_ONLINE_MODEL=gpt-5.4 node scripts/tests/apply-patch-freeform-10000-online.mjs`
  - Results: 5520 `ok=true customInputCount=4 functionArgumentPatchLeakCount=0 deltaStreamCount=0`; 5555 `ok=true customInputCount=3 functionArgumentPatchLeakCount=0 deltaStreamCount=0`
- Build/install/restart PASS:
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`
  - `git diff --check`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`
  - Installed version: `routecodex --version = 0.90.3068`, `rcc --version = 0.90.3068`
  - Health: `127.0.0.1:5555`, `5520`, `10000` all `status=ok ready=true pipelineReady=true version=0.90.3068`

## 2026-06-15 latest 5520 apply_patch failure sample re-audit

- New evidence is from current rolling sample `~/.rcc/codex-samples/openai-responses/port-5520/openai-responses-router-gpt-5.4-20260615T034207750-345862-3440/provider-request.json` plus matching `server-5520.log` request `openai-responses-router-gpt-5.4-20260615T034207750-345862-3440`.
- Server-side truth for this sample: request completed `200`; `server-5520.log` shows normal `✅ [/v1/responses]` closeout, so this sample is not an upstream/provider execution failure.
- Request-history truth inside `provider-request.json`:
  - repeated `function_call name=apply_patch` with `arguments=""` at lines such as `874-881`, `906-913`, `1880-1887`;
  - matching `function_call_output` is just `aborted`;
  - same history block includes assistant text explicitly saying the tool call was still aborted and that the model was confused about JSON vs freeform/raw patch.
- Current judgment tightened:
  1. this latest sample is not “valid patch got truncated during execution”;
  2. it is “conversation history already contains empty apply_patch tool calls”;
  3. therefore the immediate failure surface is client-visible/tool-call projection or client/tool invocation semantics, not provider patch execution.
- Important distinction from older 5555 audit:
  - 5555 older sample had real patch-content execution failures (`context mismatch` / retry instability);
  - this 5520 latest sample shows empty-call history pollution before any real patch body exists;
  - do not collapse them into one proven root cause without a new red test per shape.
- Existing gate gap remains: current SSE regression only locks suppression/projection of empty apply_patch frames on one SSE path; it does not yet prove that every client-visible path and persisted history path can never reintroduce `function_call(name=apply_patch, arguments="")`.
## 2026-06-15 5520 latest apply_patch sample re-audit

- 最新样本：`~/.rcc/codex-samples/openai-responses/port-5520/openai-responses-router-gpt-5.4-20260615T034711276-345909-3487/`
- 已验证事实：
  - `provider-response.json` 为 `status=200`，且 `url=https://one.1token.xyz/responses`，说明这次不是 upstream/provider 执行 patch 失败。
  - 同一样本 `provider-request.json` 里存在多类空参数工具调用，不止 `apply_patch`：
    - 最早空调用是 `update_plan`
    - 其后有 `exec_command` 空参数
    - 也有 `apply_patch` 空参数与 `aborted`
  - 同一样本 outbound tool declaration 存在契约错位：
    - 描述写的是 freeform/FREEFORM
    - wire shape 却是 `type=function + parameters.patch`
- 继续缩小根因后确认：
  - request-side Rust owner `normalize_apply_patch_freeform_tool_schema(...)` 已正确把 `apply_patch` 规范成 `type=custom + format={type=grammar,syntax=lark}`
  - 后续 provider outbound Rust sanitize 仍会把 openai-responses 的 `custom apply_patch` 降级成 `function`
  - 唯一 owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_protocol_spec_semantics.rs`
- 2026-06-15 修复：
  - `normalize_provider_outbound_tool(protocol, tool)` 现在对 `protocol=openai-responses && tool.type=custom && name=apply_patch` 直接保留原 shape，不再降级为 function tool。
- 红测与 gate 证据：
  - 新增 Rust 用例：
    - `sanitize_provider_outbound_payload_preserves_custom_apply_patch_for_openai_responses`
  - 同类守卫回归：
    - `sanitize_provider_outbound_payload_converts_custom_apply_patch_for_openai_chat`
    - `sanitize_provider_outbound_payload_keeps_responses_function_tools_flat`
  - 三条 Rust 定向测试均 PASS
  - `npm run verify:apply-patch-freeform-contract` PASS
  - `npm run verify:apply-patch-regressions` PASS
- 关键纠偏：
  - 这轮新红测最初失败不是实现错误，而是 `format.definition` 断言把 JSON 反序列化后的转义字符串写成了多行未转义文本；修正断言后转绿。
- 当前剩余缺口：
  - 还没做 build/install/global restart/live replay，所以还不能宣称最新 5520 live 闭环完成。
  - 样本里“多类空参数工具调用”是否由此同一 contract 漂移引发，还需要重放新样本确认。
## 2026-06-15 servertool nested followup timeout removal

- 用户给出的 live 错误样本：
  - `requestId=openai-responses-minimax.key1-MiniMax-M3-20260615T075434104-346355-3933`
  - `[servertool.followup.lifecycle] stage=attempt_error`
  - `message="[servertool] nested followup timeout after 10000ms"`
  - 最终被投影成 `SERVERTOOL_TIMEOUT / servertool_followup_timeout / 504`
- 已确认根因不是 provider，也不是 Rust followup 语义 owner，而是 HTTP executor 壳层本地加的 nested followup fail-fast：
  - `src/server/runtime/http-server/executor/servertool-followup-fail-fast.ts`
  - `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
- 原行为：
  - 默认 10s
  - 最大也被 cap 到 10s
  - followup 重入执行和 retry backoff wait 都会走 `awaitNestedExecutionWithFailFast(... timeoutMs=resolveServerToolNestedFollowupTimeoutMs())`
  - 到时直接本地抛 `SERVERTOOL_TIMEOUT`
- 本轮修复：
  - 物理删除 nested followup timeout 解析与 504 timeout error 构造：
    - `DEFAULT_SERVERTOOL_FOLLOWUP_TIMEOUT_MS`
    - `MAX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS`
    - `parsePositiveTimeoutMs(...)`
    - `resolveServerToolNestedFollowupTimeoutMs()`
    - `createServerToolFollowupTimeoutError(...)`
  - `awaitNestedExecutionWithFailFast(...)` 现在只负责两件事：
    - 响应 client abort signal
    - 轮询 abort carrier
  - `servertool-followup-dispatch.ts` 两处调用都已移除 `timeoutMs/requestId` 传参，只保留 abort 相关 fail-fast。
- 红测同步：
  - `tests/server/runtime/http-server/executor/servertool-followup-fail-fast.spec.ts`
  - 删除“20ms timeout 必须报 504”的旧断言
  - 改为：
    - 正向：无 abort 时 promise 正常 resolve
    - 反向：client abort 仍能立刻中止
- 当前验证证据：
  - `node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/server/runtime/http-server/executor/servertool-followup-fail-fast.spec.ts --runInBand` PASS
  - `npx tsc -p tsconfig.json --noEmit --pretty false` PASS
  - `rg -n "resolveServerToolNestedFollowupTimeoutMs|createServerToolFollowupTimeoutError|servertool_followup_timeout|nested followup timeout after" src tests sharedmodule -S` => 0 matches
- 待补最终闭环：
  - `npm run build:min`
  - 若 Jason 要求，后续继续 install/restart/live replay 这一类 stopless/servertool followup 样本，确认不再出现本地 10s timeout。

## 2026-06-15 stopless cli self-call contract
- stopless CLI stdout contract tightened: continuationPrompt must explicitly tell the model it cannot terminate unless it proactively calls the same stop hook with full stop schema; this is the closed loop Jason asked for.
- Visible command path remains routecodex hook run ..., not routecodex servertool run .... Generic projection reasoning text was also neutralized to avoid proxy/client wording.
- Updated focused tests/docs: cli_contract.rs, tests/cli/servertool-command.spec.ts, tests/servertool/servertool-cli-projection.spec.ts, tests/servertool/servertool-cli-result-restore.spec.ts, tests/servertool/stop-message-runtime-utils.continuation.spec.ts, docs/stop-message-auto.md, docs/design/servertool-stopmessage-lifecycle.md, docs/agent-routing/30-servertool-lifecycle-routing.md.

## 2026-06-15 stopless request-side rewrite rule
- Jason clarified the missing contract: when stopless auto-projects a CLI hook because the model did not proactively call the stop hook, the returned CLI result must be rewritten into request-side text input for the next model turn, not preserved as tool-call history. Otherwise the model may infer it mis-called a tool.
- This is a req_chatprocess governance rule, not a response-side patch. Function map / verification map must explicitly lock request injection, stop-time intercept, and request-side CLI-result-to-text rewrite as one closed loop.

## 2026-06-15 stopless contract gate expansion
- Added focused native stop-schema gates for two long-term contract points: malformed schema must return parsed feedback + explicit field guidance, and valid terminal schema can allow stop even without prior explicit stop-hook call.

- Added focused contract gate tests in tests/servertool/stop-schema-lifecycle-contract.spec.ts so long-term stopless lifecycle can be locked without relying on older prompt-wording assertions.

- Unified remaining stopless feature anchor in router-hotpath-napi/servertool_core_blocks.rs to hub.servertool_stopless_cli_continuation so function-map growth gate can resolve the new contract consistently.

- Registered tests/servertool/stop-schema-lifecycle-contract.spec.ts in function-map and verification-map required test lists for hub.servertool_stopless_cli_continuation.

## 2026-06-15 responses outbound/store audit split
- Live diag evidence: `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T001004109-345184-2762.json`
  - `requestBody.input` contains many `type=message` items whose `content` parts are `output_text`.
  - Sample: `message_idx 21` has `phase:"commentary"` and `content:[{type:"output_text", ...}]`.
  - Count scan: `output_text_msgs=53`, `reasoning_items=50`, `reasoning_parts=0`.
- Rust store owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - `normalize_output_item_to_input(item)` for `type=message` clones `content` as-is.
  - `type=reasoning` is preserved as a standalone item with `summary/content/encrypted_content`.
- TS bridge owner: `src/modules/llmswitch/bridge/responses-response-bridge.ts`
  - `persistResponsesConversationLifecycleForHttp(...)` forwards response body into store projection without response-layer protocol audit.
- Current conclusion:
  - 已证实的污染层是 response outbound / store / restore 链。
  - 已证实的非法历史形状是 `assistant message.content.output_text` 被 replay 到下一轮 request。
  - `reasoning` 目前还没证实是错映射；当前样本里它是 standalone item，不是 part-level `reasoning_text`。
- 最新 gate 现状：
  - `tests/sharedmodule/responses-continuation-store.spec.ts` 当前有现成红点，`fails fast when direct and relay continuations coexist under one scope without explicit owner` 实际返回了 relay continuation，不是 `null`。
  - 这说明 continuation owner 隔离 gate 仍有洞，和 direct/relay owner split 风险一致。
- Relay response truth split:
  - JSON path: `prepareResponsesJsonClientDispatchPlanForHttp(...)` 先调用 `projectResponsesClientPayloadForClientForHttp(...)`，`handler-response-utils.ts` 再把 `sanitized clientBody` 传给 `persistResponsesConversationLifecycleForHttp(...)`。
  - SSE path: `handler-response-sse.ts` 维护 `contractProbe`，结束时把 `stripInternalKeysDeep(contractProbe.probe)` 传给 `persistResponsesConversationLifecycleForHttp(...)`。
  - 当前 relay 本质是把“client-projected payload / projected probe”当成 continuation history 真相落盘；如果 response outbound 没做 `/v1/responses` 协议审计，错误字段就会进入历史并在下一轮请求打到上游。

## 2026-06-15 apply_patch failure-guidance audit correction
- 纠偏：当前 worktree 里没有看到 apply_patch failure guidance 修复真正落到代码；此前“已修好 failure guidance”的判断不成立。
- Rust request/store owner 现状：
  - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
  - `normalize_tool_output_text_for_storage(raw)` 仍只做 `strip_provider_tool_sentinel_residue + unwrap_chunked_exec_transcript_shape + trim`
  - 真正写回 `function_call_output/tool_result` 的调用点只调用 `normalize_tool_output_text_for_storage(output_value)`，没有传 `tool_name`
  - 因此 apply_patch 不会走 `canonicalize_tool_output_text_for_compare(... apply_patch ...)` 里的 `normalize_apply_patch_output_text(...)`
- 直接证据：
  - 位置一：`hub_req_inbound_context_capture.rs` 约第 209 行，`normalize_tool_output_text_for_storage(raw: &str)`
  - 位置二：`hub_req_inbound_context_capture.rs` 约第 749 行，写回 `output` 时仍只调用 `normalize_tool_output_text_for_storage(output_value)`
- real-sample gate 现状：
  - `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts` 对 `2026-06-07-apply-patch-error-carryover-curated` 仍断言：
    - 包含 `apply_patch verification failed`
    - 包含 `Failed to find expected lines`
    - 不包含 `APPLY_PATCH_ERROR: apply_patch did not apply`
  - 这会把旧错误行为锁成 PASS，不能证明 canonical guidance 已闭环。
- apply_patch contract gate 现状：
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts` 当前只锁 freeform/schema 与“不走 servertool”
  - 还没有锁 failure guidance 必须包含 `Retry with apply_patch only` / `workspace-relative` / `Do not switch to exec_command`
- function-map / verification-map 现状：
  - `docs/architecture/function-map.yml` 的 `tool.apply_patch_freeform_contract` summary/required_tests 只覆盖 freeform patch contract、schema、line-edit/live-context 修复
  - `docs/architecture/verification-map.yml` 的 `tool.apply_patch_freeform_contract` 只列 `apply-patch-chat-process-contract`、native regression matrix、freeform schema passthrough
  - 结论：当前 map/gate 名义上覆盖 `apply_patch` 主合同，但没有显式锁 failure-guidance / canonical retry text / tool-aware storage normalization
- S4 sample mapping:
  - curated fixture: `tests/fixtures/errorsamples/responses-request-standardization/2026-06-07-apply-patch-error-carryover-curated/*`
  - requestId: `openai-responses-router-gpt-5.5-20260607T022906302-288146-11057`
  - live log: `~/.rcc/logs/server-5520.log`
    - `[virtual-router-hit] default/gateway-priority-5520-priority-default -> llmgate.key1.free-gpt-5.5`
    - `[router-direct.send] ... statusCode=503`
  - 结论：样本来源是 `5520 direct`，上游先 503；fixture 锁住的是“后续 request-side history 仍携带 raw apply_patch verification failed 文本”的 carryover 问题，不是 relay response/store 问题。

## 2026-06-15 direct/relay unified error chain 审计（本轮产出，未动实现）

- 用户目标：审计为何 499 直接返客户端；统一 direct 与 relay 的 provider error 链；接入 primary_exhausted -> default pool。
- 现状（代码证实，未改）：
  - `decideDirectRouterRetry` 已消费统一 ErrorErr05 plan；`isClientDisconnectLikeError` 已在入口短路。
  - `decideDirectProviderRetry` 强制 rethrow（provider-mode 单点 binding）。
  - `mapErrorToHttp` 已经在 `isClientDisconnectLikeForProjection` 把 499 拉 204。
  - `planPrimaryExhaustedToDefaultPoolNative` 暴露但 host（`request-executor.ts` / `http-server/index.ts`）未调用，仍在 1s/2s/3s 阻塞退避后直接 throw。
  - 用户 06-15 08:52:30 日志 `failed: HTTP 499` 与 499+client abort 应得 204 的 SSOT 矛盾：G1 待定位真正的 res.status(499) 投影点（不在 mapErrorToHttp，估计在 router-direct caller 错误透传）。
- Gap：
  - G1 client_disconnect 没有真正落到 204。
  - G2 provider-mode 单点 binding 与中心原则冲突，需 Jason 拍板。
  - G3 primary_exhausted -> default pool 未接入 host。
  - G4 SSE midstream error 未进统一链。
  - G5 错误码 wrap 可能让 upstreamMessage 丢失。
  - G6 mapErrorToHttp 短路顺序无问题。
- 落盘：
  - `docs/goals/direct-relay-unified-error-chain-audit.md`（278 行，本轮权威真源）。
  - 含 §6 决策项 D1/D2/D3（待 Jason 拍板）。
  - 含 §8 `/goal` 提示词模板（落地修复执行）。
- 下一步：等 Jason 拍 D1/D2/D3，再按 Phase B-F 执行；本轮仅文档/审计，不写实现。

## 2026-06-15 live verify of missing capture / asxs 502
- Live probes on current installed `0.90.3071` did not reproduce the two reported runtime failures.
- `http://127.0.0.1:5555/v1/responses` returned `200` for a minimal probe and the body contained a normal completed response.
- `http://127.0.0.1:5520/v1/responses` with `provider=asxs.crsa.gpt-5.4` also returned `200` for a minimal probe.
- The earlier `native captureReqInboundResponsesContextSnapshotJson is required but unavailable` lines are therefore classified as historical runtime / install-state evidence, not as a currently reproducible source-code regression.
- The `asxs` `HTTP_502` sample in `~/.rcc/logs/server-5520.log` shows a direct `router-direct.send` failure followed by provider switch and later successful completion, so it is an upstream/provider transient, not a persistent config break.

## 2026-06-15 gate audit for apply_patch direct/relay plan
- `npm run verify:apply-patch-freeform-contract` PASS.
- `npm run verify:apply-patch-regressions` PASS (`total=41 fixed=18 stillFailing=23 mismatches=0`).
- Rust focused gate PASS:
  - `cargo test normalize_responses_input_items_dedupes_repeated_apply_patch_error_statuses --lib -- --nocapture`
  - workdir=`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi`
- But sharedmodule Jest suites that the function-map / verification-map names as required gates are currently not reliably executable:
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
  - `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts`
  - `tests/sharedmodule/native-required-exports-sse-stream.spec.ts`
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
- Current failure mode is environment/runtime setup, not business assertion:
  - Jest CJS parse hits `sharedmodule/llmswitch-core/src/native/router-hotpath/native-router-hotpath-policy.js` with `Unexpected token 'export'`
  - `native-required-exports-sse-stream.spec.ts` hits `import.meta.url` parse failure
  - `responses-continuation-store.spec.ts` also reports missing `sharedmodule/llmswitch-core/dist/conversion/shared/responses-conversation-store.js`
- Conclusion: current gate gap is two-layered:
  1. some assertions still lock old behavior
  2. some named tests are not runnable enough to be trusted as active gates
## 2026-06-15 apply_patch audit fixes landed and green

- 已落 Rust owner 修复一：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_context_capture.rs`
  - `normalize_tool_output_text_for_storage` 现在接 `tool_name`
  - `apply_patch` 失败 output 在真正写回历史时就 canonicalize 成 `APPLY_PATCH_ERROR: ...`
  - 不再只在 compare/dedupe 阶段做 canonical guidance
- 已落 Rust owner 修复二：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/standardized_request.rs`
  - `/v1/responses input[]` 进入 `convert_bridge_input_to_chat_messages(...)` 之前，先复用 `normalize_responses_input_items(...)`
  - 修掉 curated real-sample 仍带 raw `apply_patch verification failed...` 的第二入口
- 已落 Rust owner 修复三：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_responses_conversation_utils.rs`
  - relay store 在 `response.output[type=message].content` 落历史时，把 `output_text` / `text` / `commentary` 改写为合法 request history `input_text`
  - `canonicalize_continuation_item(...)` 同步做该归一化，避免 stored `input_text` 与 incoming replay `output_text` 前缀匹配失败
- 补强 gate：
  - `tests/sharedmodule/apply-patch-chat-process-contract.spec.ts`
  - `tests/sharedmodule/responses-continuation-store.spec.ts`
  - `tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts`
- 2026-06-15 验证证据：
  - PASS `cargo test -q -p router-hotpath-napi normalize_responses_input_items_dedupes_repeated_apply_patch_error_statuses --lib -- --nocapture`
  - PASS `cargo test -q -p router-hotpath-napi convert_responses_output_to_input_items_rewrites_output_text_message_content_to_input_text --lib -- --nocapture`
  - PASS `cargo test -q -p router-hotpath-napi restore_matches_prefix_when_stored_input_text_and_incoming_replays_output_text --lib -- --nocapture`
  - PASS `cargo test -q -p router-hotpath-napi responses_standardization_preserves_input_in_semantics_for_tool_result_followup --lib -- --nocapture`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/build-core.mjs`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/apply-patch-chat-process-contract.spec.ts --runInBand`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-continuation-store.spec.ts --runInBand -t 'records response message output_text as legal request history input_text instead of replaying response-only content types|restores previous_response_id by session scope when incoming input replays the exact prefix'`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/responses-request-standardization.real-samples.red.spec.ts --runInBand`
# 2026-06-15 reasoning-content client replay leak
- Live replay after `0.90.3071` still failed with upstream `array_above_max_length` on `input[41].content`; new diag `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260615T175743408-347832-1109.json` proved the client request itself still contained `type=reasoning` with non-empty `content`.
- Root cause widened: not only continuation-store persistence; Rust responses client outbound projection in `hub_resp_outbound_client_semantics_blocks/responses_payload.rs` still emitted `reasoning.content` to clients, so any client that replayed prior output polluted the next `/v1/responses` request.
- After Rust response-outbound fix + reinstall/restart (`0.90.3071` still current), fresh live 5520 direct two-turn replay passed: first response returned `reasoning.content=[]`, second replay request returned 200 instead of `array_above_max_length`.
- Fresh live 5555 replay exposed a second response-outbound audit gap: relay/servertool path returned unresolved `function_call` with `status=in_progress`; replaying that fresh response failed later with `unknown_parameter`, so response outbound still needs full protocol audit beyond reasoning fields.
- 2026-06-15 `5555 required but unavailable` 进一步坐实：`captureReqInboundResponsesContextSnapshotJson` 不是源码缺失，也不是全局安装包缺失。已验证五层证据都存在该 export：源码、仓库 dist、全局安装 JS facade、全局安装 `.node` binding、loader 直调 binding。剩余唯一合理归因收窄为 live server 进程模块实例 / 装载路径不一致，owner 仍是 `src/modules/llmswitch/bridge/native-exports.ts` + `native-router-hotpath-loader` 这一层 runtime 装载链。
- 2026-06-15 S6 状态校正：`captureReqInboundResponsesContextSnapshotJson required but unavailable` 目前不是 live 必现问题。最新 `19:25-19:27` 的 `5555` relay 样本已连续成功并返回 `finish_reason=tool_calls`。因此 S6 现在应归类为“历史 live 故障 + 当前缺历史实例级解释证据”，而不是“当前功能仍坏”。
- 2026-06-15 S5 gate 校正：`responses-continuation-store.spec.ts` 用 repo runner 可执行，当前 32 tests / 28 pass / 4 fail。已实证锁住 `output_text/commentary -> input_text` 与 `reasoning.content` 不回放；尚未锁住 internal stopless/servertool CLI `function_call` 与 `status=in_progress` 不得进入 replay history。部分失败用例仍带旧 `output_text` / `reasoning.content` 预期，不能直接拿来当 S5 缺口证据。
- 2026-06-15 S5 root-cause split refined：Rust continuation-store path already strips `function_call.status`; `shared_responses_conversation_utils.rs::normalize_output_item_to_input()` writes `id/call_id/name/arguments` only. Therefore S4 sample’s `status=in_progress` is more likely response-outbound/client-visible body pollution replayed by client, not local continuation-store materialize. Remaining S5 gaps split into two owners: store must strip internal CLI `function_call`; response outbound must not leak `status=in_progress`.
- 2026-06-15 `~/.rcc` provider cleanup：用户明确要求移除 `~/.rcc/provider/mini27` 与 `~/.rcc/config.toml` 中引用。已确认根配置真源命中 `virtualrouter.forwarders."fwd.minimax.MiniMax-M2.7".targets` 的 `providerId = "mini27"`；另发现 `~/.rcc/config.dbittai.toml` 仍有独立 `mini27` 引用，但不在本次明确范围，暂不改。
- direct SSE metadata guard corrected: latest=2026-06-16；`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` 已复跑 4/4 PASS，现明确锁住 `event: response.metadata` 在 same-protocol direct SSE 下允许普通 provider metadata 透传，同时 metadata 内部控制字段泄漏必须拒绝。仍未闭环的是更上层 `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 的两条预存业务红，不能与本次 response outbound replay-safe 清理混算。
- responses-handler submit_tool_outputs harness gap: latest=2026-06-15；`tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts` 和 `tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts` 现在在 ESM 导入阶段报 `captureReqInboundResponsesContextSnapshot` 缺导出，属于测试入口 / harness 不一致，不是 response outbound 业务断言失败；这类 failure 不能拿来反证本轮 response outbound replay-safe sanitize。
- direct-passthrough route-level harness status refined: latest=2026-06-15；`tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts` 不是“只测 chat/provider-mode”，文件里实际已有多条 `/v1/responses` direct 合同（透明 ingress、client tools 保持 direct、relay-owned scope materialize 不得被 direct 消费等）。但本地实跑该 suite 会长期挂起并遗留 Jest 进程，需要显式按 PID 清理；因此现阶段它应记为“有 coverage 但 harness 不稳定，不能直接作为稳定 gate”，不是简单记成“无关用例”。
# 2026-06-15 provider-error-chain direct/relay audit finalized
- 已落盘定稿：`docs/goals/provider-error-chain-direct-relay-audit-2026-06-15.md`（19.3KB / 268+ → 含 §10 live snapshot 附录）。
- 现状校正：用户最初担心的"5555 HTTP_499 被返回客户端"实际是 server log 字面（`❌ [...] failed: HTTP 499`），
  client 端因 `respondWithPipelineError` + `terminateClientDisconnectedResponse` 短路已拿不到任何 body。
  G1 红测 `handler-utils.client-disconnect.spec.ts` 已 GREEN（2/2）锁住该短路路径。
- 当前最实质 gap：G6 `upstream_stream_incomplete` 完全未进 `resolveRequestExecutorProviderFailurePlan`，
  5520 同 provider 连续 stream cut 不会被切 / 冷却（usage day.fail=0 + finish_reason=unknown 是证据）。
- 服务器健康：`routecodex/rcc = 0.90.3071`，5555/5520/10000 三个端口 health 全绿。
- 修复顺序最终版：`G1 → G3 → G6 → G5 → G7 → G10 → G2 → G4 → G9`，每条必须"先红测 → 改唯一 owner → 转绿 → live 复测"四步走。
- 旧编号 D1/D2/D3/D4/F8/G8 已并入 G3/G7/G1/G6，§3.1 / §10.2 留 audit 历程。
- `/goal` 提示词按 G1→G3→G6→G5→G7→G10→G2→G4→G9 顺序收口，未生成 commit（用户明确说"先把审计定稿，给我 /goal"）。
# 2026-06-15 stopless NoSchema + apply_patch wrapper compatibility
- stopless root cause 确认：
  - `servertool-core/src/stopless_prompt.rs` 之前仅 `InvalidSchema` 才 `schema_guidance_required=true`，`NoSchema` 只有自然语言继续提示，没有停止 schema contract。
  - `router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs::build_stop_hook_guidance_text_from_output()` 之前只抽 `continuationPrompt`，即使 CLI output 已带结构化 guidance，也不会重新注入给模型。
- 已补红测并转绿：
  - `stopless_prompt::tests::no_schema_first_round_is_natural_user_language`
  - `cli_contract::tests::builds_stop_message_auto_cli_output`
  - `cli_contract::tests::status_only_stopless_cli_output_does_not_require_prompt`
  - `cli_contract::tests::renders_stopless_schema_guidance_text_without_internal_proxy_terms`
  - `chat_servertool_orchestration::tests::test_stop_message_auto_followup_state_progresses_used_zero_to_three`
  - `virtual_router_engine::route` 既有 `stopless_followup_strips_tools_route_hint_and_falls_back_to_thinking`
  - `virtual_router_engine::route` 既有 `stopless_followup_strips_search_route_hint_and_falls_back_to_thinking`
  - `hub_req_inbound_tool_call_normalization::tests::stop_hook_guidance_text_appends_schema_guidance_from_cli_output`
- stopless 修复内容：
  - `NoSchema` 现在也要求 schema guidance，但仍保持 client-visible continuation prompt 为自然语言，不把 internal proxy 词直接暴露到 prompt。
  - `cli_contract.rs` 的 `stop_message_auto` CLI output 现在固定带 `schema_guidance`。
  - 新增 `render_stopless_schema_guidance_text(...)`，自动补打 stop hook 的 tool output 转文本时，会把 JSON 字段要求一并注回给模型。
  - 计数锁定：`used=0/1/2` 时 followup metadata `serverToolLoopState.repeatCount` 与 `stateUpdate.used` 分别推进到 `1/2/3`。
- apply_patch 兼容新增一条窄修复：
  - owner: `router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`
  - 当 shell/exec 工具参数里已经明确包着 canonical `*** Begin Patch ... *** End Patch` 时，允许提取该 patch 并把这次错误形状升级为真正的 `apply_patch` 调用；只修形状，不猜 patch 语义。
  - 新红测转绿：`hub_req_inbound_tool_call_normalization::tests::upgrades_shell_wrapped_canonical_patch_to_apply_patch_call`
- 2026-06-15 定向验证：
  - PASS `cargo test -p servertool-core no_schema_first_round_is_natural_user_language --lib -- --nocapture`
  - PASS `cargo test -p servertool-core builds_stop_message_auto_cli_output --lib -- --nocapture`
  - PASS `cargo test -p servertool-core status_only_stopless_cli_output_does_not_require_prompt --lib -- --nocapture`
  - PASS `cargo test -p servertool-core renders_stopless_schema_guidance_text_without_internal_proxy_terms --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi stop_hook_guidance_text_appends_schema_guidance_from_cli_output --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi test_stop_message_auto_followup_state_progresses_used_zero_to_three --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi stopless_followup_strips_tools_route_hint_and_falls_back_to_thinking --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi stopless_followup_strips_search_route_hint_and_falls_back_to_thinking --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi upgrades_shell_wrapped_canonical_patch_to_apply_patch_call --lib -- --nocapture`
  - PASS `cargo test -p router-hotpath-napi normalize_responses_input_items_dedupes_repeated_apply_patch_error_statuses --lib -- --nocapture`
- 未闭环项：
  - broader `cargo test -p router-hotpath-napi apply_patch --lib -- --nocapture` 仍有 5 条旧红样本失败：
    - 3 条 `req_process_stage1_tool_governance_tests::*apply_patch*`
    - 2 条 `resp_process_stage1_tool_governance_tests::test_normalize_tool_args_apply_patch_*`
  - 这些失败不是本次新增红测；本次只确认窄兼容 slice 已绿，完整 apply_patch 审计仍需继续。

## 2026-06-15 apply_patch req/resp owner repair
- broad apply_patch suite red: 3 req-side contract tests + 2 resp-side legacy hunk tests.
- req truth: top-level apply_req_process_tool_governance still calls normalize_apply_patch_freeform_tool_schema(), which rewrites client-visible apply_patch declaration to custom grammar and breaks no-rewrite contract tests.
- resp truth: repair_line_number_update_hunks_with_live_context() fallback path rewrites legacy @@ -n +m @@ headers into @@ even when no live file context exists; only inline-context trailers should be collapsed locally.
- build blocker: servertool-core cli_contract currently has stale calls that should target build_client_exec_cli_projection_output_with_identity().

## 2026-06-16 stopless CLI root build boundary
- Root cause from live install: global dist/cli/commands/servertool.js lacked --session-id/--request-id and recordStoplessContinuationState, so same-session stopless CLI reruns could not persist/read stopMessageUsed; schema was not the counter root cause.
- Fix in progress: move CLI wrapper state write through src/modules/llmswitch/bridge/state-integrations.ts requireCoreDist bridge instead of importing sharedmodule/llmswitch-core/src runtime-utils, eliminating rootDir TS6059 leakage.

# 2026-06-16 stopless session-id 收口 + 对客户端无感 — 二次只读审计
- 触发：用户问"实际就是不递增，要检查是因为没有 schema 还是别的原因？"，
  结合前面 §"继续，我进行了修复，你现在重新审计整个 stopless 链条，给我你的审计报告，不要修改，
  我看到现在续杯时注入的还有第一轮第二轮，这些话术不中性，不像人说的话"。
- 当前 live：`routecodex --version = 0.90.3071`；
  `sharedmodule/llmswitch-core/rust-core/target/` 下根本没有 `routecodex-servertool` 二进制。
  也就是说 rust 真源层（cli_contract.rs 重写 + 新增 stopless_prompt.rs + record_stopless_continuation_state）
  全部未编进 live；前几轮 live 看到的 stdout 是更早 plan §4.3 表里"继续做下一步；拿不到证据就再试一次…"
  那段话术，不是 stopless_prompt.rs::resolve_stopless_continuation_prompt 的真源。

## 1. 代码真源核对结果
### 已完成（与文档一致）
- `servertool-core/src/stopless_prompt.rs` 已落：禁词表 19 个 token、first/middle/final/SchemaPass 五模板，
  Rust 单元测试 7 条全绿。
- `servertool-core/src/cli_contract.rs::build_stop_message_auto_run_output` 已落：
  必填 sessionId/requestId + 字符校验 + `next_repeat_count = persisted.snapshot.used + 1` + `next_max_repeats = persisted.snapshot.max_repeats.max(1)`，
  `continuation_prompt` 走 `resolve_stopless_continuation_prompt` 真源。
- `servertool-cli/src/main.rs` 已加 `--session-id` / `--request-id` clap 参数。
- `router-hotpath-napi/src/chat_servertool_orchestration.rs::run_stop_message_auto_handler_json` 已落：
  `followup = Value::Null`，强制 `flow_id = stop_message_flow`，注释明确"永不 append_user_text reenter"。
- `virtual_router_engine/engine/route.rs::resolve_route_hint` 已落 stopless 强制清掉 routeHint，
  测试 `stopless_followup_strips_tools_route_hint_and_falls_back_to_thinking` 已绿。
- `stop-message-core::resolve_stopless_continuation_prompt` 真源已被 cli_contract.rs + chat_servertool_orchestration.rs 引用。
- `tests/servertool/stopless-prompt.client-visible.spec.ts` 5 条红测已写，覆盖 first/middle/final/CLI std-only/重复 used 递增。
- `tests/servertool/stopless-vr-route-hint.spec.ts` 已写，路由测试已绿。
- `runStopMessageAutoHandlerWithNative` 走完 Rust → TS shell 会写盘 `persist_keys` 到 `session:<id>`（TS isPersistentStickyKey 仅 session:）。

### 仍然未闭环的核心缺口
1. **`is_persistent_sticky_key` 在 Rust 端仍接受 `tmux:` / `conversation:`**（chat_servertool_orchestration.rs:2092），
   与 plan §1.1 "stopless 唯一 sessionId" 不一致。需要收口到仅 `session:` 或拆 owner（保留给非 stopless servertool flow）。
2. **`record_stopless_continuation_state` Rust 函数写好但没调用方**：napi binding 没暴露、CLI binary 不调它、
   `run_stop_message_auto_handler_json` 也没在尾部调它来更新 used。
   → "used 不递增" 链路没真正闭合：CLI 内部虽然 `resolve_runtime_stop_message_state` 读到了 persisted.used，
     但这是**读**，没人写。
3. **`plan_servertool_followup_runtime_json` / `flowPolicy.profilesByFlowId.stop_message_flow`
   仍是 `"seedLoopPayload": true`**，没有 `"noFollowup": true` / `"clientInjectOnly": true`。
   → `outcomeMode` 在 else 分支返回 `"reenter"`，`runFollowupMainline` 还会走 seedLoopPayload 路径。
   这是为什么"对客户端无感"还没生效的根本：
   - engine.ts 的 stoplessPlan.cli_projection 是基于 `execution.context.stopMessageTerminalFinal` 判定；
     terminal 时返回 `terminal_final`，非 terminal 时返回 `cli_projection`（永不 reenter）。
   - **但** 在 rust hub_pipeline `chat_servertool_orchestration` 路径上，把 `followup = Value::Null`
     包给 TS 引擎后，TS 的 `runFollowupMainline` 用 `resolveFollowupFlowDecision` 拿 outcomeMode，
     仍然按 `reenter` 处理 —— 实际还有 `requestIdSuffix=:stop_followup` 的二次请求。
4. **`stop-message-core/src/lib.rs` 仍存在 `DEFAULT_EXECUTION_PROMPTS` + 大量 `继续执行` / `继续完成当前用户目标…` 旧文案**（行 1147/1259/1277/1290/1302/1314/1332/1344/1353/1369/1400/1425/1441/1457/1647/1669），
   `chat_servertool_orchestration.rs` 行 1676/2715/2905/2997/3010/3032/3052/3129 还有 legacy `"继续执行"` 字符串测试。
   这部分没有物理删除（AGENTS.md §10 物理删除铁律）。
5. **TS shell 的 prompt 真源覆盖**：stop-message-auto.ts 第 2170 行附近，
   `effectiveDecision.followup_text` 仍可能从 stop-message-core 旧模板带过来并写进 `execution.context.assistantStopText`，
   影响后续 `engine.ts::extractStoplessReasoningText` 输出（旧"用户目标/排查"等措辞）。
6. **`buildServertoolCliProjectionForToolCall`（模型主动调 stop_message_auto 的路径）**没传 sessionId/requestId，
   会直接被 `validate_stopless_session_identity` 拒绝（fallback 给 `cli-projection.ts:32` 写死 repeatCount=0,maxRepeats=0）。
   红测 `stopless-prompt.client-visible.spec.ts` 没覆盖模型主动调用路径。

## 2. 用户现场"stdout 第一轮第二轮"问题真凶
- 用户现场 stdout 三次都是同一段话术"继续做下一步；拿不到证据就再试一次；想停的时候直接告诉我一句'做完了'或'卡住了，需要你拍板'。"
- 这段**不在 stopless_prompt.rs**（first 模板是"继续做下一步；先把手头能确认的结果拿回来。"）；
  与 `docs/goals/stopless-client-invisible-route-plan.md` §4.3 表 `NoSchema used=0` 行一字不差。
- 结论：live binary 早于新 stopless_prompt.rs 落地，走的还是 plan §4.3 描述的"过去/计划"模板（或者再早的 `DEFAULT_EXECUTION_PROMPTS[0]`）。
- 修了 6 条 Rust 红测只是让新代码逻辑闭环，**没有真装到 live server**。

## 3. 实测真信号（每次 chunk 末都自带 stderr）
```
SERVERTOOL_CLI_MISSING_FIELD: sessionId
```
- 来自 `cli_contract.rs::ServertoolCliError::MissingField` 的 `validate_stopless_session_identity`：
  当 `input.session_id.is_none() || trimmed.is_empty()` 时返回。
- 含义：用户现场 CLI 调用根本没传 `--session-id`/`--request-id`，
  因为：
  - 要么 CLI binary 还是老版本（不要求这两个字段）；
  - 要么新版 CLI binary 被调用，但调用方（旧 TS servertool handler / 老 plan §4.3 测试脚本）没改。
- 用户现场"used 不递增"的真因不是 schema，而是**双向都没有"session 身份 → persisted state"通路**：
  入参没 sessionId → persisted.used 永远拿不到 → next_repeat_count 永远 fallback 到 input.repeatCount (=1) →
  `continuationPrompt` 永远命中 first 模板。

## 4. 收口顺序（最小剩余缺口）
1. **live 重 build + 重 install + restart**：把新 stopless_prompt.rs / cli_contract.rs / record_stopless_continuation_state 真正装到 live servertool binary。
   - `PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm run build:min`
   - `node scripts/build-core.mjs`
   - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`
2. **CLI binary 端 napi binding 暴露 `record_stopless_continuation_state_sync_json` + binary 末尾调一次**：
   - `servertool-core/src/persisted_state_fs.rs` + `record_stopless_continuation_state` 已写完，
     只缺 `servertool_core_blocks.rs` 加 napi + `servertool-cli/src/main.rs` 末尾调一次。
3. **`buildServertoolCliProjectionForToolCall` 加 sessionId/requestId 入参**（从 options 透传，缺则 fail-fast）。
4. **`is_persistent_sticky_key` 收口**：stopless 路径唯一 `session:`，非 stopless servertool 另立 owner 常量。
5. **物理删除 legacy**：
   - `stop-message-core/src/lib.rs` 里所有 `DEFAULT_EXECUTION_PROMPTS` 旧模板 + `default_text: "继续执行"` 行；
   - `chat_servertool_orchestration.rs` 第 36-46 行 `normalize_stop_message_followup_text` 里的 `text == "继续执行"` legacy 升级分支；
   - 测试中所有 `assert_ne!(text, "继续执行")` 等字符串断言改为"非禁词 + 含自然人话关键词"。
6. **`flowPolicy.profilesByFlowId.stop_message_flow` 改 `"noFollowup": true`** 或在 `run_stop_message_auto_handler_json` 末尾直接 `flow_id = "stop_message_flow_cli_projection"`，让 `resolveFollowupFlowDecision` 走 `skip` 分支（彻底不 reenter）。
7. **修 `stop-message-auto.ts::handler`**：`effectiveDecision.followup_text` 一律用 `resolve_stopless_continuation_prompt` 覆盖，再写入 `execution.context.assistantStopText`。
8. **live 复测**：单 sessionId 触发 3 次 stopless，验 stdout continuationPrompt 依次 first/middle/final；
   验 `requestIdSuffix=:stop_followup` 不再出现；验 VR log `reason=thinking:user-input` 无 `route_hint:tools`。

## 5. DoD（同 docs/stop-message-auto.md §7）
- `cargo test -p servertool-core stopless --lib`
- `cargo test -p servertool-core persisted_lookup --lib`
- `cargo test -p router-hotpath-napi chat_servertool_orchestration --lib`
- `cargo test -p router-hotpath-napi virtual_router_engine --lib`
- Jest 6 条 spec（含 stopless-prompt.client-visible / stopless-vr-route-hint / stopless-cli-continuation）
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `git diff --check`
- live：routecodex --version、健康三端口、3 端口 /v1/responses smoke、stdout continuationPrompt 三档变化、
  service log 无 :stop_followup 二次请求、VR log stopless 本轮 reason=thinking:user-input 无 route_hint:tools。

# 2026-06-16 stopless CLI continuation 递增闭环修复
- 已验证根因不是 schema_missing，而是 session 作用域闭环缺失：没有 sessionId 就无法把 used 写回同一个 `session:<id>` persisted state。
- Rust / TS / live 闭环现状：
  - `servertool-core/src/cli_contract.rs` 已强制 sessionId/requestId，`next_repeat_count` 从同一 session persisted state 读 `used + 1`。
  - `servertool-cli/src/main.rs` 已在 binary 末尾调用 `record_stopless_continuation_state` + `save_persisted_runtime_stop_message_state`。
  - `servertool-core/src/persisted_state_fs.rs` 新增 `resolve_filepath_for_write`；`persisted_state_fs_write.rs` 负责把 `{"version":1,"state":...}` 原子写回 session 文件。
  - `router-hotpath-napi/src/servertool_skeleton_config.rs` 给 `stop_message_flow` 补了 `noFollowup: true`，防止旧 followup 语义继续回流到 reenter。
  - `cli-projection.ts` 的 stop_message_auto 投影现在要求 sessionId（缺则 fail-fast），命令输入只带 `flowId/repeatCount/maxRepeats`，不泄漏 continuationPrompt/schemaGuidance。
  - `chat_servertool_orchestration.rs` 已把 stopless persist key 真正收口到 `session:` 过滤；generic sticky key 不再用于 stopless flow。
- Live 证据：
  - `~/.rcc/install/current/node_modules/rcc-llmswitch-core/dist/bin/routecodex-servertool` 已存在且 `--help` 显示 `--session-id` / `--request-id`。
  - 同一 `sessionId` 连跑 3 次 live binary：`repeatCount 1 -> 2 -> 3`，prompt 依次变成 first / middle / final。
  - persisted file `~/.rcc/state/routing/session-<id>.json` 写回 `stopMessageUsed=3`，`stopMessageText` 为 final 文案。
- 定向验证 PASS：
  - `cargo test -p servertool-core --lib`
  - `cargo test -p router-hotpath-napi --lib servertool_core_blocks::tests::`
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-prompt.client-visible.spec.ts --runInBand`
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-vr-route-hint.spec.ts --runInBand`
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/servertool-cli-projection.spec.ts --runInBand`
  - `npm run verify:servertool-rust-only`
  - `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
  - `npx tsc -p tsconfig.json --noEmit --pretty false`
  - `git diff --check`
- Remaining non-stopless failures: `cargo test -p router-hotpath-napi --lib` still has unrelated resp/apply_patch/shared_json_utils red tests in dirty files from other work; not part of this stopless slice.
# 2026-06-16 provider-error-chain G1/G3 progress
- G1 已落地：`mapErrorToHttp` 对 client_disconnect 不再返回 `204/CLIENT_DISCONNECTED` body，而是 throw `ClientDisconnectHttpProjectionError` sentinel；`respondWithPipelineError` / `writeStartedSsePipelineError` 已 catch 并 silent terminate。
- G1 focused gates PASS：
  - `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts`
  - `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts`
  - `tests/server/utils/http-error-mapper.client-disconnect-log-summary.spec.ts`
  - `tests/server/handlers/handler-utils.client-disconnect.spec.ts`
  - 合计 12 PASS / 0 FAIL
- G1 logging 校正：`mapErrorToPublicLogSummary` 对 client_disconnect 返回 `client_disconnect=true request_aborted_by_client`，不再回放 raw `HTTP 499` / `client abort request`。
- G3 已落地 host 接入：
  - `src/server/runtime/http-server/executor/request-executor-core-utils.ts` 新增 `resolvePrimaryExhaustedPlan(...)`
  - `src/server/runtime/http-server/index.ts` pool-exhausted backoff 用尽后 consult native plan
  - `src/server/runtime/http-server/request-executor.ts` pool-exhausted backoff 用尽后 consult native plan
- G3 unit gate PASS：`tests/server/runtime/http-server/executor/request-executor-primary-exhausted-plan.spec.ts` 2/2 PASS，锁住 host 只通过 native bridge 取 plan，不自己合成 fallback。
- G3 当前边界：host 现在只会把当前 `allowedProviders` 作为 primary tier 送入 native；route tiers/default backup tiers 还没显式进入 metadata，所以 default_pool 真扩池要等后续把 route tiers 暴露给 host，当前先锁住“禁止 host 本地 fallback”。
- 运行态：`routecodex/rcc = 0.90.3071`，5555/5520/10000 `/health` 全绿。
- G6 细化校正（2026-06-16）：`provider-failure-policy-impl.ts` 对 `UPSTREAM_STREAM_INCOMPLETE` 已天然落到 `recoverable` + `affectsHealth=true`（focused gate `provider-failure-policy-upstream-stream-incomplete.spec.ts` 2/2 PASS）。因此 G6 当前唯一缺口不是分类，而是 raise path：`handler-response-sse.ts` 在 `stream closed before response.completed` 时只做 log + `res.end()`，没有把 error 回传到 direct/relay caller 去消费统一 ErrorErr05 decision。

## 2026-06-16 stopless 工具侧自补 sessionId + forcestop schema
- 用户纠正点成立：`sessionId` 不该暴露给模型，也不该要求模型/用户在 stopless projection 命令里显式传。工具侧必须自己补。
- 已收口：
  - `servertool-core/src/cli_contract.rs`：`stop_message_auto` 缺 `sessionId/requestId` 时自动从 `CODEX_THREAD_ID` -> `TMUX_PANE` -> `TERM_SESSION_ID` -> `ITERM_SESSION_ID` 补默认 identity；projection `execCommand` 不再带 `--session-id/--request-id`，但 stdout 仍带 `sessionId/requestId` 供 host 写盘。
  - `stop-message-core/src/lib.rs`：stop schema 新增 `forcestop`；`forcestop=1` 时强制停止优先级最高，只要求非空 `reason`，不再校验 evidence / diagnostics / done_steps 等终态字段。
  - `cli_contract.rs::stopless_schema_guidance()` 与 guidance text 已加入 `forcestop` 引导：只能在不得已必须强制停止时使用，且必须填写非空 `reason`。
- focused 验证：
  - PASS `cargo test -p stop-message-core forcestop --lib`
  - PASS `cargo test -p servertool-core builds_stop_message_auto_cli_output --lib`
  - PASS `cargo test -p servertool-core renders_stopless_schema_guidance_text_without_internal_proxy_terms --lib`
  - PASS `npx tsc -p tsconfig.json --noEmit --pretty false`
  - PASS build/install/restart，live `routecodex --version = 0.90.3072`
  - PASS live裸命令（不带 `--session-id`）：
    `CODEX_THREAD_ID=force-stop-proof-001 routecodex hook run stop_message_auto --input-json ...`
    返回 `sessionId=codex:force-stop-proof-001`，且 `schemaGuidance.requiredFields` 已含 `forcestop`。

## 2026-06-16 stopless-direct-session-scope
- verified_current: current stopless owner `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_orchestration_contract.rs` only sees `flowId + execution`; no direct/relay discriminator is passed, so direct `/v1/responses` can still CLI-project stopless. Existing contract tests also incorrectly treat `/v1/responses + openai-responses` as stopless-active.
- verified_current: `stop_message_auto` CLI `sessionId/requestId` requirement is explicit in Rust `cli_contract.rs`; live `SERVERTOOL_CLI_MISSING_FIELD: sessionId` is consistent with wrong stopless activation on direct, not proof that session validation itself is wrong.
- next: read existing runtime meta only (`__rt`/runtime metadata), add red test that direct runtime meta disables stopless, then change native owner + map/gate together.
- G5 已落地（2026-06-16）：`isProviderFailureClientDisconnect` 在 `provider-failure-policy-impl.ts` 入口处把 status=499/code=HTTP_499 短路提到 message 短路之前；bodyHints 现已覆盖 `error.details.upstreamMessage` 与 `error.response.data.error.message` 双路。focused spec `provider-failure-policy-client-disconnect-499.spec.ts` 现 5/5 PASS。

- verified_current: relay servertool adapter-context session scope was dropped in `src/server/runtime/http-server/executor/servertool-adapter-context.ts` path because backfill only read entry-origin request. Fixed by consuming existing `metadata.responsesRequestContext.sessionId/conversationId` through `servertool-request-normalizer.ts`; red test added in `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`.
## 2026-06-16 stopless relay sessionId closure follow-up

- Live evidence corrected prior assumption: `SERVERTOOL_CLI_MISSING_FIELD: sessionId` was not only the TS handler followup metadata gap. The relay stopless CLI projection path in `sharedmodule` still built `adapterContext` from top-level metadata only.
- Verified root owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs::build_adapter_context`.
- Failure shape: relay runtime carried session truth in `metadata.responsesRequestContext.sessionId/conversationId`, but `build_adapter_context()` only copied `metadata.sessionId/conversationId`, so `sharedmodule/llmswitch-core/src/servertool/engine.ts` saw empty `adapterContext.sessionId` and emitted stopless CLI projection without `--session-id/--request-id`. The CLI then failed with `SERVERTOOL_CLI_MISSING_FIELD: sessionId`.
- Fix: Rust `build_adapter_context()` now backfills `sessionId/conversationId` from `responsesRequestContext` when top-level metadata is absent.
- Gate added: Rust unit `build_adapter_context_backfills_session_identifiers_from_responses_request_context`.
- Important boundary: Jason clarified `sessionId` must be auto-supplemented by tool governance/runtime, not exposed as model responsibility. Future fixes must keep the补全 responsibility on server-generated projection/runtime owner, not on model-authored schema or user-visible prompt text.

## 2026-06-16 stopless closure audit

- Fresh read-only audit against Jason's 5-point closure target:
  1. request-side "end summary + stop schema" is still the main gap; current stopless guidance is mostly CLI/result-text based, not clearly owned as a system-instruction contract.
  2. response-side stop interception + terminal schema stripping already has Rust owner (`stop_gateway_context` / `stop_visible_text`), but trigger classification is not yet fully unified into one exact `NoSchema / InvalidSchema / NonTerminal / SchemaPass / BudgetExhausted` mainline.
  3. `used=0->1->2->3` no-schema progression and strict `session:` scope are already locked by tests, but real prompt selection still risks collapsing to `NoSchema`.
  4. stopless followup -> thinking route is strongly locked: request builder strips old routeHint and VR tests assert no `route_hint:tools/search`, only `thinking:user-input`.
  5. auto-projected stopless CLI result already rewrites into next-turn text guidance, while model-initiated stop hook history is preserved; remaining gap is finer trigger-specific guidance and system-instruction closure.
- New execution doc for implementation and E2E: `docs/goals/stopless-closure-e2e-plan.md`.

## 2026-06-16 stopless transparency re-audit

- Re-audited stopless against Jason's refined target: client/model must not perceive a server-side validator/proxy; client should only observe a model-issued CLI tool call; model should only observe ordinary user guidance; system prompt must carry stop schema format + sample; validation loop must be opaque.
- Current request-side state:
  - `req_process_stage1_tool_governance_blocks/orchestrator.rs` now prepends a stopless system instruction with required fields and `stopreason` semantics.
  - Gap: the injected system instruction has field/semantic guidance but no concrete JSON sample.
- Current model-side transparency:
  - Good: `stopless_prompt.rs` forbids internal words like `schema/hook/stopless/servertool/stop_message_auto` in client-visible continuation prompt text.
  - Good: auto-injected stopless CLI pair is rewritten in `hub_req_inbound_tool_call_normalization.rs` into ordinary user text instead of preserved tool history.
  - Gap: schema-guidance rewrite text still explicitly says things like "上一轮你直接停了，但没有附停止 JSON" / "上一轮的停止 JSON 格式不对", which exposes validation semantics to the model even if it does not expose "servertool".
- Current client-side transparency:
  - Gap: client-visible projection still intentionally exposes `exec_command` with `routecodex hook run stop_message_auto ...`; tests also assert `__servertool_cli_projection` exists on the projected chat payload.
  - Therefore current implementation does NOT satisfy the stronger "client cannot sense server existence" target; it still exposes RouteCodex-specific hook identity at the client protocol surface.
- Current loop-closure state:
  - Good: session-scoped repeat budget and 1->2->3 no-schema progression are covered by focused stopless tests.
  - Gap: trigger-specific closure is not fully transparent yet because model-facing rewrite differs by explicit validation wording, not by purely user-natural continuation framing.

## 2026-06-16 stopless transparency contract green

- Red-first lock completed:
  - TS red tests were tightened to require stopless client-visible command alias `routecodex hook run reasoning_stop`, forbid visible `stop_message_auto`, and forbid visible `__servertool_cli_projection`.
  - Rust red tests were tightened to require stopless system instruction includes concrete JSON sample, and req-side rewrite text no longer contains explicit validator narration like `停止 JSON` / `格式不对` / `重试机会`.
- Root changes landed:
  - `servertool-core/src/cli_contract.rs`: public CLI alias `reasoning_stop` now maps to internal `stop_message_auto`; client-visible payload no longer emits `__servertool_cli_projection`.
  - `src/cli/commands/servertool.ts`: CLI accepts `reasoning_stop` as stopless public alias while preserving stopless state persistence.
  - `router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`: stopless next-turn rewrite now uses user-natural wording and still carries JSON-format guidance without explicit validator narration.
  - `req_process_stage1_tool_governance_blocks/orchestrator.rs`: stopless system instruction now includes concrete JSON samples.
  - `sharedmodule/.../server-side-tools.ts`: internal execution context now carries projection metadata out-of-band instead of leaking it in client payload.
- Verified PASS:
  - `cargo test -p servertool-core cli_contract --lib -- --nocapture`
  - `cargo test -p servertool-core cli_result_guard --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi test_req_process_prepends_stopless_system_instruction_when_client_inject_ready --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi rewrites_auto_injected_stop_hook_pair_into_text_input_for_next_turn --lib -- --nocapture`
  - `cargo test -p router-hotpath-napi stop_hook_guidance_text_appends_schema_guidance_from_cli_output --lib -- --nocapture`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/servertool-cli-projection.spec.ts tests/servertool/servertool-cli-native-bridge.spec.ts tests/servertool/servertool-cli-result-restore.spec.ts tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/stopless-prompt.client-visible.spec.ts tests/servertool/servertool-mixed-tools.spec.ts tests/servertool/stop-message-runtime-utils.continuation.spec.ts --runInBand`
- Remaining gap:
  - This turn closed stopless transparency and public CLI aliasing at the focused gate layer; blackbox/live `/v1/responses` replay and full install/restart validation were not yet run in this slice.

## 2026-06-16 stopless live replay evidence

- Live gate rerun on installed `routecodex/rcc 0.90.3072`:
  - PASS focused Jest: `tests/servertool/stopless-cli-continuation.spec.ts`, `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
  - PASS Rust owner checks: `cargo test -p servertool-core cli_contract --lib -- --nocapture`, `cargo test -p router-hotpath-napi test_req_process_prepends_stopless_system_instruction_when_client_inject_ready --lib -- --nocapture`
  - PASS architecture gate: `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:function-map-compile-gate`
  - PASS hygiene: `git diff --check`
- Live relay-path proof from `~/.rcc/logs/server-4444.log`:
  - request `openai-responses-minimax.key1-MiniMax-M3-20260616T131416971-352819-447`
  - route: `longcontext/gateway-priority-5555-weighted-longcontext -> minimax.key1.MiniMax-M3.MiniMax-M3`
  - stopless fired: `[servertool] ... tool=stop_message_auto ... finish_reason=stop ... result=trigger_stop_schema_missing ... used=0 left=3 active=true`
  - final client-facing result was not raw `stop`; request completed `status=200, finish_reason=tool_calls`, proving relay stop was intercepted into CLI/tool continuation instead of terminal stop.
- Live direct-path bypass proof from the same log:
  - request `openai-responses-router-MiniMax-M3-20260616T131307950-352816-444`
  - route: `router-direct:default -> XL.key1.gpt-5.4-mini.gpt-5.5`
  - completed `status=200, finish_reason=stop`
  - no adjacent `[servertool] ... stop_message_auto ...` line for that request, which is consistent with direct stop bypassing stopless interception.
- Important live constraint discovered:
  - sending client `metadata.routeHint` directly to `/v1/responses` is rejected by request adapter (`[server.req_adapter] forbidden client metadata field: routeHint`), so live stopless replay cannot be forced from client side by routeHint injection; relay hit must come from normal classifier/weighted selection.

2026-06-16 stopless sessionId followup
- Fixed sharedmodule/llmswitch-core/src/servertool/cli-projection.ts to carry adapterContext sessionId/requestId for generic servertool CLI projection, not only stop_message_auto.
- Rebuilt routecodex-servertool debug binary before rerunning stopless/CLI blackbox, because jest targets rust-core/target/debug/routecodex-servertool directly.
## 2026-06-16 provider-error-chain G6 progress
- G6 current truth (latest=2026-06-16): `src/server/handlers/handler-response-sse.ts` now returns `Error` upward only for `upstream_stream_incomplete` cases where no client semantic SSE frame has been written yet; `src/server/handlers/handler-response-utils.ts` rethrows that error so upper executor/router-direct catch-chain can consume the normal ErrorErr05 decision path. The semantic-frame gate had to be corrected: `contractProbe.emitted` alone was insufficient because it only flips during terminal repair, not ordinary `response.created` / `response.output_text.delta` writes; current owner truth is `clientSemanticFrameWritten || terminalWatch.sawResponsesCompletedChunk || terminalWatch.sawResponsesDoneEvent || contractProbe.emitted`.
- G6 focused gates verified PASS (latest=2026-06-16): `tests/providers/core/runtime/provider-failure-policy-upstream-stream-incomplete.spec.ts` = 2/2 PASS; `tests/server/runtime/http-server/direct-decision.upstream-stream-incomplete.spec.ts` = 2/2 PASS; `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts -t "treats upstream_stream_incomplete as failed completion instead of unknown success"` = PASS after the semantic-frame gate correction; `npx tsc --noEmit --pretty false` = PASS.
- G4 red remains intentionally open (latest=2026-06-16): `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts -t "surfaces started-stream failure as explicit SSE error when upstream closes before response.completed"` still FAILs because started-stream partial output currently ends without `event: error`; this is midstream client projection / started-stream closeout behavior and belongs to G4, not G6. Do not count that red as G6 regression.
- G3/G5/G7/G10 focused gates verified PASS (latest=2026-06-16): `tests/server/runtime/http-server/executor/request-executor-primary-exhausted-plan.spec.ts` = 2/2 PASS (native VR planner bridge, no host fallback synthesis); `tests/providers/core/runtime/provider-failure-policy-client-disconnect-499.spec.ts` = 5/5 PASS; `tests/server/utils/http-error-mapper-499-client-disconnect.spec.ts` = 3/3 PASS; `tests/server/utils/http-error-mapper.client-disconnect-log-summary.spec.ts` = 2/2 PASS; `tests/server/utils/http-error-mapper.policy-exhausted-gate.spec.ts` = 7/7 PASS; `tests/server/runtime/http-server/port-config-validator-provider-failure-exemption.spec.ts` turned GREEN after adding validator checks that router-mode rejects `providerFailureExemption` and provider-mode only allows `single_binding_rethrow`.
- Live/build blocker (latest=2026-06-16): `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` currently fails in unrelated pre-existing servertool gate `cli-projection-command-contract`, specifically requiring `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs` to contain `quote_posix_single_argument(&input_json)`. Current `/health` on `127.0.0.1:5555`, `5520`, `10000` remains `status=ok ready=true pipelineReady=true version=0.90.3072`, so live replay of the new error-chain changes is still blocked by unrelated install/build state rather than runtime health.

## 2026-06-16 stopless followup -> thinking route fix

- Root cause confirmed: VR classifier only treated `latest_message_from_user=true` as thinking, so stopless CLI continuation next turn stayed tool-role and could drift to `tools` route even after stripping `routeHint`.
- Fix landed in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/classifier.rs`: when request metadata carries `serverToolFollowup=true`, classifier now promotes that turn into `thinking` eligibility.
- Red/green evidence:
  - PASS `cargo test -p router-hotpath-napi --lib -- 'virtual_router_engine::classifier::tests::' --nocapture`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-vr-route-hint.spec.ts --runInBand`
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc -p tsconfig.json --noEmit --pretty false`
- Build/install/restart evidence:
  - PASS `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh`
  - Installed `routecodex/rcc = 0.90.3074`
  - Health PASS: `127.0.0.1:5555`, `5520`, `10000` all `status=ok ready=true pipelineReady=true version=0.90.3074`
- Live local CLI continuity proof after install:
  - `CODEX_THREAD_ID=stopless-vr-fresh-3074 routecodex hook run reasoning_stop ...` returned continuation prompts in sequence:
    1. `继续做下一步；先把手头能确认的结果拿回来。`
    2. `继续推进；缺哪块结果就补哪块，别停在概述上。`
    3. `这次不要再泛泛地说了。把还能验证的文件、日志、命令都直接补完；如果还是收不住，就明确写清楚卡点、已经排除的路、以及还差我拍板的那一步。`
    4. fourth call returned `summary=stopless budget exhausted`
  - Persisted state file `~/.rcc/state/routing/session-codex_stopless-vr-fresh-3074.json` shows `stopMessageUsed=3`, `stopMessageMaxRepeats=3`, and final-round prompt text.
- G2/G4/G9 progress (latest=2026-06-16): G2 JSDoc contract in `src/server/runtime/http-server/router-direct-pipeline.ts` now explicitly says payload passthrough remains but error passthrough is not preserved; router-direct failures must flow to `decideDirectRouterRetry` / ErrorErr05 before client projection. G4 owner `src/server/handlers/handler-response-sse.ts` now emits explicit `event: error` with `upstream_stream_incomplete` for started-stream partial semantic frames before closing; `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts -t "surfaces started-stream failure as explicit SSE error when upstream closes before response.completed"` PASS, and `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts -t "treats upstream_stream_incomplete as failed completion instead of unknown success"` was updated to the new client-visible G4 contract and PASS. G9 scan: `suppressRouterDirectRetry` old guard has no code hit (only historical comment in `index.ts`); old 4xx early projection is gated by policy/candidate exhaustion and locked by `http-error-mapper.policy-exhausted-gate.spec.ts`; `Upstream rejected the request` remains only as exhausted projection text and test expectation, not a pre-exhaustion shortcut.
- Focused bundle (latest=2026-06-16): 10 suites / 54 tests PASS for provider error chain focused gates: upstream stream incomplete policy, direct decision, started-stream handler regression, SSE finish-reason contract, primary exhausted native-plan bridge, 499 client-disconnect policy/mapper/log summary, policy-exhausted gate, and providerFailureExemption validator. Jest still reports existing open handles after completion.
- Build blocker update (latest=2026-06-16): the previous install blocker `verify:responses-history-protocol-contract` was reduced to a Rust test helper visibility issue in `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/classifier.rs`: late tests referenced `classifier()` outside that helper's visible scope. Minimal fix added module-level `#[cfg(test)] use serde_json::json;` plus `test_classifier()` helper and rewired the test calls; no runtime classifier logic was intentionally changed. Gate now PASS: `cargo test -p router-hotpath-napi shared_responses_conversation --lib` -> 29 passed / 1680 filtered.

## 2026-06-16 stopless + error-chain pre-commit audit

- Current git index only held the error-chain slice; stopless source changes were still unstaged in worktree, so commit had to be rebuilt from exact owner files instead of trusting previous staged state.
- Verified stopless trigger chain is end-to-end, not an isolated `cli_contract.rs` tweak: `stop-message-auto.ts` writes `stopSchemaTriggerHint` -> `engine.ts` projects it into CLI input -> `servertool-core/src/cli_contract.rs` maps it to natural-user continuation text + schema guidance.
- Found and corrected stale dual-writer comments in Rust CLI persistence (`servertool-cli/src/main.rs`, `servertool-core/src/persisted_state_fs_write.rs`): current truth is single-writer stopless session persistence owned by the Rust CLI, not TS shell second-write compensation.

- 2026-06-16 stopless live audit: found repeatCount 2/3 oscillation. Root cause: TS stop-message-auto seeds CLI persisted state with schemaUsedBeforeCount while native handler stateUpdate already advances used+1; mixed entrypoints cause session state to bounce between used=2 and used=3. Must align to single post-handler used truth and remove old CLI preseed semantics.

- 2026-06-16 online verification: 5520 direct request returned normal assistant text and did not project stopless CLI/tool call. Added direct route red test in tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts to lock same-protocol direct + finish_reason=stop passthrough with no stopless injection.
- 2026-06-16 online verification: 5555 relay first stopless intercept returned finish_reason=tool_calls with empty visible content and exec_command tool call carrying natural-language continuationPrompt; no schema/control text leaked in client-visible message content.
- Remaining gap: need stronger live evidence for 5555 relay followup VR route=thinking from the current running log stream / request IDs; current accessible server-5555.log does not contain the fresh request lines, so this item remains unproven from logs.

- 2026-06-16 stopless budget re-arm bug fixed. Red test added at servertool-cli/tests/cli_blackbox.rs::exhausted_stopless_run_clears_session_state_for_next_turn now locks: after 3rd hit returns stopless budget exhausted with triggerHint=budget_exhausted and repeatCount=3, every subsequent invocation of stop_message_auto for the same session stays terminal (summary=budget exhausted, repeatCount=3). Root cause: persist_stopless_continuation_state wrote empty text on budget_exhausted, which record_stopless_continuation_state treats as a clear signal, so the next call re-armed from repeatCount=1. Fix: always persist continuation_prompt text; let the snapshot remain terminal.

## 2026-06-16 primary_exhausted -> default_pool review findings

- Current uncommitted host-side slice is still wrong for `virtual_router.primary_exhausted_to_default_pool`: `src/server/runtime/http-server/index.ts` and `src/server/runtime/http-server/request-executor.ts` call `resolvePrimaryExhaustedRouteName(metadata...)`, so route truth is guessed from metadata/routeHint instead of coming from VR failure details. This does not satisfy the "real exhausted route" requirement when VR selection fails before `decision.routeName` exists.
- Current host planner input also mismatches identity domains: `extractRoutingTiersForRoutingGroupRoute()` preserves raw route targets such as `fwd.gpt.gpt-5.5`, but `exhaustedTargets` is still fed from `excludedProviderKeys` concrete provider keys. Rust planner compares strings directly, so forwarder-backed primary exhaustion cannot correctly trigger backup/default tier selection.
- Current production code exports `__setPrimaryExhaustedPlanNativeForTests` from `request-executor-core-utils.ts`; this is a test-only mutable injection surface and should be removed in favor of test-local native bridge mocking.
- Preferred fix direction for this slice: Rust VR selection error must carry stable exhausted-route truth (`routeName` + route-target identity in the same domain as tier targets), and host must consume that truth only. No metadata guessing fallback.

## 2026-06-16 19:15:14 stopless session relay nested scope audit
- Hypothesis: live relay stopless loses session scope when only __rt.responsesRequestContext carries sessionId/conversationId; server-side used stays 0 and CLI projection repeats repeatCount=1.
- Evidence: old live log server-5520 shows [session-request][rt] session=unknown with stop_compare used=0 on repeated stopless followups.
- Plan: add red tests for nested __rt.responsesRequestContext -> adapterContext/sessionId and stopless 1->2->3 using only that source; then patch normalizer/engine owner paths.

## 2026-06-16 19:20:02 stopless session propagation fix verified
- Root cause confirmed: relay stopless session scope was not being backfilled from nested __rt.responsesRequestContext, so stopless CLI projection could omit --session-id and every run started at repeatCount=1.
- Fix applied: backfill nested __rt.responsesRequestContext into servertool adapter context, followup metadata, and stopless session read path.
- Verification PASS: servertool-adapter-context spec, stopless-cli-continuation spec, servertool-followup-metadata spec, root tsc, git diff --check.
- 2026-06-16 stopless live repeatCount stuck at 1 root-cause slice:
  - c1723ba fixed nested `__rt.responsesRequestContext.sessionId` propagation into relay stopless session truth.
  - Remaining live gap: stopless CLI binary and server relay runtime can read/write different routing state roots.
  - Evidence: server runtime uses per-port `ROUTECODEX_SESSION_DIR` under `~/.rcc/sessions/<serverId>/ports/<group>`, but `servertool-cli` defaults to `~/.rcc/state/routing` unless env override is passed into the projected command execution environment.
  - Fix direction: CLI projection must carry current `ROUTECODEX_SESSION_DIR`; req-side stopless command recognition must accept env-prefixed command lines so submit_tool_outputs normalization still closes the loop.

## 2026-06-16 stopless CLI sessionId/requestId 收口

- 用户约束：CLI 不许再生成 fake `sessionId`/`requestId`；stopless 续杯必须用真实链路的 sessionId，禁止 fake 兜底。
- 物理删除的 owner:
  - `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`:
    - 删除 `static STOPLESS_ID_COUNTER`、`fn next_stopless_id_counter`、`fn current_time_ms`。
    - 删除 `fn resolve_stopless_default_session_id`(env 兜底: `CODEX_THREAD_ID`/`TMUX_PANE`/`TERM_SESSION_ID`/`ITERM_SESSION_ID`/`pid:...` 全部不再回退)。
    - 删除 `fn resolve_stopless_default_request_id`(不再基于时间戳和 counter 拼 stopless id)。
    - 同步删除 `use std::sync::atomic::{AtomicU64, Ordering}` 和 `use std::time::{SystemTime, UNIX_EPOCH}` 两个仅服务于 fake 生成的 import。
    - `validate_stopless_session_identity` 改为 fail-fast：缺 `sessionId`/`requestId` 直接 `MissingField` 错误。
  - `tests/cli/servertool-command.spec.ts`:
    - 删除 `auto-fills stop_message_auto session identity when caller omits it` 旧测试。
    - 新增 `omitting sessionId causes CLI to fail with missing field error`，断言 exitCode=1 + `SERVERTOOL_CLI_MISSING_FIELD`。
- 顺带修复的二级 owner:
  - `cli_contract.rs::build_stop_message_auto_run_output` 的 `current_repeat_count` 优先级从 `[CLI arg, payload.repeatCount, persisted.used+1]` 改为 `[CLI arg, persisted.used+1, payload.repeatCount]`。这是同一真实 `sessionId` 重复调用卡在 `repeatCount=1` 的真正根因：payload 把会话状态压回 1。
- 红测新增/强化 (`servertool-cli/tests/cli_blackbox.rs`):
  - `missing_session_identity_fails_with_missing_field_error`: 缺 sessionId 必须失败，stderr 含 `SERVERTOOL_CLI_MISSING_FIELD: sessionId`。
  - `stopless_continuation_count_increments_with_real_session_id`: 同一 `sessionId` 真实调用三次，前两次 `summary=stopless continuation ready`、`repeatCount=1/2`，第三次 `summary=stopless budget exhausted`、`repeatCount=3`。
- 验证 PASS:
  - `cargo test -p servertool-cli --test cli_blackbox` 21/21。
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/cli/servertool-command.spec.ts --runInBand` 19/19。
  - `cargo build -p servertool-cli` 0 errors。
- 实机 binary (`sharedmodule/llmswitch-core/rust-core/target/debug/routecodex-servertool`) 三连调用 `session-real-verify`:
  - step 1: `repeatCount=1, summary=stopless continuation ready`
  - step 2: `repeatCount=2, summary=stopless continuation ready`
  - step 3: `repeatCount=3, summary=stopless budget exhausted, triggerHint=budget_exhausted`
  - step 4 (after exhaust): 仍 `repeatCount=3, summary=stopless budget exhausted`，不再回弹到 1。
- 残留风险: `routecodex hook run` 当前调的是已安装的 release 二进制，本次 owner 改动必须 `ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh` 之后 live 才能体现。
## 2026-06-16 ~/.rcc 只读审计

### 规模
- 根 /Volumes/extension/.rcc (= ~/.rcc)，72 项顶层，du 7.5G
- diag/ 5.3M (1 文件)
- logs/ 475M (provider-stats.jsonl + .1-.3 各 64M, server-5520.log 196.7M, server-4444.log 18.8M, process-lifecycle.jsonl 34.9M)
- codex-samples/ 753M
- state/provider-traffic.backup-20260512T102818 19M
- state/provider-traffic 416K
- state/provider-traffic-test 344K
- diag 之前 104G，cleanup 后 5.3M (1 个 gpt-5.4 错误)

### 配置文件真源
- 代码默认 config.toml（src/server/.../providers-handler-routing-utils.ts:614 列 [config.toml, config.json]）
- 脚本默认 config.json（scripts/provider-v2-smoke.mjs:12, replay-recorded-toolcall.mjs:44, clean-safe.mjs:42）
- 实测只有 config.toml (14.2K, 6/16 15:16 写入)
- 备份：config.toml.bak-20260604T235302, config.toml.bak-5520-before-llmgate-only-20260606T233448, config.toml.bak-gpt55-to-gpt54-20260611171632
- variants: config.dbittai.toml (1.4K, 5/15), config.long.omlx.toml (2.6K, 5/10)
- config/multi/, config/single/ 下的 JSON 旧配置 + 1 个 stop-message.json + .bak
- backup-20260513/ 14 个旧 config.json 残留
- 结论：真源 config.toml，其它全部应归档

### PID 文件 (16 个)
路径：~/.rcc/server-{port}.pid (src/index.ts:964, src/cli/commands/start.ts:478, src/utils/managed-server-pids.ts:18)
实测：10000 死, 18520 死, 4444 活, 5520 活(同 pid 25530), 5521 死, 5522 活, 5532 死, 5533 死, 5536 死, 5555 死, 5560 死, 5566 死, 5567 死, 6520 死, 6633 死, 6666 死
死 pid 13/16 = 81%
无任何代码清理 (rg 'unlink.*pid|deletePid|removePid|cleanupPid|clearPid' src/ = 0)
cleanup-stale-server-pids.mjs 存在但引用 ~/.routecodex（老目录），不清理 ~/.rcc

### daemon-stop (5 个)
路径：~/.rcc/daemon-stop-{port}.json (src/utils/daemon-stop-intent.ts:20, maxAgeMs=60000)
实测：10000 (5/29), 3333 (5/30), 4444 (5/30), 5520 (6/14), 5555 (6/9) — 全部超过 60s，未消费未清理
只有 start.ts:567 在新 start 时调 clearDaemonStopIntent，无独立 reaper

### 临时文件
- token-stats.json.tmp-* 12 个 (2.4-2.9M 各)，最新 6/15
- config.toml.bak-* 3 个
- stop-message.json.bak-* 1 个
- auth/windsurf-ws-pro-4.json.bak-* 1 个

### 大目录
- codex-samples/ 753M — 采集样本，可保留
- logs/ 475M — 实际日志，主因
- diag/ 已缩 104G → 5.3M（清理过）

### 未在代码中的目录
- ~/rcc-protocols/raw/ 空目录，无引用
- ~/.rcc/camoufox-fp/ 单独 fingerprint json（与 camoufox-profiles/ 重叠）
- ~/.rcc/camoufox-profiles/ 10 个 profile (rc-default, rc-auth.* 4, rc-qwen.* 5, rc-iflow.138)
- ~/.rcc/windsurf-ls/ 339M 9 个 ws-pro instance + managed + windsurf-default-runtime
- ~/.rcc/windsurf-workspaces/ 0B 空目录
- ~/.rcc/provider-traffic-test/ 0 引用（除 jest worker 自身使用，prod 无用）

### 日志轮转
- stats-manager.ts:201 有 rotateStatsLogIfNeeded (64M * 3 backups)
- process-lifecycle-logger.ts 无 rotate
- server-*.log 无 rotate（196.7M 单文件）
- provider-stats.jsonl 有 .1-.3 rotation 在工作

### 结论（按用户问题）
1. config 多份 → 留 config.toml 一份真源，其余归 backup-20260513
2. pid 16 个死 13，无清理 → 加 start/stop 收尾 unlink + 启动期 reaper
3. daemon-stop 5 个全过期 → maxAgeMs=60s 不会 reaper，扩到 process lifecycle hook
4. tmp/bak 无上限 → 启动时清理 > 7d 旧 tmp/bak
5. camoufox-fp / windsurf-ls / windsurf-workspaces 大量未引用目录 → 需评估保留范围
## 2026-06-16 agents/coding-principals architecture audit

- 审计目标：判断 `function map + owner + 主线逻辑调用绑定` 是否是大型多文件项目中降低误改风险的好方案；结合 RouteCodex 现状评估是否还有更优补强，以及本项目落地是否彻底。
- 已读真源：
  - `~/.codex/USER.md`
  - `CACHE.md`
  - `docs/agent-routing/00-entry-routing.md`
  - `docs/agent-routing/10-runtime-ssot-routing.md`
  - `~/.codex/skills/coding-principals/SKILL.md`
  - `~/.codex/skills/reviewing-code/SKILL.md`
  - `docs/architecture/function-map.yml`
  - `docs/architecture/verification-map.yml`
- 初步发现：
  - 全局/项目 `AGENTS.md` 与 `coding-principals` 明确要求 owner registry、function map、verification map、architecture gates、拓扑命名与唯一 owner，这个方向本身正确。
  - RouteCodex 已有较完整 `function-map.yml` / `verification-map.yml` / 架构 gate 命令栈，说明不是纯文档口号。
  - 但 `coding-principals` 里要求的“code-bound function map”包含 `request/response/error mainline`、`function-call tables`、`caller/callee`、`symbol path` 等；当前 `function-map.yml` 抽样更像 feature owner registry + allowed/forbidden path + tests/gates，未见完整跨主线调用表字段。
  - 结论候选：当前方案方向对，但还没完全实现到“owner + 主线调用绑定”最彻底形态；还需要把 registry 升级到更强的代码可查询调用关系与自动化入口。
- 本轮落地：
  - 新增 `docs/architecture/mainline-call-map.yml` 作为 `function-map.yml` 的补充层，先放 request/response/error 三条主线骨架。
  - 新增 `docs/goals/mainline-call-map-closeout-plan.md`，给出 closeout 目标、规则、验证和完成标准。
  - `docs/architecture/README.md` 已声明 `mainline-call-map.yml` 职责，避免后续继续把 owner registry 误当完整调用绑定图。
  - 第二轮补边已把一批 `binding_pending` 收紧为真实符号：
    - request 入口：`prepareResponsesHandlerEntryForHttp -> planResponsesHandlerEntry`
    - request capture：`buildResponsesRequestContextForHttp -> captureReqInboundResponsesContextSnapshotJson -> captureReqInboundResponsesContextSnapshotWithNative`
    - response projection：`prepareResponsesJsonClientDispatchPlanForHttp -> projectResponsesClientPayloadForClientWithNative`
    - error decision/projection：`resolveProviderRetryExecutionPlan -> consume_error_err_05_execution_decision_from_error_err_04_router_policy` 与 `project_error_err_06_client_from_error_err_05_execution_decision -> mapErrorToHttp`
  - 纠偏：`sendErrorResponse` 不存在，已从 map 中移除，防止把假 symbol 写成契约。
  - 第三轮补边：
    - response 前半段已锚定到 typed entrypoint：
      - `run_hub_resp_inbound_02_parsed_entrypoint -> parse_hub_resp_inbound_02_from_provider_resp_inbound_01`
      - `run_hub_resp_chatprocess_03_governed_entrypoint -> build_hub_resp_chatprocess_03_from_hub_resp_inbound_02`
    - request 中段仍暂留 pending，不是遗漏：当前 live runtime 主线是 `engine.rs` 里的 `select_route + apply_vr_route_04_selection`，而 typed contract owner 另有 `build_vr_route_04_from_hub_req_chatprocess_03` / `build_hub_req_outbound_05_from_hub_req_chatprocess_03`，两层尚未收敛成单一 caller-callee 直链，不能硬写假绑定。
  - 这一套方法现已上升为公共规则候选：
    - 全局 `~/.codex/AGENTS.md` 新增 `Mainline Call Map 强制原则`
    - `coding-principals` 新增 `Mainline Call Maps` 小节
    - 核心思想：`function map` 管 owner/paths/gates，`mainline call map` 管 request/response/error 主线边、caller/callee、facade/runtime/typed-contract 分层；未证实边必须 `binding pending`，禁止伪造完整主线。

### 2026-06-16 runtime lifecycle pid rebase implementation
- Added design SSOT: docs/design/server-runtime-lifecycle-ssot.md
- Added helper owners:
  - src/utils/server-runtime-pid.ts
  - src/utils/server-runtime-stop-intent.ts
  - src/utils/runtime-instance-registry.ts
- user-data-paths.ts adds subdirs: runtimeLifecycle, run, tokenStats
- daemon-stop-intent.ts is now thin re-export to new stop-intent helper
- managed-server-pids.ts reads new pid cache path first, legacy root pid second
- start.ts writes server pid cache via helper
- index.ts writes server pid cache via helper
- cli.ts + commands/token-daemon.ts move token-daemon pid path to runtime helper
- cleanup-stale-server-pids.mjs scans both ~/.rcc root legacy pid files and state/runtime-lifecycle/ports/*/pid.cache; parses pid.cache JSON
- Added tests:
  - tests/utils/server-runtime-pid.spec.ts
  - tests/utils/runtime-instance-registry.spec.ts
  - tests/red-tests/runtime_pids_moved_out_of_rcc_home_root.test.ts
- Added gate: scripts/architecture/verify-runtime-lifecycle-pid-rebase.mjs + package.json script verify:runtime-lifecycle-pid-rebase
- Added function-map entries:
  - runtime.lifecycle.pid_cache
  - runtime.lifecycle.stop_intent
  - runtime.lifecycle.instance_registry

### Verification 2026-06-16
- PASS: npm run verify:runtime-lifecycle-pid-rebase
- PASS: npx tsc --noEmit --pretty false
- PASS: focused jest
  - tests/utils/server-runtime-pid.spec.ts
  - tests/utils/runtime-instance-registry.spec.ts
  - tests/utils/daemon-stop-intent.spec.ts
  - tests/utils/managed-server-pids.spec.ts
  - tests/red-tests/runtime_pids_moved_out_of_rcc_home_root.test.ts
- Existing unrelated/ambiguous suite: tests/cli/start-command.spec.ts still exits at config path resolution branch (line 242/255) because it stubs fsImpl but resolveRouteCodexConfigPath still uses real FS; not a clean regression signal for this slice.

### Live cleanup evidence
- Ran node scripts/cleanup-stale-server-pids.mjs --quiet against real ~/.rcc
- Root pid files: 16 -> 2 (live 4444, 5520) -> manually removed both after confirming they were legacy root pid files
- Root daemon-stop files: 5 -> 0 (manually removed)
- Current root no longer has server-*.pid or daemon-stop-*.json
- Remaining root clutter not touched in this slice because live code still writes/reads them:
  - token-stats.json + token-stats.json.tmp-*
  - config.dbittai.toml / config.long.omlx.toml / config.toml.bak-*

## 2026-06-16 5520 direct responses stale inbound retention audit

- Jason 明确纠偏：这轮不要继续盯请求出站 compat，先查 direct 响应链里“上轮响应入站未清理”。
- 现场硬证据：
  - `~/.rcc/logs/server-4444.log:94090-94099` 对应 requestId `openai-responses-router-gpt-5.4-20260616T214159290-356290-3918`，`router-direct.send` -> upstream `HTTP 400`。
  - `~/.rcc/diag/error-openai-responses-router-gpt-5.4-20260616T214159290-356290-3918.json` 显示本次失败 body 没有 `previous_response_id/response_id`，但 `input` 总长 355，尾部含连续 `function_call/function_call_output` 与混入的 `reasoning/assistant output_text`，符合“普通 fresh request 混进上轮响应历史残留”。
- 代码对照：
  - `src/server/runtime/http-server/index.ts::buildRouterDirectResult()` 当前对 `openai-responses` 的 200 JSON success 一律 `recordResponsesResponseForRequest(...) + finalizeResponsesConversationRequestRetention(...)`，只在 `keepForSubmitToolOutputs` 上按 `finishReason === 'tool_calls'` 区分。
  - `buildProviderDirectResult()` 则只在 `finishReason === 'tool_calls'` 时保留，其他 success 显式 `clearResponsesConversationByRequestId(...)`。
- 当前判断：
  - router-direct 会错误保留 `finish_reason=stop/completed` 的普通响应，后续 fresh `/v1/responses` 可被 scope materialize 污染。
  - `tests/server/runtime/http-server/direct-result-metadata-propagation.spec.ts` 里现有 router-direct “success retention” 旧合同正好把这个错误行为锁成了期望，需要翻成红测。
  - 先红时又暴露一个测试壳问题：该 spec mock `responses-conversation-store-native.js` 时漏了新导出 `stripStoredContextInputMedia`，suite 先死在 module link，不是业务红。
- 本轮修复计划：
  1. 补测试 mock 缺失导出，让 suite 真正执行。
  2. 把 router-direct 普通 completed success 的旧合同改为“必须清空 store / 不得可续接”。
  3. 修改 `buildRouterDirectResult()`：仅 `finishReason === 'tool_calls'` 才 record+finalize；其他 success 显式 clear。
  4. 跑 focused Jest + `git diff --check`；若通过，再做 live replay 看 5520 direct 是否不再混入上轮 `function_call/function_call_output` 残留。

## 2026-06-16 architecture mainline split-binding closeout

- 当前 mainline call map 第 2 步不再把 `req-03` / `req-04` 当作“待补具体 symbol”的普通 pending，而是显式标注为 split binding：
  - `HubReqChatProcess03Governed -> VrRoute04SelectedTarget`
  - `HubReqChatProcess03Governed -> HubReqOutbound05ProviderSemantic`
- 证据来自 Rust 双层真相分离：
  - runtime orchestration: `hub_pipeline_lib/engine.rs`, `vr_route_04_selection_boundary.rs`
  - typed contract builders: `hub_pipeline_types/vr_route_04_selected_target.rs`, `hub_pipeline_types/hub_req_outbound_05_provider_semantic.rs`, `request_typed_entrypoints.rs`
- 约束更新：runtime orchestration 与 typed contract builder 分层时，必须落 `split_bindings`，禁止在 mainline graph 里伪造单一 caller/callee edge。

## 2026-06-16 architecture split-binding gate tightening

- 第 3 步目标：把 split binding 从“可渲染说明”升级为“强 schema + 强引用关系”。
- 结构收紧：
  - pending edge 新增 `split_binding_id`
  - `split_bindings.binding_id` 必须能被至少一条 pending edge 反向引用
  - split binding 的 `from_node/to_node` 必须与引用它的 pending edge 转换一致
  - `runtime_symbols` / `typed_symbols` 必须非空，且 symbol/file 都要真实存在
- 这样可以防止两类漂移：
  1. note 文本写了 split binding 名，但实际没有结构化绑定；
  2. split binding 还在文档里，但对应 pending edge 已被改名/改边/删除。

## 2026-06-16 architecture wiki coverage expansion

- 继续收口两件事：
  1. `response.mainline` 的 `resp-01` / `resp-02` 已有 caller/callee，但 owner 仍未绑定；本轮按 function-map 证据补齐。
  2. `docs/architecture/wiki/` 当前只有 `README.md` + `mainline-call-graph.md`，review 面明显不足；先补一页 `coverage-matrix.md` 固定“已有/缺失/下一批”清单，避免后续补图发散。
- 拆分策略已定：
  - `mainline-call-map.yml` 继续驱动 request/response/error/runtime 四条链图
  - `function-map.yml` 驱动 `hub.servertool_*` 和 `vr.* / virtual_router.*` owner 聚合页
  - 自动生成脚本统一输出 wiki 页面，禁止手写多份同义 review 面

## 2026-06-16 runtime lifecycle pid map closure
- 任务：更新 mainline-call-map.yml + wiki，完成 function-map 已绑定的 runtime.lifecycle 三个 feature 的文档闭环。
- mainline-call-map.yml：新增 `runtime.lifecycle.mainline` chain，7 edges：
  - rtl-01: start.ts → writeServerPidCache (anchored)
  - rtl-02: index.ts → writeServerPidCache (anchored)
  - rtl-03: stop.ts → writeServerStopIntent (anchored)
  - rtl-04: start.ts → consumeServerStopIntent (anchored)
  - rtl-05: cli.ts → resolveTokenDaemonPidPath (anchored)
  - rtl-06: token-daemon.ts → resolveTokenDaemonPidPath (anchored)
  - rtl-07: instance_registry self-edge (binding pending: 无主 runtime 调用方)
- shared_multi_reference_functions 新增：runtime.lifecycle.pid_cache_writer / stop_intent_signal / stop_intent_consumer
- wiki 重 render：npm run render:architecture-mainline-mermaid → ok
- gate PASS：verify:architecture-mainline-call-map (21 edges / 6 shared functions / 4 chains)
- gate PASS：verify:architecture-mainline-mermaid-sync
- CI 问题：verify:architecture-forbidden-path-growth 失败于 Rust target 目录 ENOENT，环境问题，与本 slice 无关；前面的 verify:architecture-mainline-call-map 和 mermaid-sync 均已 PASS
- git 状态：文件已被其他 session 合并入 HEAD (f5fe2a940)，无需再 commit；当前 worktree dirty 为其他 worker 改动

## 2026-06-16 5520 direct SSE response.metadata allowlist fix

- 用户给出的 live 样本：`openai-responses-router-gpt-5.4-20260616T232300793-357176-4804` 在 5520 `/v1/responses` direct SSE 写客户端前失败，错误为 `direct passthrough SSE emitted non-Responses event "response.metadata"`。
- mainline/function-map 定位：
  - response mainline `resp-03/resp-04` 显示 client projection 真源仍为 `hub.response_responses_client_projection` Rust owner；
  - direct SSE frame/metadata guard 属于 `server.responses_sse_bridge_surface` / `server.responses_response_handler_bridge_surface` TS bridge surface；
  - 不应在 provider runtime 或 Hub projection 增加转换补偿。
- 根因：direct SSE allowlist 漏掉 live upstream/provider `event: response.metadata`；这和“metadata 内部 carrier 泄漏”不是同一类问题。
- 红测证据：先把 `tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` 改为普通 `response.metadata` 应通过、同事件携带 `providerKey/__rt` 应失败，当前实现先红 2 条，说明被 event allowlist 过早拒绝。
- 修复：`src/modules/llmswitch/bridge/responses-response-bridge.ts` 的 `RESPONSES_DIRECT_PASSTHROUGH_ALLOWED_EVENTS` 增加 `response.metadata`；不改 payload、不过滤 frame、不加 provider 特例。
- 绿测证据：`PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts --runInBand` -> 4/4 PASS。
- 待验证：build/install/restart 后需要用 5520 `/v1/responses` live replay 确认不再出现该 projection error，且内部 metadata leak guard 仍无 regress。

## 2026-06-17 stopless session truth 收口

### 根因（已验证）
1. `cli_contract.rs`: CLI `--repeat-count` 优先级高于 persisted，导致 caller 传的 `repeatCount=1` 每轮重置计数器。修复：persisted truth 优先，`current_repeat_count = persisted.used + 1`（无 persisted 才用 CLI arg）。
2. `seedStoplessCliPersistedState` pre-seed 写 `used=N`，CLI 写 `used=N+1`，但 pre-seed 每次重置；加上 routing state store 的写盘路径依赖 `process.env.ROUTECODEX_SESSION_DIR`（server 进程无此 env，CLI 有），导致两边写到不同目录。修复：
   - wrapper `loadRoutingInstructionStateSync/saveRoutingInstructionStateSync` 显式接受 `sessionDir` 参数，不依赖进程 env。
   - `resolveAdapterContextSessionDir` 从 `adapterContext.__rt.sessionDir` 读。
   - stop-message handler 所有读写路径统一透传 `sessionDir`。
   - 删除 `savePersistedRuntimeStopMessageStateWithNative`（双写导致混淆）。
3. `stopMessageAiMode` 字段已弃用但未删除（根因文档有误）。
4. pre-seed `nextUsed` 应写 `schemaUsedBeforeCount`（当前轮之前的计数），让本轮 CLI 推进到本轮值。

### 修改文件
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/cli_contract.rs`: repeatCount 优先级倒置 + 测试截断修复
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.ts`: load/saveRoutingInstructionStateSync 加 `sessionDir` 参数
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts`: 删除 `savePersistedRuntimeStopMessageStateWithNative`；所有 persisted state 读写统一走 `saveRoutingInstructionStateSync` + 显式 `sessionDir`
- `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto.ts`: 所有 `loadRoutingInstructionStateSync/persistStopMessageState/resetPersistedStopMessageUsed/clearPersistedStopMessageRuntimeState` + `seedStoplessCliPersistedState` 统一透传 `sessionDir: resolveAdapterContextSessionDir(ctx.adapterContext)`；pre-seed 写 `schemaUsedBeforeCount`
- `scripts/verify-servertool-rust-only.mjs`: gate 断言更新
- `scripts/tests/stopless-5555-final-probe.mjs`: live 验证脚本

### Live 验证结果（14/14 PASS）
- Step 1: exec_command 带真实 `--session-id / --request-id`，`ROUTECODEX_SESSION_DIR` 正确
- Step 2: CLI stdout 带 `output.sessionId / requestId`；`output.input` 仅 4 keys；`continuationPrompt` 模板正确
- Step 3: 同一 sessionId 推进 `1 → 2 → 3`（terminal）
- Step 4: 5520 direct 不触发 stopless

### 未完成项
- `stopMessageAiMode` 字段物理删除（不影响 stopless 核心）
- `cli_contract.rs` 的 `STOPLESS_PROMPT_FORBIDDEN_TOKENS` 长度（长度限制未实现）

## 2026-06-17 architecture wiki coverage closeout in progress

- 新增 wiki 目标页：
  - `docs/architecture/wiki/responses-direct-relay-map.md`
  - `docs/architecture/wiki/servertool-followup-call-graph.md`
- 这两页的 review 面焦点：
  - `responses-direct-relay-map`：`direct/relay + store=true/store=false`、合法 continuation 入口、`entryKind + continuationOwner + scope` 三重隔离、`__shadowCompareForcedProviderKey` provider pin、非法 crossing。
  - `servertool-followup-call-graph`：`HubRespChatProcess03Governed -> ServertoolResp03RuntimeAction -> ServertoolReq04FollowupBuilt -> normal reenter -> ServertoolResp03FollowupResult -> HubRespOutbound04ClientSemantic`，以及 `generic CLI projection` / `stopless CLI` 与 followup 的分流。
- 同步更新：
  - `docs/architecture/wiki/README.md`
  - `docs/architecture/wiki/coverage-matrix.md`
  - `docs/architecture/README.md`
- 当前已完成文本落盘与 `git diff --check`；待补最后证据是新页 Mermaid 浏览器渲染确认，然后按小提交提交。
## 2026-06-17 architecture wiki html formalization

- 用户纠正点已确认：Mermaid HTML 渲染页不能再只是 `/tmp/*.html` 验证产物，必须是 repo 内正式文档，且同时保留人读与机器读两套正式文档面。
- 已补方案方向：`docs/architecture/wiki/*.md` 继续作为 canonical human-readable source；新增 `docs/architecture/wiki/html/*.html` 作为正式 HTML render artifact；机器可读真源继续是 `function-map.yml`、`mainline-call-map.yml`、`verification-map.yml`。
- 待验证闭环：生成 repo HTML artifact、跑 html sync gate、用浏览器直接打开 repo 内 html 页面确认 Mermaid 无语法错误。

## 2026-06-17 stopless sessionDir metadata-only simplification

- 用户要求已收口：`sessionDir` 不再信 env / 顶层字段 / 多分支猜测，只信 runtime metadata carrier。
- 已删生产逻辑里的 `ROUTECODEX_SESSION_DIR` fallback；`servertool/cli-projection.ts` 与 `stop-message-auto/runtime-utils.ts` 现在只从 `readRuntimeMetadata(...)` 读取 `sessionDir`。

## 2026-06-17 ROUTECODEX_SESSION_DIR semantics clarification

- 目录真相已确认：`ROUTECODEX_SESSION_DIR` 不是单一 session id 目录，而是 runtime workdir root。
- 这个目录混放了 routing state、session-bindings、provider-health、servertool-pending 等多类状态；`sessionId` / `tmuxSessionId` / `conversationId` 只是不同 namespace 的 key，不是同一个概念。
- 2026-06-17 followup：`pending-session.ts` 已改成显式 `sessionDir` 参数；生产 caller `pending-injection-block.ts` 只从 runtime metadata 取 `sessionDir`，不再偷读 env / top-level fallback。
- 2026-06-17 followup：`native-virtual-router-routing-state.{ts,js}` 在“未传 sessionDir”时传 `__ROUTECODEX_NO_SESSION_DIR_OVERRIDE__` sentinel；Rust `routing_state_store` 据此禁用 `ROUTECODEX_SESSION_DIR` env fallback。
- 2026-06-17 verify：`tests/servertool/pending-session.spec.ts`、`tests/sharedmodule/servertool-pending-session.spec.ts`、`tests/servertool/pending-injection-block.spec.ts`、`tests/sharedmodule/sticky-session-store-paths.spec.ts`、`tests/servertool/stopless-cli-continuation.spec.ts` 已对齐新 contract。
## 2026-06-17 direct `/v1/responses` upstream_stream_incomplete 排查

- 样本日志：5520 direct `/v1/responses`，`started (stream=true acceptsSse=true timeoutMs=900000)` 后命中 `asxs.crsa.gpt-5.4`，约 13s 后报 `[response.sse.stream] error {"message":"stream closed before response.completed","code":"upstream_stream_incomplete"}`。
- 已知前情：本轮刚修复的是 provider SSE headers timeout 过短；当前新错误已不是 `UPSTREAM_HEADERS_TIMEOUT`，需要继续确认 owner 是否在 direct SSE bridge / provider runtime / upstream 真流。
- 代码定位：client-visible `upstream_stream_incomplete` 由 `src/server/handlers/handler-response-sse.ts` stream end 收尾逻辑投影；具体 payload builder 在 `src/modules/llmswitch/bridge/responses-response-bridge.ts::buildResponsesStreamIncompleteErrorPayloadForHttp`。
- 当前判定条件：`planResponsesStreamEndRepairForHttp()` 仅在“未见 terminal event 且 probe 无法修复 continuation/completion”时走 incomplete；不是 headers timeout，也不是 router-direct request builder。
- 已排除假因：补的 custom_tool_call continuation 样本证明 bridge 对 `response.output_item.{added,done}` 的 custom tool 断流会补 `response.completed/response.done`，不会触发 `upstream_stream_incomplete`；因此当前 live 样本更像 upstream 在仅有 `response.created` / `response.in_progress` 等非 terminal 语义时就断流。
- 2026-06-17 followup：`mainline-call-map` 显示 `ServerRespOutbound05ClientFrame` 的唯一 caller/callee 是 `sendPipelineResponse -> sendSsePipelineResponse`；`function-map` 对应 owner 为 `server.responses_sse_bridge_surface` / `server.responses_response_handler_bridge_surface`。已在 `handler-response-sse.ts` 增加 incomplete 诊断字段（`lastRawFrame` / `lastProjectedFrame` / `probe` 摘要等），并修正 focused 日志断言后验证通过：
  - `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts`
  - `tests/server/handlers/responses-handler.stream-closed-before-completed.regression.spec.ts`
  - `npx tsc --noEmit --pretty false`

## 2026-06-17 stopless/schema/runtime-path gate lock

- 本轮没有再动 stopless 主实现，只补 gate，防止后续回归。
- `scripts/verify-servertool-rust-only.mjs` 新增三类硬门禁：
  - `stopless-schema-feedback-lock`：要求 Rust orchestration 保留 `decision.followup_text`，并且 `chat_servertool_orchestration.rs` 保持 `test_stop_message_auto_schema_followup_text_keeps_exact_validation_feedback`。
  - `stopless-repeat-reset-lock`：要求 focused tests 继续覆盖 repeat 递增/重置语义，避免“非连续 stop 还沿用旧计数”复活。
  - `runtime-metadata-session-dir-lock`：要求 `virtual_router_engine/napi_proxy.rs` 只从 `metadata.__rt.*` 读取 `sessionDir/rccUserDir`，禁止恢复 top-level metadata fallback，并保留对应 Rust 单测。
- 定向验证已过：
  - `node scripts/verify-servertool-rust-only.mjs`
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/servertool-cli-projection.spec.ts tests/cli/servertool-command.spec.ts tests/servertool/loop-state-block.spec.ts --runInBand`
  - `git diff --check scripts/verify-servertool-rust-only.mjs`

## 2026-06-17 hub pipeline slimming audit

- 本轮目标不是修 bug，而是审计“瘦身不减功能”可落点；证据来自静态 owner/map/code 面 + focused Jest。
- focused 验证结果：
  - `tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts` PASS
  - `tests/sharedmodule/chat-semantics-stage1.spec.ts` PASS
  - `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` FAIL
- residue audit 当前红点分两类：
  - 真残留：
    - `src/server/runtime/http-server/executor/request-executor-request-semantics.ts` 仍在 TS 本地解析 `submit_tool_outputs` / provider-native continuation 语义。
    - `src/server/utils/finish-reason.ts` 仍在 TS 本地扫描 `tool_calls` / `required_action` / `output.function_call`，并把空结果回填成 `tool_calls` / `stop`。
    - `src/modules/llmswitch/bridge/responses-response-bridge.ts` 仍是超大 TS 语义中心：本地做 SSE terminal/finish-reason/probe/persist 决策，不只是薄壳。
  - gate / hygiene 漂移：
    - `package.json` 的 `test:routing-instructions` 仍引用已不存在的 `tests/servertool/stop-message-auto.spec.ts`。
    - `sharedmodule/llmswitch-core/src/**` 仍存在 side-by-side TS emit artifacts（`.js/.d.ts/.map`），residue audit 已把它们识别为应清除面。
- 额外代码面发现：
  - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` 与 `hub-pipeline-execute-chat-process-entry.ts` 基本是同构壳：同样的 preselected-route、同样的 `runHubPipelineLibWithNative(...)`、同样的 error/summary/result 包装，只差少量字段。
  - `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` 把 resp_inbound SSE materialization、servertool runtime effect 执行、runtime-state write、resp_outbound SSE codec 四段职责叠在一个 TS 文件里，收口空间很大。
- 推荐瘦身顺序：
  1. 先删 host 侧 TS 语义残留：`request-executor-request-semantics.ts`、`src/server/utils/finish-reason.ts`
  2. 再把 `responses-response-bridge.ts` 继续向 native owner 收口，TS 只留 IO/persist glue
  3. 合并 `hub-pipeline-execute-request-stage.ts` / `hub-pipeline-execute-chat-process-entry.ts`
  4. 清掉 stale script path 与 checked-in TS emit artifacts

## 2026-06-17 commit 169c57ded

136 files, +12436 -2011。

- stopless persisted_state_fs_write.rs 物理删除；cli_contract 不再读/写文件状态
- persisted_lookup 新增 `resolve_stopless_cli_result_snapshot_from_request()` 从 tool_outputs 取真源
- napi_proxy runtime path overrides 只读 `__rt.*`，删顶层 fallback
- pending-session/injection 统一显式 sessionDir 参数，删 env 猜测
- stopMessageAiMode 字段从 LegacyReasoningStopRoutingState 删掉（build 抓到的回归）
- providerFailureExemption 类型 + port-config validator
- .gitignore 新增 `__ROUTECODEX_NO_SESSION_DIR_OVERRIDE__/` + `.tmp/`
- architecture function-map/mainline-call-map/wiki 全量更新

Gate: tsc PASS, verify:function-map-compile-gate PASS, verify-servertool-rust-only PASS, focused Jest 44/44 PASS。

## 2026-06-17 hub pipeline slimming execution closeout

- 本轮已把 `request-executor-request-semantics.ts` 的 provider-native continuation 判定改成 Rust/native owner，host TS 不再本地解析 `previous_response_id` / `submit_tool_outputs`.
- 本轮已把 `src/server/utils/finish-reason.ts` 的“visible success / tool_calls fallback”残留删掉，`deriveFinishReasonWithVisibleSuccessFallback(...)` 现在只委托 `deriveFinishReason(...)`.
- residue gate 漂移已同步到当前 owner：
  - `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` 不再盯 `handler-response-utils.ts` 里的旧内联函数，改成检查 `responses-response-bridge.ts` / `handler-response-sse.ts` / `handler-response-utils.ts` 的现行 bridge surface。
  - `package.json:test:routing-instructions` 已把不存在的 `tests/servertool/stop-message-auto.spec.ts` 替换为现存拆分用例：`stop-message-auto-no-reenter.red` / `goal-default` / `config-precedence`.
- `sharedmodule/llmswitch-core/src/**` 下 50 个 ignored side-by-side emit artifacts（`.js/.d.ts/.map`）已物理删除；每个文件都已确认存在对应 `.ts` 真源。
- `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-chat-process-entry.ts` 已物理删除；chat_process request mainline 现在复用 `hub-pipeline-execute-request-stage.ts`，通过 `entryMode: "chat_process"` 保持错误文案与结果投影差异，不再保留同构壳。
- `src/modules/llmswitch/bridge/responses-response-bridge.ts` 再删一处 zero-consumer residue：`rebindResponsesConversationRequestIdsToResponseIdForHttp`.
- 验证证据：
  - `node scripts/build-core.mjs` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/executor/request-executor-request-semantics.spec.ts tests/server/utils/finish-reason.spec.ts tests/server/utils/finish-reason.visible-success.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-preselected-route.spec.ts tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts tests/sharedmodule/chat-semantics-stage1.spec.ts tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts --runInBand` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts tests/sharedmodule/chat-semantics-stage1.spec.ts tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts --runInBand` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` PASS

## 2026-06-17 hub pipeline slimming audit report update

- 本轮按 `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md` 重新扫描 `responses-response-bridge.ts` / `responses-sse-bridge.ts` exported surface。
- 新增结论：
  - `responses-response-bridge.ts` 当前 exported helpers 都有 source/test/script consumer，不再出现新的 0-consumer export。
  - `responses-sse-bridge.ts` 虽是 98 行 re-export facade，但 function-map / verification-map 明确把它作为 `server.responses_sse_bridge_surface` owner module；不能按死文件删除。
  - `responses-response-bridge.ts` 的 SSE terminal/probe/persist helper 属于高风险状态机/生命周期语义，当前应暂缓大拆；后续只能先找更小 zero-consumer/internal helper 或设计 native-downshift 红测。
- 已把完整候选项处置表、删除策略、修改策略、暂缓原因补入 `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md`。
- 验证证据：
  - `git diff --check` PASS
  - `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts tests/sharedmodule/hub-pipeline-preselected-route.spec.ts tests/sharedmodule/chat-semantics-stage1.spec.ts tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts tests/server/runtime/http-server/executor/request-executor-request-semantics.spec.ts tests/server/utils/finish-reason.spec.ts tests/server/utils/finish-reason.visible-success.spec.ts --runInBand` PASS
  - `npx tsc --noEmit --pretty false` PASS
  - `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false` PASS

## 2026-06-17 responsesRequestContext session truth split

- 本轮确认新的主根因不是“单纯拿不到 sessionId”，而是 request session truth 与 responses continuation context 两种语义仍有残留混用。
- 当前请求真 session 只允许来自 request metadata / entry origin request / runtime metadata 中由请求真相派生的字段；`responsesRequestContext.sessionId/conversationId` 只能作为 `/v1/responses` continuation owner context，禁止升格成 request session truth。
- 生产残留点已定位并收口：`sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts` 之前仍把 `responsesRequestContext` 回填到顶层 `sessionId/conversationId`，导致 stop-message scope/state-key/stopless activation 可被 continuation context 污染。
- 新 gate 已补：Jest 锁 `responsesRequestContext-only` 不得激活 stopless、不得形成 stop-message session scope/state key；`verify-servertool-rust-only.mjs` 也已禁止 runtime-utils 复活这条升格逻辑，并顺手把旧 persisted-state TS shell gate 改回“必须删除”方向。

## 2026-06-17 metadata center audit start

- Jason 要求把 metadata 做成集中处理中心，不再靠各层 merge/backfill/传值漂移；中心必须记录值、写入者、写入阶段、状态、覆盖历史，方便一眼定位谁写坏了。
- 当前已确认 metadata 相关读写面很散：handler 入口 `mergePipelineMetadata`、executor `finalizeRequestExecutorAttemptMetadata`、`buildServerToolAdapterContext`、`servertool-request-normalizer`、`responses-request-bridge`、`executor-metadata`、`provider-response-converter` 都在读写 session/continuation/runtime control 类字段。
- 下一步审计目标：按 request / response 阶段列出所有 metadata 字段类别，形成可落地的 `MetadataCenter` 输入表，再砍掉散落传递与二次 merge。

## 2026-06-17 metadata center doc closure

- 当前 metadata center 还处于 docs-first 阶段，已存在：audit 页、mainline source 页、manifest、function-map feature、verification-map feature、mainline-call-map chain。
- 发现文档漂移：metadata-center-mainline-source.md 的 Status 仍写“no manifest / no function-map/mainline-call-map feature”，与仓库现状不符，需先修正文档真相再 render/gate。
- 下一步：补 README/索引对 manifest 的正式引用，生成 repo 内 HTML，并跑 wiki/html/mainline sync gate。

## 2026-06-17 metadata center html/gate closeout

- metadata center mainline source 已补齐 README/索引/manifest 引用，并修正文档状态漂移。
- gate 现状：`verify-architecture-wiki-sync` PASS，`verify-architecture-wiki-html-sync` PASS。
- mainline-call-map 已加入 `metadata.center.mainline`，当前仍全部 `binding pending`，这是刻意保守状态，不宣称已完成代码绑定。
- 下一步：用 Computer Use 打开 repo 内正式 HTML `docs/architecture/wiki/html/metadata-center-mainline-source.html` 做可视渲染验证，再整理实现第一刀的 owner/替换面。

## 2026-06-17 metadata center impl slice 1

- 已补 host-side 红测：servertool-adapter-context 与 executor-metadata 现在都要锁 `responsesRequestContext` 不能 materialize request truth。
- 已切第一刀实现：`buildRequestMetadata` 把 request truth 与 continuation context 读取拆开；`servertool-request-normalizer` 在无 entryOrigin 时不再回填 session；`servertool-adapter-context` 仅在有 entryOrigin 时允许 backfill。
- 正在跑定向 Jest，下一步根据失败点继续把 remaining owner 收口，而不是停在局部 patch。

## 2026-06-17 metadata center impl progress

- 第一批 host-side 红测已转绿：`servertool-adapter-context.spec.ts` + `executor-metadata.binding.spec.ts` PASS。
- 已切掉的错误语义：无 entryOrigin 时不再从 flattened metadata / `responsesRequestContext` / `__rt.sessionId` 回填 request truth。
- 当前 owner 规则：entryOrigin request 可定义 request truth；continuation context 只能留在 continuation family，不再升格。
- 下一步：把 `MetadataCenter` 最小类型/slot/provenance contract 落成代码，并把当前 owner 改成显式 center 调用。

## 2026-06-17 metadata center code module introduced

- 新增 `src/server/runtime/http-server/metadata-center/metadata-center.ts` 与 `metadata-center-types.ts`，当前承载 request_truth + continuation_context + provenance 最小 contract。
- `buildRequestMetadata` 已开始 attach `MetadataCenter` 并写入 request truth / continuation context 的最小 provenance。
- 正在跑更大定向 Jest，确认中心挂载没有破坏 executor metadata 现有行为。

## 2026-06-17 metadata center impl current blocker shape

- 更大范围 `executor-metadata.spec.ts` 暴露的是 tmux request_guard / explicit tmux liveness 旧语义，不是 request truth vs continuation_context 第一阶段的直接 blocker。
- 当前已确认与本目标直接相关并转绿的测试：
  - tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts
  - tests/server/runtime/http-server/executor-metadata.binding.spec.ts
- 下一步继续沿 metadata center 目标推进，不把 tmux 独立语义和 request truth 第一阶段强行搅在一刀里；tmux 一支后续单独审计。

## 2026-06-17 SSE stop/tool-loss log audit

- 用户怀疑 SSE 返回丢工具导致会话提前 stop；当前只做分析未改代码。
- 已验证 release 日志现状：5520 与 5555 都有 `finish_reason=stop` 样本，但分属两条路径，不能混为一个根因。
- 5520 样本 `openai-responses-router-gpt-5.4-20260617T194738010-361156-1610`、`...194825333-361162-1616` 是 `router-direct:* -> XL.key1.gpt-5.4.gpt-5.5`，`internal=0ms`，无 `hub.response` / `servertool`；direct pipeline 仅 provider passthrough + hooks，provider SSE 只包装 `__sse_responses`，handler 用 direct passthrough guard，不进入 Hub response conversion。现有日志只能证明这些请求最后被判 `stop`，不能证明 raw 有 tool 且投影丢失。
- 5555 样本 `openai-responses-minimonth.key1-MiniMax-M2.7-20260617T192235609-360945-1399`、`...193258594-361026-1480` 是 relay/provider path：`provider.send completed` 后 `servertool stop_message_auto` 记录 `finish_reason=stop` + `skipped_missing_session` + `trigger_stop_schema_missing`，再 `hub.response`/client complete stop；这更像 provider/runtime response normalization 或 stop-message schema/session scope 行为，不是 direct SSE final projection。
- 现有 installed build 有 `response.sse.project_frame`、`lastRawFrame`、`lastProjectedFrame` 诊断代码，但 release `stage-logger` 默认不打该 stage；当前 `~/.rcc` 未找到上述 requestId 的 snapshot，因此缺少 raw/projected frame 对比证据。
- 下次复现必须开启 `ROUTECODEX_STAGE_LOG=1`（必要时加 Responses debug）并抓同一 requestId 的 `response.sse.project_frame` / `response.sse.stream.end` / `lastRawFrame` / `lastProjectedFrame` / `requiredToolCalls` / `outputFunctionCalls`，否则不能宣称“丢工具”。
- 进一步静态追踪修正：direct passthrough 先过 `createDirectPassthroughSseGuardStream`，但后续统一 `enqueueClientSseFrame()` 仍会调用 `normalizeResponsesSseFrameForClientForHttp()`；所以 direct 并非完全不投影，真实风险窗口在 Rust `project_responses_sse_frame_for_client` + handler terminal repair。
- Focused 验证：
  - `tests/server/handlers/handler-response-utils.required-action-split-frame.spec.ts` PASS，证明 split `response.required_action` 会转成标准 tool-call frames 并最终补 `response.completed` / `response.done`。
  - `tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts -t 'does not auto-close early for function_call|repairs assistant response.output_item.done'` PASS，证明 message output_item.done 可自动收口，但 function_call output_item.done 不会提前 auto-close（反向锁）。
  - `tests/server/handlers/responses-sse-client-contract.blackbox.spec.ts` 当前 1 fail：`captures required_action -> completed -> done...` 未见 completed/done；但该 test 的 mock 只覆盖旧 facade `bridge.js`，而现行 handler 直接 import `responses-sse-bridge` / `responses-response-bridge`，需要先修 test harness 才能作为生产回归证据。

## 2026-06-17 20:15:23 metadata-center stopless followup
- 接手继续：先锁 stopless sessionId/request truth 与 continuation context 分离，先红测再修复；目标是既不无限循环，也不该激活时漏激活。

- 2026-06-17 metadata-center/stopless followup: Rust stopless orchestration contract 默认无 session 也会 cli_projection，是当前“缺 session 仍激活”唯一真源根因；已改为 stop_message_flow 缺/unknown session => terminal_final(reason=stop_message_missing_session)，并删除 followup metadata 把 responsesRequestContext 回填为顶层 sessionId/conversationId 的残留。

## 2026-06-17 metadata-center + stopless followup verification

- 修正 gate 方向：`planStopMessagePersistedStateSelectionWithNative` / `planPersistStopMessageStateWithNative` / 对应 required exports 必须保持删除，不可复活旧 persisted-state bridge。
- `engine.ts` 已删除 TS stopless 分支 `flowId === 'stop_message_flow'`，只调用 Rust `planStoplessOrchestrationActionWithNative` 判定。
- stopless CLI result restore 扩展到 Responses `input[].function_call_output/tool_result/tool_message`，并优先 raw request over captured stale request。
- stopMessageAiMode 已从 routing snapshot / budget state 预期中删除；Rust 测试同步期望 `ai_mode=None`。
- metadata-center 新增后验证：tsc PASS、build-core PASS、verify-servertool-rust-only PASS、function-map compile gate PASS、mainline map PASS、mermaid/html sync PASS、focused Jest 49 PASS、stopless/servertool focused Jest 81 PASS、Rust servertool 298 PASS。

## 2026-06-18 SSE side-channel contract drift cleanup

- 本轮红点不是生产代码复活旧 carrier，而是测试仍按旧契约构造 `body.sseStream` / `__routecodex_finish_reason` / `STREAM_CONTRACT_PROBE_BODY_KEY`。
- 当前 handler 真契约已确认：
  - live SSE 入口只认顶层 `PipelineExecutionResult.sseStream`；
  - direct passthrough 只接受标准 Responses SSE event，generic `event: message` 会命中 `RESPONSES_DIRECT_SSE_PROTOCOL_VIOLATION`；
  - stream-end 超时测试当前真实错误可能是 `HTTP_SSE_TIMEOUT`，不再保证一定是旧 `SSE_CLIENT_PROJECTION_TIMEOUT`。
- 已同步收口测试面：
  - `provider-response-converter.finish-reason.spec.ts` 改成 ESM `unstable_mockModule`，补齐 bridge export surface，避免误落真实 state-integrations；
  - `request-complete-log.spec.ts` 改成当前无彩色 `status=200`，并锁“stream wrapper custom metadata 不得定义 finish_reason”；
  - handler/SSE 黑盒测试统一改为 top-level `result.sseStream`；
  - direct passthrough metadata guard 测试改用合法 `response.metadata` SSE frame，而不是非标准 `event: message`；
  - tool continuation timeout 测试去掉 hidden probe carrier，改成从标准 SSE frame 自举或在 stream end repair 收口。
- 本轮验证：
  - `npm run verify:architecture-no-custom-payload-carriers` PASS
  - root `npx tsc --noEmit --pretty false` PASS
  - 定向 Jest 8 suites / 44 tests PASS（provider-response-converter finish/prebuilt/unified、request-complete-log、apply-patch freeform SSE、metadata guard、sse projection timeout、responses-response-bridge direct guard）

## 2026-06-18 request-truth reader trim follow-up

- 本轮继续收 `sessionId/conversationId` 读取面，先修真正会影响 continuation/usage 的 direct `/v1/responses` 读点，而不是继续放大 tmux fallback。
- 新增唯一 helper：`src/server/runtime/http-server/metadata-center/request-truth-readers.ts`
  - `readRuntimeRequestTruthIdentifiers()` 只认 `MetadataCenter.request_truth`，其次才认平铺 `sessionId/session_id`、`conversationId/conversation_id`；
  - 明确不再把 `clientTmuxSessionId/tmuxSessionId` 当 request session truth。
- `src/server/runtime/http-server/index.ts` 已收口：
  - `readSessionIdForUsageLog()` 改为只读 centralized request-truth reader，不再 tmux fallback；
  - direct `recordResponsesResponseForRequest(...)` 的 `conversationId` 改为同样走 centralized reader，不再只读顶层 `inputMetadata.conversationId`。
- 这次没有继续改 stopless owner 本体；目标只是把 request truth 读取面再收干净，减少“日志/continuation 看起来像 session 丢了”的伪信号。
- 本轮验证：
  - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
  - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
  - root `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS
- 仍未宣称 live stopless 激活闭环已完成：
  - 本轮没有 build/install/restart/replay，因为修改面先收在 request-truth helper + static contract；
  - 下一步应继续查 `/v1/responses` live path 里 request-truth 是否每次都被 materialize 进 `MetadataCenter`，再决定是否需要在线重放/构建验证。

## 2026-06-18 response-side request-truth reader trim

- 继续把 response-side bridge 的 request/session 读取面收向 `MetadataCenter`，避免 response handler / lifecycle persist 再从 flat metadata 猜 session truth。
- `src/modules/llmswitch/bridge/responses-response-bridge.ts` 已收口两处：
  - `buildResponsesRequestLogContextForHttp()` 现在优先读 `readRuntimeRequestTruthIdentifiers(metadata)`，只有 usageLogInfo 已显式携带时才覆盖；
  - `resolveResponsesConversationPersistInputsForHttp()` 在 `args.sessionId/args.conversationId` 与 `usageLogInfo.*` 都缺失时，会回退到 `MetadataCenter.request_truth`，不再只靠 flat metadata。
- 这一步仍然不允许 continuation context 升级成 request truth；reader helper 只看 `request_truth + flat sessionId/conversationId`，不读 `responsesRequestContext.*`、不读 tmux。
- 本轮新增验证：
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts` PASS
    - 锁 `buildResponsesRequestLogContextForHttp()` 优先读 center truth；
    - 锁 `persistResponsesConversationLifecycleForHttp()` 在 usageLogInfo 缺 session 标识时，仍能从 center truth 写入 persisted response context。
  - 联合回归：
    - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
    - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
    - root `npx tsc --noEmit --pretty false` PASS
    - `git diff --check` PASS

## 2026-06-18 continuation-context top-level read removal

- 继续清理旧 merge/backfill 语义：`src/modules/llmswitch/bridge/responses-response-bridge.ts::resolveResponsesRequestContextForHttp()` 之前仍直接读取顶层 `metadata.responsesRequestContext`，这是 continuation_context 绕过 `MetadataCenter` 的旧残留。
- 现已改成：
  - 只从 `MetadataCenter.read(metadata)?.readContinuationContext().responsesRequestContext` 取 continuation request context；
  - 若 center 没有，则只退回显式 `fallback` 参数；
  - 不再把顶层 `metadata.responsesRequestContext` 当合法读源。
- 这一步把一个真实的旧读路径物理切断了；生产 builder 仍会写 center，因此不会影响正常 Responses handler/bridge 流程。
- 本轮新增/更新验证：
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` PASS
    - 锁 center continuation context 优先于 fallback；
    - 锁“只有顶层 metadata.responsesRequestContext、没有 center binding”时不得命中，必须退回 fallback。
  - 联合回归：
    - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts` PASS
    - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
    - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
    - root `npx tsc --noEmit --pretty false` PASS
    - `git diff --check` PASS

## 2026-06-18 continuation-context top-level write removal progress

- 继续清 continuation_context 的旧平铺写入：
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts::buildResponsesPipelineMetadataForHttp()` 不再把 `responsesRequestContext` 平铺写入 metadata；
  - `src/modules/llmswitch/bridge/responses-request-bridge.ts::attachResponsesRequestContextToResultForHttp()` 也不再往 `nextMetadata.responsesRequestContext` 回填，只写 `MetadataCenter.continuation_context.responsesRequestContext`。
- 为了支撑删除旧写入，`src/modules/llmswitch/bridge/state-integrations.ts::extractContinuationContextSessionIdentifiersFromMetadata()` 已改成只读 `MetadataCenter.read(meta)?.readContinuationContext().responsesRequestContext`，不再从顶层 `meta.responsesRequestContext` 取 continuation session 标识。
- 这一轮的结构性结果：
  - request-side responses bridge：写 center，不再写 top-level `responsesRequestContext`；
  - response-side responses bridge：读 center，不再读 top-level `responsesRequestContext`；
  - continuation-only extractor：读 center，不再读 top-level `responsesRequestContext`。
- 本轮新增/更新验证：
  - `tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts` PASS
    - 锁 request-side / response-side 都只写 center；
    - 锁 metadata 顶层 `responsesRequestContext` 已不存在。
  - `tests/modules/llmswitch/bridge/state-integrations.metadata-center.spec.ts` PASS
    - 锁 continuation extractor 只认 center；
    - 锁没有 center binding 时，顶层 `responsesRequestContext` 不再被读取。
  - 联合回归：
    - `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` PASS
    - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts` PASS
    - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
    - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
    - root `npx tsc --noEmit --pretty false` PASS
    - `git diff --check` PASS
- 当前仍残留的相关生产旧写入点：
  - stopless/sharedmodule 侧还有 runtime-utils 对顶层 `responsesRequestContext` 的消费，需要继续迁。

## 2026-06-18 executor-metadata continuation top-level removal

- `src/server/runtime/http-server/executor-metadata.ts` 的 continuation-only fallback 已继续收口：
  - 当请求里只带 continuation session 线索、没有 request truth 时，现在只写 `MetadataCenter.continuation_context.responsesRequestContext`；
  - 不再把 `responsesRequestContext` 回填到顶层 metadata。
- 同时修了一个真实 merge 漏洞：
  - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts::finalizeRequestExecutorAttemptMetadata()` 之前只保 request-side metadata center，pipeline 侧 continuation center 会丢；
  - 现在当 request-side center 与 pipeline-side center 同时存在时，会把 pipeline `continuation_context` 合并进最终 merged metadata center，同时继续保持 request truth 以 request-side 为唯一真源。
- 本轮更新验证：
  - `tests/server/http-server/executor-metadata.spec.ts` PASS
    - 锁 request truth 仍由 request-side center 主导；
    - 锁 pipeline-side continuation context 会被合并到最终 center，而不是丢失或回退成顶层字段。
  - `tests/server/runtime/http-server/executor-metadata.binding.spec.ts` PASS
    - 锁顶层 `responsesRequestContext` 不再 materialize 成 request truth；
    - 现在也不再被自动写回 top-level metadata；单靠 request metadata 顶层 `responsesRequestContext` 也不再进入 continuation center。
  - root `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS

## 2026-06-18 sharedmodule stopless continuation carrier trim

- sharedmodule stop-message runtime helper 也继续收口：
  - `sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/runtime-utils.ts::buildServertoolRoutingMetadata()` 不再把 `record.responsesRequestContext` / `metadata.responsesRequestContext` / `runtime.responsesRequestContext` 重新拼回 routing metadata。
- 这一步的含义：
  - stopless/servertool state key / session scope 相关 native helper 现在只看正常 request truth、continuation、responsesResume 等显式字段；
  - 不再依赖旧的顶层 `responsesRequestContext` carrier。
- 本轮验证：
  - `tests/servertool/stop-message-runtime-utils.continuation.spec.ts` PASS
  - 联合回归：
    - `tests/server/http-server/executor-metadata.spec.ts` PASS
    - `tests/server/runtime/http-server/executor-metadata.binding.spec.ts` PASS
    - `tests/modules/llmswitch/bridge/responses-request-bridge.metadata-center.spec.ts` PASS
    - `tests/modules/llmswitch/bridge/state-integrations.metadata-center.spec.ts` PASS
    - `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts` PASS
    - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts` PASS
    - `tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts` PASS
    - `tests/server/runtime/http-server/index.request-truth-contract.spec.ts` PASS
    - total focused suites green: 53 assertions PASS
  - root `npx tsc --noEmit --pretty false` PASS
  - `git diff --check` PASS

## 2026-06-18 metadata-center verification + install/restart follow-up

- 为了把 handoff 里的 focused stack 重新拉绿，本轮先修了两处测试壳漂移：
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts`
  - `tests/modules/llmswitch/bridge/responses-response-bridge.request-context-resolution.spec.ts`
- 修复方式仅限 test mock surface 对齐当前 bridge import 面；未改生产语义。之后 9 个 metadata-center focused suites 重新 PASS（53/53）。
- 本轮额外确认：
  - root `npx tsc --noEmit --pretty false` PASS
  - `verify:architecture-mainline-call-map` PASS
  - install script 内 `verify:function-map-compile-gate` / `verify:architecture-review-surface-light` / `verify:servertool-rust-only` 等已在隔离构建目录跑通
- 全局安装真相：
  - `routecodex --version` / `rcc --version` 已到 `0.90.3087`
  - `~/.rcc/install/current` 与 `/Volumes/extension/.rcc/install/current` 都指向 `releases/routecodex-0.90.3087-2026-06-17T171023Z`
- 在线重启真相：
  - 首次 install 收尾后，在线 `/health` 仍是 `0.90.3081`，说明安装成功但运行进程未切版
  - 追加 `routecodex restart --port 5555` 后，`127.0.0.1:5555` / `5520` / `10000` `/health` 全部变成 `0.90.3087` 且 `ready=true pipelineReady=true`
- 当前仍未闭环的 live blocker：
  - `scripts/tests/stopless-5555-final-probe.mjs` 在新版本 5555 上首步失败：返回 `status=completed`，没有 `exec_command`
  - 这说明当前线上问题已不是“无限循环”或“安装没生效”，而是“该激活时没激活”仍未证实修复
  - 新增最小核对：`tests/server/utils/finish-reason.spec.ts` 已补 `responses status=completed + assistant output_text => stop` 断言并 PASS，说明 finish-reason 映射不是当前根因
- 下一步唯一重点：
  - 继续查 5555 live 请求为何 `status=completed` 时没有进入 `stop_message_auto` / CLI projection；优先排查 same-protocol direct / stop-gateway / response-stage orchestration 真正走的是哪条链

## 2026-06-18 reasoning-stop finalized marker residue trim

- 复核 `bodyContainsReasoningStopFinalizedMarker` 后确认它已经不在 request-executor 运行时主链中：
  - `src/server/runtime/http-server/executor/request-executor-response-contract.ts` 的导出实现恒 `false`；
  - `src/server/runtime/http-server/executor/request-executor-response-inspect.ts` 还有一份重复恒 `false` 定义，但零消费者；
  - runtime 仅剩 `request-executor.ts::__requestExecutorTestables` 把 response-contract 那份 helper 暴露给测试。
- 本轮动作：
  - 物理删除 response-contract / response-inspect 的双份旧 helper；
  - `request-executor.ts` 删除 testable 暴露；
  - `tests/server/runtime/http-server/request-executor.spec.ts` 改成锁“旧 helper 已不可见”；
  - `verify:architecture-deleted-path` 新增 repo-wide deny token：`bodyContainsReasoningStopFinalizedMarker` 与 `__routecodex_reasoning_stop_finalized`。
- 这一步不触碰 Jason 正在做的内部字段实现收口，只先删除已经失效的 host-side marker inspection 残留，并给旧符号加防复活 gate。

## 2026-06-18 metadata-center mtc-07 closeout binding

- 重新复核 `mtc-07` 后确认此前文档说得没错：repo 只有 `request_truth` / `continuation_context` 写入与读取，没有显式 closeout/release API，因此 mainline-call-map 一直只能写 `binding pending`。
- 本轮最小实现：
  - `MetadataCenter` 新增幂等 `markReleased(...)`，只改 slot status/history，不改 payload/value；
  - `handler-response-common.ts` 新增 `releaseMetadataCenterForHttpResponse(...)`，作为 handler closeout 统一 helper；
  - JSON closeout、SSE finish/close cleanup、SSE bridge error、JSON->SSE bridge end/error、prestart client close 都接入该 helper。
- 这使 `mtc-07` 从“文档 future owner”变成真实相邻边：
  - `releaseMetadataCenterForHttpResponse -> MetadataCenter.markReleased`
  - 语义是 request closeout 后将 request-scoped center slots 标记为 `released`，不再保持 `active`
- 同步更新：
  - function-map / verification-map：把 handler closeout helper 与 focused handler test 纳入 `hub.metadata_center_mainline`
  - mainline-call-map / metadata-center wiki：`mtc-07` 改为 anchored，不再写 pending
## 2026-06-18 mainline node-id consistency gate closeout

- completion audit 继续往下查时，发现“manifest、wiki、mainline call map 共用 node IDs，并被机器校验”这条还没完全锁死：
  - repo 里已有 `scripts/architecture/verify-architecture-mainline-node-id-consistency.mjs` 草稿；
  - 但它没接进 `package.json`，也没进 `verify:architecture-review-surface-light`；
  - 且脚本自身错误地拿聚合页 `wiki/mainline-call-graph.md` 的全量节点去和每一条 chain 单独比，天然会误报。
- 已修：
  - `scripts/architecture/verify-architecture-mainline-node-id-consistency.mjs`
    - 改成按 chain 选对应 wiki 页面；
    - 对使用聚合页的 chain，只截取 `## <chain_id>` 对应 section；
    - 对 `stopless.session.mainline` / `metadata.center.mainline` 改用各自 manual wiki 页面，而不是聚合页；
    - 正反向都只做 chain-local node/step 一致性校验，不再跨 chain 误报。
  - `scripts/architecture/mainline-call-map-lib.mjs`
    - `GENERATED_WIKI_CHAIN_PAGES` 改成把 `stopless.session.mainline` 指向 `stopless-session-mainline-source.md`；
    - `metadata.center.mainline` 指向 `metadata-center-mainline-source.md`。
  - `package.json`
    - 新增 `verify:architecture-mainline-node-id-consistency`
    - `verify:architecture-review-surface-light` 现已强制跑该 gate
  - `scripts/architecture/verify-function-map-build-wiring.mjs`
    - 新增自检：`verify:architecture-review-surface-light` 若移除 `verify:architecture-mainline-node-id-consistency` 会直接失败
  - `docs/goals/hub-pipeline-slimming-no-function-loss-plan.md`
    - `metadata.center.mainline` 行改成 `mtc-07 = anchored`，不再沿用旧 pending 叙事
- gate 继续跑后又抓到一条真实 drift：
  - `docs/architecture/mainline-call-map.yml` 里 `metadata.center.mainline` 有 `mtc-02-result`；
  - `docs/architecture/wiki/metadata-center-mainline-source.md` 只写了 `mtc-02`，漏了 result-side continuation attach；
  - 已补 `mtc-02-result` 到 mermaid + table，保证 chain-local node/step 机器校验能过。
- 顺手重新按当前 worktree 审 `responses-sse-bridge.ts` / `responses-response-bridge.ts` export consumer count：
  - 没有新的 zero-consumer export 浮出来；
  - `responses-sse-bridge.ts` 仍是高引用 re-export facade，不适合直接删；
  - `responses-response-bridge.ts` 当前最小 src consumer 也仍有 2，继续只能按“更小粒度 helper / native-downshift”推进，不能按大文件直接拆删。
