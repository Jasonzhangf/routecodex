# Hub Pipeline Architecture Review Surface Cleanup Plan

## 目标与验收标准

目标：先修复 Hub Pipeline 架构 review surface 漂移，让 function map、mainline call map、wiki、manifest、CI/local gate 重新闭环；随后在功能不变、不裁剪真实 payload、不引入 fallback 的前提下，执行代码清理与逻辑瘦身审计。

验收标准：

- `verify:architecture-mainline-call-map`、`verify:architecture-wiki-sync`、`verify:architecture-wiki-html-sync` 全部通过。
- `verify:architecture-ci-longtail` 清绿，且 longtail 中应进入主 CI 的 gate 已接入 `verify:architecture-ci`。
- `build` / `build:min` 或等价本地安装前置 gate 能阻断 mainline/wiki/manifest 漂移，不能只依赖远端 CI。
- `metadata-center-manifest.yml` 与 function map、mainline call map、wiki node IDs 有机器校验。
- wiki / mainline call map 的 chain-local node IDs 与 step IDs 有独立机器校验，不只靠 manifest token 命中。
- wiki HTML 有 repo 内正式渲染产物，并补浏览器级 render smoke，至少验证 Mermaid 非空、无 console error。
- 瘦身阶段只删除已证明的死代码、零消费者 export、重复 wrapper、stale doc/gate/script 引用；功能行为和真实传输 payload 保持语义等价。

## 2026-06-17 当前收口证据

已完成：

- `verify:architecture-review-surface-light` 已接入 `build` / `build:min`，位置在 `tsc` 前。
- `verify:architecture-review-surface` 已接入 `verify:architecture-ci`。
- `verify:architecture-ci-longtail` 已接入 `verify:architecture-ci`。
- `verify:client-response-internal-carrier-surface` 已接入 `verify:architecture-ci`，静态锁定 client-visible response/SSE 层只有 `handler-response-common.ts` 与 `responses-response-bridge.ts` 允许显式识别 `__routecodex*` / `__rt` / `response.metadata`；`__sse_*` 在该层必须保持 0。
- `verify:architecture-custom-payload-carrier-runtime-manifest` 已接入 `verify:architecture-ci-longtail`，静态锁定 `docs/architecture/custom-payload-carrier-runtime-manifest.yml` 与当前 runtime 命中集合一致，不允许新增未分类热区或保留已失效 manifest 项。
- `verify:architecture-custom-payload-carrier-owner-queryability` 已接入 `verify:architecture-ci-longtail`，静态锁定 `routecodex_prefix` / `response_metadata` 不得再出现 `missing-owner` 或 `missing-verification`，且 `sse_prefix` runtime files 必须保持 `0`。
- `custom-payload-carrier-runtime-manifest.yml` 现已继续锁定每个 runtime 热区条目的 `owner_queryability` 与 `verification_state` baseline，避免已有 `unique-owner` 文件回退成 `ambiguous-owner` / `missing verification` 而不被 longtail 报警。
- `verify:build-script-tiering` 已接入 `verify:architecture-ci-longtail`，静态锁定：
  - `build:dev` / `build:dev:full` 只能通过 `npm run build` 进入 canonical build 链；
  - `install:global` / `install:release` 只能通过各自 shell installer；
  - `scripts/install-global.sh` / `scripts/install-release.sh` 内部必须走 `npm run build:min`，不得绕开 review-surface/function-map 轻量前置链。
- `verify:function-map-build-wiring` 已加锁：后续若移除 build/min 的 review surface light，或移除 architecture-ci 的 review surface / longtail，会直接失败。
- `verify:architecture-mainline-node-id-consistency` 已接入 `verify:architecture-review-surface-light`，且 `verify:function-map-build-wiring` 已加锁：若 review surface light 移除此 gate，会直接失败。
- `verify:function-map-build-wiring` 已继续加锁：若 `verify:architecture-ci-longtail` 移除 `verify:build-script-tiering`，会直接失败。
- `verify:function-map-build-wiring` 已继续加锁：若 `verify:architecture-ci-longtail` 移除 `verify:architecture-custom-payload-carrier-owner-queryability`，会直接失败。

已验证：

- `npm run verify:architecture-review-surface` PASS。
- `npm run verify:architecture-ci-longtail` PASS。
- `npm run verify:function-map-compile-gate` PASS。
- `npm run verify:architecture-mainline-mermaid-sync` PASS。
- `git diff --check` PASS。
- 2026-06-18 continuation：
  - `npm run verify:responses-handler-single-bridge-surface` PASS。
  - `npm run verify:architecture-ci` PASS。
  - `npm run build:min` PASS。
  - `npx tsc --noEmit --pretty false` PASS。
  - `git diff --check` PASS。
  - `src/server/handlers/handler-response-utils.ts::hasSsePayload` 已物理删除，`chat-handler.ts` / `messages-handler.ts` / `responses-handler.ts` 改为直接判 `result.sseStream !== undefined`，`handler-utils.ts` 不再转发该 facade。
  - `src/server/utils/finish-reason.ts::deriveFinishReasonWithVisibleSuccessFallback` 已物理删除；`handler-utils.ts` 与 `src/server/runtime/http-server/index.ts` 改为直接使用 `deriveFinishReason(...)`，`verify:architecture-deleted-path` 已新增旧符号防复活规则。
  - 定向验证补齐：`tests/server/utils/finish-reason.spec.ts`、`tests/server/utils/finish-reason.visible-success.spec.ts`、`tests/server/handlers/responses-handler.submit-tool-outputs.responses-provider.spec.ts`、`tests/server/handlers/responses-handler.submit-tool-outputs.sse-error.spec.ts` PASS。
- 继续复核（不触碰并行 payload/SSE 内部字段清理实现）：
  - `npm run verify:architecture-mainline-call-map` PASS。
  - `npm run verify:architecture-wiki-sync` PASS。
  - `npm run verify:architecture-wiki-html-sync` PASS。
  - `npm run verify:architecture-manifest-sync` PASS。
  - `npm run verify:architecture-mainline-node-id-consistency` PASS。
  - `npm run verify:architecture-wiki-browser-smoke` PASS，Chrome 检查 14 个 HTML wiki 页面。
  - `npm run verify:architecture-ci-longtail` PASS。
  - `npm run verify:function-map-compile-gate` PASS。
  - `npm run verify:architecture-mainline-mermaid-sync` PASS。
  - `git diff --check` PASS。
  - `metadata.center.mainline` 当前不再是“后半段全 pending”：
    - `mtc-04` 已 anchored 到 `resolveRequestExecutorPipelineAttempt` 的真实 provider-observation 写边；
    - `mtc-05` 已 anchored 到 `resolveResponsesConversationPersistInputsForHttp -> readRuntimeRequestTruthIdentifiers()` 的真实 request-truth read 边；
    - `mtc-06` 已 anchored 到 `buildServerToolAdapterContext -> readRuntimeServerToolProjection()` 的真实 servertool projection read 边；
    - `mtc-07` 已落到 `metadata-center.ts::releaseMetadataCenterForHttpResponse -> MetadataCenter.markReleased` 的真实 anchored binding；JSON closeout、SSE finish/close、SSE bridge-error cleanup 已共用这条 closeout/release owner。
  - 当前 worktree 重新取证：
  - `npm run verify:architecture-review-surface-light` PASS。
  - `npm run verify:architecture-ci` PASS。
  - `npm run build:min` PASS。
  - `npm run verify:client-response-internal-carrier-surface` PASS。
  - `npm run verify:architecture-custom-payload-carrier-owner-queryability` PASS。
  - `npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS。
  - `node scripts/architecture/verify-build-script-tiering.mjs` PASS。
  - `node scripts/architecture/verify-function-map-build-wiring.mjs` PASS。
  - `npm run audit:function-map-canonical-builder-spread` PASS，当前 `features_with_multi_file_canonical_builders=14`。
  - `npm run verify:architecture-ci` 首次复跑暴露真实 review-surface 漂移：
    - `vr.route_selection` 的 canonical node id `VrRoute04SelectedTarget` 被写进了 forbidden host path `src/server/runtime/http-server/executor/request-executor-pipeline-attempt.ts` 的本地 `MetadataCenter` writer `stage`
    - 已修为局部 observation 标签 `request_executor_pipeline_target_observation`
    - 修后 `npm run verify:architecture-forbidden-path-growth` PASS，`npm run verify:architecture-ci` PASS
  - `docs/architecture/custom-payload-carrier-runtime-manifest.yml` 当前分桶真相：
    - `__routecodex*`: `payload_side_channel=10`、`local_runtime_marker=6`、`guard_surface=5`、`contract_or_test_surface=4`
    - `response.metadata`: `guard_surface=1`、`local_runtime_marker=1`、`contract_or_test_surface=2`
  - 同一 manifest 现在还机器编码了处置轨道，防止后续把不同 residue 当成同一类问题清理：
    - `payload_side_channel -> side_channel_migration`
    - `guard_surface -> guard_lock`
    - `local_runtime_marker -> local_marker_rename`
    - `contract_or_test_surface -> contract_boundary_only`
  - `verify-custom-payload-carrier-containment.mjs` 现已不再手写第二份 runtime allowlist，而是直接消费 `custom-payload-carrier-runtime-manifest.yml`；containment / manifest 不再双维护。
  - `audit:custom-payload-carriers` 现也直接输出 `runtime-category` / `runtime-resolution` 分布，避免把 `25` 个 runtime 文件误当成同一类问题。
  - manifest 现已再细分 `semantic_family`，当前 machine-readable 结果：
    - `routecodex_prefix.request_route_control = 9`
    - `routecodex_prefix.response_followup_semantics = 3`
    - `routecodex_prefix.request_route_control_contract = 4`
    - `routecodex_prefix.client_response_guard = 1`
    - `routecodex_prefix.request_entry_guard = 1`
    - `routecodex_prefix.daemon_admin_local_marker = 1`
    - `routecodex_prefix.response_metadata_protocol_guard = 1`
    - `routecodex_prefix.provider_runtime_local_marker = 5`
    - 其中 `executor-metadata.ts` 与 `servertool-followup-metadata.ts` 已确认只是 request-route-control 的 strip/guard surface，不再计入 `payload_side_channel`。
    - `request-executor-response-inspect.ts::readServerToolFollowupSource` 也已作为零 runtime consumer helper 物理删除，不再算作 `response_followup_semantics` runtime residue。
    - 这使后续 side-channel 清理可以按“真实 request-route control writer”与“response followup semantics”两条主线分开推进，而不是继续把 `payload_side_channel=10` 当成和 guard surface 混在一起的 residue。
  - 同一 manifest 当前还锁定 owner/queryability baseline：
    - `__routecodex*`: `unique-owner=20`、`ambiguous-owner=5`、`missing-verification=0`
    - `response.metadata`: `unique-owner=4`、`ambiguous-owner=0`、`missing-verification=0`
  - `docs/architecture/verification-map.yml` 已把以下 runtime 热区补进最小验证栈，避免 payload carrier 清理继续靠 grep：
    - `src/providers/core/runtime/http-request-executor.ts`
    - `src/providers/core/runtime/provider-request-header-orchestrator.ts`
    - `src/providers/core/runtime/transport/oauth-header-preflight.ts`
    - `src/server/handlers/handler-utils.ts`
  - 同步后 `custom-payload-carrier-runtime-manifest.yml` 已把上述四项 `verification_state` 从 `missing` 收到 `present`
  - 修后复验：
    - `npm run audit:custom-payload-carrier-owner-queryability` PASS，`__routecodex*` 当前 `missing-verification=0`
    - `npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
    - `npm run verify:architecture-ci-longtail` PASS
    - `npm run verify:architecture-ci` PASS
  - 当前 worktree（你这轮内部字段清理继续推进后）重新复核：
    - `npm run audit:custom-payload-carriers` PASS
    - `__routecodex*`: `runtime=72, test=103, script=16, doc=58`，runtime unique files=`25`
    - `response.metadata`: `runtime=11, test=14, script=5, doc=46`，runtime unique files=`4`
    - `npm run audit:custom-payload-carrier-owner-queryability` PASS，`__routecodex*` 当前 `unique-owner=20`、`ambiguous-owner=5`、`missing-owner=0`、`missing-verification=0`
    - `response.metadata` 当前 `unique-owner=4`、`ambiguous-owner=0`、`missing-owner=0`、`missing-verification=0`
    - `src/server/runtime/http-server/executor/provider-response-converter.ts::buildBridgeProviderResponseSeed(...)` 已移除 `response.metadata` bridge seed spread；stream-only bridge seed 仅保留 `sseStream/status/headers`。
    - `npm run verify:architecture-custom-payload-carrier-runtime-manifest` PASS
    - `node scripts/architecture/verify-custom-payload-carrier-containment.mjs` PASS
    - `npm run verify:function-map-compile-gate` PASS
    - `npm run verify:architecture-ci-longtail` PASS
    - `npm run verify:architecture-wiki-browser-smoke` PASS
    - `npm run verify:architecture-mainline-mermaid-sync` PASS
    - `npm run verify:architecture-forbidden-path-growth` PASS
    - `npm run verify:architecture-adjacent-builder-naming` PASS

新增审计发现（已由当前 worktree focused tests 证明收口）：

- `assertClientResponseHasNoInternalCarriers(...)` 现在已对“非 `response` / `response.*` 协议形状”的顶层 `metadata` 做 fail-fast。
- direct same-protocol `event: response.metadata` 仍允许普通 provider metadata 透传，但一旦 metadata 内含 `__routecodex*` / `__rt*` / internal control keys` 仍必须 fail-fast。
- 已验证：
  - `tests/red-tests/server_sse_guard_e2e.test.ts` PASS
  - `tests/server/handlers/handler-response-sse-frame-metadata-guard.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/responses-response-bridge.direct-sse-metadata-guard.spec.ts` PASS
  - `tests/modules/llmswitch/bridge/responses-response-bridge.direct-json-protocol-guard.spec.ts` PASS

当前剩余非 blocker 缺口：

- 这条 slice 后续已补跑真实 install/live：
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_INSTALL_INPLACE_BUILD=1 ROUTECODEX_BUILD_RESTART_ONLY=1 ./scripts/install-global.sh`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH routecodex --version` => `0.90.3105`
  - `routecodex restart --port 5555` / `routecodex restart --port 5520`
  - `curl -s http://127.0.0.1:5555/health` / `:5520/health` => `ready=true pipelineReady=true version=0.90.3105`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/tests/stopless-5555-live-probe.mjs` PASS
  - 仍保留的事实是：`install-global.sh` 在 snapshot refresh 后可能尾部空转，不能把“脚本未退出”直接等同于“安装失败”；真实结论要看 CLI 版本、显式 restart、health 与 live probe。
- `verify-no-custom-payload-carriers` 当前是“已知高风险 token denylist”，不是 generic `__routecodex*` / `__sse_*` 前缀防复活 gate；它当前也不扫描 `tests` / `scripts` / `docs`。这对 review-surface 绿灯足够，但对 Jason 最新“所有非标准 payload 字段都要锁死”规则还不是最终形态。
- 新增的 `verify:client-response-internal-carrier-surface` 只锁 client-visible response/SSE projection 层的前缀认知面，不等于 runtime 全局 `__routecodex*` 前缀清零；provider/runtime 内部 marker 去前缀仍要等 Jason 的实现线与后续 containment 审计收口。
- 新增的 runtime manifest 也不是 prefix 清零 gate；它的作用是把 remaining runtime hits 变成可查询的语义分桶，后续才能按 `payload_side_channel -> MetadataCenter/runtime side-channel`、`local_runtime_marker -> typed local field` 分别清理，而不是继续把 26 个 runtime 文件当成同一类问题。
- runtime manifest 现在还额外锁了 machine-readable `resolution track`；这能防止后续把 `guard_surface` 或 `local_runtime_marker` 误归为 payload 清理对象，但它仍不是 prefix 清零 gate，本身不证明 runtime 已完成字段迁移。
- runtime manifest 现在也锁了 `semantic_family`；它能证明“剩余 side-channel 到底是哪条主线的语义”，但仍不证明这些字段已经迁离 payload truth，本身不能替代实际 runtime 清理。
- baseline 里仍保留的 `ambiguous-owner` 主要都在 Rust crate broad-owner 区；这说明当前下一阶段更高价值的工作不是继续加新 deny token，而是把 Rust broad-owner 带拆成更窄的真实 owner，尤其是 `payload_side_channel` 那 10 个文件里仍落在 Rust broad owner 的部分。
- `audit:function-map-canonical-builder-spread` 已证明这批 broad owner 不是简单 map 噪音：
  - `vr.route_selection`
  - `virtual_router.primary_exhausted_to_default_pool`
  - `vr.provider_forwarder_runtime`
  - `hub.metadata_boundary`
  - `hub.response_post_servertool_client_projection`
  - 这些 feature 的 canonical builders 客观分布在多个文件；直接收窄 `owner_module` 会破坏 compile gate 的真实性。
  - 因此下一步 owner/queryability 收口必须走 truthy sub-feature split，而不是伪 file-owner 收窄。
- `metadata.center.mainline / mtc-03` 当前仍有一个 review-surface truth gap：
  - 当前 first-batch 实际槽位已可从源码证实，不应再只写成泛化描述：
    - `routeHint`, `routeName`, `routeId`, `providerProtocol`
    - `retryProviderKey`, `preselectedRoute`
    - `serverToolFollowup`, `serverToolFollowupSource`, `stoplessGoalStatus`
    - `stopMessageEnabled`, `stopMessageExcludeDirect`
  - 本轮 `metadata-center.ts` / `request-truth-readers.ts` 的 `runtimeControl` plumbing 已落地，machine-readable manifest 也已同步到 first-batch slots
  - 所以 review-surface 的下一执行 slice 已前移为：先动 `request-executor-attempt-state.ts` 这类窄 writer，再收更宽的 entry shell / followup materializer

## 范围与边界

In scope：

- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/metadata-center-manifest.yml`
- `docs/architecture/wiki/*.md`
- `docs/architecture/wiki/html/*.html`
- `scripts/architecture/*mainline*`
- `scripts/architecture/*wiki*`
- `scripts/architecture/*manifest*` 新增或强化脚本
- `package.json` architecture/build gate wiring
- Hub Pipeline / metadata center / responses bridge 相关清理候选审计
- 既有瘦身计划：`docs/goals/hub-pipeline-slimming-no-function-loss-plan.md`
- 既有 mainline 计划：`docs/goals/mainline-call-map-closeout-plan.md`
- 既有 longtail 计划：`docs/goals/function-map-longtail-closeout.md`

Out of scope：

- 不改变 provider runtime 行为。
- 不改变 Virtual Router selection/health/quota 语义。
- 不改变 direct/provider passthrough 职责边界。
- 不做真实 payload 裁剪或语义改写来换取提速。
- 不做 fallback / 降级 / 双路径补偿。
- 不为了行数拆文件；只有能删除重复语义或收缩 owner surface 才改。

## 设计原则

- 先修红 gate，再做瘦身；gate 不可信时禁止大规模清理。
- 先 owner，再 mainline，再 wiki/manifest；不能靠 grep 和记忆决定改动落点。
- mainline edge 只能描述相邻阶段；一条 edge 只能有一个真实 caller/callee。
- `binding pending` 必须显式：要么没有 caller/callee，要么 caller/callee 仍必须能被校验；禁止 pending 藏 stale symbol。
- wiki 是 review surface，不是真源；Markdown/HTML 必须由 map/manifest 生成或被 sync gate 校验。
- manifest 是机器消费面；node IDs 必须与 wiki/mainline call map 共用，不允许第二套命名。
- 瘦身只处理已证明无消费者、重复 owner、stale reference、错误实现；不做功能变更。

## 技术方案

### Phase 1: 修复当前红 gate

当前已知红项：

- `npm run verify:architecture-mainline-call-map` 失败：
  - `metadata.center.mainline/mtc-01` 使用不可匹配 symbol `MetadataCenter.writeRequestTruth`。
  - `metadata.center.mainline/mtc-02` 把 `buildResponsesPipelineMetadataForHttp / attachResponsesRequestContextToResultForHttp` 塞进单个 caller field。
  - pending edge 中存在 stale symbol `backfillAdapterContextSessionIdentifiersFromEntryOriginRequest`。
- `npm run verify:architecture-wiki-sync` 因 mainline call map 无法 render。
- `npm run verify:architecture-wiki-html-sync` 失败：`metadata-center-mainline-source.html` 与 Markdown 不同步。
- `npm run verify:architecture-ci-longtail` 失败：`metadata:runtime` 跨 family overlap。

动作：

1. 修正 `mainline-call-map.yml`：
   - `mtc-01` callee 改为真实 symbol 或调整 validator 支持 class method 符号格式。
   - `mtc-02` 拆成两条相邻 edge，或改为单一真实 caller/callee，不允许 slash 合并。
   - pending edge 删除 stale caller/callee，或把可验证部分移动到 split binding。
2. 强化 `mainline-call-map-lib.mjs`：
   - pending edge 禁止携带未校验 caller/callee。
   - 若 pending edge 保留 caller/callee，必须校验 symbol/file 存在。
   - class method 写法要有明确支持规则，不能靠字符串凑。
3. 重新生成 wiki：
   - `npm run render:architecture-mainline-mermaid`
   - `npm run render:architecture-wiki-pages`
   - `npm run render:architecture-wiki-html`
4. 清理 duplicate-owner longtail：
   - 明确 `metadata.center_mainline`、`servertool_stopless_cli_continuation`、`stage_timing_observation` 三者 owner 语义。
   - summary/owner_scope 使用可区分命名，必要时补 explicit allow rule，禁止用宽松 allowlist 掩盖真重叠。

### Phase 2: 锁住 review surface 不漂移

动作：

1. 新增 `verify:architecture-review-surface`：
   - `verify:architecture-mainline-call-map`
   - `verify:architecture-mainline-node-id-consistency`
   - `verify:architecture-wiki-sync`
   - `verify:architecture-wiki-html-sync`
   - `verify:architecture-manifest-sync`
   - `verify:architecture-wiki-browser-smoke`
2. 新增 manifest sync gate：
   - 解析 `metadata-center-manifest.yml`。
   - 校验 `lifecycle_id` 存在于 `mainline-call-map.yml`。
   - 校验 `node_ids` 与该 chain edges 的 from/to node 集合一致或显式标记允许差异。
   - 校验 `owner_feature_id` 存在于 `function-map.yml`。
   - 校验 `entrypoint.wiki_page` 存在，且 wiki required tokens 包含对应 lifecycle/node IDs。
   - 校验 manifest `required_gates` 包含真实 package scripts。
3. 新增 wiki browser smoke：
   - 用 Playwright/Chromium 打开 `docs/architecture/wiki/html/*.html`。
   - 等待 Mermaid 渲染完成。
   - 断言每页无 console error、至少一个核心页面图不空白、正文存在 canonical source。
4. Gate wiring：
   - `verify:architecture-ci` 接入 review surface。
   - `build` / `build:min` 或安装前置链至少接入 review surface 的轻量子集，防止本地构建绕过 mainline/wiki 漂移。
   - 清绿后评估是否把 `architecture-ci-longtail` 纳入主 CI。

### Phase 3: 功能不变的代码瘦身审计

执行前置条件：

- Phase 1/2 gate 全绿。
- `function-map` / `mainline-call-map` 能定位改动 owner。
- 有定向验证栈和 deleted/residue gate。

审计对象：

- Hub Pipeline TS wrappers / barrels / thin facade。
- Responses bridge / SSE bridge 的 zero-consumer helper 与重复 facade。
- metadata center 迁移后遗留 flat merge/backfill residue。
- stale tests/scripts/docs references。
- 生成产物、旧链路、已删除 provider/旧 stage 复活面。

动作规则：

- 先列候选表：symbol/file、consumer count、owner feature、能否删除、风险、验证。
- 只删除无 runtime/test/script consumer 且非 canonical builder 的对象。
- 有消费者但重复的 wrapper，先合并到唯一 owner，再物理删除旧 wrapper。
- TS 侧语义若属于 Rust owner，先补 Rust/native test，再把 TS 收缩为 fail-fast thin shell。
- 每个删除补 residue gate，证明旧文件/旧 symbol 不可复活。

## 风险与规避

| 风险 | 规避 |
| --- | --- |
| 为了清 gate 改弱 validator | 先加红测证明旧问题会红，再修实现让它绿 |
| mainline map 变成伪完整 | pending 只能显式，anchored 必须真实 symbol/file |
| manifest 成为第二份真源 | manifest 只消费同一批 node IDs，并由 sync gate 校验 |
| browser smoke 依赖网络 Mermaid CDN 不稳定 | 优先本地可用时走本地 Mermaid；否则 smoke 标记明确环境要求，不能替代文本 sync gate |
| 瘦身误删功能 | 每个候选先 consumer count + owner map + focused test；不确定则 defer |
| 本地 build 过重 | review-surface 分轻量/完整两档，安装链至少跑轻量挡漂移 |

## 测试计划

架构 review surface：

- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-node-id-consistency`
- `npm run verify:architecture-wiki-sync`
- `npm run verify:architecture-wiki-html-sync`
- `npm run verify:architecture-ci-longtail`
- `npm run verify:architecture-ci`
- 新增：`npm run verify:architecture-manifest-sync`
- 新增：`npm run verify:architecture-review-surface`
- 新增：`npm run verify:architecture-wiki-browser-smoke`

功能 map / build：

- `npm run verify:function-map-compile-gate`
- `npm run build:min`
- `git diff --check`

瘦身定向：

- `node --experimental-vm-modules ./node_modules/.bin/jest tests/sharedmodule/hub-pipeline-stage-residue-audit.spec.ts --runInBand`
- 受影响 feature 的 `verification-map.yml` required tests。
- 若影响 runtime/entry/server behavior，必须补真实入口 smoke 或旧样本 replay。

## 实施步骤

1. 记录当前红 gate 输出到 `note.md`。
2. 修正 mainline call map 的 metadata center edge 绑定。
   - 当前阶段不追求把“尚未成为 first-class family 的语义”伪装成已完成 family migration；只有在 caller/callee/read/write helper 都已真实存在时才升到 `anchored`。
3. 强化 pending edge validator，补红测或 fixture 证明 stale pending symbol 会被拦。
4. 重新生成 wiki Markdown 与 HTML，跑 sync gate。
5. 修复 duplicate-owner longtail，跑 longtail gate。
6. 新增 manifest sync gate，接入 review surface。
7. 新增 wiki browser smoke，接入 review surface。
8. 调整 package scripts，让本地 build/install 前置链不再绕过 review surface。
9. 在 gate 全绿后执行瘦身审计，输出候选表。
10. 按候选表逐项删除/合并/下沉，功能不变，每项补 residue gate。
11. 跑完整验证矩阵，必要时做 live/replay。
12. 更新 `note.md`，已验证长期结论追加 `MEMORY.md`；若形成可复用方法，更新 `.agents/skills/rcc-dev-skills` references。

## 完成定义

- 当前 architecture review surface 红项全部清零。
- 本地 build/install 与 CI 都能阻断 mainline/wiki/manifest 漂移。
- manifest、wiki、mainline call map 共用 node IDs，并被机器校验。
- Hub Pipeline 瘦身审计报告完成，候选项均有 owner、consumer count、处置结论、验证路径。
- 已执行的瘦身改动不改变功能、不裁剪真实 payload、不引入 fallback。
- 删除/合并后的旧路径、旧 symbol、旧 wrapper 有 gate 防复活。
