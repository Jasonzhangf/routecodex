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
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts tests/sharedmodule/hub-pipeline-preselected-route.spec.ts tests/sharedmodule/chat-semantics-stage1.spec.ts tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts tests/server/runtime/http-server/executor/request-executor-request-semantics.spec.ts tests/server/utils/finish-reason.spec.ts tests/server/utils/finish-reason.visible-success.spec.ts --runInBand`
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
| `metadata.center.mainline` mtc-04 到 mtc-07 | `hub.metadata_center_mainline` | 当前 `mtc-04/05/06 = partial`，`mtc-07 = anchored` | `bind-before-code-cleanup`。provider observation、response observation、servertool projection 已有真实 adjacent binding，但 `mtc-04/05/06` 仍是 flat projection；`mtc-07` closeout/release 已 anchored，瘦身前仍不能把这些层当死代码处理。 | 中高：如果先删 metadata/adapter glue，可能误删未来 center family 的唯一读写边。 | `npm run verify:architecture-mainline-call-map`；`tests/server/http-server/executor-metadata.spec.ts`；`tests/server/runtime/http-server/executor/servertool-adapter-context.spec.ts`；`tests/modules/llmswitch/bridge/responses-response-bridge.request-truth.spec.ts`；`npm run verify:architecture-manifest-sync`。 |
| Hub stage timing block family | `hub.stage_timing_observation` | active runtime consumers：`logHubStageTiming` runtime=12 / 4 files，`attachHubStageTopSummary` runtime=3 / 2 files，`clearHubStageTiming` runtime=4 / 2 files | `defer`。不是死代码；当前 owner 已通过 duplicate-owner longtail。后续仅可考虑内部 file merge，不可删除语义。 | 低中：主要是观测，不应影响 payload；但影响 usage/timing logs 和 wiki owner。 | `tests/sharedmodule/hub-stage-timing-top-summary.spec.ts`；`npm run verify:architecture-duplicate-owner`；`npm run verify:function-map-compile-gate`。 |

当前最小下一步：

1. 继续进入 metadata center 后半段 binding：当前 `mtc-07` 已有真实 closeout/release owner，下一步只剩 `mtc-04/05/06` 的 provider/response observation family 仍是 `partial`；在此之前不先删相关 metadata/adapter glue。
2. Jason 的 internal-field 清理完成后，补收 `assertClientResponseHasNoInternalCarriers` 对顶层 `metadata` 的 fail-fast 规则，并把对应 red test 纳入正式 gate。

### Internal payload carrier pre-audit（2026-06-18）

本轮不接手 Jason 正在进行的 `__routecodex_*` / SSE custom 字段删除实现，只把当前 runtime 热区、owner 可查询性、验证栈和后续收口顺序固定下来。

当前已验证命令：

- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carriers`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run audit:custom-payload-carrier-owner-queryability`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run verify:architecture-no-custom-payload-carriers`
- `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/architecture/verify-custom-payload-carrier-containment.mjs`

当前基线：

- `__routecodex*`: `runtime=76, test=81, script=12, doc=17`，runtime unique files=`26`
- `__sse_*`: `runtime=0, test=20, script=13, doc=6`，runtime unique files=`0`
- `response.metadata`: `runtime=11, test=13, script=3, doc=32`，runtime unique files=`4`
- owner-queryability 审计当前结果：
  - `__routecodex*` runtime files=`26`，其中 `unique-owner=9`、`ambiguous-owner=17`、`missing-owner=0`、`missing-verification=8`
  - `response.metadata` runtime files=`4`，其中 `unique-owner=1`、`ambiguous-owner=2`、`missing-owner=1`、`missing-verification=1`
  - 高信号缺口：
    - `src/providers/core/hooks/debug-example-hooks.ts`：`response.metadata` 下 `missing-owner`
    - `src/server/runtime/http-server/executor/**` 多数热区仍落在 `hub.metadata_center_mainline` 与 `server.http_runtime_entry` 双 owner 歧义下，清字段前必须先补 owner/queryability
  - 本轮已收口：
    - `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-execute-request-stage.ts` 现已由 `hub.request_stage_pipeline_bridge` 唯一 owning feature 锚定
    - `src/providers/core/utils/snapshot-writer-buffer.ts` 现已由 `snapshot.provider_error_buffer` 唯一 owning feature 锚定

| 候选项 | Owner feature | 当前 residue / 结论 | 风险 | 必跑验证 / gate |
| --- | --- | --- | --- | --- |
| `metadata.__routecodexPreselectedRoute` + `metadata.__routecodexRetryProviderKey` request-side control carriers | `hub.metadata_center_mainline` + `hub.runtime_ingress_bridge` + Rust request-route contract files | `audit only, do not broad-delete now`。当前 residue 分布在 Rust request-route contract/runtime ingress、TS `executor-metadata.ts` / `request-executor-attempt-state.ts` / `index.ts` / `handler-utils.ts`。这组字段仍承载 route select / retry pin 的 runtime side-channel；等 Jason 清理时必须迁到 `MetadataCenter` 或 runtime side-channel，不能直接在 payload 上做 prefix ban 后假绿。 | 高：误删会打穿 request route / retry provider pin 语义。 | `npm run audit:custom-payload-carriers`；`node scripts/architecture/verify-custom-payload-carrier-containment.mjs`；`tests/server/http-server/executor-metadata.spec.ts`；`tests/server/runtime/http-server/executor-metadata.binding.spec.ts`；`tests/sharedmodule/hub-pipeline-runtime-ingress.spec.ts`；`npm run build:min`。 |
| `requestSemantics.__routecodex` followup/request-truth residue | `binding pending` | `bind-before-cleanup`。当前命中 `request-executor-response-inspect.ts`、`servertool-followup-dispatch.ts`、`provider-response-converter.ts`。按现有 function-map / verification-map，1-2 次查询内还不能唯一反查这条 carrier family 的 owner feature；在 owner 没补齐前，不做物理删除或 generic prefix gate 升级。 | 高：这是当前 review surface 的真实缺口；若继续靠 grep 改，容易把 servertool followup / response truth / client projection 三层混在一起。 | `npm run audit:custom-payload-carriers`；`npm run verify:architecture-mainline-call-map`；`npm run verify:function-map-compile-gate`；Jason 清理前先补 owner/queryability，再跑对应 feature tests。 |
| Provider-runtime local markers: `__routecodexRequestInfo` / `__routecodexAuthPreflightFatal` / `__routecodexProviderErrorReported` / `__routecodexProviderSnapshotErrorBuffer` | `error.pipeline_contract` 部分锚定；其余 `binding pending` | `defer, owner-map first`。这些字段当前都在 provider-runtime 内部对象/错误对象上，不是 client payload；但现有 function-map 还不能稳定把 `http-request-executor.ts`、`provider-request-header-orchestrator.ts`、`oauth-header-preflight.ts`、`snapshot-writer-buffer.ts` 反查到唯一 feature。后续若要彻底去掉 `__routecodex*` 前缀，必须先补 owner map，再决定是 typed local field 还是 runtime side-channel。 | 中高：直接 rename/delete 容易打坏 auth preflight、request retry、snapshot diagnostics、provider error de-dup。 | `npm run audit:custom-payload-carriers`；`node scripts/architecture/verify-custom-payload-carrier-containment.mjs`；`tests/providers/core/utils/provider-error-reporter.spec.ts`；`npm run verify:error-pipeline-contract`；补齐 owner 后再加 focused provider-runtime tests。 |
| Client-visible `response.metadata` guard and protocol boundary | `server.responses_response_handler_bridge_surface` + `hub.response_responses_client_projection` | `tighten after Jason cleanup`。当前 runtime 只剩 4 个文件：Rust contract files、`responses-response-bridge.ts`、provider debug hook。现在实现是“允许标准 `response.metadata`，但若内部含 `__routecodex*` / `__rt*` / internal keys 则 fail-fast”；按 Jason 最新规则，后续需要继续收口到“非标准 payload 载体一律不入 client-visible body/SSE data”。 | 高：这里直接影响 client protocol；必须保留标准协议语义，不能把合法 provider `response.metadata` 一并剪掉。 | `npm run verify:architecture-no-custom-payload-carriers`；`tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts`；`tests/server/handlers/handler-response-sse-frame-metadata-guard.spec.ts`；`tests/red-tests/server_response_projection_metadata_guard.test.ts`；`tests/red-tests/server_sse_guard_e2e.test.ts`。 |
| `__sse_*` runtime residues | `n/a (runtime zero residue)` | `runtime locked, cleanup can focus on tests/scripts/docs`。当前 runtime unique files=`0`，说明旧 SSE wrapper 自定义语义已从 runtime 面撤出；剩余残留都在 tests/scripts/docs/fixtures。 | 低：runtime 语义面已经不再依赖 `__sse_*`。 | `npm run audit:custom-payload-carriers`；`npm run verify:architecture-no-custom-payload-carriers`；`node scripts/architecture/verify-custom-payload-carrier-containment.mjs`。 |

### 候选项处置表

| 候选项 | Owner | 当前状态 | 处置 | 证据 | 风险与验证 |
| --- | --- | --- | --- | --- | --- |
| `request-executor-request-semantics.ts` provider-native continuation 判定 | Rust/native chat node result semantics | 已从 TS 本地 parser 收敛到 native wrapper | 已改 | `isProviderNativeResumeContinuation(...)` 现在调用 `isProviderNativeResumeContinuationWithNative`；定向 Jest 覆盖 inline tool output negative、previous response positive、submit_tool_outputs positive | 验证：`request-executor-request-semantics.spec.ts`、`tsc`、`build-core` |
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
- `node --experimental-vm-modules ./node_modules/.bin/jest tests/server/runtime/http-server/executor/request-executor-request-semantics.spec.ts --runInBand`
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
