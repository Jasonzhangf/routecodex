# Hub Inbound/Outbound Boundary Residual Inventory (2026-06-26)

目标：把 `inbound/outbound 只做协议映射`、`tool governance / reasoning-stop / schema 判定 / tool-result 合法性与语义修补只归 req/resp chatprocess` 这条边界，按当前仓库状态钉成可执行清单。

判定真源：
- `docs/design/pipeline-type-topology-and-module-boundaries.md`
- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/wiki/chat-process-protocol-mapping.md`
- pasted goal: `/Users/fanzhang/.codex/attachments/d66414ce-dccd-4bba-8efd-3f94f1caa559/pasted-text-1.txt`

判定口径：
- `可保留`：纯协议解析、格式投影、wire/client frame build、runtime control carrier、log sink。
- `已收口`：原先存在第二真源/越界语义，现已改成 center-only 或只剩桥接壳。
- `待 closeout`：仍在 inbound/outbound / host shell 承担 chatprocess 语义修补、tool/reasoning/schema 判定，或保留死的过渡语义。

## 1. 已收口

| 项 | 文件 | 证据 | 当前判定 |
| --- | --- | --- | --- |
| Host outbound protocol truth | `src/server/runtime/http-server/executor/servertool-adapter-context.ts` | 已在本轮前序 closeout 中改成只读 `MetadataCenter.runtime_control.providerProtocol` | 已收口，禁止 `args.providerProtocol` 补真源 |
| Host response converter protocol truth | `src/server/runtime/http-server/executor/provider-response-converter.ts` | [provider-response-converter.ts](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/executor/provider-response-converter.ts:319) | `readProviderProtocolForProviderResponseConverter(...)` 已 center-only fail-fast |
| Host response converter request semantics passthrough | `src/server/runtime/http-server/executor/provider-response-converter.ts` | [provider-response-converter.ts](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/executor/provider-response-converter.ts:463) | 已删除 host 侧 `clientToolsRaw` 回补；bridge 只消费调用方给定 `requestSemantics` |
| Host direct chat SSE reprojection no longer revives visible content | `src/server/runtime/http-server/executor/provider-response-converter.ts` | [provider-response-converter.ts](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/executor/provider-response-converter.ts:494) | 已删除 host 侧 SSE 文本解析与 `message.content` 回填；reprojection 仅消费 bridge 已定型 body |
| Servertool shell protocol truth | `sharedmodule/llmswitch-core/src/servertool/dispatch-preparation-shell.ts` 等 7 处 | 已在本轮前序 closeout 中改成 `stopless-metadata-carrier` center-only | 已收口，shell 不再接受 flat shadow / args fallback |
| Servertool protocol reader helper | `sharedmodule/llmswitch-core/src/servertool/stopless-metadata-carrier.ts` | 已在本轮前序 closeout 中改成只认 bound center | 已收口，flat `providerProtocol` shadow 已禁用 |
| Executor bypass helper protocol truth | `src/server/runtime/http-server/executor/request-executor-runtime-blocks.ts` | 已在本轮新增 closeout 中删掉 `options.providerProtocol` 回退 | 已收口，`/v1/responses` bypass 特例只认 metadata center truth |
| Hub response core protocol truth | `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` | [provider-response.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts:319) | center-only fail-fast；其余命中目前只是参数透传 |
| Hub request-stage bridge legacy metadata compatibility | `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` | [hub-pipeline-execute-request-stage.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts:11), [hub-pipeline-execute-request-stage.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts:129), [tests/sharedmodule/hub-pipeline-preselected-route.spec.ts](/Users/fanzhang/Documents/github/routecodex/tests/sharedmodule/hub-pipeline-preselected-route.spec.ts:1), [tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts](/Users/fanzhang/Documents/github/routecodex/tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts:1755) | 已删除 `__metadataCenter` fallback、`__rt` 读取/whitelist 回写、legacy key 透传；契约测试改成只走 `MetadataCenter.attach/bind` |
| Host response converter dead residue imports/types | `src/server/runtime/http-server/executor/provider-response-converter.ts` | [provider-response-converter.ts](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/executor/provider-response-converter.ts:1), [tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts](/Users/fanzhang/Documents/github/routecodex/tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts:1) | 已物理删除无消费的 `isImagePathLike`、`containsBroadKillCommand`、`importCoreDist`、`NativeRespSemanticsModule`；契约测试锁死不得回潮 |
| Hub stage timing observation carrier | `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.ts` / `src/server/runtime/http-server/executor/provider-response-converter.ts` / `src/server/runtime/http-server/executor/retry-payload-snapshot.ts` | [hub-stage-timing.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-stage-timing.ts:1), [provider-response-converter.ts](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/executor/provider-response-converter.ts:1), [retry-payload-snapshot.ts](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/executor/retry-payload-snapshot.ts:1), [request-truth-readers.spec.ts](/Users/fanzhang/Documents/github/routecodex/tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts:1), [provider-response-converter.stopless-runtime-sync.spec.ts](/Users/fanzhang/Documents/github/routecodex/tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts:1) | `hubStageTop` 已从 `__rt` 单路径迁到 `MetadataCenter.debug_snapshot.hubStageTop`；host converter 与 retry/usage 读端不再依赖 legacy `__rt` timing carrier |
| Hub response post-servertool Responses projection | `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts` | [provider-response.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts:1), [function-map.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/function-map.yml:2100), [tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts](/Users/fanzhang/Documents/github/routecodex/tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts:4201) | 已删除 TS `/v1/responses` 分支、`readClientToolsRawForResponsesNormalization(...)`、`normalizeResponsesToolCallsAtChatProcessExit(...)`；post-servertool client semantic truth 只经 Rust owner `project_post_servertool_hub_resp_outbound_04_client_semantic(...)` 投影 |

## 2. 可保留

| 项 | 文件 | 证据 | 为什么可保留 |
| --- | --- | --- | --- |
| Hub request-stage bridge metadata snapshot/route input build | `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` | [hub-pipeline-execute-request-stage.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts:30), [hub-pipeline-execute-request-stage.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts:154), [hub-pipeline-execute-request-stage.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts:210) | 当前职责是把 metadata center 快照、route input metadata、native request payload 组织给 Rust owner；未直接做 tool/reasoning/schema 判定 |
| Hub pipeline ingress materialization | `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts` | [hub-pipeline.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts:104), [hub-pipeline.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts:160) | 当前是 SSE/JSON 物化、entry metadata 整理、stage recorder 传递；未见第二套治理语义 |
| Servertool progress log sink | `sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts` | [progress-log-block.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts:66), [progress-log-block.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts:99), [progress-log-block.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/progress-log-block.ts:201) | 只把已有结果写 console/file/stage recorder，不生成新的语义真相 |
| Servertool match log sink | `sharedmodule/llmswitch-core/src/servertool/match-log-block.ts` | [match-log-block.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/match-log-block.ts:5), [match-log-block.ts](/Users/fanzhang/Documents/github/routecodex/sharedmodule/llmswitch-core/src/servertool/match-log-block.ts:25) | 只记录 matched/skipped 事实，不拥有 engine selection / followup policy |
| Response passthrough gate helper | `src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts::shouldAllowDirectResponsesPrebuiltSsePassthrough` | [provider-response-shared-pure-blocks.ts](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts:217) | 当前是 contract-only pure predicate：只判 entry/protocol/owner/SSE；不重建语义 payload |

## 3. 待 closeout

## 4. 当前不判为残余

- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
  - 当前主要是 Rust owner bridge、native effect 执行、runtime state save、SSE codec 投影。
  - `/v1/responses` post-servertool 分支已删；目前未见 host/TS 再做第二套 tool governance / schema judgement。
- `src/server/runtime/http-server/executor/request-executor-runtime-blocks.ts`
  - 当前还能保留为 host gate helper；本轮已把 protocol truth 缩成 metadata-center-only。
- `src/server/runtime/http-server/executor/provider-response-shared-pure-blocks.ts`
  - 当前大部分是 deterministic pure helper；只有在真正被 host shell 用来重建 chatprocess 语义时，才应升级为残余。

## 5. Closeout priority

1. 继续扩张 inbound/outbound residual 审计范围，找下一个仍保留 chatprocess 语义或 legacy carrier 的 owner 点。

## 6. 当前验证证据

- Focused tests / gates 已过：
  - `tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts`
  - `tests/server/runtime/http-server/executor/provider-response-converter.finish-reason.spec.ts`
  - `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`
  - `tests/server/runtime/http-server/request-executor-runtime-blocks.spec.ts`
  - `tests/servertool/entry-context-shell.spec.ts`
  - `tests/servertool/dispatch-preparation-shell.spec.ts`
  - `tests/servertool/engine-observation-shell.spec.ts`
  - `tests/servertool/pre-command-runtime-state-shell.spec.ts`
  - `tests/servertool/pre-command-hooks.spec.ts`
  - `tests/red-tests/hub_pipeline_provider_response_converter_no_ts_projection_fallback.test.ts`
  - `tests/red-tests/servertool_provider_protocol_metadata_center_only.test.ts`
  - `tests/servertool/stop-message-responses-bypass.spec.ts`
  - `npm run verify:architecture-thin-wrapper-only`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-preselected-route.spec.ts -t "does not project legacy __rt fields back into native request metadata|projects MetadataCenter runtime stop-message control into native request metadata|builds metadataCenterSnapshot only from MetadataCenter families before native request dispatch|reuses MetadataCenter runtime preselectedRoute without reading flat routecodex residue|projects stopless runtime control into native top-level metadata for relay request owners|projects resumed continuation session scope and provider pin from MetadataCenter into native request metadata|hydrates resumed continuation session scope and provider pin before routerEngine.route consumes metadata" --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts -t "request-stage bridge must not retain legacy metadataCenter or __rt compatibility residue" --runInBand`
  - `npm run verify:function-map-compile-gate`
  - `npm run verify:llmswitch-core-tsc`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts --runInBand`
  - `npx tsc -p tsconfig.json --noEmit --pretty false`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/metadata-center/request-truth-readers.spec.ts tests/sharedmodule/hub-stage-timing-top-summary.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.stopless-runtime-sync.spec.ts tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/provider-response-rust-plan.spec.ts --runInBand`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts -t "servertool response SSE projection must use post-governance client semantic truth" --runInBand`
  - `npm run verify:llmswitch-core-tsc`

## 7. 未完成项

- 这份清单已钉死当前已查范围，但还不是“所有 response/inbound 文件全仓扫描完毕”的绝对终稿。
- `provider-response-converter.ts` 两个 high 项、dead residue imports/types、`hubStageTop` observation carrier 与 `hub-pipeline-execute-request-stage.ts` 的 legacy metadata 兼容面已完成 owner 收口；下一步应回到清单视角继续扩张 residual 审计，再决定是否需要同步修 `function-map / verification-map / mainline/wiki`。
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` 全量运行当前仍有仓库既有无关红：
  - `package scripts must not reference missing test files`
  - `stop_message schema budget must not be restored from servertool loop repeat count`
  这些不阻断本轮 request-stage bridge closeout 的 focused 合同证据，但意味着不能宣称“全量 residue audit 已全绿”。
- 当前没有 live replay 证据；本清单只证明“架构归属 + focused tests/gates + 代码证据”，不证明端到端运行行为已全部收口。
