# 编译 Warning 修复计划

## 真相

当前 `build:base` 全量编译产生 **~636 条去重 warning**（`build:base` log 中 raw 960 行含重复/跨编译单元）。

- **TS** (`tsc --noEmit`, `vite build webui`, `build-core`): **0 warning**。已清洁。
- **Rust** (`router-hotpath-napi` + `servertool-core`): **全部 636 条 warning**。

---

## Warning 分类（去重后）

| 类型 | 数量 | 风险 |
|------|------|------|
| dead function（从未调用的函数） | 440 | 低-中��死代码膨胀，影响维护 |
| unused import | 50 | 低：IDE 可自动删 |
| other（private_interfaces, must_use 等） | 50 | 低 |
| unused variable | 22 | 低 |
| dead const（未使用的常量） | 21 | 低 |
| dead method（struct 方法） | 21 | 低 |
| dead field（struct 字段） | 10 | 低 |
| unused mut（不需要 mut） | 7 | 低 |
| non_snake_case | 3 | 低 |

**结论**: 全部是 dead code / unused import / naming style 类，**无类型安全或运行时 bug 类 warning**。

---

## 修复计划（按优先级）

### Phase 1: `servertool-core`（4 warning，最低风险，可练手）

文件: `crates/servertool-core/src/cli_contract.rs`

1. 删 `use std::env`（行 11）
2. `mut count` → `count`（行 438）
3. 删 `collect_text_from_content_parts`（行 1399，dead function）
4. 删 `read_optional_string_from_object`（行 1428，dead function）

**验证**: `cargo test -p servertool-core` 全 PASS

---

### Phase 2: `hashline/mod.rs` + `hub_pipeline.rs`（unused import 清理）

- `crates/router-hotpath-napi/src/hashline/mod.rs`: 删 5-6 个未使用的 re-export（`compute_line_hash`, `compute_line_hashes`, `verify_anchor`, `ApplyResult`, `HashlineConflict`, `HashlineErrorCode`, `HashlineOp`, `OpKind`）
- `crates/router-hotpath-napi/src/hub_pipeline.rs`: 删 7 个未使用的 `*_json` import

**风险**: 低。这些函数已在其他文件直接 use 原始模块路径，mod.rs 只是额外 re-export。

---

### Phase 3: 全局 `unused import`（~50 处）

涉及大量 `napi_bindings.rs`, `mod.rs` 文件中的 `use` 声明。可批量 `cargo fix --lib -p router-hotpath-napi --allow-dirty` 自动修复 **56 条建议**。

**风险**: 低。`cargo fix` 只删未使用 import。

---

### Phase 4: `hub_snapshot_hooks.rs`（最大单文件 43 warning）

全文件 ~25 个函数/struct/const 标记为死代码。该文件是旧的 snapshot 异步写盘实现，已被 `src/debug/snapshot/*` 统一写盘工具替代。

**风险**: 中。必须先确认 `hub_snapshot_hooks.rs` 中确实没有被 live path 引用的函数。需 grep 确认每个函数的调用者。

候选处理方式：
- 若确认无 live caller，物理删除整个文件（按 AGENTS.md 物理删除铁律）。
- 若有少数 live entry，保留并删其余死代码。

---

### Phase 5: `chat_servertool_orchestration.rs`（41 warning）

~15 个 dead function + 部分 unused variable。需要逐函数 grep 确认无调用者。

**风险**: 中。该文件是 servertool orchestration 主逻辑，部分函数可能是上次重构后未清理的旧路径。

---

### Phase 6: `virtual_router_engine/*` 死代码（health_weighted.rs, context_weighted.rs 等）

`health_weighted.rs` 和 `context_weighted.rs` 的整个模块结构 + 常量从未被使用。这是旧的 weighted routing 实现。

**风险**: 中。必须先确认它们确无 live caller（已在 `build:base` 日志中被标记 dead function/const，但需双保险 grep）。

---

### Phase 7: `non_snake_case`（3 处，`lib.rs`）

3 个 napi 桥接函数名不符合 Rust 命名规范。改名为 snake_case 并同步 TS 侧调用。

**风险**: 低-中。改名会改 TS → Rust 的绑定名，需要同步更新 `sharedmodule/llmswitch-core/src/native/` 中对应的 napi 声明。

---

### Phase 8: 其余 ~100 条散落 warning

逐个文件逐函数确认。大部分是 dead function（上次 hub pipeline 重构后未清理的旧入口）。

---

## 验证门禁

每个 Phase 后必须：

1. `cargo check --manifest-path sharedmodule/llmswitch-core/rust-core/Cargo.toml --all-targets` 确认 warning 数下降。
2. `cargo test -p router-hotpath-napi` 全 PASS。
3. `cargo test -p servertool-core` 全 PASS。
4. `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs` PASS。
5. `PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit` PASS。

---

## 时间预估

| Phase | 文件数 | 预估时间 |
|-------|--------|----------|
| P1 servertool-core | 1 | 5 min |
| P2 hashline + hub_pipeline | 2 | 10 min |
| P3 `cargo fix` 批量 | ~20 | 5 min |
| P4 hub_snapshot_hooks | 1 | 20 min |
| P5 chat_servertool_orchestration | 1 | 30 min |
| P6 VR dead code | 4 | 20 min |
| P7 non_snake_case | 1 | 15 min |
| P8 散落 warning | ~20 | 30 min |

**总计**: ~2h（全做）或 ~30min（P1-P3 快速减 100+ warning）

---

## 建议执行顺序

1. P1 (servertool-core, 4 warning) → 最快见效。
2. P3 (cargo fix, 56 auto-fix) → 最大减量。
3. P2 (hashline + hub_pipeline, ~15 warning) → 手动补全。
4. 评估 P4-P8 风险后决定是否执行。若时间有限，P1-P3 已消除 ~25% warning 且零风险。

