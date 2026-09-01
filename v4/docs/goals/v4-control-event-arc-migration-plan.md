# V4 Control Event / Immutable Arc Migration Plan

status: design
owner_feature_id: v4.control_event_arc_data_ownership_migration
owner_module: routecodex-v4-governance

## 1. Objective and acceptance

在独立 branch/worktree 中，把 V4 的控制面从同步散落状态推进为 scope-bound typed control event + owner-acknowledged decision；把业务数据面推进为 immutable `Arc` ownership，保持固定 pipeline、Error chain、continuation immutable interval、plugin/lifecycle 语义不变。

验收：控制事件有唯一 producer/consumer/owner、scope、sequence、causality、delivery、ack 与 terminal contract；诊断事件先完成迁移；业务 request/response/provider raw/wire 共享路径无不必要 deep clone；所有控制/诊断资源仍不能进入 payload；V4 boundary contract、resource/function/mainline/verification maps 与真实代码/gates 一致。

## 2. Scope and boundaries

### In scope

- 建立 `v4-control-event-registry` 与 `v4-data-ownership-registry`，并接入 V4 manifest/build/CI。
- 将 observation、timing、node lifecycle、route-hit、provider-attempt diagnostic 迁移到 typed event 传递。
- 为 immutable request/response/provider raw/provider semantic/wire bytes、compiled manifest、continuation snapshot 建立 `Arc` ownership 与 copy budget。
- 为 control event 增加 request/pipeline/port/session/conversation/attempt scope、sequence、causality、ack、release 与 terminal semantics。
- 在完成证据后，逐层迁移 provider availability/health 与 retry/reroute；最终决策仍由唯一 owner 同步确认。
- 补齐 RED-01..RED-11、event ordering/drop/duplicate/delay/cross-scope、Arc mutation/copy-budget、V3 isolation 与 V4 real-runtime admission gates。

### Out of scope

- 不修改 V3 runtime、V3 配置、V3 安装、V3 live server 或 V3 生产状态。
- 不把普通 `broadcast`/fire-and-forget 当作 routing、health、retry、Error05、continuation 或 lifecycle 的决策真源。
- 不引入 `Arc<Mutex<Value>>`、跨节点 shortcut、第二 runtime、第二 response exit、fallback、silent strip 或 payload cleanup。
- 不在没有证据时把 V4 contract 从 design 直接改为 active。

## 3. Design contract

### Control event

每个事件必须声明：

```text
event_id, event_kind, producer, consumer, owner_node,
request_id, pipeline_id, port, session, conversation, attempt scope,
sequence, causality_id, delivery_policy, ack_required,
terminal, release_point, allowed_edges, forbidden_edges
```

事件总线只负责 typed transport；route selection、health mutation、retry/reroute、Error05、continuation save/restore、client commit、restart handoff 必须由唯一 owner 产生并返回 typed receipt/decision。事件丢失、重复、乱序、延迟、跨 scope、重复 terminal 都必须显式失败或被 owner 拒绝。

### Data ownership

优先使用：

```text
Arc<ImmutableRequest>
Arc<ImmutableResponse>
Arc<ProviderRawResponse>
Arc<ProviderSemantic>
Arc<[u8]>
Arc<CompiledManifest>
```

语义变更只能在相邻 owner 产生新的 immutable value；禁止共享可变 JSON 容器。每个资源登记 owner、reader、writer、mutation owner、clone budget、release point；Arc clone 只减少重复所有权，不得绕过节点转换。

### Existing V4 contract alignment

- `v4/docs/architecture/v4-data-control-plane-boundary.md` 必须从 design 到 active 前完成 RED-01..RED-11 的真实 build/CI 接线。
- `v4/docs/architecture/v4-resource-operation-map.yml` 的 active/anchored 状态必须与实现和 gate 证据一致。
- `v4/docs/architecture/maps/{resource-map,function-map,mainline-call-map,verification-map}.json` 必须同步，禁止只改散文文档。
- `v4/docs/architecture/v4-pipeline-abstraction-model.md` 的六轴模型保持不变；event 属 control/diagnostic side-channel，Arc 数据属 data/information resource。

## 4. Planned ownership and files

- Control contract/registry: `v4/crates/routecodex-v4-control/`, `v4/contracts/`, `v4/docs/architecture/`, `v4/scripts/architecture/`。
- Runtime carrier and adjacent node transitions: `v4/crates/routecodex-v4-runtime/`。
- Error decisions: `v4/crates/routecodex-v4-error/`。
- Data/provider raw and wire ownership: `v4/crates/routecodex-v4-provider/`, `v4/crates/routecodex-v4-standard-plugins/`。
- Lifecycle/admission and cross-scope guards: `v4/crates/routecodex-v4-node-container/`, `v4/crates/routecodex-v4-lifecycle/`。
- Diagnostic event projection only: `v4/crates/routecodex-v4-debug/`。
- Server is transport/projection consumer only: `v4/crates/routecodex-v4-server/`。
- No V3 paths are allowed in the change set.

## 5. Risk controls

- Event ordering/ack race: use per-loop sequence and causality, owner-side monotonic validation, typed terminal receipt。
- Health/routing delay: migrate observation first; health and route decisions stay synchronous until paired tests prove atomic decision semantics。
- Continuation corruption: save/restore remains only at declared Chat Process boundaries; event/Arc layers cannot mutate immutable interval。
- Shared mutation: use immutable types and compile-time ownership; no generic `Value` control carrier。
- Memory retention: bound Arc lifetime by scope/release point; add large payload copy and release tests。
- Contract drift: every registry entry must resolve real symbol/path/edge and run through CI; design status cannot be used as active truth。

## 6. Verification matrix

1. Baseline: V4 isolation, resource/function/mainline/verification maps, active-link and node graph.
2. Red first: RED-01..RED-11 and event/Arc negative fixtures must fail against the pre-change implementation.
3. Unit/module: control event lifecycle, scope, sequence, ack, duplicate/drop/delay/terminal; immutable Arc ownership and mutation rejection。
4. Pipeline black box: request/response/error/config/lifecycle adjacent edges, payload isolation, continuation interval, plugin admission。
5. Build/CI: `npm ci --ignore-scripts`, `npm run verify:ci`, V4 workspace tests, architecture gates, manifest compilation。
6. Runtime admission: build/install isolated `rccv4` canary, `/health`, `/v1/models`, Responses JSON/SSE, failure and disconnect samples。
7. Isolation: prove no V3 source/config/install/log/sample/restart mutation and no V3 call。
8. Review: run AGY Review only after all source/build/install/live evidence is complete; any post-review code change invalidates prior evidence。

## 7. Implementation order

0. Create clean `playground/v4-control-event-arc-<run_id>` worktree from current remote main; record run/claim/actor and preserve unrelated main dirty。
1. Read and bind resource/function/mainline/verification maps; add registries and red tests; prove baseline red without changing runtime semantics。
2. Implement typed event envelope, scope/sequence/causality validator, bounded transport and ack/terminal receipt; migrate diagnostic events only。
3. Implement immutable data carriers and Arc ownership at adjacent boundaries; remove only proven redundant deep copies; add copy-budget/mutation red tests。
4. Re-run module-boundary and payload-isolation self-audit; then migrate provider attempt/availability/health facts one owner at a time。
5. Migrate retry/reroute and lifecycle/continuation decisions only with synchronous owner receipts and paired positive/negative tests。
6. Compile manifest, run full V4 verification, install isolated canary, execute live admission and V3 isolation checks。
7. Run AGY Review; fix findings in a new review cycle; only then merge exact change set, commit/push, and record evidence.

## 8. Definition of done

- No unregistered control event or Arc data resource is used by runtime。
- Event delivery cannot reorder, duplicate, cross scopes, or silently lose terminal control decisions。
- Control never enters normal request/response/provider/client payload；payload never reconstructs control。
- Data ownership is immutable and copy-budget evidence is green；no generic shared mutable payload container。
- V4 boundary contract is active only with real gate evidence；all maps/manifests/source bindings are synchronized。
- V4 CI/build/install/live admission and V3 isolation are green；AGY Review controller PASS；main merge and evidence records are exact。
