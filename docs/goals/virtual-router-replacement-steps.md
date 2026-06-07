# Virtual Router 安全替换步骤清单

基于审计报告：docs/goals/virtual-router-full-rustification-audit.md

---

## Phase 0：死代码清理（可立即执行，无风险）

### Step 0.1：删除 10 个零引用 TS 文件

**改什么**：删除以下文件
- `src/router/virtual-router/load-balancer.ts`（185 行）
- `src/router/virtual-router/health-weighted.ts`（92 行）
- `src/router/virtual-router/context-advisor.ts`（91 行）
- `src/router/virtual-router/context-weighted.ts`（82 行）
- `src/router/virtual-router/success-center.ts`（75 行）
- `src/router/virtual-router/stop-message-stage-template-files.ts`（86 行）
- `src/router/virtual-router/default-thinking-keywords.ts`（13 行）
- `src/router/virtual-router/routing-stop-message-parser.ts`（8 行）
- `src/router/virtual-router/routing-pre-command-parser.ts`（102 行）
- `src/router/virtual-router/message-utils.ts`（250 行）

**为什么改**：grep 确认 0 引用，属于死代码，违反 AGENTS.md 第 10 条（冗余代码物理移除）

**改后验证**：
1. `npm run build:dev` 通过
2. `grep -rn "from.*load-balancer\|from.*health-weighted\|from.*context-advisor\|from.*context-weighted\|from.*success-center\|from.*stop-message-stage-template-files\|from.*default-thinking-keywords\|from.*routing-stop-message-parser\|from.*routing-pre-command-parser\|from.*message-utils" --include='*.ts' src/` 返回空

**对应测试**：`tests/sharedmodule/virtual-router-*.spec.ts`

### Step 0.2：确认 token-file-scanner.ts 和 token-estimator.ts 死代码

**改什么**：检查引用，如确认死代码则删除
- `src/router/virtual-router/token-file-scanner.ts`（131 行，0 引用，2026-06-07 Phase 8F-4 已删）
- `src/router/virtual-router/token-estimator.ts`（21 行，0 引用）

**为什么改**：grep 确认 0 引用

**改后验证**：build 通过

**Checkpoint 0**：`npm run build:dev` + `npm run jest:run -- --runTestsByPath tests/sharedmodule/virtual-router-*.spec.ts`

---

## Phase 1：Rust bootstrap.rs block 拆分（Rust-only，TS 不动）

所有步骤在 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/` 下操作。

### Step 1.1：抽取工具函数到 `routing/utils.rs`

**改什么**：从 `bootstrap.rs` 抽出以下函数到新文件 `routing/utils.rs`
- `scalar_to_trimmed_string`（L834）
- `parse_bool_like`（L937）
- `normalize_positive_i64`（L948）
- `normalize_json_number`（L961）
- `display_pool_id`（L78）

**为什么改**：工具函数不属于任何 block，独立复用，减少 bootstrap.rs 粒度

**改后验证**：`cargo test -p router-hotpath-napi virtual_router_engine` 通过

**对应测试**：`bootstrap.rs` 内已有 tests（L980-L1105）

### Step 1.2：抽取 `routing/source_normalizer.rs`

**改什么**：从 `bootstrap.rs` 抽出 `normalize_routing` 函数（L121）
- 输入：`&Map<String, Value>`（原始 routing config）
- 输出：`Vec<(String, Vec<NormalizedRoutePoolConfig>)>`

**为什么改**：routing 归一化是独立 block，职责边界清晰

**改后验证**：cargo test 通过

**对应测试**：bootstrap.rs 内 tests

### Step 1.3：抽取 `routing/target_expander.rs`

**改什么**：从 `bootstrap.rs` 抽出以下函数
- `expand_routing_table`（L168）
- `build_legacy_route_pool`（L390）
- `normalize_route_pool_entry`（L404）
- `normalize_simplified_weighted_route`（L505）
- `normalize_simplified_weighted_target`（L548）
- `normalize_route_targets`（L718）
- `normalize_target_list`（L814）
- `parse_route_entry`（L869）
- `split_model_priority`（L913）
- `build_runtime_key`（L933）

**为什么改**：target 展开是独立 block

**改后验证**：cargo test 通过

**对应测试**：bootstrap.rs 内 tests

### Step 1.4：抽取 `routing/target_validator.rs`

**改什么**：从 `bootstrap.rs` 抽出 `has_explicit_route_targets`（L791）
- 输入：`&Map<String, Value>`
- 输出：`bool`

**为什么改**：校验是独立 block

**改后验证**：cargo test 通过

### Step 1.5：抽取 `routing/pool_sorter.rs`

**改什么**：从 `bootstrap.rs` 抽出以下函数
- `infer_route_pool_mode_from_config`（L619）
- `normalize_weighted_strategy`（L694）
- `normalize_route_pool_mode`（L706）
- `normalize_priority_value`（L856）
- `resolve_pool_strategy`（L67）

**为什么改**：排序是独立 block

**改后验证**：cargo test 通过

### Step 1.6：抽取 `routing/param_resolver.rs`

**改什么**：从 `bootstrap.rs` 抽出以下函数
- `normalize_route_params`（L566）
- `normalize_thinking`（L594）
- `normalize_route_pool_load_balancing`（L666）
- `read_route_policy_group`（L57）

**为什么改**：参数解析是独立 block

**改后验证**：cargo test 通过

### Step 1.7：重写 `routing/bootstrap.rs` 为纯编排

**改什么**：`bootstrap.rs` 只保留 `bootstrap_virtual_router_routing_json` 入口（L94），内部调用 5 个 block
- 调用 source_normalizer 归一化
- 调用 target_expander 展开
- 调用 target_validator 校验
- 调用 pool_sorter 排序
- 调用 param_resolver 解析参数

**为什么改**：入口变纯编排，职责单一

**改后验证**：cargo test 通过

**Checkpoint 1**：`cargo test -p router-hotpath-napi virtual_router_engine` + `npm run build:dev` + shadow regression

---

## Phase 2：Rust health.rs 三层分离

所有步骤在 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/` 下操作。

### Step 2.1：抽取 `health/state_store.rs`

**改什么**：从 `health.rs` 抽出以下方法到新文件 `health/state_store.rs`
- `configure`（L93）
- `register_providers`（L109）
- `clear_runtime_state`（L398）
- `clear_imported_persisted_state`（L414）
- `export_persistable_state`（L435）
- `import_persistable_state`（L457）

**为什么改**：状态持久化与策略判定分离

**改后验证**：cargo test 通过

**对应测试**：health.rs 内 tests（L661-L709）

### Step 2.2：抽取 `health/policy.rs`

**改什么**：从 `health.rs` 抽出以下方法到新文件 `health/policy.rs`
- `record_failure`（L134）
- `cooldown_provider`（L164）
- `cooldown_provider_until_midnight_persisted`（L186）
- `record_success`（L207）
- `clear_windsurf_managed_persisted_503_family`（L224）
- `trip_provider`（L250）
- `is_available`（L273）
- `cooldown_remaining_ms`（L311）
- `is_persisted_503_daily_cooldown_active`（L321）
- `consume_persisted_503_reprobe_if_available`（L339）
- `record_http_502_failure`（L504）
- `record_http_429_failure`（L527）
- `record_recoverable_failure`（L580）

**为什么改**：策略判定独立，降低 ProviderHealthManager 总管化趋势

**改后验证**：cargo test 通过

### Step 2.3：重写 `health.rs` 为 facade

**改什么**：`health.rs` 只保留以下 facade 方法
- `new`（L86）
- `snapshot`（L299）
- `describe_state`（L378）
- `config`（L394）

加上对 `state_store` 和 `policy` 的调用转发。

**为什么改**：facade 只做调度，不承载业务逻辑

**改后验证**：cargo test 通过

**Checkpoint 2**：`cargo test -p router-hotpath-napi virtual_router_engine` + `npm run build:dev` + focused regression

---

## Phase 3：Rust 模块显式 I/O struct 补充

### Step 3.1：为 engine/core.rs 补充 CoreInput/CoreOutput

**改什么**：定义 `CoreInput` 和 `CoreOutput` struct，包裹 `initialize`, `refresh_provider_health_from_store`, `persist_provider_health` 等方法的参数

**为什么改**：显式 I/O contract 使 block 边界清晰，可独立测试

**改后验证**：cargo test 通过

### Step 3.2：为 engine/route.rs 补充 RouteInput/RouteOutput

**改什么**：定义 `RouteInput` 和 `RouteOutput` struct，包裹 `route`, `get_stop_message_state`, `get_pre_command_state` 的参数

**改后验证**：cargo test 通过

### Step 3.3：为 engine/selection.rs 补充 SelectionInput/SelectionOutput

**改什么**：定义 `SelectionInput` 和 `SelectionOutput` struct，包裹 `apply_standard_filters`, `select_provider`, `is_provider_available` 的参数

**改后验证**：cargo test 通过

### Step 3.4：为 engine/events.rs 补充 EventInput/EventOutput

**改什么**：定义 `EventInput` struct，包裹 `handle_provider_success`, `handle_provider_failure`, `handle_provider_error` 的参数

**改后验证**：cargo test 通过

### Step 3.5：为 routing/selection.rs 补充 SelectionInput/SelectionOutput

**改什么**：定义 `SelectionInput` 和 `SelectionOutput` struct，包裹 `filter_candidates_by_state`, `resolve_instruction_target` 的参数

**改后验证**：cargo test 通过

### Step 3.6：为 routing/metadata.rs 补充 MetadataInput/MetadataOutput

**改什么**：定义 `MetadataInput` struct，包裹 `is_continuation_request`, `resolve_routing_state_key`, `resolve_session_scope` 等方法的参数

**改后验证**：cargo test 通过

**Checkpoint 3**：`cargo test -p router-hotpath-napi virtual_router_engine` + `npm run build:dev` + focused regression

---

## 并行/串行关系

| 步骤 | 依赖 | 可并行 |
|---|---|---|
| Phase 0（Step 0.1-0.2） | 无 | ✅ 与 Phase 1 并行 |
| Phase 1（Step 1.1-1.7） | 串行（1.1→1.2→...→1.7） | ❌ |
| Phase 2（Step 2.1-2.3） | 串行（2.1→2.2→2.3） | ✅ 与 Phase 1 并行 |
| Phase 3（Step 3.1-3.6） | Phase 1-2 完成后 | ✅ 内部可并行 |

---

## 总计

| Phase | 步骤数 | 预估耗时 | 风险 |
|---|---|---|---|
| Phase 0 | 2 | 10 min | 极低（删死代码） |
| Phase 1 | 7 | 2 hr | 中（Rust 重构） |
| Phase 2 | 3 | 1 hr | 中（Rust 重构） |
| Phase 3 | 6 | 1.5 hr | 低（补充 struct） |
| **总计** | **18** | **~5 hr** | - |
