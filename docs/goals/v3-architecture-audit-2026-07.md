# V3 架构审计 2026-07-30

## 1. 目标与范围
- 目标：按当前架构规则审计 V3 架构，列问题、按优先级排序、给修复计划、提供 `/goal`。
- 范围：V3 全部 Rust runtime/server/runtime/hub_v1/provider/lifecycle/target/virtual-router/route-classifier/error/debug/config/cli；V3 canonical 文档、machine registry、CI/build 接线、architecture lock。
- 不在范围：V2 历史 llmswitch-core 主线已 closeout；本审计不触发其改动；纯 V2 文档不修。

## 2. 审计方法
- 只读静态证据 + 跑现有 V3 architecture gate，记录实际红/绿。
- 唯一真源链：`resource map -> function map -> mainline call map -> verification map -> wiki/HTML -> CI/test.yml -> source`。
- 不改锁链指纹；如发现 fingerprint drift，按 `auth_required` 标记。
- 不跑 `install:v3 / rccv3 restart / live replay`；这是文档/架构审计，需 Jason 授权才跑 live 验证。

## 3. 已跑的 Gate（实跑结果）

| Gate | 结果 | 关键发现 |
| --- | --- | --- |
| `verify:v3-file-size` | 红 | 9 文件超 ratchet/limit |
| `verify:v3-hub-v1-node-file-topology` | 红 | 3 个 mainline call edge 缺定义 |
| `verify:v3-module-boundaries` | 红 | Server 仍在构造/分类 Error 节点 |
| `verify:v3-resource-map` | 绿 | 91 resources bound |
| `verify:v3-resource-relation-edge-lock` | 绿 | 91 resources, 290 edge flows |
| `verify:v3-mainline-caller-flow` | 红 | `v3.debug_error_foundation.mainline` fingerprint drift |
| `verify:v3-architecture-docs`（umbrella） | 红 | 透传子项红 |
| `verify:v3-rust-only` | 绿 | v3/ 下未发现 JS/TS |
| `verify:v3-stopless-resource-control` | 绿 | |
| `verify:v3-entry-protocol-endpoint-binding` | 绿 | |
| `verify:v3-selected-provider-model-binding` | 绿 | |
| `verify:v3-protocol-conversion-field-parity` | 绿 | |
| `verify:v3-static-hook-registry` | 红 | 非相邻 builder + provider-specific 分支词 + H1 网络连 provider |
| `verify:v3-hub-relay-runtime-closeout` | 红 | 5 处缺失符号 + verification map 缺测试 |

## 4. Findings（按优先级）

### P0-1：Canonical doc 多真源漂移（continuation store=false 语义冲突）
- 证据：
  - `docs/ARCHITECTURE.md:200-205` 写 `store=false` 不保存、不存在恢复权。
  - 项目 AGENTS 当日事实 #7（`store:false` 不得阻止同一 response 的 tool continuation 持久化）。
  - `docs/design/v3-system-definition.md:5` 仍写“before the request pipeline is implemented” + `Relay/continuation/servertool/...` pending，但 `v3-function-map.yml` 多项 Relay 标 `live_5555_verified`、`controlled_json_sse_error_isolation_save_restore_release_verified`。
- 根因：ARCHITECTURE.md 是 V2 时代产物（仍写 `sharedmodule/.../router-hotpath-napi` 为 Rust 真源），与 V3 `docs/design/v3-system-definition.md` 并存造成 canonical 入口歧义。
- 影响：架构变更评审、CI 注释、错误链契约、continuation owner 判定容易引用错误文档。
- 修复：
  1. 在 `docs/ARCHITECTURE.md` 顶部加 V3-index 框，明确 V2-only 与 V3 canonical（v3-system-definition.md）。
  2. 改写 `docs/ARCHITECTURE.md` 的 `store=false` 段为与项目 AGENTS #7 一致的“`store:false` 不得阻止同 response 的 tool continuation 持久化”。
  3. `docs/design/v3-system-definition.md` 顶部加 phase 表，区分 `defined / source implemented / executable / MVP usable / live`；移除 `before the request pipeline` 静态陈述。

### P0-2：Hub v1 sole-entry 与 live runtime 状态割裂（typed skeleton 不能当 active truth）
- 证据：
  - `docs/architecture/v3-function-map.yml`:
    - `v3.hub_pipeline_static_skeleton` = `typed_skeleton_only`
    - `v3.hub_relay_hook_resource_contract` = `contract_only`
    - 多项 Relay = `*_source_slice_only` / `*_gates_only`
    - 同时 `v3.hub_relay_runtime_closeout` = `live_5555_relay_json_sse_verified`
  - `docs/design/v3-system-definition.md:163-165` 仍要求 Hub v1 吸收 P6 + physical deletion of old lifecycle。
  - `verify:v3-static-hook-registry` 红：`Hub v1 contains provider-specific branch vocabulary` + `H1 Hub v1 skeleton must not connect Provider network`。
- 根因：function map 用非枚举自由文本 `runtime_status`，与 system definition 的“唯一 fixed topology”目标语义割裂；缺乏 status enum → 目标态/现状不能机器区分。
- 影响：audit / review surface 不能反映真实 sole-entry；CI 文档可信度低。
- 修复：
  1. function map status 改为枚举：`design | source_implemented | executable | mvp_usable | live_verified | retired`，附 `last_verified_at`、`evidence_refs`。
  2. resource map `binding_status: design` 资源禁止被 runtime 消费；新增 `verify:v3-design-resource-leak` gate。
  3. 在 system definition 加 H1 sole-entry 锁契约：旧 P6 / 旧 hub node 物理删除路径。

### P0-3：核心 V3 architecture gate 未完整接入 CI/build
- 证据：
  - `.github/workflows/test.yml` 跑：`verify:architecture-ci`、`verify:v3-file-size`、`verify:v3-provider-action-gate`、`verify:v3-runtime-timing-observability`、`verify:v3-debug-payload-budget`、`verify:v3-console-request-count-visibility`、`verify:v3-responses-session-admission`、`verify:v3-route-classifier-local-owner`、`verify:servertool-rust-only`。
  - 未在 CI 显式跑：`verify:v3-rust-only`、`verify:v3-hub-v1-node-file-topology`、`verify:v3-mainline-caller-flow`、`verify:v3-architecture-docs`、`verify:v3-module-boundaries`、`verify:v3-resource-map`、`verify:v3-resource-relation-edge-lock`、`verify:v3-static-hook-registry`、`verify:v3-hub-relay-runtime-closeout`、`verify:v3-entry-protocol-endpoint-binding`、`verify:v3-selected-provider-model-binding`、`verify:v3-protocol-conversion-field-parity`、`verify:v3-stopless-resource-control`、`verify:v3-stopless-state-machine-docs`。
  - `verify:v3-rust-only` 仅扫描 `v3/` 下是否存在 JS/TS；不能证明语义 owner / 唯一入口 / import-call graph。
- 根因：CI 是增量接入、缺 umbrella；本次实跑大量 V3 关键 gate 全红 → CI 红绿失真。
- 影响：合并/发布没有 V3 架构真源门禁；AGENTS 22a/20 直接违反。
- 修复：
  1. 新增 `verify:v3-architecture-ci` umbrella（子项必须含：rust-only、file-size、module-boundaries、resource-map、resource-relation-edge-lock、mainline-caller-flow、node-file-topology、static-hook-registry、entry-protocol-binding、selected-provider-model-binding、protocol-conversion-field-parity、stopless-resource-control、stopless-state-machine-docs、hub-relay-runtime-closeout、architecture-docs、hub-pipeline-core-manifests）。
  2. 接入 `.github/workflows/test.yml` 两段矩阵 + release workflow + `build:v3-cli` / `install:v3` 前置。
  3. CI fail 必须 fail build；本地 `make verify` 复用同一入口。

### P0-4：巨型 owner 文件超出 ratchet，跨层逻辑继续聚集
- 实测：
  - `v3/crates/routecodex-v3-server/src/lib.rs` = 10707 行（ratchet 8540）
  - `v3/crates/routecodex-v3-runtime/src/kernel.rs` = 5485 行（ratchet 2919）
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs` = 6432 行（ratchet 7265，绿但接近上限）
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs` = 1673 行（ratchet 1588）
  - `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs` = 2176 行（ratchet 1712）
  - `v3/crates/routecodex-v3-config/src/validate.rs` = 1775 行（ratchet 1705）
  - `v3/crates/routecodex-v3-lifecycle/src/lib.rs` = 3050 行（ratchet 2795）
  - `v3/crates/routecodex-v3-provider-responses/src/transport.rs` = 1763 行（limit 1500）
  - `v3/crates/routecodex-v3-target/src/lib.rs` = 1897 行（limit 1500）
  - `v3/crates/routecodex-v3-virtual-router/src/lib.rs` = 1533 行（limit 1500）
- `verify:v3-file-size` 全红。
- 根因：单一 owner 承担相邻多 node 多 resource 逻辑；缺少按节点/资源/动作的物理切分；ratchet 持续被绕过。
- 风险：note.md 多日 bug 出在 `kernel.rs` / `servertool_hooks.rs` / `responses_relay_runtime.rs` / `server/lib.rs`（SSE closeout、request counter、provider event console、Error05/Direct timing、provider-error prefix、tool identity）。文件越大、上下文越乱，单步定位/红测成本越高。
- 修复：
  1. 严格按相邻节点拆分：`kernel.rs` 按 req_inbound/req_chatprocess/req_outbound/resp_inbound/resp_chatprocess/resp_outbound 切模块；`responses_relay_runtime.rs` 已有 provider_stream_materialization / responses_provider_event_codec 子模块，应继续按 relay_provider_event / relay_provider_request / relay_runtime_decision 拆。
  2. 拆分原则：相邻节点 + 唯一 owner + 不抽泛 utils + 不复制业务逻辑；每 slice 必须有正反白盒/黑盒测试。
  3. `lib.rs` 巨型聚合只能做 mod/pub use；超过 500 行的 pub use 块拆 sub-aggregator。
  4. 每拆一段后必须先在 CI 跑全 V3 architecture 红测，再写 module 文档。

### P0-5：Locked chain fingerprint drift 已发生两次以上
- 证据：`docs/architecture/v3-architecture-audit-locks.yml` 当前 locked `v3.debug_error_foundation.mainline.fingerprint = 5e3f4fc…`，但 verifier 报 current map = `4858bdc…`，`v3-mainline-caller-flow` 红。
- note.md 已记 `v3.debug_error_foundation.mainline` drift 是已知 blocker。
- 根因：lock 字段 `fingerprint` 与 `last_manual_authorization_id` 的 fingerprint 不一致，且 verify 路径直接拿 lock 的旧值比对 → 误报 drift；true root 可能是 lock 自身字段被改但未走 manual authorization。
- 修复：
  1. 不自行改 fingerprint。先 `find . -name "v3-mainline-call-map.yml" -newer docs/architecture/v3-architecture-audit-locks.yml -print` 看 map 是否在 lock 之后漂移。
  2. 若 map 真的变了且未授权 → 立即停止、标记 P0 事件、写 handoff、请求 Jason 决定是接受 / 回滚 / 重新授权。
  3. 长期：在 CI 加 `verify:v3-architecture-lock-fingerprint-provenance`，要求每条 lock 同时存 current_fingerprint 与 last_authorization_fingerprint，并要求 provenance 文件被锁链声明引用。

### P0-6：Server 在构造/分类 Error 节点（`verify:v3-module-boundaries` 红）
- 证据：gate 报错 "Server must project Runtime output and cannot build or classify Error nodes"。
- 根因：server crate 直接做 Error01..Error06 builder 逻辑；这是协议/语义真源层，server 应只做 HTTP 投影。
- 影响：违反 AGENTS 17（pipeline 节点职责硬边界）、AGENTS 21（重复实现物理禁止）。
- 修复：把所有 Error builder/分类搬入 `routecodex-v3-error`；server 只消费 typed Error06 客户端投影。

### P0-7：Hub v1 node file topology 缺定义（mainline call map 红）
- 证据：`v3-responses-provider-event-terminal-merge-01` / `v3-servertool-stopless-resp-01` caller/callee symbol 缺定义。
- 根因：function map 与 mainline call map 的 symbol 同步流程缺少；map 增加新边但未注册 symbol 或 symbol 重命名后未刷新 map。
- 修复：固化 `verify:v3-function-map-symbol-resolution`，要求每 caller/callee symbol 必须在 source 或 tests 中存在；runbook：map 改 → symbol 检查 → CI。

### P1-1：Registry 状态词自由文本 / 现状-目标态无法机器区分
- 证据：`v3-function-map.yml` 出现 47 个 `runtime_status`，大量自由文本（`controlled_runtime_slice_only`、`source_pending_live_replay`、`source_field_parity_focused_gates_only`、`partial_live_provider_replay_verified` 等）。
- `v3-resource-operation-map.yml`：91 resources；83 `anchored`、2 `design`、3 `review_gate`；其中 `v3.web_search_servertool_state_machine` function map = `design_only_not_implemented`；与 `web_search.execution_mode` 设计态同源。
- 根因：自由文本是 phase 渐变过程的妥协，但长期必须收敛。
- 修复：
  1. enum 收敛：`design | source_implemented | executable | mvp_usable | live_verified | retired`。
  2. 必须附 `last_verified_at` ISO8601、`evidence_refs[]`（run_id / RID / 路径）。
  3. `design` 资源禁 runtime 引用；新增 `verify:v3-design-resource-leak`。

### P1-2：module registry / `owned_paths` / import-call graph 覆盖证据不足
- 证据：function map 部分 feature 用宽目录 `allowed_paths`，部分 `owner_crates` 多 owner；尚未见 module registry 全源码一对一 owned_paths 声明。
- 修复：
  1. 在 `docs/architecture/v3-module-ownership-map.yml`（或同源）声明每个 source 文件唯一 owner module；无主文件数量必须趋零。
  2. 解析 Rust `use` / `mod` 调用图，跨模块边必须命中 edge registry 边；未声明即红。
  3. 在 `verify:v3-module-boundaries` 增加子项：用真实 import graph（`cargo metadata --format-version=1` + 解析）做 cross-module edge check，不只是字符串/路径扫描。

### P1-3：SSE/Error05/continuation/console 等资源 map 与 code 实际调用边漂移
- 证据：
  - note.md 多日 bug：`terminal merge` 字段被 stream 覆盖（`resp_chat_process_03_governed.rs` / `responses_provider_event_codec.rs`）。
  - codex 架构 review 报 P0 map drift（terminal merge owner/call edge 缺失）。
  - mainline call map 中 `v3-responses-provider-event-terminal-merge-01` 现仍缺 symbol 定义。
  - 修复要求：terminal fields win + stream only backfill absent keys；测试已加，但 call map edge 仍需补登记。
- 修复：
  1. function map 补 `v3-responses-provider-event-terminal-merge-01` 的 owner/caller/callee 定义。
  2. 给 Error05 → Error06 链加 forward + reverse 红测：success / failure / non-terminal / already-terminal 四态。
  3. 给 Direct SSE passthrough + console keepalive 加正反 fixture。

### P1-4：协议 parity 仍是 `source_field_parity_focused_gates_only`，多 provider 不齐
- 证据：
  - `v3-function-map.yml` 多处 `*_codec_characterization_only`、`source_field_parity_focused_gates_only`。
  - 但 `verify:v3-entry-protocol-endpoint-binding` 绿、`verify:v3-protocol-conversion-field-parity` 绿、`verify:v3-anthropic-relay-runtime-integration` 已 live。
  - 风险：Anthropic OpenAI/Gemini 仍 characterization/controlled/live 状态不一致。
- 修复：
  1. 把每个 provider codec 列 phase 矩阵：characterization → controlled → live_5555 → live_cross_port → live_external_sample。
  2. 关闭 characterization 残留；剩余 controlled 限定日期完成。
  3. v3-protocol-conversion-field-parity CI 必须挂 release。

### P1-5：CI 不强制 hub-relay-runtime-closeout
- 证据：`verify:v3-hub-relay-runtime-closeout` 红但 CI 没跑；closeout 是 locked chain 的一部分。
- 修复：把 closeout gate 加进 release workflow；红即拒发。

### P2-1：历史 V2/Rust-only 审计文档易被误用
- 证据：`docs/hubpipeline-migration/AUDIT-RUST-ONLY.md` 是 2026-05 历史报告（12/16 Rust，4 mixed TS）；文件本身标 historical，但会被新人当现状。
- 修复：
  1. 在文件头加 red banner + link 到 V3 system definition。
  2. 不删除（删除需 Jason 授权）。
  3. `verify:architecture-deleted-path` 应扫出 archived-only 文档并加 banner。

### P2-2：evidence freshness 无统一过期策略
- 证据：`last_verified_at` 没强制；许多 live_verified 资源缺证据引用；call map 的 edge 也无 freshness。
- 修复：在 resource map / function map schema 强制 `last_verified_at`；CI 失败若该字段 > 30 天未刷新。

### P2-3：ratchet whitelist 缺少 provenance
- 证据：`config/v3-file-size-policy.json` ratchet 白名单每条只给数字；无 source-of-truth、approval_id。
- 修复：每条白名单加 `approval_id` 引用 Jason manual auth；CI 校验 whitelist 与 lock file 对应。

## 5. 修复计划（phased）

### Phase 0：Truth freeze（不改锁链）
- 写本审计 doc + machine manifest `docs/architecture/reviews/v3-architecture-audit-2026-07.yml`。
- 修 canonical docs（P0-1）但不动 `docs/ARCHITECTURE.md` 的 Rust 真源段落语义；只加 V3-index 框。
- 不改 lock fingerprint；handoff 给 Jason。

### Phase 1：CI / Build 接线
- 新增 `verify:v3-architecture-ci` umbrella。
- 接入 `.github/workflows/test.yml` 两段矩阵 + release workflow + `build:v3-cli` / `install:v3`。
- 让 verify:v3-rust-only 升级为含 import-call graph 校验。

### Phase 2：Registry 收敛
- enum status + last_verified_at + evidence_refs。
- 禁止 design 资源被 runtime 消费；新 gate `verify:v3-design-resource-leak`。

### Phase 3：Sole-entry proof
- 红测先红后绿证明 server/runtime 不能绕 Hub v1。
- 把 Hub v1 sole-entry 锁入 `v3-architecture-audit-locks.yml`，申请 Jason 授权。
- 旧 P6 独立生命周期按 SOP 物理删除（需 Jason 明确授权）。

### Phase 4：Module decomposition
- 按节点/资源拆 `kernel.rs` / `responses_relay_runtime.rs` / `servertool_hooks.rs` / `server/lib.rs` / `config/validate.rs` / `lifecycle/lib.rs` / `target/lib.rs` / `virtual-router/lib.rs`。
- 每 slice 唯一 owner、无 behavior change、正反测试。
- `lib.rs` 只做 mod/pub use；超 500 行拆 sub-aggregator。

### Phase 5：Protocol / continuation / error closure
- 逐协议 live matrix：Responses direct/relay/remote/local continuation；JSON/SSE/WebSocket；success/failure/non-terminal/already-terminal。
- Error05/06 forward+reverse 四态红测。
- SSE passthrough + console keepalive 正反 fixture。

### Phase 6：Docs / wiki / live / review closeout
- 更新 canonical V3 docs。
- render/browser smoke。
- install:v3 / rccv3 restart / 全端口 /health / 旧样本同入口 live replay。
- 最后 codex review（必须 `VERDICT: PASS` 或等价语义 PASS）；review 后改动全套重跑。

## 6. 文件清单（计划改 / 新建）

新增：
- `docs/goals/v3-architecture-audit-2026-07.md`（本文件）
- `docs/architecture/reviews/v3-architecture-audit-2026-07.yml`（machine manifest）
- `scripts/architecture/verify-v3-architecture-ci.mjs`（umbrella）

修改（待 Jason 授权）：
- `docs/ARCHITECTURE.md`：加 V3-index 框；改写 `store=false` 段
- `docs/design/v3-system-definition.md`：补 phase 表；移除“before request pipeline”静态陈述
- `docs/architecture/v3-function-map.yml`：status enum 化
- `docs/architecture/v3-resource-operation-map.yml`：status enum + last_verified_at
- `config/v3-file-size-policy.json`：ratchet whitelist 加 approval_id（Phase 4 同步）
- `.github/workflows/test.yml`：加 verify:v3-architecture-ci + closeout gates
- 各 gate 输出：先红后绿，红测写到 `tests/architecture/`

禁止改动（除非 Jason 授权）：
- `docs/architecture/v3-architecture-audit-locks.yml`（fingerprint）
- `docs/architecture/v3-mainline-call-map.yml`（locked chain）
- 删除任何历史 V2 文档

## 7. 风险
- Phase 4 拆分大型文件若不顺，可能引入 regression；必须先红测（terminal merge / SSE / Error05/06 / Direct passthrough）。
- Phase 1 CI umbrella 接入失败会让 CI 红绿继续失真，必须先把所有子项跑绿再接。
- Phase 0 fingerprint drift 必须由 Jason 决定接受 / 回滚 / 重授权；不动手。
- Live replay 不在本审计轮；只有授权后才跑 `install:v3 / rccv3 restart`。

## 8. 验证矩阵

| 维度 | 命令 | 当前 | 完成标准 |
| --- | --- | --- | --- |
| file-size ratchet | `npm run verify:v3-file-size` | 红 | 全部 ≤ ratchet 或 ≤ 1500 |
| hub v1 topology | `npm run verify:v3-hub-v1-node-file-topology` | 红 | 全部 caller/callee 定义存在 |
| module boundaries | `npm run verify:v3-module-boundaries` | 红 | Server 不构造/分类 Error |
| mainline call map | `npm run verify:v3-mainline-caller-flow` | 红 | locked chain fingerprint 同步或 Jason 授权新 fingerprint |
| architecture docs | `npm run verify:v3-architecture-docs` | 红 | 全部子项绿 |
| static hook registry | `npm run verify:v3-static-hook-registry` | 红 | 无非相邻 builder / provider-specific 分支 / H1 网络连 provider |
| hub relay closeout | `npm run verify:v3-hub-relay-runtime-closeout` | 红 | function map + verification map 同步 |
| umbrella | `npm run verify:v3-architecture-ci` | 待新建 | 子项全绿 |
| live | `rccv3 restart` + 多端口 /health + 旧样本 replay | 未跑 | 仅在 Jason 授权后跑 |

## 9. DoD
1. P0 全部修复完成；gate 实跑绿。
2. CI umbrella 接入；release/build/install 前置。
3. canonical docs 与 machine registry 一致；现状/目标态机器可区分。
4. Hub v1 sole-entry 锁链在 Jason 授权后入锁；旧 P6 物理删除有方案且在 lock 中声明。
5. module registry 全源码一对一 owned_paths；import-call graph 边命中 edge registry。
6. codex review 出 `VERDICT: PASS` 或语义 PASS；review 后改动全套重跑。

---

## 7. 2026-07-31 修复执行计划：SSE / Inbound-Outbound / Provider Error / Gate Wiring

### 7.1 目标与验收标准
- 目标：关闭 V3 架构审计中的真实违规：SSE/Server 不承载非 transport/Error 语义，Inbound/Outbound 只做各自节点语义，Provider 错误进入 typed Error chain，V3 architecture gate 成为 CI/build/install 真实门禁。
- 验收：相关红测先红后绿；`verify:v3-module-boundaries`、`verify:v3-provider-action-gate`、`verify:v3-architecture-ci` 通过；无 fallback/降级/双路径补偿；runtime 改动完成后有 build/install/restart/live replay/codex review 证据。

### 7.2 范围与边界
- In scope：`v3/crates/routecodex-v3-server`、`routecodex-v3-error`、`routecodex-v3-runtime/src/hub_v1`、V3 provider action/verification registry、`scripts/architecture/verify-v3-architecture-ci.mjs`、`package.json`、CI/release workflow、必要文档/manifest/map/gate。
- Out of scope：未授权不刷新 locked fingerprint；不删除旧生命周期/迁移生产配置；不触碰无关 V2 路径；不修和本次违规无关的文件体积 debt，除非阻塞本次 gate。

### 7.3 设计原则
- SSE transport 只做 framing/lifecycle/close，不判断 provider 语义、不构造 Error06、不伪造 terminal success/failure。
- Server 只投影 runtime typed output；不得 build/classify `ErrorErr01..06`。
- `req_inbound` 只做入口协议解析、上下文捕获、非破坏性归一化；canonicalization 失败必须 fail-fast/typed error，禁止 `(false, None)` 继续。
- `req_outbound`/provider codec 只做 provider wire build/校验；不得做 Chat Process 工具治理或 metadata/debug payload 混入。
- Provider/runtime 错误必须先归一到 typed Error chain；禁止把中间 truth 包成 `client_response.error.type=provider_error`。
- Gate 必须接入 CI/build/install/release；手动可跑但未接线的 gate 不算门禁。

### 7.4 技术方案与文件清单
1. Gate 接线先落地：补 `verify:v3-architecture-ci` package script，并接入 `.github/workflows/test.yml`、`.github/workflows/release.yml`、`build:v3-cli`、`scripts/install-v3-cli.mjs`。
2. 先加红测：新增 direct/relay SSE abrupt close 不伪造 Error06/error event；新增 provider hook/runtime failure 不生成 `provider_error` 中间 truth；新增 Responses inbound malformed canonicalization 不进入 Chat Process。
3. Server Error owner 修复：把 post-commit SSE source projection 的 Error02→06 构造移入 `routecodex-v3-error` typed projection helper；server 移除 Error builder/classifier/action imports，只消费 Error06/client projection。
4. Provider error wrapper 修复：`V3ResponsesRelayProviderFailure`/policy input 改为 typed source/code/message/stage 字段；`handle_v3_responses_relay_provider_failure` 不再从 `client_response.error.type` 反读 policy truth；最终 client-visible error 只来自 Error06 projection。
5. Inbound fail-fast 修复：`req_inbound_02_normalized.rs` canonicalization 返回 `Result`/typed inbound error；更新 caller 与测试，禁止静默继续。
6. Map/manifest/gate 修复：补 provider action map 缺项、missing tests、node topology symbol、generated field parity HTML；fingerprint drift 只记录 blocker，不擅自刷新。

### 7.5 风险与规避
- 风险：SSE closeout 当前可能被 console/error 投影测试耦合。规避：先红测锁“abrupt close 不伪造”，再移动 Error owner，不改 SSE transport core。
- 风险：provider failure 字段改动影响 relay policy。规避：保留 typed source/message/status 输入，移除 only 中间 wrapper，不改 policy 决策语义。
- 风险：inbound signature 变化扩散。规避：只改 `req_inbound` caller 相邻边，不在 handler/outbound/provider 补偿。
- 风险：umbrella gate 接线后 CI 变红。规避：接受红灯作为真实门禁，逐项修绿；不以跳过/soft-fail 处理。

### 7.6 验证矩阵
| 类别 | 必跑验证 | 目标 |
| --- | --- | --- |
| 红测 | 新增 SSE/provider-error/inbound malformed tests 先红 | 证明现有违规可复现 |
| 定向架构 | `npm run verify:v3-module-boundaries` | server 不构造/classify Error nodes |
| Provider action | `npm run verify:v3-provider-action-gate` | required tests/map/manifest 完整 |
| SSE 边界 | `npm run verify:sse-architecture-boundary`、`npm run verify:sse-transport-core-shared` | transport 只承载 transport |
| Error 链 | `npm run verify:error-pipeline-contract`、`npm run verify:provider-response-errorerr-bypass-closeout` | provider error 不绕 typed chain |
| Normalization | `npm run verify:v3-normalization-payload-logic-boundary` | inbound/outbound 不越界 |
| Umbrella | `npm run verify:v3-architecture-ci` | V3 架构门禁真实聚合 |
| Build/install/live | `npm run build:v3-cli`、`npm run install:v3`、`routecodex restart --port <locator>`、旧样本 live replay | runtime 改动端到端生效 |
| Review | codex review PASS | 交付前独立审查 |

### 7.7 实施步骤
1. 刷新 `.agent-collab` 状态并持有本次 feature/gate claim；确认无 KILL_SWITCH。
2. 接线 `verify:v3-architecture-ci` 到 package/CI/release/install，先跑出真实红灯。
3. 添加三组红测并确认红：SSE abrupt close、provider-error wrapper、inbound canonicalization fail-fast。
4. 修 Server Error owner，移动 Error projection 到 `routecodex-v3-error`，跑 module boundary 与相关 SSE tests。
5. 修 provider failure typed input，删除 `provider_error` 中间 truth，跑 Error chain/provider failure tests。
6. 修 inbound canonicalization fail-fast，只改相邻 caller，跑 normalization/inbound tests。
7. 修 provider action map、node topology、field parity generated artifact；fingerprint drift 若仍红，记录需 Jason 授权。
8. 跑完整验证矩阵；runtime 影响确认后 build/install/restart/live replay。
9. 更新 note/MEMORY/必要 local skill；执行 codex review；review 后若再改，重跑受影响验证。

### 7.8 完成定义
- 代码层：SSE/Server/Inbound/Outbound/Provider Error 均只在唯一 owner 处理对应语义，无跨层 shortcut、无 fallback、无 debug/metadata/error normal payload 泄漏。
- Gate 层：V3 architecture umbrella 挂入 CI/build/install/release，失败会阻断；不是人工约定。
- 证据层：有红测先红、绿测、build/install/restart/live replay、codex review PASS；无法授权的 fingerprint drift 明确列为剩余 blocker。
