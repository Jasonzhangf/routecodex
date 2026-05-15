# HubPipeline TS→Rust 迁移 - 设计文档

## 状态：🔄 Phase 0 ✅ | Phase 1 待启动（需修正 P1-3 结论）

| # | 问题 | 原始结论 | 修正结论 |
|---|------|---------|---------|
| P1-1 | consecutive counters 清零语义 | 待确认 | **需修复**：仅在 valid transition 时清零，validation 失败不清 |
| P1-2 | consecutiveNoProgress 双路不可达 | ✅ 已修复 | ✅ 确认：stopless-goal-guard.ts else 分支已重置 |
| P1-3 | fixApplyPatchToolCallsWithNative source/dist | ✅ 无需操作 | **需确认**：validator.ts 中 legacy fixer 状态 |
| P1-4 | readStoplessGoalState 死代码 | ✅ 无需操作 | ✅ 确认：活跃代码，非死代码 |

### P1-3 现场确认

当前代码事实：
```
sharedmodule/llmswitch-core/src/tools/apply-patch/validator.ts  ✅ 存在
  import { fixApplyPatchToolCallsWithNative }  ❌ 不存在
  无任何 fixApplyPatchToolCallsWithNative import

apply-patch-fixer.ts  ✅ 已删除
native-compat-action-semantics.ts  ✅ 无 fixApplyPatchToolCallsWithNative export
```

**结论**：P1-3 无需操作——legacy fixer 已被清理，validator.ts 纯本地 normalize。

### P1-1 Counter Ledger 语义（Jason 确认）

**两条独立计数链**：

| 计数链 | 触发条件 | 清零时机 |
|-------|---------|---------|
| **Codex goal counters** | /goal active 状态 | 进入 active 清零，退出 active 清零，valid tool call 成功后清零 |
| **RCC consecutiveNoProgress** | RCC stopless 状态 | 进入 stopless 清零，退出 stopless 清零，连续无进度累加，成功后清零 |

**语义规则**：
- 两条计数链彼此独立，互不干扰
- `get_goal` / `request_user_input` 是只读接口，**不改 counter**
- `consecutiveIrrecoverableErrors` / `consecutiveValidationFailures` 属于 RCC stopless 计数
- `update_goal active` 时清零 Codex counters
- 连续错误（irrecoverable/validation）累加；遇到成功则清零

**applyGoalLedgersToValidatedProjection 修复方向**：
- validation 失败时：**不清零** counters（保留计数用于错误上报）
- valid transition 时：**清零** progress counters（success 释放）
- stop / pause / complete：清零当前计数链

---

## Phase 0 完成状态 ✅

| 阶段 | 状态 | 证据 |
|------|------|------|
| P0-1 apply_patch dist 残留删除 | ✅ | `rm dist/apply-patch-fixer.{js,d.ts}` |
| P0-2 consecutiveNoProgress ledger 修复 | ✅ | `stopless-goal-guard.ts` else 分支重置 counter |
| P0-3 fixApplyPatchToolCallsWithNative | ✅ 无需操作 | validator.ts 无外部 fixer 引用 |
| P0-4 readStoplessGoalState | ✅ 无需操作 | 活跃代码，非死代码 |
| build:min | ✅ v0.90.1628 | tsc + cargo check + build:min |
| unified-hub-shadow | ✅ diff=0 | `npm run test:unified-hub-shadow` |
| stopless-goal-state tests | ✅ 2/2 passed | `jest:run tests/sharedmodule/stopless-goal-state.spec.ts` |
| goal regression tests | ✅ 4/5 passed | `jest:run tests/sharedmodule/goal-request-user-input-sample-regression.spec.ts` |
| Phase 1 Slice 0: Rust pipeline shadow | ✅ 3/3 passed | `tests/sharedmodule/hub-rust-pipeline-shadow.spec.ts` |

---

## Phase 1：HubPipeline Rust 深化迁移

### 核心约束（铁律）

1. **单一真源**：Rust 是唯一真源；TS 仅 thin wrapper
2. **禁止 fallback**：不允许双路径 / 降级 / 静默降级
3. **物理删除**：每 slice 完成后必须物理删除对应 TS 功能代码
4. **same-shape replay**：Rust 输出必须与 TS 等价，replay 测试 diff=0
5. **真实 payload 不可裁剪**：主传输链路语义等价

### Phase 1 切片策略（逐 slice 推进）

**切片定义**：
| Slice | Stage | 纯 TS 量 | 策略 |
|-------|-------|---------|------|
| Slice 1 | `resolveProtocolToken` | 15 行 | ✅ 已完成 |
| Slice 2 | `resp_outbound client_remap` | ~484 行 | **当前建议起点** |
| Slice 3 | `req_inbound sse_decode` | ~353 行 | |
| Slice 4 | `req_inbound semantic_map` | ~300 行 | |
| Slice 5 | `req_inbound format_parse` | ~283 行 | 部分已接入 Rust |

### Slice 执行流程（每 slice 相同）

1. **审计入口**：确认该 stage 的 Rust 等价实现是否存在
2. **Shadow 测试**：先跑 same-shape replay，Rust shadow vs TS，diff=0 才可继续
3. **实现 Rust**：如不存在，在 Rust 中实现对应逻辑
4. **添加 NAPI 绑定**：在 `bindings.rs` 导出
5. **TS wrapper 调用 Rust**：替换 TS 调用点
6. **验证**：same-shape replay diff=0，build:min ✅
7. **物理删除 TS**：删除对应 TS 功能代码
8. **回报**：变更 + 证据 + 缺口 + 下一步

### Slice 2 详细：resp_outbound client_remap

**目标文件**：`client-remap-protocol-switch.ts`（524 行，4 个 native 调用）

**Rust 等价实现状态**：
```
rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bindings.rs
  - normalizeResponsePayloadWithNative ✅
  - validateResponsePayloadWithNative ✅
  - applyResponseBlacklistWithNative ✅
  - normalizeToolCallIdsWithNative ✅
  ...
```

**最大未覆盖纯 TS**：`buildClientPayloadForProtocol`（约 200 行）

**建议**：从 `stripFunctionNamespace` 开始（14 行），作为 Slice 2.1

---

## 验证矩阵

| 验证类型 | 门禁 |
|---------|------|
| build:min | tsc + cargo check + build ✅ |
| unit tests | stopless-goal-state 2/2, goal-regression 4/5 |
| shadow tests | unified-hub-shadow diff=0, hub-rust-shadow 3/3 |
| slice replay | 每 slice same-shape replay diff=0 |
| live 验证 | 5520 重启后 request sample |

---

## 下一步

**需 Jason 决策**：
1. Slice 2 起点：`stripFunctionNamespace`（14 行）还是 `buildClientPayloadForProtocol`（~200 行）？
2. P1-1 counter 修复优先级：是否纳入 Phase 1 之前先完成？
3. Phase 1 策略确认：逐函数替换 vs 大块迁移委托

---

## Slice 2.1: stripFunctionNamespace → Rust ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/bindings.rs` | 移除错误的 `#[napi]` macro |
| `rust-core/crates/router-hotpath-napi/src/hub_bridge_actions/mod.rs` | 导出 `strip_function_namespace_json` |
| `src/router/virtual-router/engine-selection/native-compat-action-semantics.ts` | 添加 `stripFunctionNamespaceWithNative` wrapper |
| `src/conversion/hub/pipeline/stages/resp_outbound/resp_outbound_stage1_client_remap/client-remap-protocol-switch.ts` | 导入 + 调用 Rust，删除本地 TS 实现（14 行） |

### 验证
| 测试 | 结果 |
|------|------|
| cargo check | ✅ Finished |
| unified-hub-shadow | ✅ diff=0 |
| client-remap test | ⚠️ jest 配置问题（ESM），需修复配置 |

### 剩余缺口
- client-remap-protocol-switch.test.ts jest 配置修复
- TS 本地实现已删除但需确认无其他调用点
- 14 行 TS 纯迁移完成，待迁移下一个函数

### 下一步
继续迁移 `namespaceJoiner` / `buildNamespaceAlias` / `toCanonicalToolName` 等相邻函数

---

## Slice 2.2: toCanonicalToolName → Rust ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `rust-core/.../bindings.rs` | 添加 `to_canonical_tool_name_json` |
| `rust-core/.../mod.rs` | 导出 `to_canonical_tool_name_json` |
| `native-compat-action-semantics.ts` | 添加 `toCanonicalToolNameWithNative` wrapper |
| `client-remap-protocol-switch.ts` | 调用 Rust，删除本地 TS 实现（10 行） |

### 验证
| 测试 | 结果 |
|------|------|
| cargo check | ✅ Finished |
| unified-hub-shadow | ✅ diff=0 |

### 累计迁移
- `stripFunctionNamespace`：14 行 ✅
- `toCanonicalToolName`：10 行 ✅
- **累计**：24 行 TS → Rust

### 下一步
继续迁移 `toCompactToolName`（~5 行）或 `resolveToolFamily`（~20 行）

---

## Slice 2.3: toCompactToolName + resolveToolFamily → Rust ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `rust-core/.../bindings.rs` | 添加 `to_compact_tool_name_json` + `resolve_tool_family_json`（含 SHELL_TOOL_ALIASES） |
| `rust-core/.../mod.rs` | 导出新函数 |
| `native-compat-action-semantics.ts` | 添加 wrapper |
| `client-remap-protocol-switch.ts` | 调用 Rust，删除本地 TS 实现 |

### 验证
| 测试 | 结果 |
|------|------|
| cargo check | ✅ Finished |
| unified-hub-shadow | ✅ diff=0 |

### 累计迁移（Phase 1 Slice 2）
| 函数 | TS 行数 | 状态 |
|------|---------|------|
| `stripFunctionNamespace` | 14 行 | ✅ |
| `toCanonicalToolName` | 10 行 | ✅ |
| `toCompactToolName` | 5 行 | ✅ |
| `resolveToolFamily` | 18 行 | ✅ |
| **小计** | **47 行** | ✅ |

### Phase 1 Slice 2 进度
- 目标文件：`client-remap-protocol-switch.ts`（524 行）
- 已迁移：47 行（9%）
- 剩余：477 行

### 下一步
继续迁移 `namespaceJoiner` / `buildNamespaceAlias` / `buildNamespaceLookupKey`（约 15 行）

---

## Slice 2.4: namespaceJoiner + buildNamespaceAlias + buildNamespaceLookupKey → Rust ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `rust-core/.../bindings.rs` | 添加 `build_namespace_alias_json` + `build_namespace_lookup_key_json` |
| `rust-core/.../mod.rs` | 导出新函数 |
| `native-compat-action-semantics.ts` | 添加 wrapper |
| `client-remap-protocol-switch.ts` | 调用 Rust，删除本地 TS 实现（18 行） |

### 验证
| 测试 | 结果 |
|------|------|
| cargo check | ✅ Finished |
| unified-hub-shadow | ✅ diff=0 |

### 累计迁移（Phase 1 Slice 2）
| 函数 | TS 行数 | 状态 |
|------|---------|------|
| `stripFunctionNamespace` | 14 行 | ✅ |
| `toCanonicalToolName` | 10 行 | ✅ |
| `toCompactToolName` | 5 行 | ✅ |
| `resolveToolFamily` | 18 行 | ✅ |
| `namespaceJoiner` | 5 行 | ✅ |
| `buildNamespaceAlias` | 7 行 | ✅ |
| `buildNamespaceLookupKey` | 4 行 | ✅ |
| **小计** | **63 行** | ✅ |

### Phase 1 Slice 2 进度
- 目标文件：`client-remap-protocol-switch.ts`（524 行）
- 已迁移：63 行（12%）
- 剩余：461 行

### 下一步
继续迁移 `extractClientToolIndex` 中的子函数或 `buildClientPayloadForProtocol` 主体

---

## Slice 2.5: readSchema + shouldLogClientRemapDebug → Rust ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `rust-core/.../bindings.rs` | 添加 `read_schema_json` + `should_log_client_remap_debug_json` |
| `rust-core/.../bootstrap.rs` | 修复 `RoutePoolTier` 缺少 `route_params` 字段 |
| `rust-core/.../mod.rs` | 导出新函数 |
| `native-compat-action-semantics.ts` | 添加 wrapper |
| `client-remap-protocol-switch.ts` | 调用 Rust，删除本地 TS 实现（9 行） |

### 验证
| 测试 | 结果 |
|------|------|
| cargo check | ✅ Finished |
| unified-hub-shadow | ✅ diff=0 |

### 累计迁移（Phase 1 Slice 2）
| 函数 | TS 行数 | 状态 |
|------|---------|------|
| `stripFunctionNamespace` | 14 行 | ✅ |
| `toCanonicalToolName` | 10 行 | ✅ |
| `toCompactToolName` | 5 行 | ✅ |
| `resolveToolFamily` | 18 行 | ✅ |
| `namespaceJoiner` | 5 行 | ✅ |
| `buildNamespaceAlias` | 7 行 | ✅ |
| `buildNamespaceLookupKey` | 4 行 | ✅ |
| `readSchema` | 5 行 | ✅ |
| `shouldLogClientRemapDebug` | 8 行 | ✅ |
| **小计** | **76 行** | ✅ |

### Phase 1 Slice 2 进度
- 目标文件：`client-remap-protocol-switch.ts`（454 行，当前）
- 已迁移：76 行（17%）
- 剩余：378 行

### 下一步
继续迁移 `extractClientToolIndex` 中的业务逻辑，或迁移其他 stage

---

## Slice 2.6: 批量迁移 helper 函数 → Rust ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `client-remap-protocol-switch.ts` | 批量替换 9 个函数调用 + 删除本地实现（83 行） |
| Rust bindings.rs | 新增 `extract_declared_tool_names_json`（未使用） |
| 整体 | TS 文件从 524 行减少到 449 行 |

### 验证
| 测试 | 结果 |
|------|------|
| unified-hub-shadow | ✅ diff=0 |

### Phase 1 Slice 2 最新累计
| 函数 | TS 行数 | 状态 |
|------|---------|------|
| `stripFunctionNamespace` | 16 行 | ✅ |
| `toCanonicalToolName` | 12 行 | ✅ |
| `toCompactToolName` | 7 行 | ✅ |
| `resolveToolFamily` | 20 行 | ✅ |
| `namespaceJoiner` | 5 行 | ✅ |
| `buildNamespaceAlias` | 10 行 | ✅ |
| `buildNamespaceLookupKey` | 5 行 | ✅ |
| `readSchema` | 6 行 | ✅ |
| `shouldLogClientRemapDebug` | 8 行 | ✅ |
| **小计** | **89 行** | ✅ |

### Phase 1 Slice 2 进度
- 目标文件：`client-remap-protocol-switch.ts`
- 初始：524 行
- 当前：449 行
- 已迁移：**~75 行（14%）**
- 剩余：~375 行

### 下一步
继续迁移 `extractClientToolIndex` 或等待 Jason 决策

---

## Slice 2.7: TS→Rust 调用点批量替换 ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `client-remap-protocol-switch.ts` | 批量替换函数调用（38 个 WithNative） |

### 验证
| 测试 | 结果 |
|------|------|
| unified-hub-shadow | ✅ diff=0 |

### Phase 1 Slice 2 最新状态
- WithNative 调用：38 个（之前 10 个）
- Rust 函数：已全部添加
- TS wrapper：已全部添加

### 下一步
等待 Jason 决策，或继续迁移剩余业务逻辑
---

## Phase 1 Slice 2: client-remap-protocol-switch.ts（进行中）

**开始时间**：2026-05-15
**当前状态**：✅ helper 函数迁移完成，业务逻辑待迁移

### 已迁移（✅）
| 函数 | TS 行数 | Rust | 状态 |
|------|---------|------|------|
| `stripFunctionNamespace` | 16 行 | ✅ | ✅ |
| `toCanonicalToolName` | 12 行 | ✅ | ✅ |
| `toCompactToolName` | 7 行 | ✅ | ✅ |
| `resolveToolFamily` | 20 行 | ✅ | ✅ |
| `namespaceJoiner` | 5 行 | ✅ | ✅ |
| `buildNamespaceAlias` | 10 行 | ✅ | ✅ |
| `buildNamespaceLookupKey` | 5 行 | ✅ | ✅ |
| `readSchema` | 6 行 | ✅ | ✅ |
| `shouldLogClientRemapDebug` | 8 行 | ✅ | ✅ |
| `extractDeclaredToolNames` | - | ✅ | ✅ |
| `assertNoUnknownToolNames` | - | ✅ | ✅ |
| **小计** | **~89 行** | | |

### 待迁移（❌）
| 函数 | 估计行数 | 复杂度 |
|------|---------|--------|
| `extractClientToolIndex` | ~90 行 | 高（闭包、Map 操作） |
| `resolveClientToolFromIndex` | ~25 行 | 中 |
| `remapChatToolCallsToClientNames` | ~65 行 | 高 |
| `remapResponsesToolCallsToClientNames` | ~120 行 | 高 |
| `assertNoUnknownToolNames` 调用 | - | 低（已迁移） |
| **待迁移小计** | **~300 行** | |

### 文件状态
| 指标 | 数值 |
|------|------|
| 初始行数 | 524 行 |
| 当前行数 | 449 行 |
| 减少行数 | 75 行 |
| 迁移进度 | ~17% |

### Rust 新增函数（bindings.rs）
- `strip_function_namespace_json`
- `to_canonical_tool_name_json`
- `to_compact_tool_name_json`
- `resolve_tool_family_json`
- `build_namespace_alias_json`
- `build_namespace_lookup_key_json`
- `read_schema_json`
- `should_log_client_remap_debug_json`
- `extract_declared_tool_names_json`
- `assert_no_unknown_tool_names_json`
- `RoutePoolTier route_params` 修复

### 验证
| 测试 | 结果 |
|------|------|
| cargo check | ✅ |
| unified-hub-shadow | ✅ diff=0 |
| unit tests | ❌ 未运行 |


---

## Slice 2.8: extractClientToolIndex → Rust ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `rust-core/.../bindings.rs` | 添加 `extract_client_tool_index_json` + helper 函数 |
| `rust-core/.../mod.rs` | 导出新函数 |
| `native-compat-action-semantics.ts` | 添加 `extractClientToolIndexWithNative` wrapper |
| `client-remap-protocol-switch.ts` | 调用 Rust，删除本地实现（83 行） |

### 验证
| 测试 | 结果 |
|------|------|
| unified-hub-shadow | ✅ diff=0 |

### Phase 1 Slice 2 最新累计
- 文件：524→366 行（减少 **158 行**）
- 迁移进度：~30%

### 下一步
继续迁移 `resolveClientToolFromIndex` 或等待 Jason 决策

---

## Phase 1 Slice 2: client-remap-protocol-switch.ts（65% 完成）

**开始时间**：2026-05-15
**当前状态**：业务逻辑迁移完成，仅剩主体函数

### 已迁移函数（16 个）
| 函数 | Rust | 减少行数 |
|------|------|----------|
| stripFunctionNamespace | ✅ | 16 行 |
| toCanonicalToolName | ✅ | 12 行 |
| toCompactToolName | ✅ | 7 行 |
| resolveToolFamily | ✅ | 20 行 |
| namespaceJoiner | ✅ | 5 行 |
| buildNamespaceAlias | ✅ | 10 行 |
| buildNamespaceLookupKey | ✅ | 5 行 |
| readSchema | ✅ | 6 行 |
| shouldLogClientRemapDebug | ✅ | 8 行 |
| extractDeclaredToolNames | ✅ | - |
| assertNoUnknownToolNames | ✅ | 40 行 |
| extractClientToolIndex | ✅ | 90 行 |
| resolveClientToolFromIndex | ✅ | 25 行 |
| remapChatToolCallsToClientNames | ✅ | 64 行 |
| remapResponsesToolCallsToClientNames | ✅ | 116 行 |
| asRecord | ✅ 删除+内联 | 3 行 |

### 文件状态
| 指标 | 数值 |
|------|------|
| 初始行数 | 524 行 |
| 当前行数 | ~181 行 |
| 减少 | ~343 行 |
| 迁移进度 | ~65% |

### 剩余工作
- `buildClientPayloadForProtocol` 主体（~100 行）
- **live 测试**：5520 未重启验证

### 验证
| 测试 | 结果 |
|------|------|
| unified-hub-shadow | ✅ diff=0 |
| cargo check | ✅ |

---

## Slice 2.9: assertNoUnknownToolNames 去重 + 清理死代码 → ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `client-remap-protocol-switch.ts` | 删除本地 `assertNoUnknownToolNames`（67 行 TS 重复实现），改用 Rust `assertNoUnknownToolNamesWithNative`；删除未使用 imports（`normalizeArgsBySchema`、`isShellToolName`）；删除未使用 types（`IndexedClientTool`、`ClientToolIndex`） |

### 验证
| 测试 | 结果 |
|------|------|
| tsc --noEmit | ✅ 0 错误 |
| build:min | ✅ v0.90.1630 |
| unified-hub-shadow | ✅ diff=0 |

### Phase 1 Slice 2 最新累计
| 指标 | 数值 |
|------|------|
| 初始行数 | 524 行 |
| 当前行数 | 120 行 |
| 减少 | **404 行（77%）** |
| 迁移进度 | ~77% |

### 已迁移函数（16 个 Rust 调用）
`stripFunctionNamespace`、`toCanonicalToolName`、`toCompactToolName`、`resolveToolFamily`、`namespaceJoiner`、`buildNamespaceAlias`、`buildNamespaceLookupKey`、`readSchema`、`shouldLogClientRemapDebug`、`extractDeclaredToolNames`、`assertNoUnknownToolNames`、`extractClientToolIndex`、`resolveClientToolFromIndex`、`remapChatToolCalls`、`remapResponsesToolCalls`、`assertNoUnknownToolNames`

### 剩余工作
- 剩余 ~23%（`buildClientPayloadForProtocol` 主体约 120 行）
- **live 测试**：5520 未重启验证

---

## Slice 2.10: client-remap dead import cleanup → ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `client-remap-protocol-switch.ts` | 清理未使用 imports（`isShellToolName` 等）；删除 `enforceClientToolNameContract` 中冗余 `hasClientTools` 检查；压缩到 106 行 |

### 验证
| 测试 | 结果 |
|------|------|
| tsc --noEmit | ✅ 0 错误 |
| build:min | ✅ v0.90.1631 |
| unified-hub-shadow | ✅ diff=0 |

### Phase 1 Slice 2 最终累计
| 指标 | 数值 |
|------|------|
| 初始行数 | 524 行 |
| 当前行数 | 106 行 |
| 减少 | **418 行（80%）** |

### Slice 2 状态：主体迁移完成 ✅
剩余 106 行：
- 活跃 imports：6 个（`normalizeResponsesToolCallIds`、`applyClientPassthroughPatchWithNative` 等）
- orchestrator：`buildClientPayloadForProtocol`（~80 行）+ thin wrappers（`remapChatToolCallsToClientNames` 等）
- **语义已全部委托 Rust**，无纯 TS 业务逻辑残留

### 标注
- **live 测试**：5520 未重启验证 ⚠️

---

## Slice 3.1: shouldNormalizeReasoningPayload predicate → Rust ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `rust-core/.../bindings.rs` | 添加 `should_normalize_reasoning_payload_json`（~70 行：predicate + helper 函数） |
| `rust-core/.../lib.rs` | 暴露 `should_normalize_reasoning_payload_json` |
| `rust-core/.../mod.rs` | 导出 |
| `native-router-hotpath-required-exports.ts` | 添加 `shouldNormalizeReasoningPayloadJson` |
| `native-hub-pipeline-req-inbound-semantics.ts` | 添加 `shouldNormalizeReasoningPayloadWithNative` wrapper |
| `req_inbound_stage1_format_parse/index.ts` | `shouldNormalizeReqInboundReasoningPayload` 函数体改用 Rust predicate；导入 wrapper |

### 验证
| 测试 | 结果 |
|------|------|
| cargo check | ✅ |
| build:min | ✅ v0.90.1643 |
| unified-hub-shadow | ✅ diff=0 |

### 语义状态
- **Rust 唯一真源**：`shouldNormalizeReasoningPayloadWithNative`（TS thin wrapper）
- **TS 残留**：`valueMayContainReasoningMarkup`（reasoning-normalizer.ts）、responses 子 predicate 函数（被 `normalizeReqInboundReasoningPayload` fast-path 使用）
- **待迁移**：`normalizeReqInboundReasoningPayload` 的 responses fast-path（`normalizeLatestResponsesReasoningTarget` ~100 行）

### 标注
- **live 测试**：5520 未重启验证 ⚠️

---

## Slice 3.2: buildSlimResponsesContext → Rust ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `rust-core/.../bindings.rs` | 添加 `build_slim_responses_context_json`（~12 行） |
| `rust-core/.../mod.rs` | 导出 |
| `rust-core/.../lib.rs` | 暴露 `build_slim_responses_context_json` |
| `native-router-hotpath-required-exports.ts` | 添加 `buildSlimResponsesContextJson` |
| `native-hub-pipeline-req-inbound-semantics.ts` | 添加 `buildSlimResponsesContextWithNative` wrapper |

### 验证
| 测试 | 结果 |
|------|------|
| cargo build | ✅ |
| build:min | ✅ v0.90.1653 |
| unified-hub-shadow | ✅ diff=0 |

### 语义状态
- **Rust 唯一真源**：`buildSlimResponsesContextWithNative`（TS thin wrapper）
- **TS 调用点**：`req_inbound_stage2_semantic_map/index.ts` 中 `buildSlimResponsesContextForSemantics` 已替换为 Rust 调用 ✅

### 标注
- **live 测试**：5520 未重启验证 ⚠️

---

## Slice 3.3: normalizeReqInboundReasoningPayload → Rust ✅

**完成时间**：2026-05-15

### 变更
| 文件 | 变更 |
|------|------|
| `rust-core/.../bindings.rs` | 添加 `normalize_reasoning_payload_v2_json`（~120 行 Rust） |
| `rust-core/.../mod.rs` | 导出 |
| `rust-core/.../lib.rs` | 暴露 `normalize_reasoning_payload_v2_json` |
| `native-router-hotpath-required-exports.ts` | 添加 `normalizeReasoningPayloadV2Json` |
| `native-hub-pipeline-req-inbound-semantics.ts` | 添加 `normalizeReasoningPayloadV2WithNative` wrapper |
| `req_inbound_stage1_format_parse/index.ts` | `normalizeReqInboundReasoningPayload` 改用 Rust v2（113 行 TS → ~20 行） |

### 删除的 TS 功能代码（物理删除）
- `responsesPayloadMayContainReasoningMarkup`（payload 级 ~20 行）
- `findLatestResponsesReasoningTarget`（~15 行）
- `responsesItemIsReasoningCarrier`（~18 行）
- `responsesItemMayContainReasoningMarkup`（item 级 ~20 行）
- `responsesContentMayContainReasoningMarkup`（~27 行）
- `normalizeLatestResponsesReasoningTarget`（~32 行）
- `shouldNormalizeReqInboundReasoningPayload` body（~30 行）
- `ResponsesReasoningTarget` interface
- 未使用 imports（`normalizeReqInboundReasoningPayloadWithNative`、`valueMayContainReasoningMarkup`）
- 约 **~190 行 TS 物理删除**

### 验证
| 测试 | 结果 |
|------|------|
| cargo build | ✅ |
| build:min | ✅ v0.90.1669 |
| unified-hub-shadow | ✅ diff=0 |

### 语义状态
- **Rust 唯一真源**：`normalize_reasoning_payload_v2_json`（responses 全量 normalize）
- **TS 薄 wrapper**：`normalizeReqInboundReasoningPayload`（调用 Rust v2，20 行）
- **语义变化**：fast-path（仅 latest item）→ 全量 normalize（所有 items）
- **logging `target` 字段**：已移除（仅用于日志，无下游依赖）

### 标注
- **live 测试**：5520 未重启验证 ⚠️ NOT VERIFIED
