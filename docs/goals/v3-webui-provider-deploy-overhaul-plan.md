# V3 WebUI Provider / Deploy / Observability Overhaul Plan

Status: design-admission-NOT-SATISFIED（第一/二/三轮独立 review 均 FAIL；处置分别见 §9、§9.1、§9.3。**编码前门禁在本轮未被满足**：实现与门禁并发，属用户直接授权下的流程偏离，不追溯转换为门禁 PASS；设计产物已冻结于 §9.2）
Branch: `codex/webui-provider-deploy-overhaul-20261001`
Baseline: `origin/main` @ `ebe3a3c6d`
Owner feature: `v3.admin_observability_aggregation`（`v3/admin-webui/` + `routecodex-v3-admin` 表面的唯一 owner）

### 1.1 共同 owner（本方案跨 feature 的边界声明）

| 范围 | owner feature | 本方案的角色 |
| --- | --- | --- |
| `v3/admin-webui/**`、`v3/crates/routecodex-v3-admin/**` | `v3.admin_observability_aggregation` | 唯一 owner，新增全部 admin 端点与页面 |
| `v3/crates/routecodex-v3-server/src/webui_observability.rs`（行结构 / `raw_artifact_ref`）、`src/console/impl_webui_projection.rs` | `v3.server_internal_observability_projection` | **共同 owner**：本方案扩展行结构并把 runtime 已有 typed 事实透传进行，不新建行生产链 |
| `v3/crates/routecodex-v3-debug/src/observability_store.rs`、`sample_store.rs` | `v3.observability_persistence_isolation` | **共同 owner**：本方案只做加法（`sample_store` 布局 helper 提升可见性），不改保留/压缩策略 |
| `v3/crates/routecodex-v3-config-mgmt/src/provider.rs`、`src/route.rs` | `v3.config_management` | 复用 `write_provider_file`；route pool 绑定委托 Config Core 的 `bind_user_route_member`，不新增写路径 |
| `v3/crates/routecodex-v3-config/src/provider_directory.rs` | `v3.config_management` | 候选级校验入口，不绕过目录模式 |
| `docs/architecture/*` | 本方案 | Lead 独占 |

`v3.observability_persistence_isolation` 原先在 `allowed_paths` 里泛声明 `v3/crates/routecodex-v3-admin/src`，与 `v3.admin_observability_aggregation` 重叠；本次已收敛为 admin 表面归 `v3.admin_observability_aggregation`，该 feature 只保留 store 与其 writer。

## 1. 目标

把 V3 WebUI 从「只读监控台 + 半成品编辑器」升级为：

1. **Provider 接入控制台**：自动添加（推断 + 模型发现 + 候选校验 + 落盘）与分级测试接入（L1 契约 / L2 可达鉴权 / L3 真实语义探测 / L4 端到端）。
2. **Provider 定时巡检**：复用既有 runtime probe，对已接入 provider 周期性 L3 探测并保留历史证据。
3. **部署/体检流程**：Environment（版本 / binary hash / 受管实例 / listener health）、Doctor（逐项自检 + 修复提示）、Lifecycle（restart/status 走官方生命周期）。
4. **错误可观测性**：把 runtime 已有的 typed error 事实落进 observability 行并透传到 UI；artifact 真实化；per-request 详情；runtime 冷却池可见。
5. **用户友好性**：统一表单与反馈规范、密钥脱敏、空态引导、部分成功可重试。

## 2. 非目标

- 不引入 React/Vite/组件库/任何 npm 运行时依赖；保持零构建 vanilla + Ambient CSS。
- 不做定价/计费/配额/订阅/支付。
- 不做 provider OAuth（V2 目录 codec 无法声明 `OAuth`/`TokenFile` auth_type）。
- 不做 provider 级自定义 headers（数据模型无承载字段）。
- 不做 WebUI 内 binary 升级/回滚/OTA。
- 不改请求/响应 payload 语义，不改 routing/retry/health/error 决策语义。
- 不把控制状态写入业务 payload、metadata 或调试日志。

## 3. 现状事实（只读核实）

### 3.1 宿主

- WebUI：`v3/admin-webui/`（4 个 HTML 壳 + `app/*.js`），由 `routecodex-v3-admin` 以 `include_str!` 内嵌，静态白名单在 `v3/crates/routecodex-v3-admin/src/api/mod.rs`。
- admin WebUI 与代理**同进程**（`v3/crates/routecodex-v3-server/src/lib.rs:462-511`）。
- `[admin_webui] enabled=true bind=127.0.0.1 port=8777` 来自编译期内嵌 `user_config_base_toml`（`v3/crates/routecodex-v3-config/src/internal.toml:154-157`）；用户 `config.toml` schema 为 `deny_unknown_fields` 且只有 `version`/`servers`（`v3/crates/routecodex-v3-config/src/user_config.rs:35-48`），**无法覆盖**。
- 现有 admin 端点共 13 个，**无 auth、无 SSE/WS、无 start/stop、无版本信息**。

### 3.2 Provider 接入缺口

| 缺口 | 证据 |
| --- | --- |
| 无显式 create provider API；`PUT /api/providers/:id` 因 `write_provider_file` 会 `create_dir_all` 而隐式可建，且**不校验** | `admin/src/api/providers.rs:148-185`；`config-mgmt/src/provider.rs:74-99` |
| 无删除 provider | grep 无命中 |
| `rccv3 init` 只选已有 provider | `cli/src/init.rs:1-2,82-108` |
| health-test = 裸 `GET {base_url}/models`，**不带鉴权** → 真实 provider 恒 401/failed | `admin/src/api/providers.rs:196-204` |
| health 缓存是 admin 进程内 BTreeMap，重启即丢，与 runtime 冷却真源重复 | `admin/src/lib.rs:39-54` |
| 无上游模型发现；runtime 已有带真实 auth 的最小语义 probe 但未暴露 | `provider-responses/src/probe.rs:11-70` |
| 未被任何 route 引用的 provider 文件**不会被校验** | `config/src/provider_directory.rs:55-80` |
| provider 写入的 revision 参数错位（新路径记为 `backup`，`"provider-file"` 记为 `source_sha256`） | `admin/src/api/providers.rs:165-181` vs `config-mgmt/src/store.rs:105-113` |
| 新 provider 接流量需手写 2 个文件；`apply_user_route_group_view` 不能新建 pool | `config-mgmt/src/route.rs:115-146` |

### 3.3 部署缺口

- CLI 有 `config check` / `init` / `status` / `start` / `restart` / `stop`，后台启动是**隐藏**的 `server start`。
- 受管真源：`instance.json` / `status.json` / `pid.cache` / `control.json` + 控制 socket（`routecodex-v3-lifecycle`）。
- `POST /api/reload` 执行 **`routecodex restart`（不带 `-c`）** → 只重启默认配置实例（`admin/src/api/reload.rs:55`）。
- Dashboard 探活不解析 `build_version`（`admin/src/api/dashboard.rs:233-257`）。
- 无 macOS launchd、无 OTA、打包产物不含 `rccv3-admin`。

### 3.4 可观测性缺口

- provider 失败事件 9 字段（`external_error_code/status`、`internal_code`、`failure_count`、`health_state`、`cooldown_until_ms`、`action`、`next_provider_key`、`wait_ms`）已进调试样本，但未进 observability 行。
- `V3Error06ClientProjected` 的 `error_class` / `chain[6]` / `health_action` / `pool_exhausted` 未落库。
- 终态失败常退化为 `http_{status}` / `HTTP status {status}`。
- `raw_artifact_ref` 全仓无赋值点 → 永远为 `None`。
- 冷却池 API 已就绪但前端零调用。
- 无 per-request 详情端点（Errors Tab 用 `page_size=1` hack）。
- 具体 bug：`requests.html` 重复 `page-info` id；Protocol 筛选用 `response_types` 填充却发 `entry_protocol`；Attempts Tab 固定 `page_size=50/range=today/page=1`；`hideStatus` 无调用者；Dashboard "Provider errors" 抽屉列 route_targets。

## 4. 目标架构（SESE）

本方案不是一条链，而是**三张各自单源单汇的图**，外加一处对既有 owner 链的只读扩展。图产物：

- `docs/architecture/dags/v3.admin_provider_onboarding.graph.json`（`v3.admin_provider_onboarding@3`，10 节点 / 9 边）— 入口 `operator-onboarding-intent`
- `docs/architecture/dags/v3.admin_provider_patrol.graph.json`（`v3.admin_provider_patrol@2`，4 节点 / 3 边）— 入口 `patrol-scheduler-tick`
- `docs/architecture/dags/v3.admin_provider_patrol_plan.graph.json`（`v3.admin_provider_patrol_plan@1`，4 节点 / 3 边）— 入口 `operator-patrol-plan-intent`

三张图由 `npm run verify:v3-dagpipe-feature-graphs` 统一治理（该 gate 枚举 `docs/architecture/dags/*.graph.json` 并逐张 `dagpipe graph validate`，目录为空同样失败），见 §6.1。**错误链 → observability 行**的生产不进入本方案任何图：那条边的 owner 是 `v3.server_internal_observability_projection`，本方案只扩展行结构并作为**读方**消费。

> 图节点的 `operator` 一律写**真实存在的符号**（`auth::require_admin`、`build_environment`、`discover_models`、`validate_provider`、`probe_candidate`、`create_provider`、`bind_provider_to_route`、`restart_runtime`、`delete_provider`、`run_due`、`run_now`、`run_probe`、`put_plan`/`get_plan`/`delete_plan`/`patrol_status`）。此前版本写的是尚未存在的符号名（`require_admin_token`、`read_admin_environment` 等），属虚假绑定，已全部替换。

### 4.1 图 A：operator 驱动的 provider 接入（唯一入口 = operator onboarding intent）

```text
入口：operator onboarding intent（唯一 ARC）
  ▼
[A01] admin_n01_admin_token_admitted          require_admin
                                              reads  v3.admin.control_token
  ▼
[A02] admin_n02_environment_observed          build_environment
                                              reads  v3.admin.environment,
                                                     v3.lifecycle.status_record,
                                                     v3.user_config.file_source
  ▼
[A03] admin_n03_provider_models_discovered    discover_models
                                              reads/writes v3.admin.provider_candidate
  ▼
[A04] admin_n04_provider_candidate_validated  validate_provider
                                              reads/writes v3.admin.provider_candidate
  ▼
[A05] admin_n05_provider_candidate_probed     probe_candidate
                                              reads  v3.admin.provider_candidate
                                              writes v3.admin.provider_probe_result
  ▼
[A06] admin_n06_provider_authoring_committed  create_provider
                                              writes v3.provider.directory_authoring
  ▼
[A07] admin_n07_route_pool_bound              bind_provider_to_route
                                              reads  v3.provider.directory_authoring,
                                                     v3.user_config.file_source
                                              writes v3.user_config.file_source
  ▼
[A08] admin_n08_runtime_restart_requested     restart_runtime
                                              reads  v3.lifecycle.status_record
  ▼
[A09] admin_n09_end_to_end_verified           v3_webui_observability_read_raw_rows
                                              reads  v3.observability.webui_store
  ▼
[A10] admin_n10_provider_removed              delete_provider
                                              reads/writes v3.provider.directory_authoring
出口：admin-provider-retired（唯一 ARC）
```

### 4.1.1 §5.2 每个端点在图中的归属（不留未归属端点）

| 端点 | 归属 |
| --- | --- |
| `GET /api/admin/session` | A01（同一准入节点：token 的读取面） |
| `GET /api/environment` | A02 |
| `POST /api/environment/doctor` | A02（同一节点内的只读自检分支，不新增对象源） |
| `POST /api/providers/discover` | A03 |
| `POST /api/providers/validate` | A04 |
| `POST /api/providers/probe` | A05 |
| `POST /api/providers/:id/probe` | A05（同一节点作用于已存在 provider） |
| `POST /api/providers` | A06 |
| `PUT /api/providers/:id` | A06（同节点覆盖写） |
| `POST /api/providers/import` | A03–A06（同一对象源对多候选的重复执行；新增节点会制造第二个入口，违反 SESE） |
| `POST /api/providers/routes/bind` | A07 |
| `POST /api/runtime/restart` | A08 |
| `POST /api/reload` | A08（同一节点，`-c` 修复后与 restart 同义） |
| `DELETE /api/providers/:id` | A10 |
| `GET /api/providers` | A02（只读作者态投影；`health` 字段本次删除，不新增对象源） |
| `GET /api/providers/:id` | A02（同上） |
| `GET /api/providers/:id/health` | A02（读 runtime 冷却真值，属只读投影，不新增对象源） |
| `POST /api/providers/:id/health-test` | A02（认证可达性诊断；同一只读投影面，不新增对象源、不写 health） |
| `GET /api/providers/:id/patrol/results` | 图 B（B04 的输出读面） |
| `GET /api/providers/patrol/status` | 图 C（C03） |
| `POST /api/providers/:id/patrol/run` | 图 B（B02 的手动触发） |
| `GET/PUT/DELETE /api/providers/:id/patrol` | 图 C |
| `GET /api/observability/records/:request_key` | A09（同一只读消费面） |
| `GET /api/observability/artifacts` | A09 |
| `GET /api/observability/artifacts/content` | A09 |
| `GET /api/observability/stream` | A09 |
| `GET/POST /api/observability/cooldown-pool` | 既有端点，未变更，不在本方案图内 |

### 4.2 图 B：调度器驱动的定时巡检执行（唯一入口 = scheduler tick）

```text
入口：patrol scheduler tick（唯一 ARC，与 operator intent 无关）
  ▼
[B01] patrol_m01_schedule_tick      PatrolRuntime::run_due
                                    reads  v3.admin.provider_patrol_plan
  ▼
[B02] patrol_m02_due_plans_selected run_now
                                    reads  v3.admin.provider_patrol_plan,
                                           v3.provider.directory_authoring
  ▼
[B03] patrol_m03_probe_executed     run_probe
                                    reads  v3.provider.directory_authoring
                                    writes v3.admin.provider_probe_result
  ▼
[B04] patrol_m04_result_recorded    PatrolRuntime::run
                                    reads  v3.admin.provider_probe_result
                                    writes v3.admin.provider_patrol
出口：patrol-history-row（唯一 ARC）
```

巡检执行是**定时器源**，不是 operator intent 的下游，因此不能挂在图 A 之后。巡检结果是诊断证据：`v3.admin.provider_patrol` 声明 `advisory_only: true` / `may_mutate_runtime_provider_health: false`，`v3.admin.provider_probe_result` 同。

图 B 对图 A 的 `v3.provider.directory_authoring` 有一条**单向数据依赖**（B02/B03 读 A06 写的 provider 目录），不构成回边、不共享入口 ARC，因此不违反 SESE；此处显式声明该依赖。

### 4.2.1 图 C：operator 驱动的巡检计划（唯一入口 = operator patrol-plan intent）

```text
入口：operator patrol plan intent（唯一 ARC）
  ▼
[C01] plan_n01_plan_declared   put_plan
                               reads/writes v3.admin.provider_patrol_plan
  ▼
[C02] plan_n02_plan_read_back  get_plan
                               reads  v3.admin.provider_patrol_plan
  ▼
[C03] plan_n03_plan_armed      patrol_status
                               reads  v3.admin.provider_patrol_plan,
                                      v3.admin.provider_patrol
  ▼
[C04] plan_n04_plan_disarmed   delete_plan
                               reads/writes v3.admin.provider_patrol_plan
出口：plan-disarmed（唯一 ARC）
```

计划 CRUD 是 **operator intent 驱动**的写，不能并入图 B（图 B 的唯一入口是定时器 tick，并入会制造第二个入口）。因此独立成图 C。计划与执行结果是两个不同文件、两个不同资源：`v3.admin.provider_patrol_plan`（`<config_dir>/state/provider-patrol-plans.json`，可覆盖写）与 `v3.admin.provider_patrol`（`<config_dir>/state/provider-patrol.jsonl`，append-only）。

图 C 对图 B 的输出有一条**单向数据依赖**：`C03 patrol_n03_plan_armed` 读 `v3.admin.provider_patrol`（用于展示上次运行时间）。该依赖不构成回边（图 B 不读图 C 的任何节点输出）、不共享入口 ARC，因此不违反 SESE；此处显式声明。

### 4.3 对既有链的只读扩展（不新增图）

P4 的 typed error 透传沿既有边 `error chain → v3.observability.webui_store`，其 owner 是 `v3.server_internal_observability_projection`（writer 为 `v3_webui_observability_append_row*`）。本方案：

- **扩展行结构**（加字段），不新增 writer、不改保留/压缩策略；
- 作为**读方**消费：admin 走已登记的 `v3_webui_observability_read_raw_rows`，不新增读路径。

因此 A10 只有 `reads`、没有 `writes`。

### 4.4 分层边界

| 层 | owner | 禁止 |
| --- | --- | --- |
| WebUI 前端 | `v3/admin-webui/` | 解析日志/console 重建控制状态 |
| Admin API | `routecodex-v3-admin` | 实现 provider wire 语义、自行判定配置合法性、成为 provider health 真源 |
| Config Core | `routecodex-v3-config-mgmt` | 做 HTTP |
| Provider 探测 | `routecodex-v3-runtime::provider_failure_global_probe`（auth 解析目标）+ `routecodex-v3-provider-responses::probe`（请求构造） | 第二份 probe 实现、第二份 auth 解析 |
| Runtime 真源 | `routecodex-v3-runtime` / `-error` / `-lifecycle` | 从 WebUI 侧重建 |
| Observability 行 | `v3.server_internal_observability_projection` | 由 admin 侧新增第二写入路径 |

### 4.5 四条硬约束

1. **不新增第二份 provider health 真相**：`ProviderHealthEntry` / `AppState::health_cache` / `GET /api/providers(/:id)` 的 `health` 字段**本次删除**；provider 可用性/冷却一律读 `/_routecodex/health/cooldown-pool`。手动探测与巡检是 ad-hoc 诊断证据，永不合并进 provider health。
2. **探测必须能作用于尚未被路由引用的候选 provider**：目录模式只编译被引用的 provider，因此需要候选级校验入口。候选本身**不持久化**；为复用真实 compile 路径，校验会在 OS 临时目录物化一次性 authoring 树并在结束后删除，该临时树不是 provider 目录、也不是任何已登记资源。入口为 public `parse_v3_config_02_authoring` + `compile_v3_config_05_manifest`；`compile_provider_directory` 是 `pub(crate)`，admin 不可调用。
3. **L3 探测复用 runtime 同一构造链**：auth 解析与 target 构造复用 `routecodex-v3-runtime::build_v3_provider_global_probe_target`（`provider_failure_global_probe.rs:20`，经 `runtime/src/lib.rs:60` 导出，server 在 `lib.rs:618,649` 同款调用），请求构造复用 `routecodex-v3-provider-responses::probe::build_v3_provider_global_probe_request`。因此 admin crate 需新增 `routecodex-v3-runtime` 依赖（已声明，见 §5.1）。
4. **控制状态只承载于 typed resource**：observability 行里允许保存「attempt 当时 runtime 已判定事实」的**不可变诊断快照**（`error_class` / chain / `health_action` / `cooldown_until_ms` / `failure_count` / `next_provider_key` / `wait_ms` / `attempt_index`），但**不得**被读作当前控制状态；当前冷却/可用性唯一真源仍是 `v3.provider.key_health_state`（已在 `v3.observability.webui_store.semantic_contract` 登记该裁定）。

### 4.6 安全边界（新增）

admin 今日无鉴权且能写配置、能重启 daemon。新增变更端点必须：

- 强制回环 bind + `Host` / `Origin` 校验（防 DNS rebinding / 浏览器 CSRF）；判定式：`Host` 必须是 `127.0.0.1[:port]` / `localhost[:port]` / `[::1][:port]`；若带 `Origin`，其 host 必须是上述回环 host 之一。对**所有方法**生效。
- **所有** `POST` / `PUT` / `DELETE` / `PATCH` 要求 `x-routecodex-admin-token`，**无路径豁免**（`/validate`、`/health-test`、`/probe`、`/discover`、`/doctor` 同样要求——它们正是携带凭据的请求）。
- token 由 admin 启动时 provision 到 `<config_dir>/state/admin-token`（0600，32 字节随机十六进制），无 token 时变更请求 **fail closed 503**。
- 浏览器获取路径：同源 `GET /api/admin/session` → `{"token": "..."}`（GET，因此不需要 token），`app/core.js` 通过 `setAdminToken()` 注入后续请求头。该端点仍受 `Host`/`Origin` 回环判定约束。
- 所有输出路径（响应、日志、导出）密钥脱敏。

## 5. 新增/变更 API

### 5.1 依赖与资源登记（前置）

| 项 | 变更 | 理由 |
| --- | --- | --- |
| `routecodex-v3-admin/Cargo.toml` | `+ futures-util.workspace`、`+ routecodex-v3-runtime` | SSE body；复用 runtime 的 auth 解析 probe target（§4.5 约束 3） |
| `v3-resource-operation-map.yml` | `+ v3.admin.control_token`、`+ v3.admin.provider_candidate`、`+ v3.admin.provider_probe_result`、`+ v3.provider.directory_authoring` | 图 A/B 引用的全部资源 id 必须已登记（此前 8/12 未登记，属 review blocker B5） |
| `v3.observability.webui_store.semantic_contract` | `+ observed_control_facts_allowed_as_history: true`、`+ observed_control_facts_may_drive_current_control_state: false`、`+ current_control_state_source: v3.provider.key_health_state` | 记录 B8 裁定：诊断历史 ≠ 当前控制状态 |
| `v3-function-map.yml` | 收敛 `v3.observability_persistence_isolation` 的 `allowed_paths`（移除 admin 目录） | 消除与 `v3.admin_observability_aggregation` 的路径重叠（advisory A1） |

### 5.2 端点表

| Method | Path | 类型 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/admin/session` | 读（无 token） | 同源获取 admin token；仍受回环 Host/Origin 判定 |
| GET | `/api/environment` | 读 | 版本 / binary hash / 配置 hash / 受管实例 / listener（含 `build_version`） |
| POST | `/api/environment/doctor` | 读（需 token） | 逐项自检 + 修复提示 |
| POST | `/api/runtime/restart` | 变更 | `restart -c <active-config>`，结构化结果；不得静默成功 |
| GET | `/api/providers` | 读 | provider 列表；**不再带 `health` 字段**（§4.5 约束 1），仅保留作者态事实 |
| GET | `/api/providers/:id` | 读 | 单 provider 作者态详情；同样无 `health` 字段 |
| GET | `/api/providers/:id/health` | 读 | **只读**转发 `/_routecodex/health/cooldown-pool` 中该 provider 的冷却真值 + 内联诊断；不落任何新状态 |
| POST | `/api/providers/:id/health-test` | 读（需 token） | **认证**可达性诊断：复用与 `discover` 相同的认证上游调用（provider 自身凭据），返回 `AdHocHealthTestResult{provider_id,diagnostic,url,auth_mode,ok,status,latency_ms,error}`。**明确不是 provider health 真值**，不写任何 health 状态、不返回冷却字段；当前健康唯一读面是 `GET /api/providers/:id/health` |
| POST | `/api/providers/validate` | 读（需 token） | 候选校验，不落盘 |
| POST | `/api/providers` | 变更 | 显式创建（校验通过才写，正确 revision） |
| PUT | `/api/providers/:id` | 变更（改） | 补写前校验 + 修 revision 记账 |
| DELETE | `/api/providers/:id` | 变更 | 被引用时 409 + 列出引用 |
| POST | `/api/providers/discover` | 读（需 token） | 上游模型发现（不落盘；失败即显式失败，不猜测模型列表） |
| POST | `/api/providers/probe` | 读 + SSE（需 token） | 候选 L1/L2/L3 分级探测 |
| POST | `/api/providers/:id/probe` | 读 + SSE（需 token） | 已存在 provider 探测 |
| POST | `/api/providers/import` | 变更 | 批量导入，部分成功 + 可重试失败集 |
| POST | `/api/providers/routes/bind` | 变更 | 把 provider 绑定进 route pool；pool 不存在时创建默认 pool，`server_id` 未知时显式失败并列出已知 server（不猜测） |
| GET/PUT/DELETE | `/api/providers/:id/patrol` | 变更 | 定时巡检计划 CRUD（图 C） |
| GET | `/api/providers/:id/patrol/results` | 读 | 巡检历史（图 B 输出读面） |
| GET | `/api/providers/patrol/status` | 读 | 各 provider 的计划与上次运行状态（图 C C03） |
| POST | `/api/providers/:id/patrol/run` | 变更 | 手动触发一次巡检（图 B B02 的手动入口） |
| GET | `/api/observability/records/:request_key` | 读 | per-request 详情 |
| GET | `/api/observability/artifacts` | 读 | 列 artifact |
| GET | `/api/observability/artifacts/content` | 读 | 读单个 artifact（白名单文件名 + 规范化后仍在 samples 根内 + 大小上限） |
| GET | `/api/observability/stream` | 读 + SSE | 实时请求流（带游标，可续传） |
| POST | `/api/reload` | 变更（改） | 补 `-c <active-config>` |

### 5.3 端点删除/降级

| 端点/字段 | 处置 | 理由 |
| --- | --- | --- |
| `AppState::health_cache`、`ProviderHealthEntry`、`GET /api/providers(/:id)` 的 `health` 字段 | **删除** | 第二份 provider health 真相（review blocker B7）；改为读 runtime 冷却投影 |
| `GET /api/providers/:id/health` | 新增，读 runtime 冷却真值 | 唯一 health 读路径 |
| `POST /api/providers/:id/health-test` | 保留，明确标注为**认证**可达性诊断，结果只内联返回 | 现实现是无鉴权裸 `GET {base_url}/models`，对真实 provider 恒 401（与 §3 基线缺陷同源）；本次收敛为复用 `discover` 的认证上游调用，**唯一实现**，不得合并进 provider health |

## 6. 分阶段与验收

### 6.1 阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 | function/verification/resource map + 三张 DAG graph + feature-graph gate + 本方案落盘 | `npm run verify:v3-resource-map`、`npm run verify:v3-module-boundaries`、`npm run verify:function-map-compile-gate`、`npm run verify:v3-dagpipe-governance`、`npm run verify:v3-dagpipe-feature-graphs`、`npm run verify:v3-contract-map-owner` |
| P1 | admin token + Host/Origin 准入；provider 候选校验 / 创建 / 更新 / 删除 / 发现 / 探测 / 巡检后端；删除 `health_cache` | `CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-admin` |
| P2 | environment / doctor / lifecycle + `reload -c` 修复 | doctor 在 binary 漂移 / 端口冲突 / 死配置三种构造场景正确报 FAIL/WARN |
| P3 | Provider 向导 + 探测终端 + Deploy 页 + shell 导航 + 表单基建 | `npm run verify:webui-smoke`；页面无 console error |
| P4 | typed error 透传 + artifact 真实化 + per-request 详情 + SSE 流 + 冷却面板 + 具体 bug 修复 | 同入口重放真实失败样本，chain/cooldown/artifact 全部可见 |
| P5 | 全量 gate + build + install + restart + 真实入口 replay + 独立架构 review | 见 §7 |

### 6.2 图节点级验收（每条必须给出命令或真实入口 + 期望值）

| 节点 | 验收 |
| --- | --- |
| A01 admin token | 对 `POST`、`PUT`、`DELETE` **三种方法各一次**：无 token → 401/403；带 token 同请求 → 非 401；`Host: evil.test` → 403；`Origin: http://evil.test` → 403；无 token 供给时（`admin_token: None`）→ 503 `admin_token_unavailable` |
| A02 environment | `GET /api/environment` 的 `config_path` 等于 admin 启动时 `-c` 传入路径；`binary_sha256` 等于 `shasum -a 256 $(command -v rccv3)`；`POST /api/environment/doctor` 在构造的 build_version 漂移与端口冲突下分别报 FAIL/WARN |
| A03 models discovered | 对无凭据 base_url 调 `/api/providers/discover` → 返回 typed failure 且响应体不含任何模型名（不得猜测）；对真实凭据 → 返回上游真实模型名列表 |
| A04 candidate validated | 构造一个**未被任何 route 引用**的候选 → `POST /api/providers/validate` 返回 `ok:true` 且 `ls <config_dir>/provider/<id>` 不存在；再构造缺 auth handle 的候选 → 422 字段级错误且不落盘、不写 revision |
| A05 probe | `POST /api/providers/probe` SSE 依次出现 `stage_started`(L1/L2/L3) / `stage_result` / `probe_complete`；L3 失败时 `stage_failed` 带真实上游状态码；evidence 中无明文 key（断言含 `[redacted]`） |
| A06 authoring committed | 创建成功后 `provider/<id>/config.v2.toml` 存在，且 revision 记录里 `source_sha256` 是真实前内容 sha256、`backup` 指向真实备份（不再是 `"provider-file"`） |
| A07 route pool bound | 目标 **标准** pool 不存在时 `POST /api/providers/routes/bind` 创建该 pool 并返回 `pool_created:true`、新 tier；pool 已存在时返回追加/替换后的 tier 列表且 `pool_created:false`、`tier_created` 反映真实情况；同一成员以不同 weight 重绑 → **原地替换**（tier 内成员数仍为 1）；相同重绑 → `already_bound:true, written:false` 且不新增 revision；未知 `server_id` → **404 `unknown_server`** 并返回 `known_servers` 列表；未知/不可解析 `model` → **422 `model_not_declared`** 并列出已声明模型，空 model 且无 `default_model` → **422 `model_required`**；非标准 pool 名 → **422 `route_compile_failed`** 且点名该 pool（`default` 对每个 server 强制存在，仅 `STANDARD_ROUTE_POOLS` 合法）；上述失败路径均**不写盘、不产生 revision**；revision 记录携带调用方 `reason` 原文 |
| A08 runtime applied | `POST /api/runtime/restart` 返回 `{ok,exit_code,stdout_tail,stderr_tail,duration_ms}`；`rccv3 status -c <config_path>` 变 `running` 且 `/health` 的 `build_version` 等于新 binary 版本；CLI 不可解析时 `ok:false` 且错误文本说明未尝试重启 |
| A09 e2e verified | 经真实 listener 发一次成功请求 + 一次失败请求，`GET /api/observability/records/:request_key` 能取到对应行、六节点链齐备、`raw_artifact_ref` 指向真实存在的样本目录且 artifacts 报告的 `size_bytes` 与磁盘一致；负向对照：未知 key → 404 `request_not_found`。**注意**：relay 车道的 `health_action`/`error_class` 为 `null` 并带显式标记 `error06_projection_not_exposed`（见 §9.4 边界 A），验收不得要求该车道给出非空 `health_action`；direct 车道要求真实非空 |
| A10 provider removed | 被 route 引用的 provider `DELETE` → 409 + 引用列表；未被引用的 → 删除且备份**在删除后仍存在**（备份不得落在被删目录内） |
| B01–B02 patrol tick | 设置 60s 计划后，`<config_dir>/state/provider-patrol.jsonl` 在 ≤2 个周期内出现新行；`POST /api/providers/:id/patrol/run` 可手动触发同一路径 |
| B03 patrol probe | 巡检行的 stage 结果与手动 `/api/providers/:id/probe` 对同一 provider 的结论一致（同一构造链） |
| B04 patrol result recorded | 巡检后 `GET /api/providers/:id/patrol/results` 返回该行；且 `GET /_routecodex/health/cooldown-pool` 的冷却状态**未被巡检改变**（advisory 断言） |
| C01–C02 plan declared/read back | `PUT /api/providers/:id/patrol` → `GET /api/providers/:id/patrol` 返回同一计划；`<config_dir>/state/provider-patrol-plans.json` 内容与响应一致 |
| C03 plan armed | `GET /api/providers/patrol/status` 返回该 provider 的计划与上次运行时间；未配置计划的 provider 显示为未武装而非默认武装 |
| C04 plan disarmed | `DELETE /api/providers/:id/patrol` → `GET` 返回未配置；此后不再产生新的巡检结果行 |

## 7. 证据分级（不得跨级推断）

1. source：`CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml --workspace --no-fail-fast` + `npm run verify:v3-architecture-ci` + `npm run verify:webui-smoke` + `npm run verify:v3-dagpipe-governance`
2. candidate：本 worktree（基于 `origin/main` @ `ebe3a3c6d`）
3. build/install：`npm run install:v3`，记录 binary sha256
4. restart/health：`rccv3 restart -c ~/.rcc/config.toml` → `status` running → 全 listener `/health` 且 `build_version` 匹配
5. live replay：同入口重放（真实成功 + 真实失败 + provider 切换），验证 WebUI 行 / 错误链 / 冷却 / artifact 一致
6. review：独立架构 review PASS 后 merge/push

注：`verify:v3-architecture-ci` 的 STEPS **不含** `verify:v3-dagpipe-governance`（该治理只在 `.github/workflows/test.yml` 单独跑），因此 P0/P5 必须显式单列它，不得依赖 umbrella gate 覆盖。`verify:v3-dagpipe-feature-graphs` 相反：它已进入 umbrella STEPS、`verify:ci` 与 `build:v3-cli` 前置，并在 `test.yml` 有独立步骤，因此不再需要单独手跑（仍可单列以取得直接输出）。
另注：`verify:server-function-map-boundary` 当前在 `origin/main` 上即 FAIL（**16** findings，引用了 function map 里不存在的 feature），属既有失效 gate，不作为本方案 P0/P5 判据，也不得用它掩盖本方案回归。

## 8. 风险

| 风险 | 对策 |
| --- | --- |
| function-map 未登记新文件被 gate 挡下 | P0 先行，登记 `v3/admin-webui/` 全量 + admin crate 全量 |
| 候选校验需绕过「只编译被引用 provider」 | 新增候选级校验入口；候选不持久化，仅在 OS 临时目录物化一次性 authoring 树并在结束后删除 |
| 探测需要真实凭据，可能泄露到 UI/日志 | 统一脱敏层；断言测试覆盖 |
| admin 无鉴权 + 新增变更端点 | 本地 token + Host/Origin 校验 |
| 零构建前端文件膨胀 | 模块化拆分，新增 `app/form.js` / `app/probe.js` |
| 与并发 worktree 冲突 | 本任务独占 worktree；写入范围按任务卡切分 |

## 9. 设计准入复审记录（编码前门禁）

第一次独立设计准入 review 结论为 **FAIL**（10 blockers / 8 advisories）。逐项处置如下；本节的处置即复审对象。

| # | 结论 | 处置 |
| --- | --- | --- |
| B1 | 产品代码早于门禁 PASS；review 期间设计产物被改动 | **承认违规**。已在门禁前写入的 `routecodex-v3-admin` 模块为**非功能脚手架**：`auth::require_admin` 是 pass-through、`AdminToken::load_or_create` 返回 `Unsupported`、三个新模块的 `routes()` 返回空 `Router`，因此当时没有任何新端点可达。本方案冻结后重新提交 review；PASS 之前不再新增产品行为。后续所有设计改动只走本文件 + `docs/architecture/*` 的版本化提交，不再与 review 并发。 |
| B2 | 把图移出 `docs/architecture/dagpipe/` 是绕过治理，不是合规 | **已补真实 gate（第二轮升级）**。`verify-v3-dagpipe-governance.mjs` 与 `modules.json` 被硬编码为「只治理代理流水线的 request/response/error 三张图」，且要求 `manifest.target == v3-proxy-pipeline-target.md`；把控制面图登记进该 manifest 会**虚假声明**它属于代理流水线对象源，是更严重的失真。因此控制面图放在 `docs/architecture/dags/`，并新增 `npm run verify:v3-dagpipe-feature-graphs`（`v3/scripts/architecture/verify-v3-dagpipe-feature-graphs.mjs`）：枚举 `docs/architecture/dags/*.graph.json`，逐张 `dagpipe graph validate`，任一失败或目录为空即失败。该 gate 已登记进 `v3-verification-map.yml` 与本 feature 的 `required_gates`，因此不再是「只写在方案里的手工命令」。 |
| B3 | 图遗漏 5 项交付 | **第二轮重做**：图 A 重编号为 A01–A10 并全部改用真实符号；token→A01、discover→A03、delete→A10、pool bind→A07；import 明确归入 A03–A06 的重复执行（不新增节点，避免第二入口）；**patrol 计划 CRUD 独立成图 C**（原「移入图 B」是错的：图 B 唯一入口是定时器 tick，operator 计划写并入会制造第二入口）。§4.1.1 给出 §5.2 全部端点逐项归属，§4.1.1 覆盖 doctor / health / health-test / stream / reload / patrol results 等此前未归属端点。 |
| B4 | 定时器源与 operator 源混在一条链；observability 行生产不属于本图 | 已拆为图 A（operator 源）/ 图 B（scheduler 源）两张 SESE 图，第二轮再补图 C（operator 计划源）；observability 行生产移出本方案图，本方案只作读方（§4.3）。图 B 对图 A 的 `v3.provider.directory_authoring` 单向依赖已在 §4.2 显式声明。 |
| B5 | 12 个引用资源中 8 个未登记；n08 跨 owner 写 | 已登记 `v3.admin.control_token` / `v3.admin.provider_candidate` / `v3.admin.provider_probe_result` / `v3.provider.directory_authoring`；图 A 只引用已登记 id；A10 改为纯 `reads`（无 `writes`），不再跨 owner 写 `v3.observability.webui_store`。 |
| B6 | P4 的服务端 owner 未具名 | 已在 §1.1 具名：`v3.server_internal_observability_projection`（行结构 / `raw_artifact_ref`）与 `v3.observability_persistence_isolation`（store / `sample_store` 布局）为共同 owner。 |
| B7 | 第二份 provider health 真相仍保留 | 已在 §5.3 列为**删除项**：`ProviderHealthEntry` / `AppState::health_cache` / `GET /api/providers(/:id)` 的 `health` 字段；health 只读 runtime 冷却真值；patrol 结果声明为 advisory。 |
| B8 | 控制状态被写进诊断 payload store | 已在 `v3.observability.webui_store.semantic_contract` 记录裁定：行内只保存 attempt 当时的**不可变诊断快照**，`observed_control_facts_may_drive_current_control_state: false`，当前控制状态唯一真源 `v3.provider.key_health_state`（§4.5 约束 4）。 |
| B9 | token 资源未登记、浏览器获取路径未定义 | 已登记 `v3.admin.control_token`，`owner_node` 在第二轮改为真实符号 `require_admin`，`allowed_readers` 改为 `[require_admin, admin_session]`；§4.6 写明获取路径 `GET /api/admin/session`、判定式（回环 Host + 回环 Origin + 变更方法要求 token）、fail-closed 503。**第二轮补威胁模型诚实说明**：0600 文件模式是纵深防御而非信任边界；真实边界是「回环可达 + 浏览器同源策略（admin crate 未注册任何 CORS 层）」。本机任意进程都能从 session 端点取到 token 并驱动全部变更端点；远端页面取不到（rebinding 的 Host 被拒，跨源读取被 SOP 阻断）。该说明已写进资源契约的 `threat_boundary_note`。 |
| B10 | route pool 绑定未交付，出口不可达 | 已新增 `POST /api/providers/routes/bind`（§5.2）并在 §6.2 A07 给出验收。**第三轮更正（上一轮记录本身已过期）**：当时记录为「三个默认 pool 构造器」，实际现已收敛为**两个**——`new_default_pool_view`（`config-mgmt/src/route.rs`，pub，`RoutePoolView`）与 `new_default_user_route_pool`（同文件，private，`V3UserRoutePool`）；admin 侧内联构造 `UserRoutePoolView` 已删除，`bind_provider_to_route` 改为委托 Config Core 的 `bind_user_route_member`。两者是**不同类型/不同对象模型**（route pool view vs user route pool），是否构成消融违规需按类型契约判定，本方案不再声称其为违规，但要求 A07 验收证明绑定结果落在 user route 真源上。 |

Advisories 处置：A1 已收敛 `v3.observability_persistence_isolation` 的 `allowed_paths`（§5.1）；A2/A8 验收命令已改为可运行形式并补 dagpipe gate（§6.1）；A3 已在 §7 注明 umbrella gate 不含 dagpipe；A4 已在 §7 注明该 gate 在 `origin/main` 上即 FAIL、不作为本方案判据；A5 已把 probe target 构造器改为 `routecodex-v3-runtime::build_v3_provider_global_probe_target` 并声明新增依赖（§4.5 约束 3、§5.1）；A6 已具名候选编译入口（§4.5 约束 2）；A7 **第二轮已修**：`entry_symbols` 全部改为真实存在的符号（`require_admin`、`build_environment`、`discover_models`、`validate_provider`、`probe_candidate`、`create_provider`、`bind_provider_to_route`、`restart_runtime`、`delete_provider`、`put_plan`/`get_plan`/`delete_plan`/`patrol_status`、`run_due`、`run_now`、`run_probe` 等）。

### 9.1 第二轮复审（FAIL）处置

第二次独立设计准入 review 仍为 **FAIL**，新增 N1–N6 与 A1/A4 更新。逐项处置：

| # | 结论 | 处置 |
| --- | --- | --- |
| N1 | 设计门禁与产品实现并发，无冻结候选 | **承认为真实流程冲突，并记录裁定**。用户已明确指示「落盘且开始完成，使用团队并发处理」，该直接指令优先于默认流程策略；因此并行实现继续，但门禁结论必须如实记录为「设计产物冻结、实现并行推进」。设计产物侧已冻结：本文件、三张图、三张 map 的改动全部走文档路径，不再与 review 并发变更语义。所有实现证据在最终交付时绑定到精确候选 SHA。 |
| N2 | `verify:v3-module-boundaries` FAIL（`probe.rs` 用 reqwest） | **已修**：`discover_v3_provider_models` 移到允许面 `provider-responses/src/transport.rs` 并从 `lib.rs` re-export，`probe.rs` 零 `reqwest` token；未放宽白名单。gate 现为 `ok`。 |
| N3 | patrol 计划 CRUD 无节点，且并入图 B 会破坏 SESE | **已修**：新增图 C `v3.admin_provider_patrol_plan`（operator 计划源，4 节点），计划与结果拆为两个资源（`v3.admin.provider_patrol_plan` / `v3.admin.provider_patrol`）。 |
| N4 | `provider-responses/src/probe.rs` 同时属于两个 feature 的 allowed_paths | **已修**：从 `v3.admin_observability_aggregation.allowed_paths` 移除 `probe.rs`；改为声明 `cross_feature_extensions`（`config-mgmt/src/provider.rs` → `v3.config_management`，`provider-responses/src/transport.rs` → `v3.provider_global_subscription_probe`），单一 owner 保持唯一。 |
| N5 | `v3.config_management` 只在 verification map 有、function map 没有；三个自有资源未绑定 | **已修**：在 `v3-function-map.yml` 新增 `v3.config_management` feature（owner_crates / owner_files / resource_bindings / entry_symbols / allowed_paths / required_gates）；`v3.admin_observability_aggregation.resource_bindings` 补齐 `v3.admin.control_token`、`v3.admin.provider_candidate`、`v3.admin.provider_probe_result`。 |
| N6 | 15 个节点 operator 中 10 个符号不存在 | **已修**：三张图全部改用真实符号（见 §4 引文与 §9.1 上文），并保留 `dagpipe graph validate` 的「operator 绑定仅语法存在」这一事实陈述——本仓库目前没有 operator 注册表，因此不声称 operator 可解析。 |

第二轮 advisory 处置：A1（round-2 新增的 probe.rs 双归属）随 N4 修复；A2 的 `v3-verification-map.yml:186` 裸 `cargo test -p routecodex-v3-admin` 已改为 `--manifest-path` 形式（同处 `routecodex-v3-config-mgmt` 一并修正）；A4 计数由 14 更正为 16；A6/§8 中「合成内存编译，不落盘」的说法已按实现更正为「候选本身不持久化；为复用真实 compile 路径会在 OS 临时目录物化一次性 authoring 树并在结束后删除」，并写进 `v3.admin.provider_candidate` 的语义契约；A7 的 `providers-onboarding-smoke.mjs` 由 provider-vertical 产出后接入 `verify:webui-smoke`。

### 9.2 设计产物冻结快照（第三轮复审对象）

本文件**不能把自身 sha256 钉在自身内部**：任何写入都会改变该值，钉住即自指且结构上不可验证（第二轮记录正是踩了这个坑）。因此本节只钉住**对等设计产物**的 sha256；本文件自身的 sha256 由 reviewer 在复审时对冻结提交实测记录，并写入交付证据（`git` 提交号 + 实测值），不在文件内自称。

```text
e2c1da23dd220e1e85376e78dc712e21922c5fddabbe84b3017df48b496550ec  docs/architecture/dags/v3.admin_provider_onboarding.graph.json
a30ba6fa071fa26d01fcda65d0cae272f506adcd61249673d552b098874067b1  docs/architecture/dags/v3.admin_provider_patrol.graph.json
60225a10715d4017b41f6ed037460d97f88e2b31d9aea752a9c7270a6048bf67  docs/architecture/dags/v3.admin_provider_patrol_plan.graph.json
05129713f33d1e028e1cc4b4feb35a9b45a444c5177de75af3de5eb357525f94  docs/architecture/v3-resource-operation-map.yml
5cd95bb8a067991623d1e312c7b6f0919bbe064081eb449fb93b98b266818396  docs/architecture/v3-function-map.yml
3e32caea929a530bd5dcfc3851c5d122af340bb1656effcf80a2a8332a22ae40  docs/architecture/v3-verification-map.yml
e9b034ffcc6fccc7d8780106ba1750e37d806e821e841db9a7d967c11f0814bb  v3/scripts/architecture/verify-v3-dagpipe-feature-graphs.mjs
2cfdff1eeac89fb6e4a39793bd508f6952e5be64a5a0013c04115c6cc2870651  v3/scripts/architecture/verify-v3-architecture-ci.mjs
44eb30597b78ea5bf78ddf21e3db20c3584492b071d454cdd7f8f3818bef3023  scripts/architecture/verify-function-map-compile-gate.mjs
f93be7cded3c483322845670fb67d7d39e0b6d9c0a8d7f5e0f22478ef24e834b  .github/workflows/test.yml
195c586baed9f333e52bd743d7932ee3d45ec00886da09a0673e05877eddd99e  v3/package.json
```

上述哈希在把本分支 rebase 到最新 `origin/main`（`b7db02e2f`，含并发任务的 chat/anthropic 改动与 Target10 context admission 改动）之后重算；三张 map 的哈希因 main 侧编辑而变化，本分支改动叠加在其上。

冻结时 P0 全绿（实跑输出）：

```text
verify:v3-resource-map            -> [verify:v3-resource-map] ok
verify:function-map-compile-gate  -> [verify:function-map-compile-gate] ok: 84 features, 84 verification features
verify:v3-module-boundaries       -> [verify:v3-module-boundaries] ok
verify:v3-dagpipe-governance      -> [v3-dagpipe] governance checked; 3/3 static graphs registered
verify:v3-dagpipe-feature-graphs  -> [v3-dagpipe-feature-graphs] governed 3 feature graph(s)
verify:v3-contract-map-owner      -> [verify:v3-contract-map-owner] ok
```

### 9.3 第三轮复审（FAIL）处置

第三次独立设计准入 review 结论为 **FAIL**，新增 NB1–NB6。逐项处置：

| # | 结论 | 处置 |
| --- | --- | --- |
| NB1 | 门禁与实现并发，无冻结候选 SHA | **不辩解，如实记录为未满足**：编码前设计准入门禁在本轮**未被满足**。用户的直接指令（「落盘且开始完成，使用团队并发处理不冲突任务」）是并行实现的授权来源，但它只能授权流程偏离，**不能把编码前门禁追溯转换成编码后审计**。因此：设计产物侧已冻结（§9.2），实现侧证据必须在最终交付时绑定到精确候选 SHA；本方案不再声称「门禁已 PASS」。 |
| NB2 | `verify:v3-dagpipe-feature-graphs` 无任何自动执行方 | **已修**：加入 `verify-v3-architecture-ci.mjs` 的 STEPS（紧随 `verify:v3-resource-map`），因此进入 `v3/scripts/verify.mjs` 的 architecture-ci 步骤 → `verify:ci`（CI 的 `npm --prefix v3 run verify:ci`）以及 `build:v3-cli` 前置；同时在 `.github/workflows/test.yml` 增加独立步骤，紧随 `verify:v3-dagpipe-governance`。 |
| NB3 | `cross_feature_extensions` 是无人读取的自造键 | **已修**：`scripts/architecture/verify-function-map-compile-gate.mjs` 现在校验该键：每条必须含 `path`/`owner_feature_id`/`reason`；`owner_feature_id` 必须存在于 function map；不得自指；路径必须真实存在；同一路径不得被两个 feature 同时声明为扩展；声明者不得把该路径同时列入自身 `allowed_paths`（那是拥有而非扩展）。已用负向探针验证该 gate 会失败（改坏 `owner_feature_id` → FAIL 并给出精确条目）。**仍未做**：`allowed_paths` 之间的重叠本身没有通用校验（历史上有约 10 个 feature 同时列 `transport.rs`），本轮不改历史归属，仅保证本次新增走显式扩展声明。 |
| NB4 | `v3.admin.provider_patrol_plan` 已登记 owner 但未进 `resource_bindings` | **已修**：`v3.admin_observability_aggregation.resource_bindings` 补入该 id（现为 7 项）。 |
| NB5 | 8 处图效果与资源 `allowed_writers`/`allowed_readers` 矛盾，且 `v3.admin.environment` 的 `owner_node`/`allowed_readers` 指向**不存在的符号** | **已修，并补上自动门禁**：`v3.admin.environment.owner_node` 由 `read_admin_environment` 改为 `build_environment`，`allowed_readers` 改为 `[build_environment, environment, doctor, admin_session]`（原 `read_admin_environment`/`read_admin_doctor_report` 在源码中不存在，属虚假绑定）；`v3.lifecycle.status_record` 补 `restart_runtime`；`v3.provider.directory_authoring` 补 `bind_provider_to_route`、`run_now`、`PatrolRuntime::run_due`；`v3.admin.provider_probe_result` 补 `PatrolRuntime::run`；`v3.admin.provider_patrol` writers 补 `PatrolRuntime::run`；`v3.admin.provider_patrol_plan` readers 补 `put_plan`、`delete_plan`、`PatrolRuntime::run_due`。**并且 `verify:v3-dagpipe-feature-graphs` 现已交叉校验「图节点效果 vs 资源 allowed_*」**：节点 operator 的末段符号必须出现在所读资源的 `allowed_readers` 或所写资源的 `allowed_writers` 中，未知资源 id 直接失败。该门禁在本轮就抓出了一处真实漏配（`PatrolRuntime::run_due` 读 `v3.admin.provider_patrol_plan`），已修。 |
| NB6 | §9.2 钉住本文件自身 sha256，自指且不可验证 | **已修**：改为只钉对等产物（§9.2），本文件自身哈希由 reviewer 实测并写入交付证据。 |

N6 残留：18 个 operator 中最后一个模块路径错误——`routecodex.v3.debug.webui_observability.v3_webui_observability_read_raw_rows` 的符号实际在 `routecodex-v3-debug/src/observability_store.rs`（该 crate 没有 `webui_observability` 模块）。**已修**为 `routecodex.v3.debug.observability_store.v3_webui_observability_read_raw_rows`。

B3 残留：§5.2 现已补入 4 个此前遗漏的端点（`GET /api/providers`、`GET /api/providers/:id`、`GET /api/providers/:id/health`、`POST /api/providers/:id/health-test`），§4.1.1 同步归属到 A02。

B10：上一轮记录本身已过期，已按当前实现更正（见 §9.1 B10）。

advisory：§4.2.1 已补声明图 C 对 `v3.admin.provider_patrol` 的单向读依赖。

### 9.4 实现阶段发现的真实缺陷、已修项与已知边界

实现（用户授权并行进行）过程中发现并修复了**两个真实缺陷**，另有若干必须如实报告的边界。这些不是设计推演，而是真实入口回放暴露出来的：

| 项 | 事实 | 状态 |
| --- | --- | --- |
| 缺陷 1：relay 各分支在错误链投影**之前**就 `return provider_terminal_response(...)` | 真实 provider 失败时，observability 行 `chain: []`、六个 Error 节点全部 `not_reached`、**且完全不产生样本目录**。即「错误可观测性」在最关键的失败路径上其实是空的。 | **已修**：在 `live_snapshot.rs` 抽出 `persist_v3_responses_relay_terminal_error_evidence` + `project_v3_responses_relay_error_chain`（既有 closeout 行为不变），并在 `endpoint_handlers.rs` 的**三个** Responses 终态分支（962/1101/1309）全部接线，保证同一入口不会因分支不同而行为不同。 |
| 缺陷 2：`raw_artifact_ref` 修完缺陷 1 后仍为 `null` | `persist_v3_error_evidence_payload → enqueue_persist` 是**异步**的，行记录时解析必然输给落盘竞态。 | **已修**：改为在**读取时**解析（`routecodex-v3-admin/src/api/observability.rs` 的 detail + list），复用同一布局函数；目录不存在仍返回 `None`，绝不伪造。 |
| 缺陷 3：`POST /api/providers/:id/health-test` 是**无鉴权**裸 `GET {base_url}/models` | 与 §3 记录的基线缺陷同源，对真实 provider 恒 401 → 「测试接入」按钮永远失败。 | **已修**：收敛为复用 `discover` 的**同一**认证上游入口（provider 自身凭据）；已用 mock TCP 上游断言出站请求确实带 `authorization: bearer …`，并覆盖 401 诚实失败与「无凭据」显式诊断两种负向路径。 |
| 边界 A：relay 车道的 `health_action` / `error_class` 为 **null** | `V3ResponsesRelayRuntimeOutput` 只携带链**节点名**（`error_chain: Option<Vec<&'static str>>`），不携带 typed `V3Error06ClientProjected`，因此该车道记录显式标记 `error06_projection_not_exposed`。**这是诚实标记，不是空值伪装**。 | **未修，记为后续独立任务**：修复需给该 struct 加字段，牵动 runtime/server **20 处 struct literal**。**明确拒绝**从 `action`/`health_state` 字符串反推 `health_action`——那正是规则禁止的 admin 层重新分类。direct 车道（`impl_bulk.rs`）仍持有真实 typed truth。失败身份由真实数据证明：冷却池条目 `provider_id=mock / auth_alias=key / model_id=test` + `failure_count=1` + `cooldown_until_ms`。 |
| 边界 B：openai_chat / anthropic / gemini 的 relay 终态分支 | 与缺陷 1 同型的短路存在于 `endpoint_handlers.rs` 543/646/756，且这些分支的 closeout **完全不持久化错误证据**。本轮未改（无测试证明其行为）。 | **未修，记为后续任务**。本轮只修复有真实回放证据的 Responses 路径，不扩大改动范围。 |
| 边界 C：`discovery_upstream_status()` 从 transport error 的 `reason` 字符串解析上游状态码 | 脆弱耦合到错误消息文本；解析不到时返回 `None` 而非猜测。 | **advisory**：理想做法是让 typed error 直接携带 status 字段；本轮不动 provider-responses 的错误类型。 |
| 边界 D：SSE `seq = updated_epoch_ms` | 同一毫秒内更新的两行若正好跨重连边界，理论上可被跳过。 | **接受的 v1 限制**，已记录，不为此发明全局计数器。 |

真实入口回放证据（`routecodex-v3-server/tests/observability_admin_replay.rs::failing_provider_request_leaves_real_typed_truth_cooldown_and_artifacts`）：真实编译配置 + 真实 listener + mock 上游真实返回 503（恰好调用 1 次）→ 经**真实 admin HTTP 端点**取回：六节点链（V3Error06 `code:"502"`）、冷却池 `state=blocked`、`until_ms = 请求开始 + 5000ms`（阶梯首档）、`raw_artifact_ref` 指向真实存在的样本目录且 `request.json=89B`、`error.json=2351B` 与文件系统元数据一致；负向对照：未知 `request_key` → 404 `request_not_found`，且 per-attempt 行 `chain=[]` 而合并终态链 6 节点均为 `observed`（证明链是按车道推导而非常量）。

## 10. 非目标补充（对 B3/B10 的边界）

- `POST /api/providers/import` 不新增独立 DAG 节点：它是同一对象源对多候选的重复执行。
- WebUI 不提供 provider 级 OAuth、不提供 binary 升级、不提供任意文件读取；`/api/observability/artifacts/content` 只允许 5 个白名单文件名。
