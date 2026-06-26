# Virtual Router 全面 Rust 化 + Block 化 + 纯编排化 审计报告

审计日期：2026-05-31

2026-06-09 closeout: 静态 0-consumer 复查确认 `native-virtual-router-bootstrap-routing.ts` 与 `native-virtual-router-stop-message-state-semantics.ts` 没有 runtime/static/dynamic/test consumer；当前 TS wrapper 与 dist 产物已物理删除，Rust native capability 保留为 Rust 真源能力。

## 一、Former VR wrapper TS helper audit（80 文件）

### 结论：**全部合规，零违规**

80 个 native-*.ts 文件分为 5 类，无一违反"纯编排"原则：

| 类别 | 文件数 | 判定 | 说明 |
|---|---|---|---|
| A. 薄壳（含 native 调用） | 67 | ✅ 合规 | JSON 序列化 → native call → JSON 反序列化，零 payload 语义变换 |
| B. 纯类型定义 | 4 | ✅ 合规 | 只导出 interface/type，零逻辑 |
| C. 类型重导出 | 2 | ✅ 合规 | barrel re-export，零逻辑 |
| D. JSON 结果解析器 | 5 | ✅ 合规 | 解析 native 返回的 JSON 字符串为 TS 类型，无语义变换 |
| E. 基础设施 | 2 | ✅ 合规 | native 加载策略 + 导出列表 |

#### A 类薄壳文件完整清单（67 文件）

每个文件的统一模式：`loadNativeRouterHotpathBinding() -> readNativeFunction(cap) -> JSON.stringify(args) -> fn(args) -> JSON.parse(result) -> return typed`

| 文件 | 行数 | exports | native 调用点 |
|---|---|---|---|
| native-chat-process-servertool-orchestration-semantics.ts | 912 | 58 | 38 |
| native-compat-action-semantics.ts | 651 | 40 | 19 |
| native-chat-process-governance-semantics.ts | 610 | 20 | 22 |
| native-hub-pipeline-edge-stage-semantics.ts | 560 | 11 | 14 |
| native-hub-bridge-policy-semantics.ts | 541 | 14 | 12 |
| native-hub-pipeline-orchestration-semantics-protocol.ts | 539 | 12 | 15 |
| native-hub-pipeline-resp-semantics-outbound-tools.ts | 480 | 14 | 14 |
| native-hub-pipeline-resp-semantics-inbound-tools.ts | 476 | 15 | 16 |
| native-shared-conversion-semantics-id-stream.ts | 462 | 15 | 16 |
| native-hub-pipeline-inbound-outbound-semantics.ts | 473 | 10 | 11 |
| native-hub-pipeline-orchestration-semantics-metadata-policy.ts | 453 | 7 | 10 |
| native-hub-pipeline-req-inbound-semantics.ts | 442 | 19 | 15 |
| native-hub-bridge-action-semantics-tools-post.ts | 418 | 10 | 11 |
| native-hub-pipeline-req-outbound-semantics.ts | 373 | 11 | 13 |
| native-shared-conversion-semantics-reasoning.ts | 371 | 9 | 10 |
| native-hub-bridge-action-semantics-tools-request.ts | 363 | 9 | 10 |
| native-shared-conversion-semantics.ts | 360 | 19 | 9 |
| native-hub-pipeline-orchestration-semantics-search-resume.ts | 已删：2026-06-09 | 0 | 0 |
| native-shared-conversion-semantics-metadata.ts | 285 | 7 | 8 |
| native-hub-bridge-action-semantics-tools-core.ts | 280 | 8 | 9 |
| native-hub-pipeline-orchestration-semantics.ts | 271 | 27 | 2 |
| native-shared-conversion-semantics-tools.ts | 265 | 7 | 8 |
| native-hub-pipeline-governance-semantics.ts | 238 | 0 | 已删：2026-06-07 Phase 8F-6 |
| native-hub-pipeline-session-identifiers-semantics.ts | 231 | 6 | 2 |
| native-chat-process-node-result-semantics.ts | 226 | 6 | 2 |
| native-hub-pipeline-orchestration-semantics-builders.ts | 313 | 12 | 2 |
| native-hub-pipeline-semantic-mappers.ts | 149 | 7 | 2 |
| native-followup-mainline-semantics.ts | 196 | 16 | 4 |
| native-hub-pipeline-req-process-semantics.ts | 196 | 7 | 2 |
| native-shared-conversion-semantics-openai.ts | 197 | 5 | 6 |
| native-hub-pipeline-target-semantics.ts | 143 | 0 | 已删：2026-06-07 Phase 8F-6 |
| native-servertool-core-semantics.ts | 142 | 10 | 0 |
| native-router-hotpath-quota-buckets.ts | 137 | 6 | 0 |
| native-virtual-router-bootstrap-providers.ts | 131 | 2 | 2 |
| native-virtual-router-bootstrap-routing.ts | 0 | 0 | 已删：2026-06-09 0-consumer wrapper |
| native-snapshot-hooks.ts | 113 | 3 | 2 |
| native-stop-message-auto-semantics.ts | 117 | 10 | 3 |
| native-virtual-router-routing-instructions-semantics.ts | 144 | 3 | 2 |
| native-chat-process-governed-filter-semantics.ts | 78 | 0 | 已删：2026-06-07 Phase 8F-6 |
| native-chat-process-post-governed-normalization-semantics.ts | 54 | 0 | 已删：2026-06-07 Phase 8F-6 |
| native-chat-process-web-search-intent-semantics.ts | 54 | 0 | 已删：2026-06-07 Phase 8F-6 |
| native-chat-request-filter-semantics.ts | 61 | 1 | 2 |
| native-shared-conversion-semantics-core.ts | 60 | 7 | 2 |
| native-shared-conversion-semantics-misc.ts | 90 | 3 | 4 |
| native-shared-conversion-semantics-shell-utils.ts | 183 | 6 | 7 |
| native-shared-conversion-semantics-tool-definitions.ts | 199 | 6 | 7 |
| native-virtual-router-stop-message-actions-semantics.ts | 102 | 0 | 已删：2026-06-07 Phase 8F-6 |
| native-virtual-router-stop-message-semantics.ts | 97 | 2 | 2 |
| native-virtual-router-stop-message-state-semantics.ts | 0 | 0 | 已删：2026-06-09 0-consumer wrapper |
| native-router-hotpath.ts | 199 | 11 | 2 |
| native-hub-pipeline-req-inbound-semantics-tools.ts | 284 | 8 | 3 |
| native-hub-pipeline-req-outbound-semantics-parsers.ts | 308 | 1 | 1 |
| native-rcc-fence-semantics.ts | 104 | 6 | 0 |

#### B 类纯类型定义（4 文件）

| 文件 | 行数 | 说明 |
|---|---|---|
| native-hub-bridge-action-semantics-types.ts | 300 | 46 个 interface 定义 |
| native-hub-pipeline-req-inbound-semantics-types.ts | 28 | 5 个 interface 定义 |
| native-hub-pipeline-req-outbound-semantics-types.ts | 127 | 15 个 interface 定义 |
| native-hub-pipeline-resp-semantics-types.ts | 54 | 9 个 interface 定义 |

#### C 类重导出（2 文件）

| 文件 | 行数 | 说明 |
|---|---|---|
| native-hub-bridge-action-semantics.ts | 84 | re-export types |
| native-hub-pipeline-resp-semantics.ts | 39 | re-export types |

#### D 类 JSON 解析器（5 文件）

| 文件 | 行数 | 说明 |
|---|---|---|
| native-hub-bridge-action-semantics-parsers.ts | 410 | 解析 native 返回的 bridge action 结果 |
| native-hub-pipeline-req-inbound-semantics-parsers.ts | 101 | 解析 native 返回的 req inbound 结果 |
| native-hub-pipeline-req-outbound-semantics-parsers.ts | 308 | 解析 native 返回的 req outbound 结果 |
| native-hub-pipeline-resp-semantics-parsers.ts | 328 | 解析 native 返回的 resp semantics 结果 |
| native-router-hotpath-analysis.ts | 647 | 类型定义 + JSON 解析函数 |

#### E 类基础设施（2 文件）

| 文件 | 行数 | 说明 |
|---|---|---|
| native-router-hotpath-policy.ts | 23 | isNativeDisabledByEnv / failNativeRequired |
| native-router-hotpath-required-exports.ts | 367 | REQUIRED_NATIVE_HOTPATH_EXPORTS 常量列表 |

---

## 二、TS virtual-router/ 根目录审计（28 文件）

### 判定：10 个死代码文件（删除），18 个存活文件

#### 死代码文件（0 引用，应删除）

| 文件 | 行数 | 证据 |
|---|---|---|
| load-balancer.ts | 185 | grep 0 引用 |
| health-weighted.ts | 92 | grep 0 引用 |
| context-advisor.ts | 91 | grep 0 引用 |
| context-weighted.ts | 82 | grep 0 引用 |
| success-center.ts | 75 | grep 0 引用 |
| stop-message-stage-template-files.ts | 86 | grep 0 引用 |
| default-thinking-keywords.ts | 13 | grep 0 引用 |
| routing-stop-message-parser.ts | 8 | grep 0 引用 |
| routing-pre-command-parser.ts | 102 | grep 0 引用 |
| message-utils.ts | 250 | grep 0 引用 |

#### 存活文件分类

| 文件 | 行数 | 引用数 | 判定 | 说明 |
|---|---|---|---|---|
| types.ts | 825 | 多 | 留 TS | 纯类型定义 + 常量 |
| engine.ts | 445 | 多 | 留 TS | 编排入口，调用 native |
| engine-logging.ts | 458 | 多 | 留 TS | 日志基础设施 |
| routing-state-store.ts | 500 | 多 | 留 TS | 状态持久化（FS 操作） |
| provider-registry.ts | 283 | 多 | 留 TS | provider 注册表（调用 native） |
| provider-runtime-ingress.ts | 173 | 5 | 留 TS | 编排：provider 错误上报 |
| routing-instructions.ts | 20 | 17 | 留 TS | barrel re-export |
| routing-instructions/ | 522 | 多 | 留 TS | 解析+序列化（调用 native） |
| token-counter.ts | 229 | 2 | 待审 | token 计数逻辑 |
| routing-pre-command-state-codec.ts | 30 | 1 | 待审 | 编解码 |
| routing-stop-message-state-codec.ts | 262 | 2 | 待审 | 编解码 |
| stop-message-state-sync.ts | 153 | 2 | 待审 | 状态同步 |
| stop-message-markers.ts | 138 | 2 | 待审 | marker 处理 |
| stop-message-file-resolver.ts | 96 | 2 | 待审 | 文件解析 |
| pre-command-file-resolver.ts | 129 | 2 | 待审 | 文件解析 |
| token-file-scanner.ts | 131 | 0 | 已删 | 2026-06-07 Phase 8F-4 已物理删除；auth token scanning 现由 `src/providers/auth/token-scanner/` 承担 |
| token-estimator.ts | 21 | 0 | 待审 | 可能死代码 |
| bootstrap.ts | 162 | 2 | 留 TS | 编排：bootstrap 入口（调用 native） |

---

## 三、Rust bootstrap.rs 审计（1105 行）

### 当前结构：1 个 pub(crate) 入口 + 24 个内部函数

| 函数 | 行号 | 职责归属 |
|---|---|---|
| `bootstrap_virtual_router_routing_json` | 94 | 入口：序列化/反序列化边界 |
| `normalize_routing` | 121 | routing_source_normalizer |
| `expand_routing_table` | 168 | route_target_expander |
| `build_legacy_route_pool` | 390 | route_target_expander |
| `normalize_route_pool_entry` | 404 | route_target_expander |
| `normalize_simplified_weighted_route` | 505 | route_target_expander |
| `normalize_simplified_weighted_target` | 548 | route_target_expander |
| `normalize_route_params` | 566 | route_param_resolver |
| `normalize_thinking` | 594 | route_param_resolver |
| `infer_route_pool_mode_from_config` | 619 | route_pool_sorter |
| `normalize_route_pool_load_balancing` | 666 | route_param_resolver |
| `normalize_weighted_strategy` | 694 | route_pool_sorter |
| `normalize_route_pool_mode` | 706 | route_pool_sorter |
| `normalize_route_targets` | 718 | route_target_expander |
| `has_explicit_route_targets` | 791 | route_target_validator |
| `normalize_target_list` | 814 | route_target_expander |
| `scalar_to_trimmed_string` | 834 | 工具函数 |
| `normalize_priority_value` | 856 | route_pool_sorter |
| `parse_route_entry` | 869 | route_target_expander |
| `split_model_priority` | 913 | route_target_expander |
| `build_runtime_key` | 933 | route_target_expander |
| `parse_bool_like` | 937 | 工具函数 |
| `normalize_positive_i64` | 948 | 工具函数 |
| `normalize_json_number` | 961 | 工具函数 |
| `read_route_policy_group` | 57 | route_param_resolver |
| `resolve_pool_strategy` | 67 | route_pool_sorter |
| `display_pool_id` | 78 | 工具函数 |

### 拆分建议

| 目标 Block | 包含函数 | 行数估算 |
|---|---|---|
| routing_source_normalizer | normalize_routing | ~50 |
| route_target_expander | expand_routing_table, build_legacy_route_pool, normalize_route_pool_entry, normalize_simplified_weighted_*, normalize_route_targets, normalize_target_list, parse_route_entry, split_model_priority, build_runtime_key | ~450 |
| route_target_validator | has_explicit_route_targets | ~25 |
| route_pool_sorter | infer_route_pool_mode_from_config, normalize_weighted_strategy, normalize_route_pool_mode, normalize_priority_value, resolve_pool_strategy | ~120 |
| route_param_resolver | normalize_route_params, normalize_thinking, normalize_route_pool_load_balancing, read_route_policy_group | ~80 |
| 工具函数 | scalar_to_trimmed_string, parse_bool_like, normalize_positive_i64, normalize_json_number, display_pool_id | ~80 |

---

## 四、Rust health.rs 审计（938 行）

### 当前结构：1 个 struct + 20 个 pub(crate) 方法

| 方法 | 行号 | 归属层 | 副作用 |
|---|---|---|---|
| `new` | 86 | facade | 创建实例 |
| `configure` | 93 | state_store | 写 config |
| `register_providers` | 109 | state_store | 写 provider 状态 |
| `record_failure` | 134 | policy | 写 cooldown + trip |
| `cooldown_provider` | 164 | policy | 写 cooldown |
| `cooldown_provider_until_midnight_persisted` | 186 | policy | 写 cooldown |
| `record_success` | 207 | policy | 清 cooldown + trip |
| persisted 503 family cleanup | 224 | policy | 清 503 状态 |
| `trip_provider` | 250 | policy | 写 trip |
| `is_available` | 273 | policy | 读 availability（可能触发 auto-trip） |
| `snapshot` | 299 | facade | 读状态 |
| `cooldown_remaining_ms` | 311 | policy | 读 cooldown |
| `is_persisted_503_daily_cooldown_active` | 321 | policy | 读 503 cooldown |
| `consume_persisted_503_reprobe_if_available` | 339 | policy | 历史残留；当前已废弃，不再作为活路由真源 |
| `describe_state` | 378 | facade | 读状态 |
| `config` | 394 | facade | 读 config |
| `clear_runtime_state` | 398 | state_store | 清运行时状态 |
| `clear_imported_persisted_state` | 414 | state_store | 清持久化状态 |
| `export_persistable_state` | 435 | state_store | 导出状态 |
| `import_persistable_state` | 457 | state_store | 导入状态 |
| `record_http_502_failure` | 504 | policy | 写 502 cooldown |
| `record_http_429_failure` | 527 | policy | 写 429 cooldown |
| `record_recoverable_failure` | 580 | policy | 写 recoverable cooldown |

### 拆分建议

| 目标层 | 包含方法 | 说明 |
|---|---|---|
| health_state_store | configure, register_providers, clear_runtime_state, clear_imported_persisted_state, export_persistable_state, import_persistable_state | 状态持久化 |
| health_policy | record_failure, cooldown_provider, cooldown_provider_until_midnight_persisted, record_success, persisted 503 family cleanup, trip_provider, is_available, cooldown_remaining_ms, is_persisted_503_daily_cooldown_active, consume_persisted_503_reprobe_if_available(历史残留, 已废弃), record_http_502_failure, record_http_429_failure, record_recoverable_failure | 策略判定 |
| health_facade | new, snapshot, describe_state, config | 对外接口 |

---

## 五、Rust virtual_router_engine/ 其余模块审计

| 模块 | 行数 | block 边界 | 显式 I/O struct |
|---|---|---|---|
| engine/core.rs | 185 | ✅ 稳定 | ❌ 缺 |
| engine/route.rs | 768 | ✅ 稳定 | ❌ 缺 |
| engine/selection.rs | 1166 | ✅ 稳定 | ❌ 缺 |
| engine/events.rs | 1375 | ✅ 稳定 | ❌ 缺 |
| engine/status.rs | 24 | ✅ 稳定 | N/A |
| engine/tier_load_balancing.rs | 68 | ✅ 稳定 | ❌ 缺 |
| routing/config.rs | 620 | ✅ 稳定 | ✅ RoutingPools |
| routing/selection.rs | 229 | ✅ 稳定 | ❌ 缺 |
| routing/metadata.rs | 276 | ✅ 稳定 | ❌ 缺 |
| routing/key_utils.rs | 29 | ✅ 稳定 | N/A |
| routing/direct_model.rs | 77 | ✅ 稳定 | ❌ 缺 |
| classifier.rs | 583 | ✅ 稳定 | ✅ ClassificationResult |
| features.rs | 1150 | ✅ 稳定 | ✅ RoutingFeatures |
| config_bootstrap.rs | 830 | ✅ 稳定 | ❌ 缺 |
| provider_bootstrap.rs | 3175 | ✅ 稳定 | ❌ 缺 |
| provider_registry.rs | 472 | ✅ 稳定 | ✅ ProviderProfile |
| load_balancer.rs | 340 | ✅ 稳定 | ✅ LoadBalancingPolicy |
| quota.rs | 413 | ✅ 稳定 | ✅ ProviderQuotaState |
| health_weighted.rs | 96 | ✅ 稳定 | ❌ 缺 |
| context_weighted.rs | 112 | ✅ 稳定 | ❌ 缺 |
| routing_state_store.rs | 808 | ✅ 稳定 | ✅ RoutingInstructionState |
| rcc_fence.rs | 672 | ✅ 稳定 | ✅ RccFenceDocument |
| napi_proxy.rs | 283 | ✅ 纯 adapter | N/A |
| error.rs | 31 | ✅ 工具 | N/A |
| message_utils.rs | 49 | ✅ 工具 | N/A |
| time_utils.rs | 3 | ✅ 工具 | N/A |

---

## 六、调用链审计摘要

```
HTTP Server (TS)
  -> engine.ts (TS 编排入口)
    -> native virtual router engine proxy bridge (TS 薄壳)
      -> napi_proxy.rs (Rust NAPI adapter)
        -> engine/core.rs -> engine/route.rs -> engine/selection.rs (Rust 语义真源)
          -> routing/bootstrap.rs (Rust routing 归一化)
          -> health.rs (Rust health 策略)
          -> quota.rs (Rust quota 管理)
          -> classifier.rs (Rust 分类)
          -> features.rs (Rust 特征提取)
```

**TS/Rust 边界**：
- TS 侧：engine.ts -> native-*.ts（80 文件薄壳）-> NAPI binding
- Rust 侧：napi_proxy.rs -> virtual_router_engine/ 全部模块

**payload 变换节点**：
- TS 侧零 payload 变换（80 文件全部合规）
- Rust 侧：routing/bootstrap.rs（routing 归一化）、features.rs（特征提取）、classifier.rs（分类）

---

## 七、TS Residue Matrix

| 判定 | 文件数 | 说明 |
|---|---|---|
| ✅ 合规（薄壳） | 67 | native-*.ts 含 native 调用 |
| ✅ 合规（类型） | 4 | 纯 interface/type |
| ✅ 合规（重导出） | 2 | barrel re-export |
| ✅ 合规（解析器） | 5 | JSON 反序列化 |
| ✅ 合规（基础设施） | 2 | native 加载策略 |
| ⚠️ 待审（存活） | 18 | TS 根目录编排文件 |
| 🗑️ 死代码（删除） | 10 | TS 根目录零引用文件 |
| **违规** | **0** | **无** |
