# V3 Entry Protocol Endpoint Binding Parallel Goals Plan

## 1. 目标与验收标准

把 V3 第一段缺口收口为一个中性、可审计、可并行执行的入口协议与入口 endpoint 绑定面：

- Config 发布唯一 entry protocol binding registry。
- Server 只消费 registry 绑定 endpoint 与执行投影，不再复制 endpoint/protocol 表。
- Map、manifest、wiki、gate、red fixtures 锁住绑定面，并审计 A/B 两个实现 worker 的集成一致性。

验收标准：

- `responses`、`anthropic`、`openai_chat` 三个已存在 runtime endpoint 都有显式 binding。
- `gemini` endpoint 只允许显式 `pending_not_implemented`，不得伪装成 runtime 已实现。
- Server 不再通过 raw path 分支或 `endpoint_protocol()` 复制协议表。
- `docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml`、function/resource/mainline/verification map、wiki/HTML、package scripts、verifier、red fixture 同步。
- `npm run verify:v3-entry-protocol-endpoint-binding` 与 `npm run test:v3-entry-protocol-endpoint-binding-red-fixtures` 最终通过。
- 本目标不声明 live/global/prod 可用，不实现 Gemini runtime，不做 runtime 归一。

## 2. 范围与边界

In scope：

- V3 Config entry protocol binding registry contract。
- V3 Server endpoint binding consumer。
- V3 entry binding map/gate/review surface 与集成审计。
- Controlled/source-level tests、red fixtures、architecture gates。
- `.agent-collab` claim/evidence/handoff。

Out of scope：

- Gemini runtime/provider transport 实现。
- runtime 归一化重构。
- live config、`~/.rcc`、credentials、install、restart、release/global deployment。
- OpenAI Chat、Anthropic、Responses runtime 内部语义重写。
- provider-specific 分支、fallback、隐式 foundation pending。

## 3. 设计原则

- 中性命名：统一使用 `V3 Entry Protocol Endpoint Binding`。
- Config 是 binding registry 的唯一声明真源。
- Server 只消费 registry，不复制协议表，不用 raw path 分支绕过 binding。
- `pending_not_implemented` 是显式状态，不是 fallback。
- Map/gate 先锁合同，runtime 能力实现另开目标。
- 三 worker 通过 `.agent-collab` 只按语义 claim 协作，禁止覆盖无关 dirty worktree。

## 4. 技术方案与文件清单

### Worker A — Registry/contract truth

目标 feature claim：

- `feature_id:v3.entry_protocol_registry_contract`

主要文件：

- `v3/crates/routecodex-v3-config/src/types.rs`
- `v3/crates/routecodex-v3-config/src/validate.rs`
- `v3/crates/routecodex-v3-config/tests/*`
- 必要时补充 Config-focused manifest/source anchor 文档。

交付内容：

- `V3EntryProtocolBinding`
- `V3EntryProtocolImplementationStatus`
- `lookup_v3_entry_protocol_binding`
- closed protocols：`responses`、`anthropic`、`openai_chat`、`gemini`
- endpoint patterns：
  - `/v1/responses`
  - `/v1/messages`
  - `/v1/chat/completions`
  - `/v1beta/models/:model/generateContent`
- statuses：
  - implemented：`responses`、`anthropic`、`openai_chat`
  - `pending_not_implemented`：`gemini`

### Worker B — Server binding consumer

目标 feature claim：

- `feature_id:v3.entry_protocol_endpoint_binding_server_consumer`

主要文件：

- `v3/crates/routecodex-v3-server/src/lib.rs`
- `v3/crates/routecodex-v3-server/tests/*`
- 必要时补充 Server-focused source anchor 文档。

交付内容：

- Server endpoint table 只从 Config registry binding 消费协议/状态/执行投影。
- 删除或改掉 `endpoint_protocol()` 这类 duplicate registry。
- 删除 raw path runtime branch 对 registry 的 bypass。
- Gemini endpoint 返回显式 typed `pending_not_implemented` 投影，不进入已实现 runtime，也不隐式 foundation fallback。
- `responses`、`anthropic`、`openai_chat` endpoint 仍绑定既有 runtime owner，不改其内部语义。

### Worker C — Map/gate/review surface + integration audit

目标 feature claim：

- `feature_id:v3.entry_protocol_endpoint_binding_review_gate`

主要文件：

- `docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-verification-map.yml`
- `docs/architecture/wiki/v3-entry-protocol-endpoint-binding.md`
- `docs/architecture/wiki/html/v3-entry-protocol-endpoint-binding.html`
- `scripts/architecture/architecture-wiki-lib.mjs`
- `scripts/architecture/verify-v3-entry-protocol-endpoint-binding.mjs`
- `scripts/tests/v3-entry-protocol-endpoint-binding-red-fixtures.mjs`
- `package.json`

交付内容：

- manifest/wiki/map/gate/review surface 锁住四个 protocol endpoint binding。
- verifier 能同时检查 map/gate/docs、Config registry source、Server consumer source。
- red fixtures 覆盖缺 Gemini binding、未知 protocol、资源进 provider/client body、Server bypass/duplicate registry。
- 审计 Worker A/B evidence 与 diff，不抢 A/B runtime/config/server owner。

## 5. 风险与规避

- 风险：把 Gemini pending 误报为 runtime 已实现。
  - 规避：manifest、verification map、wiki、server test 均必须写 `Gemini pending_not_implemented`。
- 风险：Server 为了快在 path 分支里复制 registry。
  - 规避：gate 扫描 `endpoint_protocol()` 与 raw path branch；红测锁复活。
- 风险：Config 与 Server 各自维护 endpoint/protocol 表。
  - 规避：Server 只调用 registry lookup；unknown/missing binding fail-fast。
- 风险：C worker verifier 先红导致误报失败。
  - 规避：记录 baseline red；A/B complete 后再要求 verifier/red fixture green。
- 风险：多 worker 覆盖 dirty worktree。
  - 规避：每个 worker 精确 claim，定向 patch，证据写入自己的 `.agent-collab/runs/<run_id>/evidence.jsonl`。

## 6. 测试计划

Worker A focused：

- Config unit/fixture tests for registry compile, duplicate/unknown protocol rejection, deterministic manifest projection。
- `cargo test -p routecodex-v3-config`
- `npm run verify:v3-entry-protocol-endpoint-binding` may remain red until B/C complete; record exact remaining failures.

Worker B focused：

- Server tests for `/v1/responses`、`/v1/messages`、`/v1/chat/completions` binding to implemented owners。
- Server test for `/v1beta/models/:model/generateContent` returning typed `pending_not_implemented`。
- Negative test for unknown endpoint / missing binding / duplicate path bypass。
- `cargo test -p routecodex-v3-server`
- `npm run verify:v3-entry-protocol-endpoint-binding` may remain red until A/C complete; record exact remaining failures.

Worker C focused：

- `npm run verify:v3-entry-protocol-endpoint-binding`
- `npm run test:v3-entry-protocol-endpoint-binding-red-fixtures`
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run verify:architecture-wiki-sync`
- `npm run verify:architecture-wiki-html-sync`
- `git diff --check`

Integration closeout：

- A/B/C evidence audited.
- New verifier green.
- Red fixtures green.
- Architecture review confirms no fallback, no provider-specific branch in Hub/VR, no metadata/debug payload leakage, no live/global/prod claim.

## 7. 实施步骤

1. 三个 worker 各自刷新 `.agent-collab`，创建/续租自己的 semantic claim。
2. Worker A 先锁 Config registry contract，提交 handoff evidence。
3. Worker B 并行准备 Server consumer；若 A interface 未落地，只记录 blocked tokens，不伪造 registry。
4. Worker C 并行落 map/wiki/manifest/verifier skeleton，先记录 baseline red。
5. A 完成后 B 接真实 registry lookup，删 duplicate path/protocol logic。
6. A/B 完成后 C 跑 integration verifier/red fixtures，做 architecture review。
7. 所有 focused gate 绿后，再进行定向 stage/commit；未完成 worker diff 不混入。

## 8. 完成定义

- 三个 worker 的 claim/evidence 都可查。
- Config registry 是 binding 真源。
- Server endpoint binding 只消费 registry。
- map/manifest/wiki/gate 全部同步。
- `verify:v3-entry-protocol-endpoint-binding` 和 red fixtures 通过。
- 汇报明确：entry endpoint binding complete；runtime protocol implementation is separate；Gemini pending_not_implemented；live/global/prod not claimed。
