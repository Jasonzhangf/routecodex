# Hub Pipeline Slimming Without Function Loss Plan

## 目标与验收标准

目标：在不减少功能、不裁剪真实 payload、不引入 fallback 的前提下，继续审计并收缩 Hub Pipeline 相关 TS/bridge 残留，实现“Rust 真源 + TS 薄壳/IO glue”的更小维护面。

验收标准：
- 输出完整审计报告，列出每个候选项的 owner、现状、是否可删、如何改、风险与验证方式。
- 只删除已确认的死代码、零消费者 export、重复 wrapper、source-adjacent 生成产物、失效 gate/script 引用。
- 只修改全局唯一 owner；禁止 provider 特例、双路径补偿、silent fallback、语义等价 payload 裁剪。
- 每个删除/合并都必须有可查询 gate 或定向测试锁住不复活。
- 验证通过后更新 `note.md`；已验证长期结论追加到 `MEMORY.md`。

## 范围与边界

### In Scope

- `sharedmodule/llmswitch-core/src/conversion/hub/**` 中 Hub Pipeline TS wrapper、bridge、barrel、legacy residue。
- `src/modules/llmswitch/bridge/responses-response-bridge.ts` 与 `responses-sse-bridge.ts` 的 zero-consumer helper、重复 facade、可下沉 native glue。
- `src/server/runtime/http-server/**` 与 `src/server/handlers/**` 中 Hub Pipeline 入口/响应投影的 TS 残留语义。
- `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts` 等 residue/static gate。
- `package.json`、root scripts、ignored source-adjacent emit artifacts 等 hygiene drift。

### Out of Scope

- 不改 provider runtime 协议差异，除非发现 Hub Pipeline 写了 provider-specific 分支。
- 不改 Virtual Router selection/health/quota 语义。
- 不改 direct/provider passthrough 的职责边界。
- 不拆 SSE 主状态机，除非先完成 owner map、红测、native 下沉方案和 failure path 验证。
- 不做安装/重启/线上端口验证，除非本轮改动影响 runtime 行为且定向测试已绿。

## 当前已验证基线

截至 2026-06-17，以下收口已完成并验证：
- `request-executor-request-semantics.ts` 的 provider-native continuation 判定已转 native owner。
- `finish-reason.ts` 已删除 TS 侧 visible-success/tool-call fallback。
- `hub-pipeline-execute-chat-process-entry.ts` 已物理删除，chat_process 复用 `hub-pipeline-execute-request-stage.ts`。
- `responses-response-bridge.ts` 已删除 zero-consumer export `rebindResponsesConversationRequestIdsToResponseIdForHttp`。
- `package.json:test:routing-instructions` 已移除不存在的 `stop-message-auto.spec.ts` 路径。
- `sharedmodule/llmswitch-core/src/**` ignored side-by-side `.js/.d.ts/.map` artifacts 已删除。

已验证命令：
- `node scripts/build-core.mjs`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts tests/sharedmodule/hub-pipeline-preselected-route.spec.ts tests/sharedmodule/chat-semantics-stage1.spec.ts tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts tests/server/runtime/http-server/executor/request-executor-native-semantics.spec.ts tests/server/utils/finish-reason.spec.ts tests/server/utils/finish-reason.visible-success.spec.ts --runInBand`
- `npx tsc --noEmit --pretty false`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`
- `git diff --check`

## 2026-06-17 当前审计报告

### 当前状态复核补充（active goal continuation）

本轮在不触碰并行 payload/SSE 内部字段清理代码的前提下，重新按当前 worktree 做 consumer count。统计口径排除了 `coverage/`、`dist/`、`target/`、`*-migrated/`、wiki HTML 生成物，并把生产代码、测试、脚本、docs/map 分开。

当前状态：payload/SSE 内部字段清理已删除旧 SSE wrapper builder；本轮继续补 stale test/doc 与 deleted/residue gate，不改 runtime 行为。

| 候选项 | Owner feature | 当前 consumer count | 处置结论 | 风险 | 必跑验证 / gate |
| --- | --- | --- | --- | --- | --- |
| `src/server/handlers/handler-response-utils.ts::hasSsePayload` | `server.responses_response_handler_bridge_surface` handler response surface trim | runtime handler import=3，re-export=1，bridge owner=0 | `deleted + gate locked`。helper 与 `handler-utils.ts` 转发已物理删除，三处 handler 统一改成直接判 `result.sseStream !== undefined`；`verify:responses-handler-single-bridge-surface` 现作为防复活 gate。 | 低：只影响 handler-side facade 数量，不改 SSE/runtime 语义。 | `npm run verify:responses-handler-single-bridge-surface`；`npm run verify:architecture-ci`；`npm run build:min`；`npx tsc --noEmit --pretty false`；`git diff --check`。 |
| `src/server/runtime/http-server/executor/servertool-response-normalizer.ts::buildServerToolSseWrapperBody` | `server.responses_sse_bridge_surface` / payload side-channel cleanup | runtime=0，test/script residue 清理中，doc=historical only | `deleted + gate locked`。旧 wrapper 文件已物理删除；`verify:architecture-deleted-path` 现同时禁止文件路径与 symbol 在 `src` / `sharedmodule/llmswitch-core/src` / `tests` / `scripts` 复活。 | 中：docs 中可能仍有历史取证文字，不能当当前 contract；runtime 侧由 no-custom-payload-carriers gate 防 payload carrier 回流。 | `npm run verify:architecture-deleted-path`；`npm run verify:architecture-no-custom-payload-carriers`；`tests/server/handlers/handler-response-utils.sse-finish-reason.spec.ts` focused run；`npm run verify:function-map-compile-gate`。 |
| `src/server/utils/finish-reason.ts::deriveFinishReasonWithVisibleSuccessFallback` | finish reason/native response semantics | runtime consumer 已清零；test direct import 1 -> 0；mock residue 2 -> 0 | `deleted + gate locked`。fallback 残名已物理删除；[`handler-utils.ts`](/Users/fanzhang/Documents/github/routecodex/src/server/handlers/handler-utils.ts)、[`src/server/runtime/http-server/index.ts`](/Users/fanzhang/Documents/github/routecodex/src/server/runtime/http-server/index.ts) 统一改回直接使用 `deriveFinishReason`；`verify:architecture-deleted-path` 现禁止该旧符号在 `src/tests/scripts` 复活。 | 低中：只改符号面，不改 native finish reason 语义；风险主要是 logging/direct result 调用点和测试 mock 漂移。 | `tests/server/utils/finish-reason.spec.ts`、`tests/server/utils/finish-reason.visible-success.spec.ts`、`tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`、`tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts`、`npm run verify:architecture-deleted-path`、`npx tsc --noEmit --pretty false`、`npm run verify:architecture-ci`、`npm run build:min`、`git diff --check`。 |
| `src/server/runtime/http-server/executor/request-executor-response-contract.ts::bodyContainsReasoningStopFinalizedMarker` | server response contract / stopless marker removal | runtime=0，test=0，doc=historical only | `deleted + gate locked`。恒 `false` 的旧 marker helper 已从 request-executor testable surface、response-contract、response-inspect 三处物理删除；`verify:architecture-deleted-path` 现禁止 helper 名与 `__routecodex_reasoning_stop_finalized` 在 `src/tests/scripts` 复活。 | 低中：删除的是已失效 inspection 残留，风险主要是测试或静态脚本误依赖旧 helper。 | `tests/server/runtime/http-server/request-executor.spec.ts`；`npm run verify:architecture-deleted-path`；`npm run verify:servertool-rust-only`；`npm run verify:function-map-compile-gate`；`npm run verify:architecture-ci`；`npm run build:min`；`git diff --check`。 |
| `src/server/runtime/http-server/executor/servertool-request-normalizer.ts::syncStoplessGoalStateFromCapturedRequest` | `hub.metadata_center_mainline` / stopless current-request state | 单文件单生产 consumer；行为已由 `servertool-adapter-context.spec.ts` 正反路径锁住 | `deleted + inlined`。RCC fence sniff + stopless goal sync 已内联回 `buildServerToolAdapterContext`，独立单函数文件已物理删除，并由 deleted-path gate 防复活。 | 中：影响 stopless goal sync，但已有现成白盒覆盖 capturedEntryRequest/capturedChatRequest 覆盖和 error callback。 | `tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`；`npm run verify:architecture-deleted-path`；`npm run verify:function-map-compile-gate`；`npm run verify:servertool-rust-only`；`npm run build:min`。 |
| `src/modules/llmswitch/bridge/responses-sse-bridge.ts` pure re-export facade | `server.responses_sse_bridge_surface` | 当前唯一文件级命中：runtime=4，test=5，script=1，doc=12；exported symbol 复核无新的 zero-consumer export | `defer, do not delete now`。虽然是 re-export facade，但 function-map/verification-map 把它定义为 SSE 单一 bridge surface；删除会破坏 owner queryability。 | 高：直接影响 handler 单 bridge surface gate 和 wiki/map。 | 若未来合并：先改 `function-map.yml`、`verification-map.yml`、`mainline-call-map.yml`、`server_responses_sse_surface_single_owner.test.ts`、`verify-responses-handler-single-bridge-surface.mjs`，再改 imports。 |
| `src/modules/llmswitch/bridge/responses-response-bridge.ts` lifecycle + SSE helper mixed surface | `server.responses_response_handler_bridge_surface` + `server.responses_sse_bridge_surface` | 当前唯一文件级命中：runtime=5，test=11，script=1，doc=13；exported symbol 复核无新的 zero-consumer export | `defer broad split`。当前不能按“大文件”拆；只允许继续找 zero-consumer helper 或明确 native-downshift helper。 | 高：包含 continuation lifecycle、terminal repair、direct metadata guard、JSON/SSE projection，误拆会制造第二套协议语义。 | `verify:responses-handler-single-bridge-surface`、`tests/server/handlers/handler-response-utils.responses-conversation.spec.ts`、force-SSE/required-action split tests、direct metadata guard tests、`npm run verify:function-map-compile-gate`。 |
| `metadata.center.mainline` mtc-03 到 mtc-07 | `hub.metadata_center_mainline` | 当前 `mtc-03 = partial`，`mtc-04/05/06/07 = anchored` | `bind-before-code-cleanup`。request truth、provider observation、servertool projection、closeout/release 都已有真实 adjacent binding；剩余缺口是 `mtc-03` 的 runtime-control / response-observation family 还没 first-class 化，瘦身前仍不能把相关 metadata/adapter glue 当死代码处理。 | 中高：如果先删 metadata/adapter glue，可能误删未来 center family 的唯一读写边。 | `npm run verify:architecture-mainline-call-map`；`tests/server/http-server/executor-metadata.spec.ts`；`tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`；`tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts`；`npm run verify:architecture-manifest-sync`。 |
| Hub stage timing block family | `hub.stage_timing_observation` | active runtime consumers：`logHubStageTiming` runtime=12 / 4 files，`attachHubStageTopSummary` runtime=3 / 2 files，`clearHubStageTiming` runtime=4 / 2 files | `defer`。不是死代码；当前 owner 已通过 duplicate-owner longtail。后续仅可考虑内部 file merge，不可删除语义。 | 低中：主要是观测，不应影响 payload；但影响 usage/timing logs 和 wiki owner。 | `tests/sharedmodule/hub-stage-timing-top-summary.spec.ts`；`npm run verify:architecture-duplicate-owner`；`npm run verify:function-map-compile-gate`。 |

当前最小下一步：

1. 继续进入 metadata center 后半段 family closeout：当前 `mtc-04/05/06/07` 已 anchored，下一步只剩 `mtc-03` 的 runtime-control / response-observation family 仍是 `partial`；在此之前不先删相关 metadata/adapter glue。
2. Jason 的 internal-field 清理完成后，继续收口 `response.metadata` 只保留标准协议语义这条边界；当前 focused tests 已证明：
   - 非 `response` / `response.*` 协议形状的顶层 `metadata` 会 fail-fast
   - direct same-protocol `event: response.metadata` 允许普通 provider metadata 透传
   - 同事件携带 `__routecodex*` / `__rt*` / internal control keys` 时仍 fail-fast
   下一步不是“补顶层 metadata fail-fast”，而是确认剩余 runtime residues 真的退出 payload truth。
3. 先用 `npm run audit:function-map-canonical-builder-spread` 处理 remaining broad-owner truth，再考虑继续压 `ambiguous-owner`：
   - 当前 `features_with_multi_file_canonical_builders=14`
   - `vr.route_selection`、`virtual_router.primary_exhausted_to_default_pool`、`hub.metadata_boundary` 等 feature 的 canonical builders 本来就分散在多个 Rust 文件
   - 这意味着后续只能做 truthy sub-feature split，不能伪造更窄 `owner_module` 来换 owner-queryability 绿灯

### Internal payload carrier pre-audit（2026-06-18）

本轮不接手 Jason 正在进行的 `__routecodex_*` / SSE custom 字段删除实现，只把当前 runtime 热区、owner 可查询性、验证栈和后续收口顺序固定下来。

当前已验证命令：

- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-no-custom-payload-carriers`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-custom-payload-carrier-containment.mjs`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-custom-payload-carrier-owner-queryability`

当前基线：

- `__routecodex*`: `runtime=72, test=103, script=16, doc=58`，runtime unique files=`25`
- `__sse_*`: `runtime=0, test=20, script=15, doc=7`，runtime unique files=`0`
- `response.metadata`: `runtime=11, test=14, script=5, doc=46`，runtime unique files=`4`
- owner-queryability 审计当前结果：
  - `__routecodex*` runtime files=`25`，当前 `unique-owner=20`、`ambiguous-owner=5`、`missing-owner=0`、`missing-verification=0`
  - `response.metadata` runtime files=`4`，其中 `unique-owner=4`、`ambiguous-owner=0`、`missing-owner=0`、`missing-verification=0`
  - `docs/architecture/custom-payload-carrier-runtime-manifest.yml` 当前把 remaining runtime heatmap 继续拆成可执行分桶：
    - `__routecodex*` => `payload_side_channel=10`、`local_runtime_marker=6`、`guard_surface=5`、`contract_or_test_surface=4`
    - `response.metadata` => `guard_surface=1`、`local_runtime_marker=1`、`contract_or_test_surface=2`
  - 同一 manifest 当前还锁定 owner/queryability baseline：
    - `__routecodex*` => `unique-owner=20`、`ambiguous-owner=5`、`missing-verification=0`
    - `response.metadata` => `unique-owner=4`、`ambiguous-owner=0`、`missing-verification=0`
  - manifest 现已机器编码 category -> resolution track：
    - `payload_side_channel -> side_channel_migration`
    - `guard_surface -> guard_lock`
    - `local_runtime_marker -> local_marker_rename`
    - `contract_or_test_surface -> contract_boundary_only`
  - 现在这不再只是 audit 报表基线：
    - `verify:architecture-custom-payload-carrier-owner-queryability` 已硬失败 `missing-owner` / `missing-verification`
    - `verify:architecture-custom-payload-carrier-runtime-manifest` 已硬失败未知 resolution track / category mapping 漂移
    - `verify:function-map-build-wiring` 已锁死 `verify:architecture-ci-longtail` 必须继续带这个 gate
  - 这意味着 TS/host 热区里此前写成 `binding pending` 的几组 surface，现在已经能在 1-2 次查询内唯一反查到 owner；剩余 ambiguity 基本都集中在 Rust broad-owner 带。
  - 审计链当前已去掉一层 drift 源：
    - `verify-custom-payload-carrier-containment.mjs` 不再手写第二份 allowlist，直接消费 `custom-payload-carrier-runtime-manifest.yml`
    - `audit:custom-payload-carriers` 现在直接输出 runtime `category` / `resolution track` 分布
    - `custom-payload-carrier-runtime-manifest.yml` 现在还记录 `semantic_family`
    - 因此后续清理时，只要 manifest 更新，containment/audit 输出会自动跟上，不再需要人工同步两份 runtime 文件清单
  - 当前 `semantic_family` 真相：
    - `request_route_control=9`
    - `request_route_control_contract=4`
    - `response_followup_semantics=3`
    - `provider_runtime_local_marker=5`
    - `client_response_guard=1`
    - `request_entry_guard=1`
    - `daemon_admin_local_marker=1`
    - `response_metadata_protocol_guard=1`
    - 其中 `src/server/runtime/http-server/executor-metadata.ts` 与 `src/server/runtime/http-server/executor/servertool-followup-metadata.ts` 已确认属于 `request_route_control` 的 guard/strip surface，不再算作真实 `payload_side_channel`
    - `src/server/runtime/http-server/executor/request-executor-response-inspect.ts::readServerToolFollowupSource` 已因零 runtime consumer 被物理删除，不再算作 `response_followup_semantics` runtime residue
    - 这说明下一步最应该收的不是所有 `payload_side_channel=10` 一起上，而是：
      1. request-side `PreselectedRoute/RetryProviderKey` 一带；
      2. response-side `requestSemantics.__routecodex` followup 一带。
  - 解释：
    - `payload_side_channel` 是后续必须迁到 `MetadataCenter / runtime side-channel` 的真清理对象；
    - `local_runtime_marker` 不该混同为 payload 问题，后续应走 typed local field / local struct rename；
    - `guard_surface` 当前必须保留，用于 fail-fast 防泄漏；
    - `contract_or_test_surface` 是边界锁，不是 runtime 业务真相 owner。
    - `owner_queryability` baseline 则用来防止已收窄到 `unique-owner` 的 TS/host 热区重新滑回 broad owner 模糊带。
  - 高信号缺口：
    - TS/host 热区当前已全部有唯一 owner；剩余 `ambiguous-owner=5` 集中在 Rust broad-owner / contract-test 带，不能再用伪 file-owner 收窄，只能做真实 sub-feature split 或保留显式 broad-owner 证据。
  - 本轮已收口：
    - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` 现已由 `hub.request_stage_pipeline_bridge` 唯一 owning feature 锚定
    - `src/providers/core/utils/snapshot-writer-buffer.ts` 现已由 `snapshot.provider_error_buffer` 唯一 owning feature 锚定
    - `src/providers/core/hooks/debug-example-hooks.ts` 现已由 `provider.debug_example_hooks_surface` 唯一 owning feature 锚定，并有 focused test / compile gate 证据
    - `src/providers/core/runtime/http-request-executor.ts`
    - `src/providers/core/runtime/provider-request-header-orchestrator.ts`
    - `src/providers/core/runtime/transport/oauth-header-preflight.ts`
    - `src/server/handlers/handler-utils.ts`
      - 现已补进 `verification-map.yml` 与 `custom-payload-carrier-runtime-manifest.yml` 的 `verification_state=present`
      - `audit:custom-payload-carrier-owner-queryability` 现已把 `__routecodex*` 的 `missing-verification` 收口到 `0`

| 候选项 | Owner feature | 当前 residue / 结论 | 风险 | 必跑验证 / gate |
| --- | --- | --- | --- | --- |
| `metadata.__routecodexPreselectedRoute` + `metadata.__routecodexRetryProviderKey` request-side control carriers | `hub.metadata_center_mainline` + `hub.runtime_ingress_bridge` + Rust request-route contract files | `audit only, do not broad-delete now`。当前 residue 分布在 Rust request-route contract/runtime ingress、TS `executor-metadata.ts` / `request-executor-attempt-state.ts` / `index.ts` / `handler-utils.ts`。这组字段仍承载 route select / retry pin 的 runtime side-channel；等 Jason 清理时必须迁到 `MetadataCenter` 或 runtime side-channel，不能直接在 payload 上做 prefix ban 后假绿。 | 高：误删会打穿 request route / retry provider pin 语义。 | `npm run audit:custom-payload-carriers`；`node scripts/architecture/verify-custom-payload-carrier-containment.mjs`；`tests/server/http-server/executor-metadata.spec.ts`；`tests/server/runtime/http-server/executor-metadata.binding.spec.ts`；`tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts`；`npm run build:min`。 |
| `requestSemantics.__routecodex` followup/request-truth residue | `server.servertool_followup_dispatch_surface` + `server.provider_response_conversion_host` | `owner anchored, partially slimmed`。`request-executor-response-inspect.ts::readServerToolFollowupSource` 已因零 runtime consumer 物理删除；当前剩余命中集中在 `servertool-followup-dispatch.ts` 与 `provider-response-converter.ts`。现在真正缺的不是 owner，而是把这组 response-side residue 收到显式 runtime side-channel / MetadataCenter truth 后，再做物理删除。 | 高：若继续靠 grep 改，仍会把 servertool followup / response truth / client projection 三层混在一起。 | `npm run audit:custom-payload-carriers`；`npm run audit:custom-payload-carrier-owner-queryability`；`npm run verify:architecture-mainline-call-map`；`npm run verify:function-map-compile-gate`；`tests/server/runtime/http-server/executor/request-executor-response-inspect.spec.ts`；`tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts`；`tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts`。 |
| Provider-runtime local markers: `__routecodexRequestInfo` / `__routecodexAuthPreflightFatal` / `__routecodexProviderErrorReported` / `__routecodexProviderSnapshotErrorBuffer` | `error.provider_failure_policy` + `error.pipeline_contract` + `snapshot.provider_error_buffer` | `owner anchored, defer semantic rename`。这些字段当前都在 provider-runtime 内部对象/错误对象上，不是 client payload；owner/queryability 已经补齐，后续如果要去掉 `__routecodex*` 前缀，应按“typed local field / local struct rename”处理，而不是按 payload-side-channel 清理。 | 中高：直接 rename/delete 容易打坏 auth preflight、request retry、snapshot diagnostics、provider error de-dup。 | `npm run audit:custom-payload-carriers`；`npm run audit:custom-payload-carrier-owner-queryability`；`node scripts/architecture/verify-custom-payload-carrier-containment.mjs`；`tests/providers/core/utils/provider-error-reporter.spec.ts`；`npm run verify:error-pipeline-contract`。 |
| Client-visible `response.metadata` guard and protocol boundary | `server.responses_response_handler_bridge_surface` + `hub.response_responses_client_projection` | `guard anchored, converter seed cleanup done`。当前 runtime 只剩 4 个 unique-owner 文件：Rust contract files、`responses-response-bridge.ts`、provider debug hook；`provider-response-converter.ts` 已不再把 `response.metadata` spread 进 bridge seed。focused tests 已证明：非 `response` / `response.*` 协议形状的顶层 `metadata` 会 fail-fast；direct same-protocol `response.metadata` 只允许普通 provider metadata，内部 control keys 仍 fail-fast。按 Jason 最新规则，后续要继续确认的是 remaining runtime residues 是否完全退出 payload truth，而不是再补一遍 guard 语义。 | 高：这里直接影响 client protocol；必须保留标准协议语义，不能把合法 provider `response.metadata` 一并剪掉。 | `npm run verify:architecture-no-custom-payload-carriers`；`tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts`；`tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts`；`tests/server/handlers/handler-response-sse-frame-metadata-guard.spec.ts`；`tests/red-tests/server_response_projection_metadata_guard.test.ts`；`tests/red-tests/server_sse_guard_e2e.test.ts`；`tests/server/runtime/http-server/executor/provider-response-converter.bridge-seed.spec.ts`；`tests/server/runtime/http-server/executor/provider-response-converter.contract.spec.ts`。 |
| Rust `payload_side_channel` broad-owner band (`hub_pipeline_lib/engine.rs` / `meta_error_carriers.rs` / `chat_node_result_semantics.rs`) | `vr.route_selection` + `virtual_router.primary_exhausted_to_default_pool` + `hub.metadata_boundary` + `hub.servertool_followup` 等 broad-owner family | `next truthy split target`。当前 `__routecodex*` owner ambiguity 已降到 5 个文件，其中真正 payload-side-channel broad-owner 主要是 Rust `engine.rs` / `meta_error_carriers.rs` / `chat_node_result_semantics.rs`；`router_metadata_input.rs` 与 `virtual_router_engine/engine/route.rs` 已分别收窄到 `hub.route_metadata_surface` / `vr.route_retry_pin_surface` unique owner。后续如果还要把 `ambiguous-owner` 往下压，只能做 truthy Rust sub-feature split，不能伪 file-owner 收窄。 | 中高：误拆会把 request-route、retry pin、servertool followup、response projection 的 Rust 边界写假。 | `npm run audit:function-map-canonical-builder-spread`；`npm run audit:custom-payload-carrier-owner-queryability`；`npm run verify:function-map-canonical-builder-definitions`；`npm run verify:function-map-compile-gate`；`npm run verify:architecture-ci-longtail`。 |
| `__sse_*` runtime residues | `n/a (runtime zero residue)` | `runtime locked, cleanup can focus on tests/scripts/docs`。当前 runtime unique files=`0`，说明旧 SSE wrapper 自定义语义已从 runtime 面撤出；剩余残留都在 tests/scripts/docs/fixtures。 | 低：runtime 语义面已经不再依赖 `__sse_*`。 | `npm run audit:custom-payload-carriers`；`npm run verify:architecture-no-custom-payload-carriers`；`node scripts/architecture/verify-custom-payload-carrier-containment.mjs`。 |

### Remaining `payload_side_channel=10` prioritized candidate table

以下表格只覆盖 manifest 当前仍标成 `payload_side_channel` 的 10 个 runtime 文件，按“先收 unique-owner TS/host，再收 ambiguous-owner Rust broad-owner”排序。`current hits` 统计口径是当前文件内 `__routecodex*` token 命中数，用来标记 residue 热度，不代表 public API consumer 数。

| Priority | File | Owner feature | Current hits | Semantic family | 处置结论 | 风险 | 必跑验证 / gate |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| P0 | `src/server/runtime/http-server/executor/request-executor-attempt-state.ts` | `hub.metadata_center_attempt_merge` | 3 | `request_route_control` | `migrate then delete flat key`。下一步应把 `__routecodexRetryProviderKey` 从 attempt metadata 顶层写入迁到 `MetadataCenter` 的 request-route / provider-observation family，再物理删除 flat key 回写。 | 高：误删会打坏 retry provider pin 和后续 attempt merge truth。 | `tests/server/http-server/executor-metadata.spec.ts`；`npm run verify:function-map-compile-gate`；`npm run build:min`。 |
| P0 | `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts` | `server.servertool_followup_dispatch_surface` | 18 | `response_followup_semantics` | `move followup semantics off requestSemantics.__routecodex`。这里是当前最热的 TS residue，后续必须把 followup source / stopless status / nested followup control 改到 `MetadataCenter` 或 runtime side-channel，再清掉 `requestSemantics.__routecodex`。 | 高：误改会把 followup dispatch、request truth、response truth 三层重新缠在一起。 | `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts`；`tests/server/runtime/http-server/executor/servertool-followup-model-pin-regression.spec.ts`；`tests/server/handlers/responses-handler.stop-followup-metadata.blackbox.spec.ts`；`npm run verify:architecture-ci`；`npm run build:min`。 |
| P0 | `src/server/runtime/http-server/executor/provider-response-converter.ts` | `server.provider_response_conversion_host` | 1 | `response_followup_semantics` | `consume side-channel only`。清理目标不是“再包一层 sanitize”，而是让 response converter 不再读 `requestSemantics.__routecodex`，只认 runtime side-channel truth。 | 高：这里贴着 client projection，错误迁移会把 followup residue 重新投影回 client-visible 协议。 | `tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts`；`tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`；`npm run verify:architecture-ci`；`npm run build:min`。 |
| P0 | `src/server/runtime/http-server/index.ts` | `server.http_runtime_entry` | 4 | `request_route_control` | `stop writing flat route pin at entry shell`。后续要把 `metadataForHub.__routecodexPreselectedRoute / __routecodexRetryProviderKey` 改成 entry shell 对 MetadataCenter / runtime side-channel 的显式写入。 | 高：这里是 server runtime entry；若改错会打坏 per-port dispatch 和 retry pin 透传。 | `tests/server/runtime/http-server/direct-passthrough-payload.spec.ts`；`tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts`；`npm run verify:architecture-ci`；`npm run build:min`。 |
| P1 | `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` | `hub.request_stage_pipeline_bridge` | 2 | `request_route_control` | `keep as last TS bridge slice`。只有在 Rust request-stage ingress 已能直接吃 typed route side-channel 时，才能删掉这里的 `__routecodexPreselectedRoute` bridge handoff。 | 中高：这是 TS->Rust 入口薄壳，过早删除会让 request-stage route handoff 断层。 | `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts`；`tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`；`npm run verify:llmswitch-core-tsc`；`npm run build:min`。 |
| P1 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs` | `vr.route_selection` / `hub.metadata_boundary` / `virtual_router.primary_exhausted_to_default_pool` | 2 | `request_route_control` | `truthy Rust sub-feature split first`。这是 request-route control Rust 带的直接入口，不先拆 broad owner 就不能安全改字段名/载体。 | 高：这里是 Rust request-route selection 输入边；改错会污染 VR select/availability semantics。 | `tests/red-tests/hub_pipeline_vr_provider_boundary_contract.test.ts`；`tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`；`npm run audit:function-map-canonical-builder-spread`；`npm run verify:function-map-canonical-builder-definitions`。 |
| P1 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs` | `vr.route_selection` / `hub.metadata_boundary` | 2 | `request_route_control` | `convert request-stage engine read after route input split`。这里直接读 `metadata.__routecodexPreselectedRoute`；必须跟 `router_metadata_input.rs` / TS bridge 一起改，不能单点 patch。 | 高：这是 Hub request-stage Rust 主引擎，不能做半迁移。 | `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts`；`tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts`；`npm run verify:architecture-ci-longtail`；`npm run build:min`。 |
| P1 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/meta_error_carriers.rs` | `hub.metadata_boundary` / `vr.route_selection` | 2 | `request_route_control` | `typed carrier rename only after route pin truth changes`。这里不是入口逻辑，而是 typed carrier copy；必须等 request-route 真源先换载体，再同步 rename/delete。 | 中高：过早改这里只会让 typed carrier 和实际 producer 脱节。 | `tests/red-tests/hub_pipeline_meta_error_carrier_contract.test.ts`；`tests/red-tests/hub_pipeline_type_topology_contract.test.ts`；`npm run verify:architecture-custom-payload-carrier-runtime-manifest`。 |
| P1 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs` | `vr.route_selection` / `virtual_router.primary_exhausted_to_default_pool` | 1 | `request_route_control` | `VR retry pin slice must follow Rust owner split`。这里只剩 1 个 token，但它是 VR retry pin 读取点，必须跟 request-route control Rust 带一起清。 | 高：会直接影响 VR retry/provider pin route semantics。 | `tests/sharedmodule/virtual-router-provider-unavailable-cooldown-native.spec.ts`；`tests/sharedmodule/virtual-router-quota-shadow-compare-native.spec.ts`；`npm run verify:vr-no-ts-runtime`；`npm run build:min`。 |
| P1 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_node_result_semantics.rs` | `hub.servertool_followup` / `hub.metadata_boundary` | 2 | `response_followup_semantics` | `Rust followup residue waits for TS followup writers to move first`。这里对应 response/request semantics followup residue；先收 `servertool-followup-dispatch.ts` / `provider-response-converter.ts`，再回头删 Rust broad-owner residue。 | 中高：这里属于 response/followup client projection边界，过早改会让 Rust/TS 两侧 followup 真相脱节。 | `tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts`；`tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts`；`npm run verify:servertool-rust-only`；`npm run build:min`。 |

### P0 TS/host role map

为避免后续清理继续停留在“某文件里还有 token”这种粗粒度，这里把 P0 五项再按角色拆成 writer / reader / bridge / materializer。执行顺序应优先收真正的 writer，再收纯 reader，最后再收 bridge shell。

2026-06-18 复跑审计后确认：新增这张 role map、writer-first checklist、source-to-sink 审计与同轮审计记录只抬高了 docs/test 命中，未改变 runtime 文件集；当前 `__routecodex*` 为 `runtime=72, test=103, script=16, doc=58`、runtime unique files=`25`，owner-queryability 为 `unique-owner=20 / ambiguous-owner=5 / missing-owner=0 / missing-verification=0`。

| File | Exact role | Current line anchors | Current field shape | 执行含义 |
| --- | --- | --- | --- | --- |
| `src/server/runtime/http-server/executor/request-executor-attempt-state.ts` | `writer` | `L48-L55` | writes flat `metadataForAttempt.__routecodexRetryProviderKey` | 这是 request retry pin 的 TS 写入点之一；先迁出这里，后续 merge/read 才不会继续被顶层 metadata 复活。 |
| `src/server/runtime/http-server/index.ts` | `writer + relay bridge` | `L1310-L1319`, `L1402-L1410` | writes `metadata.__routecodexPreselectedRoute` and `metadataForHub.__routecodexRetryProviderKey` | 这是 server entry / router-direct 进入 Hub 前的 route-pin 写入面；属于高优先 writer。 |
| `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` | `bridge copier` | `L20-L25` | reads then re-writes `normalized.metadata.__routecodexPreselectedRoute` | 这里不是 route decision owner，而是 TS->Rust request-stage 薄壳桥接；应在前面 writer 迁完后再删。 |
| `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts` | `materializer / mutating reader` | `L223-L245`, `L279-L331` | reads and rebuilds `requestSemantics.__routecodex` | 这是 followup 语义残留最热文件；虽然不写顶层 metadata，但会重新 materialize request semantics residue，属于 response-side 第一优先级。 |
| `src/server/runtime/http-server/executor/provider-response-converter.ts` | `reader` | `L1070-L1071` | reads `options.requestSemantics?.__routecodex` only | 这里是纯消费面；`response.metadata` bridge-seed spread 已删除；应等 followup dispatch 写入面先迁走，再把 converter 改成只认 runtime side-channel。 |

### Writer-first execution checklist

下面这份 checklist 只定义“清理顺序 + 前置依赖 + 最小验证栈”，不替代具体实现方案。目标是保证后续字段迁移按唯一 owner 顺序收口，而不是在多个层同时改一版“看起来等价”的 side-channel。

1. Request retry pin writer first: `hub.metadata_center_attempt_merge`
   - 文件/锚点：`src/server/runtime/http-server/executor/request-executor-attempt-state.ts` `L48-L55`
   - 原因：这是最窄的 request-route writer，只写 `__routecodexRetryProviderKey`，先迁出它，后续 attempt merge/read 才不会继续把顶层 metadata 复活回来。
   - 前置依赖：无；这是 request-route-control lane 最小 writer。
   - 最小验证栈：
     - `tests/server/http-server/executor-metadata.spec.ts`
     - `npm run verify:function-map-compile-gate`
     - `npm run build:min`

2. Entry-shell writer second: `server.http_runtime_entry`
   - 文件/锚点：`src/server/runtime/http-server/index.ts` `L1310-L1319`, `L1402-L1410`
   - 原因：这里同时写 `__routecodexPreselectedRoute` 和 `__routecodexRetryProviderKey`，而且位于 port dispatch / router-direct relay 边界；必须在较窄的 attempt writer 已收口后再动 entry shell，避免 route pin / retry pin 两套 truth 并存。
   - 前置依赖：步骤 1 已明确 retry pin 的 request-local 写入载体。
   - 最小验证栈：
     - `tests/server/runtime/http-server/direct-passthrough-payload.spec.ts`
     - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`
     - `npm run verify:architecture-ci`
     - `npm run build:min`

3. Request-stage bridge last in request-route lane: `hub.request_stage_pipeline_bridge`
   - 文件/锚点：`sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` `L20-L25`
   - 原因：这是 TS->Rust bridge copier，不是 route decision owner。只有当前两个 writer 都迁完、且 Rust request-stage route input 已能直接消费新 side-channel truth 后，才能删掉这里的 `normalized.metadata.__routecodexPreselectedRoute` handoff。
   - 前置依赖：步骤 1-2 完成；Rust request-route-control 带的真实输入边同步完成。
   - 最小验证栈：
     - `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts`
     - `tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts`
     - `npm run verify:llmswitch-core-tsc`
     - `npm run build:min`

4. Response-side materializer before reader: `server.servertool_followup_dispatch_surface`
   - 文件/锚点：`src/server/runtime/http-server/executor/servertool-followup-dispatch.ts` `L223-L245`, `L279-L331`
   - 原因：这是 followup residue 的主要重建点，会重新 materialize `requestSemantics.__routecodex`。必须先把这里迁到 `MetadataCenter / runtime side-channel`，否则下游 reader 即使改完，也还会被这个 writer-like materializer 重新污染。
   - 前置依赖：无 request-route lane 强依赖；它是 response-followup lane 的第一步。
   - 最小验证栈：
     - `tests/server/runtime/http-server/executor/servertool-followup-dispatch.spec.ts`
     - `tests/server/runtime/http-server/executor/servertool-followup-model-pin-regression.spec.ts`
     - `tests/server/handlers/responses-handler.stop-followup-metadata.blackbox.spec.ts`
     - `npm run verify:function-map-compile-gate`
     - `npm run verify:architecture-ci`
     - `npm run build:min`

5. Pure reader last: `server.provider_response_conversion_host`
   - 文件/锚点：`src/server/runtime/http-server/executor/provider-response-converter.ts` `L1070-L1071`
   - 原因：这里仅读 `options.requestSemantics?.__routecodex`；只有在步骤 4 不再重建旧语义后，reader 改成只认 runtime side-channel 才不会出现“上游已迁、下游又兼容一份旧字段”的双轨残留。
   - 前置依赖：步骤 4 完成。
   - 最小验证栈：
     - `tests/server/runtime/http-server/executor/provider-response-converter.unified-semantics.spec.ts`
     - `tests/server/runtime/http-server/executor/provider-response-converter-empty-sse.spec.ts`
     - `tests/server/runtime/http-server/executor/provider-response-converter.prebuilt-sse-passthrough.spec.ts`
     - `tests/server/runtime/request-executor.unified-semantics.spec.ts`
     - `npm run verify:architecture-ci`
     - `npm run verify:function-map-compile-gate`
     - `npm run build:min`

执行约束：

- request-route-control 与 response-followup-semantics 是两条不同 lane，不要在同一批改动里混成一套“大扫除”。
- request-route lane 的 TS 顺序固定为：`attempt writer -> entry writer -> request-stage bridge`；bridge 不得先于 writer 清。
- response-followup lane 的 TS 顺序固定为：`dispatch materializer -> response converter reader`；reader 不得先于 materializer 清。
- 任何一步只要仍依赖 Rust broad-owner 带（`router_metadata_input.rs` / `hub_pipeline_lib/engine.rs` / `meta_error_carriers.rs` / `virtual_router_engine/engine/route.rs` / `chat_node_result_semantics.rs`），都必须显式记为 `binding pending`，不能靠 TS 壳层先兼容一版旧字段。

### Request-route control source-to-sink map

这张图只覆盖 request-route lane 当前最关键的两类字段：`__routecodexRetryProviderKey` 与 `__routecodexPreselectedRoute`。目的不是重复列 hit，而是看清“谁在写、谁在清、谁在桥接、谁在 Rust 侧消费”。

1. `__routecodexRetryProviderKey`
   - TS writers:
     - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts` `L51-L55`
     - `src/server/runtime/http-server/index.ts` `L1402-L1410`
   - TS/Rust carrier copy or read:
     - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
     - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/meta_error_carriers.rs`
     - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/server_contracts.rs`
     - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/engine/route.rs`
   - Contract/test surface:
     - `tests/red-tests/hub_pipeline_meta_error_carrier_contract.test.ts`
     - `tests/red-tests/hub_pipeline_vr_provider_boundary_contract.test.ts`
     - `tests/server/runtime/http-server/direct-passthrough-route-level.spec.ts`
     - `tests/runtime/request-executor.single-attempt.spec.ts`

2. `__routecodexPreselectedRoute`
   - TS writers / guards:
     - `src/server/runtime/http-server/index.ts` `L1310-L1319`
     - `src/server/runtime/http-server/executor-metadata.ts` `L728-L733` 仅做 retry strip guard
     - `src/server/runtime/http-server/executor/servertool-followup-metadata.ts` `L51` 仅做 followup strip guard
   - TS bridge copier:
     - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` `L20-L25`
   - Rust read side:
     - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
   - Contract/test surface:
     - `tests/sharedmodule/hub-pipeline-preselected-route.spec.ts`
     - `tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts`
     - `tests/server/http-server/executor-metadata.spec.ts`
     - `tests/server/runtime/http-server/request-executor.spec.ts`

当前最安全的下一执行 slice：

- 首选执行 slice：`hub.metadata_center_attempt_merge / request-executor-attempt-state.ts`
  - 前置的 `hub.metadata_center_mainline / mtc-03 runtime_control plumbing` 已落地：`MetadataCenterRuntimeControl`、`MetadataCenterState.runtimeControl`、`writeRuntimeControl(...)`、`readRuntimeControl(...)`、`readRuntimeControlProjection(...)`、`markReleased(...)` 与 `finalizeRequestExecutorAttemptMetadata(...)` 的 runtime-control merge 都已有代码面。
  - 原因 1：它仍是最窄的 request-route writer，只有 3 个 runtime hits，不同时碰 entry relay 与 bridge handoff。
  - 原因 2：最小验证栈短，主要靠 `tests/server/http-server/executor-metadata.spec.ts` 与 `request-executor-attempt-state.contract.spec.ts` 即可先锁 merge/write truth。
  - 原因 3：它不直接跨到 router-direct relay、Hub request-stage bridge 或 response followup client projection，blast radius 仍最小。
- 暂不首选 `server.http_runtime_entry / index.ts`
  - 原因：它同时碰 direct relay -> executePipeline 重入、port dispatch、`PreselectedRoute` 与 `RetryProviderKey` 两类字段，改动面明显更宽。
- 暂不首选 `hub.request_stage_pipeline_bridge`
  - 原因：它依赖 Rust request-stage route input 已完成同批切换；单改 TS bridge 只会制造新旧 side-channel 双轨。

`mtc-03` 当前缺口结论：

- mainline call map 已明确：
  - `MetaReq03ContinuationAttached -> MetaReq04RuntimeControlBound`
  - caller/callee 仍落在 `finalizeRequestExecutorAttemptMetadata`
  - 当前状态仍是 `partial`，原因不再是 carrier 缺失，而是旧 writer/materializer/reader 尚未全部迁到 first-class runtime-control family。
- 当前源码已经能证明 `mtc-03` 不是抽象 family 缺口，而是一个可枚举的 first-batch contract 缺口：
  - request-route control:
    - `routeHint`
    - `routeName`
    - `routeId`
    - `providerProtocol`
    - `retryProviderKey`
    - `preselectedRoute`
  - followup / stopless control:
    - `serverToolFollowup`
    - `serverToolFollowupSource`
    - `stoplessGoalStatus`
  - stop-message control:
    - `stopMessageEnabled`
    - `stopMessageExcludeDirect`
  - 当前证据来源：
    - `src/server/runtime/http-server/executor/request-executor-attempt-state.ts`
    - `src/server/runtime/http-server/index.ts`
    - `src/server/runtime/http-server/executor/servertool-followup-dispatch.ts`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/napi_bindings.rs`
    - `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_lib/engine.rs`
- 本轮已补齐的 plumbing：
  - `MetadataCenterRuntimeControl` 类型
  - `MetadataCenterState.runtimeControl`
  - `writeRuntimeControl(...)`
  - `readRuntimeControl(...)`
  - `readRuntimeControlProjection(...)` host-side reader
  - `markReleased(...)` 对 `runtime_control` family 的 closeout
  - `finalizeRequestExecutorAttemptMetadata(...)` 对 `runtimeControl` family 的 center merge
- 额外 review-surface 漂移点本轮也已收口：
  - `docs/architecture/metadata-center-manifest.yml` 不再只写泛化槽位 `stopMessage`
  - machine-readable manifest 现已对齐到 `stopMessageEnabled` / `stopMessageExcludeDirect`
- 因此 `mtc-03` 的下一步不再是补 carrier，而是迁 writer / materializer / reader 到这个已落地的 family
- 因此真正的顺序应收敛为：
  1. 先改 `hub.metadata_center_attempt_merge`，把当前最窄 request-route writer 从顶层 metadata 迁进已落地 carrier；
  2. 再改 `server.http_runtime_entry`，收入口壳层的 `PreselectedRoute/RetryProviderKey` 写入；
  3. 再继续 request-stage bridge / response followup materializer / Rust broad-owner 带。

### 候选项处置表

| 候选项 | Owner | 当前状态 | 处置 | 证据 | 风险与验证 |
| --- | --- | --- | --- | --- | --- |
| `request-executor-request-semantics.ts` provider-native continuation 判定 | Rust/native chat node result semantics | TS leaf wrapper 已物理删除，host 直接调用 `native-exports` | 已改 | `isProviderNativeResumeContinuationNative(...)` 覆盖 inline tool output negative、previous response positive、submit_tool_outputs positive | 验证：`request-executor-native-semantics.spec.ts`、`tsc`、`build-core` |
| `finish-reason.ts` visible-success/tool-call fallback | native finish reason derivation | fallback 残名已物理删除，只保留 native `deriveFinishReason(...)` | 已改 | 生产代码调用点已统一改回 `deriveFinishReason(...)`；`verify:architecture-deleted-path` 禁止 `deriveFinishReasonWithVisibleSuccessFallback` 在 `src/tests/scripts` 复活 | 验证：`finish-reason.spec.ts`、`finish-reason.visible-success.spec.ts`、submit_tool_outputs handler focused tests、`verify:architecture-deleted-path`、`tsc`、`architecture-ci`、`build:min` |
| `hub-pipeline-execute-chat-process-entry.ts` | `hub.runtime_ingress_bridge` | 与 `hub-pipeline-execute-request-stage.ts` 同构 | 已删并合并 | 文件已删除；chat_process 入口通过 `entryMode: "chat_process"` 复用 request-stage executor | 验证：`hub-pipeline-preselected-route.spec.ts`、`hub-pipeline-stage-residue-audit.spec.ts`、sharedmodule `tsc` |
| `responses-response-bridge.ts::rebindResponsesConversationRequestIdsToResponseIdForHttp` | `server.responses_response_handler_bridge_surface` | zero-consumer export | 已删 | 精确 grep 仅定义处命中；删除后 `tsc` 与 residue gate 通过 | 验证：`hub-pipeline-stage-residue-audit.spec.ts`、`tsc` |
| `package.json:test:routing-instructions` stale `stop-message-auto.spec.ts` | test script hygiene | 引用不存在文件 | 已改 | 替换为现存拆分用例 `stop-message-auto-no-reenter.red` / `goal-default` / `config-precedence` | 验证：residue audit 的 missing test file gate |
| `sharedmodule/llmswitch-core/src/**` side-by-side `.js/.d.ts/.map` | generated artifact hygiene | ignored source-adjacent emit artifacts | 已删 | 每个 artifact 都存在对应 `.ts` 真源；删除后 residue audit 通过 | 验证：`hub-pipeline-stage-residue-audit.spec.ts` |
| `responses-sse-bridge.ts` | `server.responses_sse_bridge_surface` | 98 行纯 re-export facade，但 function-map 定义为独立 SSE facade owner | 暂缓删除 | function-map/verification-map 明确 owner_module 为 `responses-sse-bridge.ts`；handler imports 从该 facade 进入 | 不能按死代码删；若要合并，需要先改 owner map、mainline map、single bridge gate 和 handler imports |
| `responses-response-bridge.ts` SSE terminal/probe/persist helpers | `server.responses_sse_bridge_surface` + `server.responses_response_handler_bridge_surface` | 高风险状态机/生命周期语义仍集中在大文件中 | 暂缓大拆 | 当前 export 引用计数均非 0；部分 helper 是 SSE facade 的 canonical builders | 不能盲拆 SSE 主状态机；下一步只能先找更小 zero-consumer helper、同义 facade，或设计 native-downshift 红测 |
| `handler-response-sse.ts` SSE transport orchestration | server response transport | 仍消费 SSE bridge facade 并维护 transport state | 暂缓 | function-map 允许该路径，notes 要求 transport 物理隔离在 handler-response-sse | 不属于本轮可删项；若改，需要 terminal/non-terminal/already-terminal/client-close/upstream-close 成对测试 |

### 如何继续删

1. 每次先生成候选清单，不直接改代码：
   - 精确统计 exported symbol 的 source consumer 数。
   - 分离 docs/map 命中和实际 runtime/test/script 命中。
   - 若只剩定义处，才进入 delete 候选。
2. delete 候选必须同时满足：
   - 无 runtime/test/script consumer。
   - 非 function-map canonical builder。
   - 非 barrel public API。
   - 删除后 `tsc` 与 residue gate 通过。
3. 删除后必须补 gate：
   - deleted file：`expect(fs.existsSync(path)).toBe(false)`。
   - deleted symbol：`expect(source).not.toContain("<symbol>")` 或在 residue audit 中加入 forbidden pattern。
   - stale script：missing file audit 必须覆盖。

### 如何继续改

1. 重复 wrapper 合并：
   - 先比较 native 入参、输出字段、错误投影差异。
   - 用参数表达差异，不复制执行骨架。
   - 合并后删除旧文件，并在 residue audit 锁 deleted file。
2. TS 语义下沉：
   - 先在 Rust/native 增加 capability 和 focused Rust test。
   - TS wrapper 必须 fail-fast，不允许 fallback。
   - 删除 TS 本地 parser/helper。
   - 更新 required native export gate。
3. Responses bridge 收缩：
   - 第一阶段只删 zero-consumer helper/export。
   - 第二阶段合并同义 facade，但必须同步 function-map / verification-map / mainline-call-map。
   - 第三阶段才考虑 native-downshift，且必须补正反向测试。

### 暂缓项说明

`responses-sse-bridge.ts` 看起来像纯 re-export，但当前 architecture map 将它作为 `server.responses_sse_bridge_surface` 的 owner module；直接删除会破坏 owner queryability 和单 bridge surface 约束。因此本轮只记录为“可设计合并，但不可直接删除”。

`responses-response-bridge.ts` 仍有大段 TS helper，但当前引用计数显示 exported helpers 都有消费者，且部分属于 canonical builders。继续瘦身必须从更小粒度下手：zero-consumer internal helper、重复 facade、或明确 native-downshift，而不是按行数拆文件。

## 审计方法

1. 先读真源规则：
   - `AGENTS.md`
   - `docs/agent-routing/00-entry-routing.md`
   - `docs/agent-routing/10-runtime-ssot-routing.md`
   - `.agents/skills/rcc-dev-skills/SKILL.md`
   - `MEMORY.md`
   - `note.md`
2. 查询 owner/gate：
   - `docs/architecture/function-map.yml`
   - `docs/architecture/verification-map.yml`
   - `docs/architecture/mainline-call-map.yml`
3. 对候选文件做三类扫描：
   - zero-consumer export/function/type。
   - 重复 wrapper / 同构壳。
   - TS 侧 payload/tool/finish_reason/continuation/SSE terminal 语义处理。
4. 对每个候选项先分类再动作：
   - `delete`: 真死代码、失效 script、生成产物、零消费者 export。
   - `merge`: 逻辑同构但还被调用的 wrapper。
   - `native-downshift`: 语义应归 Rust/native owner，TS 只保留调用壳。
   - `defer`: 高风险状态机或 owner 未清晰项，只记录不动。
5. 每次动作后补 gate，避免旧语义复活。

## 删除策略

可以直接物理删除的条件：
- 全仓精确搜索只有定义处，且没有 barrel/re-export/文档作为 public contract。
- 删除后 `tsc` 与对应 Jest/gate 通过。
- 对应功能有别的唯一 owner，或该功能已确认不存在消费者。
- 删除对象是 ignored/generated artifact，且存在 `.ts` 真源或 dist 构建真源。

不得删除的条件：
- 仍属于 public API/exported contract。
- 仍被 `src/server/**`、`sharedmodule/**`、tests、scripts、docs architecture map 引用。
- 只是“看起来重复”，但返回字段、错误投影、metadata side-channel 或 runtime effect 有差异且未建测试。
- 会影响 SSE terminal / continuation / persistence 主状态机，但没有正反向黑盒测试。

删除前必做：
- `grep` / `git grep` 精确定位引用。
- 若是 generated artifact，确认 ignore 状态和对应源码。
- 若是 TS helper，确认 owner map / residue gate。
- 若是 bridge export，确认 barrel 文件没有 re-export。

删除后必做：
- 更新 residue audit。
- 跑定向 Jest。
- 跑 `tsc`。
- 跑 `git diff --check`。
- 更新 `note.md` / `MEMORY.md`。

## 修改策略

### 1. 重复 wrapper 合并

适用对象：
- 同样调用 `runHubPipelineLibWithNative(...)`。
- 同样做 route/preselected-route/materialize/native result wrapping。
- 差异只在错误文案或少数返回字段。

做法：
- 合并到一个 executor。
- 用显式参数表达差异，例如 `entryMode`。
- 删除旧 wrapper 文件。
- 测试锁住：
  - preselected route 不重复 route。
  - native 入参不变。
  - 原有返回字段差异保持。
  - deleted file 不可复活。

### 2. TS 语义下沉 native/Rust

适用对象：
- TS 扫描/判断 `tool_calls`、`required_action`、`function_call_output`、`finish_reason`、Responses continuation、servertool/tool output。
- TS 自行构造 terminal/probe/client-visible protocol semantics。

做法：
- 先在 Rust/native owner 增加 capability。
- TS 改为 fail-fast native wrapper，不提供 fallback。
- 删除 TS 本地 parser/helper。
- `REQUIRED_NATIVE_HOTPATH_EXPORTS` 同步更新。
- 测试覆盖 positive + negative。

### 3. Bridge 大文件瘦身

适用对象：
- `src/modules/llmswitch/bridge/responses-response-bridge.ts`
- `src/modules/llmswitch/bridge/responses-sse-bridge.ts`

做法顺序：
1. 先删 zero-consumer helper/export。
2. 再合并同义 facade。
3. 再把可明确归 native 的语义 helper 下沉。
4. 最后才考虑文件拆分。

禁止：
- 纯粹为了行数把函数搬到新文件。
- 拆 SSE 主状态机但没有 terminal / non-terminal / already-terminal / client-close / upstream-close 成对测试。

## 风险与规避

- 风险：把“桥接 glue”误删成行为回归。规避：只删 zero-consumer；有消费者的先合并/下沉并补测试。
- 风险：拆分 `responses-response-bridge.ts` 后 owner 更不清晰。规避：先 owner/gate，再移动代码；优先删真死面。
- 风险：native export 增加后 TS wrapper fallback。规避：required export gate + fail-fast test。
- 风险：测试只覆盖 happy path。规避：正反向测试成对，特别是 continuation / terminal / finish_reason。
- 风险：工作树并行变更混入。规避：只提交本任务相关文件；不回滚他人修改。

## 验证矩阵

基础验证：
- `git diff --check`
- `npx tsc --noEmit --pretty false`
- `npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false`

Hub Pipeline 定向：
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-preselected-route.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/chat-semantics-stage1.spec.ts tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts --runInBand`

Host/handler 定向：
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/executor/request-executor-native-semantics.spec.ts --runInBand`
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/utils/finish-reason.spec.ts tests/server/utils/finish-reason.visible-success.spec.ts --runInBand`

Native/Rust 变更时追加：
- `node scripts/build-core.mjs`
- `cargo test -p router-hotpath-napi <focused_test> -- --nocapture`

Runtime 行为受影响时追加：
- 真实入口 replay 或端口 smoke。
- 若涉及 live server，必须明确端口、版本、health 和样本证据。

## 实施步骤

1. 建立审计清单：列候选文件、函数、export、引用计数、owner、gate。
2. 标记动作类型：delete / merge / native-downshift / defer。
3. 对 delete 项先补或确认 residue gate，再物理删除。
4. 对 merge 项先写保行为测试，再合并 wrapper，删除旧文件。
5. 对 native-downshift 项先补 Rust/native test 与 export，再删 TS parser。
6. 跑验证矩阵。
7. 更新 `note.md` 和 `MEMORY.md`。
8. 若用户要求提交，只 staged 本任务相关文件，不混入并行脏改。

## 完成定义

- 有完整审计报告：每个候选项都有“删/改/暂缓”结论和证据。
- 所有执行项已物理删除或最小改造，没有遗留闲置代码。
- residue gate 能防止删除项复活。
- 定向 Jest、TypeScript、build/Rust 必要项全部通过。
- `note.md` / `MEMORY.md` 已记录已验证结论。
- 最终回复包含改动、验证、剩余风险和下一步。
