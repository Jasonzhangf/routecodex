# Run notes: models-catalog-direct-surface-20261003

Task: `/v1/models` 暴露直连面 `provider.model` + 虚拟入口名；`provider.未声明模型` 回退 auto。

Worktree: `/Volumes/Intel/playground/routecodex/models-catalog-direct-surface-20261003`
Branch: `bug/models-catalog-direct-surface-20261003`
Base: `origin/main` = `2fde74987ed8079c36961bd7bb0c8c07348cb4b9`

## 用户确认的设计（2026-10-03）

- `expose_models` 语义：白名单只约束"路由组可达 visible id"；**所有** enabled `provider.model` 直连 id 不受白名单约束，始终发布；`expose_models` 中不匹配任何 provider model 的名字作为**虚拟入口条目**发布（`direct_route: false`），走正常 VR 路由。
- 虚拟入口名与 `auto` 走**同一条路径**（正常 VR 路由），不做特判。
- 客户端发 `provider.未声明模型`（前缀是有效 provider、模型未声明）→ **回退 auto**，不再 404。

## 基线观察（实测，port 4444，base 之前的 live runtime）

| model | 行为 |
|---|---|
| `gpt-5.5` / `auto` / `totally-unknown-model-xyz` | 200，正常 VR 路由（已符合目标） |
| `whitehat.deepseek-v4.1-flash` | 200，`pool=direct` 直连（已符合目标） |
| `lifeai.nonexistent-model` | 404 `direct_model_not_found`（需改为回退 auto） |
| `GET /v1/models` | 空（缺陷） |

## 根因

`v3/crates/routecodex-v3-server/src/models_catalog.rs`:
- `is_exposed` 用 `expose_models` 匹配所有条目的 `visible_id`；
- 直连面（`provider.model`）也被 `is_exposed` 过滤（`models_catalog.rs:133`）；
- `expose_models = ["gpt-5.5"]` 里 `gpt-5.5` 既不是 provider model visible_id 也不是直连 id → 整个目录为空。
- 该白名单路径**无任何测试**（所有测试用 `expose_models: Vec::new()`）。

`v3/crates/routecodex-v3-virtual-router/src/lib.rs:666-674`:
- `V3DirectModelResolution::UnknownModel` → `Err(DirectModelUnknown)`。

## 节点记录

| 时间 | 节点 | 结论/状态 | 证据 | 下一步 |
|---|---|---|---|---|
| 2026-10-03 19:0x | observe | 完成：基线见上表 | live probes + `~/.rcc/logs/server-v3-4444.request-records.jsonl` | 建 worktree |
| 2026-10-03 19:0x | worktree | 完成：base=2fde74987 | `git worktree list` | 实现 |
| 2026-10-03 19:2x | implement | 完成：config/VR/runtime/server 四处改动 | 见「改动清单」 | 编译 |
| 2026-10-03 19:2x | compile | 完成：`cargo check --workspace --all-targets` EXIT=0，0 error | /tmp/cc.log | 跑测试 |
| 2026-10-03 19:3x | test:unit | 完成：virtual-router 36 + config 57/11/9/26/2 全绿 | cargo test | 跑入口测试 |
| 2026-10-03 19:3x | test:old-contract | 完成：3 个 relay 集成测试断言旧 ModelNotFound 契约，按新契约改为「回退 default pool」后全绿 | `*_unknown_direct_provider_model_falls_back_to_default_pool` | 补黑盒 |
| 2026-10-03 19:3x | test:catalog | 完成：新增 `p6_models_endpoint_expose_models_publishes_entry_names_and_keeps_direct_surface` 通过 | `cargo test -p routecodex-v3-server --test multi_listener_server p6_models_endpoint` 4 passed | 补 HTTP 黑盒 |
| 2026-10-03 19:4x | test:blackbox | 完成：真实 HTTP 入口 `POST /v1/chat/completions` model=`controlled.unknown-model` → 200 且上游收到 `chat-wire-model` | `cargo test -p routecodex-v3-server --test openai_chat_relay_controlled` 1 passed | 文档/契约 |
| 2026-10-03 19:4x | docs | 完成：function-map / verification-map / catalog test-design 三处契约更新 | `docs/architecture/v3-function-map.yml`、`docs/architecture/v3-verification-map.yml`、`docs/goals/v3-models-capability-catalog-test-design.md` | 跑 gate |
| 2026-10-03 19:4x | fmt | 完成：`cargo +stable fmt --all -- --check` 干净（先 `fmt` 修正 2 处） | 仅本次改动的 2 个文件被格式化 | gate |
| 2026-10-03 19:5x | gate:docs | 完成：`compile-v3-build-admission` PASS digest=e8a16fef…；`verify:v3-architecture-docs` / `verify:v3-resource-map` / `verify:v3-module-boundaries` / `verify:v3-rust-only` 全 PASS | /tmp/gates2.log | clippy |
| 2026-10-03 20:0x | gate:clippy | **前置失败（非本次引入）**：`cargo +stable clippy --workspace -D warnings` 在 `routecodex-v3-route-classifier/src/active_turn.rs` 报 3 条（single_match / needless_lifetimes ×2），另有 `provider-compat-core`、`agent-memory` 各 1 条（仅 1.97.1 新 lint）。这些文件 `git status` 未修改，即与 `origin/main` 逐字节相同 → 失败前置存在。本次改动的 4 个 crate 在 1.96.1（`v3/rust-toolchain.toml` 钉版）下无任何 clippy 报错。CI（`.github/workflows/{test,release}.yml`）不含 clippy 步骤 | /tmp/clippy.log、/tmp/clippy_mine.log、/tmp/clippy196.log | 记录并继续 |
| 2026-10-03 20:1x | gate:workspace-tests(1) | **前置环境失败（非本次引入）**：`npm run test:v3-workspace`（真实 state dir）唯一失败二进制 `routecodex-v3-admin --test l4_admin_deploy`（6 passed / 7 failed），全部是 `reqwest TimedOut`（客户端 10s）打 `/api/environment`。根因：该 handler 在 current-thread tokio runtime 上同步遍历真实 `$HOME/.rcc/state/runtime-lifecycle/v3`（本机 **1692 instance / 81MB**）→ 超 10s。对照：`ROUTECODEX_V3_STATE_DIR=/tmp/empty-v3-state` 下同一二进制 **13 passed / 0 failed / 3.79s** | /tmp/workspacetest.log | 用干净 state dir 复跑全量 |
| 2026-10-03 20:2x | test:red-green | 完成：把 `models_catalog.rs` 临时换回 `origin/main` 版本 → 新测试 FAILED（`gpt-5.5 must be listed`，红）；恢复本次版本 → PASS（绿）。文件已按字节恢复（`diff` 一致） | 见本行证据；备份 `/tmp/models_catalog.mine.rs` | 全量复跑 |
| 2026-10-03 20:2x | gate:workspace-tests(2) | 完成：干净 state dir 下全量跑到 `routecodex-v3-cli --test managed_lifecycle` 失败 3 条（22 passed），与 (1) 互为反向：真实 state dir 下该二进制通过、`l4_admin_deploy` 失败；空 state dir 下相反。两者都依赖本机环境（真实 lifecycle state 规模 / release snapshot / hooks readiness 计时），且 `git status` 未改这两个 crate 任何文件 | /tmp/workspacetest2.log | 无 `--no-fail-fast` 全量复跑 |

## 改动清单（相对 origin/main 2fde74987）

| 文件 | 改动 |
|---|---|
| `v3/crates/routecodex-v3-config/src/types.rs` | 删除 `V3DirectModelResolution::UnknownModel`；enabled provider 未声明该 model → `NotDirect`（回退正常分类） |
| `v3/crates/routecodex-v3-virtual-router/src/lib.rs` | 删除 `V3VirtualRouterError::DirectModelUnknown`；`resolve_v3_direct_model_plan` 只保留 `NotDirect`/`Resolved` 两支 |
| `v3/crates/routecodex-v3-virtual-router/src/tests/mod.rs` | 旧「unknown model 显式失败」测试拆为「回退 default pool」+「media mismatch 仍显式失败」 |
| `v3/crates/routecodex-v3-runtime/src/shared.rs` | `v3_route_plan_error_source` 去掉不可达的 `DirectModelUnknown` 投影分支 |
| `v3/crates/routecodex-v3-runtime/tests/{openai_chat,gemini,anthropic}_relay_runtime_integration.rs` | 3 个测试由「provider.model 缺失 → ModelNotFound」改为「→ 回退 default pool」 |
| `v3/crates/routecodex-v3-server/src/models_catalog.rs` | `is_exposed`→`is_routed_exposed`（只裁剪路由条目）；直连面去掉白名单门；新增入口名虚拟条目段（`direct_route:false`） |
| `v3/crates/routecodex-v3-server/tests/multi_listener_server.rs` | 新增 `p6_manifest_with_expose_models` + `p6_models_endpoint_expose_models_publishes_entry_names_and_keeps_direct_surface` |
| `v3/crates/routecodex-v3-server/tests/openai_chat_relay_controlled.rs` | 新增真实 HTTP 入口黑盒断言：未声明 model → 正常路由到 default pool 目标 |

## Review 与消融（2026-10-03 20:5x）

独立架构 review（只读 reviewer，未改文件）结论 **FAIL**，唯一 blocking 属消融项：
`shared.rs` 把 `v3_route_plan_error_source` 变成无条件 `RuntimeFailure` 后，relay 侧整条
`ModelNotFound` 错误链失去唯一生产者 → 变成不可达死链。作者独立复核确认：
`V3ErrorSourceKind` 仅 `Serialize`（无 `Deserialize`），全仓无第二种构造点，
`v3_route_plan_error_source` 的 4 个调用点都无法再产出该 kind → 结论成立。

已按消融物理删除（编译器零错误验证）：

| 位置 | 删除内容 |
| --- | --- |
| `hub_v1/relay_runtime_core.rs` | `V3RelayCoreError::ModelNotFound` 变体 + Display 分支 + `source_kind==ModelNotFound` 守卫；`V3ErrorSourceKind` 未用 import |
| `hub_v1/responses_relay_runtime_inner.rs` | 同守卫分支 |
| `hub_v1/anthropic_relay_runtime.rs` | 同守卫分支 + `V3AnthropicRelayRuntimeError::ModelNotFound` |
| `hub_v1/anthropic_relay_runtime_helpers.rs` | `ModelNotFound` 投影分支 |
| `hub_v1/gemini_relay_runtime.rs` | 变体 + `V3RelayCoreError::ModelNotFound` 映射 + 投影分支 |
| `hub_v1/openai_chat_relay_runtime.rs` | 变体 + 映射 + 投影分支 |
| `hub_v1/responses_relay_types.rs` | `V3ResponsesRelayRuntimeError::ModelNotFound` 变体 |
| `hub_v1/responses_relay_dry_run.rs` | `ModelNotFound` 404 投影分支 |
| `routecodex-v3-error/src/lib.rs` | `V3ErrorSourceKind::ModelNotFound` 变体及其 5 处分类/校验/状态映射分支 |

消融后验证：`cargo check --workspace --all-targets` **0 error**；全仓 `ModelNotFound` 仅剩 0 处
（`ProviderModelNotFound` 除外）；`cargo +stable fmt --check` 干净；
error crate 18/14/2/4、runtime lib 1104、runtime 集成 18/21/43、config+VR 36/57/11/9/26/2、
server p6 4、controlled 1、admin 20/14/13/13 全绿。

review advisory 已一并处理：
- `docs/architecture/v3-verification-map.yml` VR `required_unit` 旧表述「unknown model fails as a config error without reroute」→ 改为「an enabled provider that declares no such model also falls back to normal classification」。
- `docs/architecture/v3-function-map.yml` catalog feature `owner_files` 补 `v3/crates/routecodex-v3-server/src/models_catalog.rs`（`allowed_paths` 此前已补）。
- advisory 3（`codex-model-capability-contract.md:94` 与 test-design 的措辞）判为前置作用域问题，记录不改历史/设计记录。

## Live 黑盒验证（隔离实例，2026-10-03 22:4x）

本机 live daemon（PID 52706）持有 4444/7777 + admin 8777，且 `rccv3` 的 managed lifecycle
在 macOS 上按 getpwuid 解析 home，直接用 `HOME` 隔离会被 lifecycle 的终止守卫拒绝
（`refusing to signal listener PID 52706 ... target_ports={8777}`）。改用源码已文档化的
dev 覆盖 `ROUTECODEX_V3_ADMIN_BIND=127.0.0.1:18090` 让 admin 端口避让后，隔离实例可正常启动。

- 配置：`/tmp/rcc-iso/config.toml`（server `iso` 127.0.0.1:18080，`expose_models = ["gpt-5.5","auto","client-alias"]`，
  route `default` → `mock/mock-model`；provider `mock` 走 `/tmp/rcc-iso/provider/mock/config.v2.toml`，
  baseURL 指向本地 mock upstream 127.0.0.1:18081）
- 产物：本次改动后的 `v3/target/debug/rccv3`（`cargo build -p routecodex-v3-cli`，0.90.4827）
- 启动：`HOME=/tmp/rcc-iso/home ROUTECODEX_V3_STATE_DIR=/tmp/rcc-iso/state ROUTECODEX_V3_ADMIN_BIND=127.0.0.1:18090 rccv3 start -c /tmp/rcc-iso/config.toml`
- `GET /health` → `{"status":"ok","manifest_version":3,"port":18080,"server_id":"iso",...}`

`GET /v1/models` 真实入口（三面同时成立）：

| id | direct_route | owned_by | canonical_model_id |
| --- | --- | --- | --- |
| `mock.mock-model` | `true` | `provider:mock` | `mock-model` |
| `gpt-5.5` | `false` | `routecodex` | — |
| `auto` | `false` | `routecodex` | — |
| `client-alias` | `false` | `routecodex` | — |

`POST /v1/chat/completions`（同一入口，逐类）：`gpt-5.5` / `auto` / `client-alias` /
`mock.unknown-model` / `mock.mock-model` **全部 HTTP 200**，且 mock upstream 记录到的 wire model
**全部为 `mock-model`**（即正常 VR→default pool→声明 target，既不是 404，也不是把未声明模型名直接透传给上游）。
其中 `mock.unknown-model` 是改动前 404 `direct_model_not_found` 的同入口样本。

`POST /v1/responses`（第二入口协议）：`mock.unknown-model` 与 `auto` 均 **HTTP 200**，响应 `model=mock-model`。

边界：以上为本次候选产物在隔离实例上的真实入口证据；**用户 live daemon（4444/7777）尚未安装/重启**，
故「已安装 runtime 的同入口重放」不成立，未宣称闭环。

## 二次 review 与合并（2026-10-03 23:0x）

第二轮独立架构 review 结论 **PASS**：blocking 消融项确认解决，未发现引入回归。其独立核验：
全仓 `ModelNotFound` 0 命中；`routecodex-v3-admin/src/provider_models.rs:100` 的 `model_not_found`
是 admin provider-model 变更接口的局部 HTTP 错误码，与已删除的 `V3ErrorSourceKind` 无耦合；
`routecodex-v3-error/src/lib.rs` 的状态映射是逐变体穷尽匹配（无通配），删 404 分支不改变其它 kind。

review advisory 处理：
- 已改：catalog feature 的 `owner_scope` / `required_unit` / `completion_rule.runtime` 旧「路由组上限」表述，
  以及本 feature 绑定的 `docs/design/codex-model-capability-contract.md` 的可见模型规则（改为三面 + 入口名优先级）。
- 已改：`v3-function-map.yml` catalog `owner_files` / `allowed_paths` 补齐 `models_catalog.rs` 与本笔记。
- 驳回：reviewer 建议删除 `anthropic_relay_runtime.rs` 的 `V3ErrorSourceKind` import。该 import 被
  `use super::*` 的子模块使用；删除后 `cargo check` 报 4 个 `E0433`，属活跃引用而非死代码，已保留并记录。

## origin/main 前进与合并后复验（2026-10-03 23:1x）

推分支时发现 `origin/main` 已从 `2fde74987` 前进到 `50ba5e540`（PR #313：client boundary 与
"converge terminal error evidence on one writer"，含 `routecodex-v3-server/src/{endpoint_handlers,
frame_builders,live_snapshot,websocket}.rs` 与 `hub_v1/{relay_runtime_shared,responses_relay_failures}.rs`）。
已把最新 main 合入候选：merge commit `b0ea0fdff`，**无文本冲突**；合并后复核
`ModelNotFound` 仍 0 命中、`is_routed_exposed` 与入口名虚拟条目段仍在。

合并后重跑（候选 = main@50ba5e540 + 本修复）：
- `cargo check --workspace --all-targets` **0 error**；`cargo +stable fmt --all -- --check` 干净。
- error 18/14/2/4；runtime lib 1104；runtime 集成 18/21/43；config+VR 36/57/11/9/26/2 —— 全绿。
- `multi_listener_server` **78 passed / 0 failed 连续 3 次**；controlled relay/gemini/direct 全绿。
- 首轮合并后全量跑出现 3 个失败，**判为并发争用**：全部 panic 在
  `spawn_v3_server_aggregate(...).unwrap()`（测试服务器起不来），三个用例单独跑全绿，
  且每次失败集合不同（run1 与 run2 三个失败互不相同），随后连续 3 次全量 78/78。
- gates：build-admission lockstep PASS digest=`406616463cc04e228029cb38943f573b2498dd63752fc2ec00e0de732685612e`；
  docs / resource / module / rust-only 全 PASS。

合并后 live 复验（重新 build 的 `rccv3`，隔离实例，真实入口）：
- `GET /health` ok；`GET /v1/models` 仍是三面：`mock.mock-model`（`direct_route:true`, `provider:mock`）
  + `gpt-5.5` / `auto` / `client-alias`（`direct_route:false`, `routecodex`）。
- `POST /v1/chat/completions`：`gpt-5.5` / `auto` / `client-alias` / `mock.unknown-model` / `mock.mock-model`
  **全部 200**，upstream 收到的 wire model 全部 `mock-model`。
- `POST /v1/responses`：`mock.unknown-model` 与 `auto` 均 **200**，`model=mock-model`。

边界：用户 live daemon（4444/7777）仍未安装/重启；已安装 runtime 的同入口重放不成立，未宣称闭环。

## 合并收口（2026-10-04 19:0x）

- 合并解析 review（独立，只读）结论 **PASS**，`b0ea0fdff` 的合并完整性可证明：
  `git merge-tree --write-tree 918b120da 50ba5e540` = `702f1872f403795935147fdea36a6e6692ed3f98`
  = `b0ea0fdff^{tree}`，即合并结果是干净的三方并集，无丢失无重复。它另证实：
  `multi_listener_server.rs`（+135/−0）与 `openai_chat_relay_controlled.rs`（+39/−0）
  均为**纯增量**；与本仓库另一侧改动同一测试函数
  `openai_chat_relay_controlled::server_executes_controlled_json_sse_error_and_isolation_without_second_owner`
  的两侧断言共存并通过；`V3DirectModelResolution::UnknownModel` 删除后所有 match 点穷尽。
- PR #314 首次 CI：`test` **fail**，唯一失败子门禁是 `verify:v3-file-size`（`live_snapshot.rs` 1564 > 1500）。
  证据显示该超限与本改动无关：本改动从未触及该文件（base 1498 行，是 PR #313 的
  `a44c2daae`/`6067ed748` 涨到 1564）；纯 `origin/main` 同样超限；`test` job 自 2026-08 起持续红。
  40 个子门禁通过 38 个。经确认该超限已由 PR #325 `9895f59af`（拆分 `live_snapshot`）修复。
- `origin/main` 前进到 `de953d36e` 后再次合入（`493a2a263`），最终候选 = 最新 main + 本修复。
  复核：我的测试与两份 map 的新增断言全部保留，`ModelNotFound` 仍 0 命中，`never_reaches_the_client`
  6 个用例仍在。
- 最终候选验证：`cargo check --workspace --all-targets` **0 error**；`fmt --check` 干净；
  config/VR/error/debug 13 个 suite 全 ok；runtime lib **1104**；relay 集成 **18/21/43**；
  server controlled relay/gemini/direct 全绿；
  gates build-admission `c891f217cffb86b7dd431b8f6bc166964be89bdd2d44d20bafe2e49ba48ae787`、
  docs/resource/module/rust-only/**file-size**（`limit=1500, files=311, ratchet entries=13`）全 PASS。
- `multi_listener_server` 全量在本机高负载（load avg 30~48 / 32 核，多 agent 并发）下间歇失败
  2~3 个用例，**判为并发争用**：每次失败集合都不同，全部 panic 在
  `spawn_v3_server_aggregate(...).unwrap()`（起测试服务器失败），每个失败用例单独跑均绿，
  且同一候选有过连续 78/78 全绿的结果。
- 最终 live 黑盒（build `0.90.4831`，隔离实例，真实入口）：`/health` ok；
  `/v1/models` 三面 = `mock.mock-model`（`direct_route:true`, `provider:mock`）+
  `gpt-5.5` / `auto` / `client-alias`（`direct_route:false`, `routecodex`）；
  `/v1/chat/completions` 对 `gpt-5.5`/`auto`/`client-alias`/`mock.unknown-model`/`mock.mock-model`
  **全部 200**，upstream wire model 全部 `mock-model`；`/v1/responses` 对
  `mock.unknown-model` 与 `auto` 均 **200**，`model=mock-model`。

## 合并后 CI 与 flake 归因（2026-10-04 11:0x）

PR #314 已在 `origin/main` 前进到 `de953d36e` 后合并为 `d1639c4fa`：
- 合并父提交核对：`d1639c4fa^1 = de953d36e`（main 尖端）、`d1639c4fa^2 = 30cb95cb9`（本候选），
  即第三方 review 的「合并基线过期」结论只对已被取代的旧 head `36bd12536` 成立，对实际合并不成立。
- 内容等价：`git diff --quiet origin/main 30cb95cb9` → **IDENTICAL**；本地 main 与远端 main 均为 `d1639c4fa`。
- 相对最新 main，我的候选只**新增 135 行 / 删除 0 行**于 `multi_listener_server.rs`，
  测试函数数 123 → 125，不存在 review 担心的「测试面被永久丢弃」。
- #323 的 5 个新测试（`persist_async_worker_keeps_every_sample_under_burst`、
  `persist_async_worker_bounds_tiny_payload_job_count_by_fixed_overhead`、
  `skipped_samples_do_not_displace_error_evidence`、
  `disabled_samples_need_no_worker_but_forced_errors_still_report_missing_worker`、
  `measure_sample_persistence_throughput`）在合并后 main 中全部存在；被取代的
  `persist_async_worker_bounds_queue_and_reports_overload` 与「64-job」表述均已消失。

合并后 main CI（run `37170572616`）**fail**，唯一失败用例
`responses_inbound_websocket_projects_json_completed_event_and_enters_runtime`。已做归因实验：

| 结论 | 证据 |
| --- | --- |
| 与本次改动无关 | 该用例出自历史提交（`82efe5670`/`e332265d4`），我的 diff 不含任何 websocket 文件 |
| 不是由最后一次 push 引起 | CI 绿提交 `493a2a263` 与 CI 红提交 `30cb95cb9` 的差异**仅一个 markdown 文件**（32 行新增），无任何 rs/js/toml |
| **纯 main 也复现**（决定性对照） | 新建 `de953d36e` 对照 worktree（**不含我的改动**）：串行 3 次 = 1 绿 2 红（3 个/5 个失败）；并行 2 次 = 1 红 1 绿 |
| **flake 早于 #323** | 在 `50ba5e540`（#323 之前、sample_store 改造之前）对照 worktree：串行 3 次 = 1 红 2 绿 |

失败签名一致，全部是共享 `$HOME/.rcc/codex-samples` 的 TOCTOU：
`spawn_v3_server_aggregate(...).unwrap()` 报 `No such file or directory (os error 2)`，
以及 `codex sample persist failed ... reason=Not a directory (os error 20)`。
本机 load average 在 20~48 / 32 核之间（多 agent 并发），单独跑每个失败用例均绿。
→ 判定：**预先存在的并行/文件系统 flake，非本次改动引入**。对照 worktree 已删除
（`git worktree list` 不含 `ci-flake-control-20261004`，`test ! -e` 成立）。

## 安装/重启节点：未做（UNVERIFIED）

已安装 runtime 仍是旧产物：`/Users/fanzhang/.local/bin/rccv3`（Oct 3 19:21），
live daemon PID 49150（`--config /Volumes/extension/.rcc/config.toml`，4444/7777）
`GET /v1/models` 仍返回 `{"data":[],"models":[]}`，即**未包含本修复**。

`npm run install:release` 在当前环境有三个阻断点，且重启会影响本会话：
1. **会终止本会话**：运行本会话的 DSH harness（`DeepSeek Harness` PID 61334）与 4444 有已建立连接；
   4444 上还有 18 个 codex + 22 个 rccv3 连接，属共享 live runtime。
2. **验证配置缺失**：脚本要求 `$VERIFY_CONFIG`（默认 `/Volumes/extension/.rcc/config.v3.toml`）不存在。
3. **构建源不是已验候选**：脚本从 `SOURCE_ROOT`（主树 `/Users/fanzhang/Documents/github/routecodex`，
   HEAD `30f0bb619`、40 个 dirty 文件）构建，该树**不含**本次合并 `d1639c4fa`；
   且 `0.90.4831` 版本号未变，`/health` 版本匹配也无法证明新代码已加载。

→ 故「已安装 runtime 的同入口重放」不成立，交付在此节点标为 UNVERIFIED，未宣称闭环。

## 安装已完成、重启被阻塞（2026-10-04 20:2x）

（本节取代上一节：上一节的 3 个阻断点中，「构建源不是已验候选」与「验证配置缺失」已解决，安装已完成。）

**已完成：构建 + 安装（从本候选 worktree 构建，非主树）**
- 命令：`CARGO_TARGET_DIR="$PWD/v3/target" CARGO_NET_OFFLINE=true npm --prefix v3 run install`，exit 0。
  `Finished release profile [optimized] target(s) in 38.29s`；`[install-cli] ok`。
- 已安装 `/Users/fanzhang/.local/bin/rccv3` sha256 `65fbf9fe0194e1886b6151c57f2489dbddbf4482959f9ce99e9ae3e5668a17de`；
  `rccv3-admin` `6f3154b69908f52c7f2e022050e5a2cce7925fc01e30ceacb82eda3722e97b1b`；
  `rccv3-hooksd` `35628eacaa1d361e551cb1ee482a8a24979f11c52df3ed31c852a6b1802d63ae`。
- 非破坏性：live daemon PID 49150 仍持有旧 inode，不受替换影响。

**重启阻塞：live config 需要未合并的 `[runtime] fd_limit`**
- live config `/Volumes/extension/.rcc/config.toml`（mtime 2026-10-03 20:40:18，即 daemon 09:04 启动**之后**被改）
  第 3–4 行为 `[runtime]` / `fd_limit = 65535`。
- 新装 binary 对该文件 `config check -c` 与 `start -c` 均在 **line 3 `[runtime]`** 报
  `unknown field 'runtime', expected 'version' or 'servers'` → **解析失败，重启必然起不来**。
- 隔离验证（`/tmp/rcc-probe/home4`，basename 保持 `config.toml`）：
  - **带** `[runtime]` → parse error（line 3）；
  - **去掉** `[runtime]`（`/tmp/rcc-probe/home5`）→ **解析通过**，仅在 validation 阶段因隔离 HOME 缺 provider 文件而报错。
  → `routes` 用户方言本身没问题；**唯一阻断项就是 `[runtime]`**。
- **更正早前结论**：此前「新 binary 连 `routes` 也拒绝」是**探针文件命名假象**。本 loader 按 **basename** 选方言：
  仅 basename 为 `config.toml` 时走 user/authoring 方言（支持 `routes`）；其他名字走 server/manifest 方言
  （要求 `routing_group`/`route_groups`）。同一内容改名为 `othername.toml` 即在 line 43 `[servers.responses_v3_7777.routes.coding]` 报错。
- `[runtime]`/`fd_limit` 只存在于**未合并**分支 `97cecc329`（`fd-limit-config-20261003`，其父正是本次合并 `d1639c4fa`）；
  `git grep V3RuntimeManifest origin/main -- v3/crates/` 为空 → main 无该字段。
- 该分支 worktree 仍是**他人活跃工作**（dirty 5 文件，`runtime_config.rs` mtime Oct 3 19:51），
  且 live config 的 `[runtime]` 是在其 19:49 提交之后（20:40）加入的 → 属他人在共享 live config 上的在建依赖。
- 二进制接受矩阵（对真实 live config）：`fd-limit-config-20261003` 的 dist/release **ACCEPT**；
  新装 binary、`client-provider-decoupling-main-20261003`、`provider-terminal-witness-evidence-20261003` 均 **REJECT**。

**回归性判断**：live daemon PID 49150 启动于 Oct 3 09:04，早于 `fd_limit` 提交（19:49），
其运行中的 binary 不可能含 `[runtime]` 支持；live config 于 20:40 加入 `[runtime]` 后，
**任何 main 基线的 binary（含本次安装）都无法重启该 daemon**。该「不可重启」状态由 20:40 的 config 改动造成，
不是本次安装引入。

→ 「已安装 runtime 的同入口重放」仍**不成立**，本节点标为 **BLOCKED**（非仅 UNVERIFIED）。
未擅自重启：重启会解析失败导致 4444/7777 下线并中断本会话。已向用户升级该决策（选项：等 fd-limit 合并 /
授权临时移除这 2 行后重启再恢复 / 其他）。
