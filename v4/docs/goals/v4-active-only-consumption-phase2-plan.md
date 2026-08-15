# V4 Active-only 消费收口 Phase 2 实现计划

Design ID: `V4-ACTIVE-LINK-002`（本计划）；上游设计：`v4/docs/design/v4-active-artifact-linking-design.md`
（`V4-ACTIVE-LINK-001`）、`v4/docs/goals/v4-active-artifact-linking-test-design.md`。

## 1. 目标与验收标准

### 目标

关闭 Active-link Phase 1 遗留的 Known Boundary：V4 所有 frozen 模块（base-node/control/error/edge）
只允许通过 resolver（`routecodex-v4-build-link`）的 Active artifact 面被消费；任何 V4 Cargo manifest
不得对 frozen 模块保留源码 path 依赖；frozen-consumer registry 全部迁移为 `active_artifact`；
工作区 build/test 入口与 CI gate 同步改到 resolver entrypoint。

### 验收标准

- `v4/contracts/active-link/frozen-consumer-registry.json` 无 `source_path`/`transitional` 条目；
  `verify:v4-active-link` gate 绿。
- control re-freeze 到 `active-v2`、error re-freeze 到 `active-v3`（resolver build 命令），
  既有 frozen 记录（control active-v1、error active-v1/v2）保持不可变。
- config（source_implemented）build/regression 迁移到 resolver build-consumer/test-consumer，无 path dep。
- `cargo test --workspace` / `cargo build --release --workspace` 经 resolver entrypoint 全绿；
  module regression：base-node 12、edge 11、control 15、error 23(+1 doc compile-fail)、config 15。
- `appsdk verify v4` 与 `appsdk verify --admission v4` 绿；index gen/verify 绿。
- DSH review（`opencode-go/deepseek-v4-flash`）明确 `VERDICT: PASS`，无 P0/P1。

## 2. 范围与边界

### In scope

- resolver 能力：多依赖 `--deps`（config: base-node+edge）与 transitive closure（edge→base-node）红测；
  外部 registry 依赖已支持（sha2/toml/serde/thiserror）。
- control、error：Cargo.toml 移除 base-node path dep → 移出 workspace members →
  project.json build/regression 改 resolver → control re-freeze active-v2、error re-freeze active-v3
  （evidence/review/promotion/regression/freeze/publish）。
- config：Cargo.toml 移除 base-node、edge path dep → build/regression 改 resolver（不 freeze）。
- workspace/CI：`v4/Cargo.toml` members 收口；`verify:v4-active-link`、`v4_cargo_workspace_build`、
  module regression gate、CI `v4-active-link` job 命令改 resolver entrypoint。
- registry/maps/docs：frozen-consumer-registry、resource/function/mainline/verification map、
  design/test-design 文档状态同步。
- hermetic fixture：control active-v2 / error active-v3 与 config 编译产物进入 fixture，CI 恢复后跑 index gate。

### Out of scope

- appsdk 合约扩展（freeze record 显式记录 `target_triple`/`rustc_version`、真实 `public_api_hash`
  API-surface 提取）：记为 future-freeze 项，不做（Phase 2 不引入新 appsdk release）。
- V3/V4 runtime、provider、pipeline、payload、servertool/stopless/continuation 语义。
- base-node 任何改动；其他 frozen 模块（edge active-v2）不重冻结。
- 对已冻结记录的改写（沿用 edge 模式：历史 frozen 记录保留，resolver 为 active truth）。

## 3. 设计原则

- 唯一 owner：resolver 是 Active link surface 唯一 owner；消费边必须命中 registry 声明。
- 无 fallback：不提供源码回退、auto-rebuild、双 link 路径、re-export 包装 crate、RUSTFLAGS hack。
- 不可变历史：active-v1 记录与 artifact 不动；新版本只走完整生命周期。
- 红测先行：每个迁移先有 registry/gate 红测，再改唯一真源。
- 控制面与 payload 隔离：本任务纯 build-governance，不触碰业务 payload。

## 4. 技术方案（含文件清单）

1. `v4/crates/routecodex-v4-control/Cargo.toml`、`v4/crates/routecodex-v4-error/Cargo.toml`：
   删除 `routecodex-v4-base-node = { path = ... }`（与 edge 一致，依赖由 resolver `--extern` 注入）。
2. `v4/crates/routecodex-v4-config/Cargo.toml`：删除 base-node、edge path dep，保留 sha2/toml/serde/thiserror。
3. `v4/Cargo.toml`：members 移除 control、error（edge/config 已不在 members）。
4. `v4/.appsdk/project.json`：
   - control/error build → `cargo run --quiet --release -p routecodex-v4-build-link -- build-consumer --root . --consumer <module> --deps routecodex-v4-base-node --out generated/modules/<module>/lib/libroutecodex_v4_<module>.rlib`
   - regression → `... test-consumer --root . --consumer <module> --deps routecodex-v4-base-node`
   - config build/regression → `--deps routecodex-v4-base-node,routecodex-v4-edge`
5. `v4/contracts/active-link/frozen-consumer-registry.json`：control/error/config 四条边 → `active_artifact`/`migrated`。
6. resolver `v4/crates/routecodex-v4-build-link/`：验证/补 multi-dep 与 transitive closure（
   config→edge→base-node）、registry coverage 红测（ActiveLinkErr 族沿用）。
7. `scripts/architecture/verify-v4-active-link.mjs`：删除 transitional 分支，全量扫描保持。
8. CI（`.github/workflows/test.yml`）+ `v4/contracts/` gate 命令：workspace build/regression 走 resolver。
9. fixture：control active-v2 / error active-v3 rlib/artifact/records、config compiled artifact 固化到
   `v4/contracts/active-link/fixture`（沿用 Phase 1 模式，CI restore + index gate）。
10. maps/docs：registry、resource/function/mainline/verification map、design/test-design 状态、
    `note.md`/`MEMORY.md`。

## 5. 风险与规避

| 风险 | 规避 |
|---|---|
| control/error re-freeze 改变 artifact 字节 | 完整生命周期 + Jason 已批准本计划即批准 re-freeze；active-v1 不可变 |
| resolver 多依赖/传递闭包遗漏 | 先红测：config→edge→base-node 闭包、dep hash/version swap 必红 |
| frozen 记录与 resolver truth 漂移 | 沿用 edge 模式：frozen 记录历史化，project.json 迁移为 resolver 命令；registry/gate 机器校验 |
| workspace 全量 build 被拆散 | `v4_cargo_workspace_build` gate 与 CI 同变更集改 resolver entrypoint，禁止中间态落地 |
| 其他 worker staged 文件混入 | 只 stage 本任务路径；提交前 `git diff --cached --name-only` 核对 |

## 6. 测试计划

- 白盒：resolver multi-dep/transitive/identity/hash/path-safety 单测（先红后绿）。
- 模块黑盒：control/error/config 经 resolver `--extern` 编译 + l2/l1 回归通过，无 Cargo path dep。
- 项目黑盒：`cargo fmt --all -- --check`、`cargo test --workspace`（resolver entrypoint）、
  `cargo build --release --workspace`、`appsdk verify v4`、`appsdk verify --admission v4`、
  `verify:v4-active-link`、index gen/verify、CI admission 命令链。
- 红测：registry 改 `active_artifact` 后旧 path dep 仍存在 → gate 必红；修复后必绿。
- 完成后在线同入口复测（build/test-consumer 命令），再 DSH review。

## 7. 实施步骤（顺序）

1. 红测：resolver multi-dep/transitive + registry 全量迁移 gate 红测（control/error/config 仍 transitional）。
2. 修改 control/error/config Cargo.toml、workspace members、registry、project.json（apply_patch 逐文件）。
3. control/error 生命周期：begin-version（control active-v1→active-v2、error active-v2→active-v3）→
   compile-module（resolver build）→ evidence/review/promotion/regression → freeze → publish。
4. config 迁移：build/regression → resolver；不 freeze。
5. workspace/CI/gate/命令同步；fixture 更新；maps/docs 同步。
6. 全量验证矩阵（§6）绿；真实样本/命令复测。
7. DSH review（opencode-go/deepseek-v4-flash）→ `VERDICT: PASS`。
8. 提交（只含本任务路径）→ 按 Jason 指示推送/交付。

## 8. 完成定义（DoD）

- registry 零 transitional；`verify:v4-active-link` 绿；CI 同命令链绿。
- control active-v2、error active-v3 已发布，既有 frozen 记录不可变；config 无 path dep。
- 验证矩阵全部证据可回放；DSH review 明确 PASS；无 P0/P1。
- 提交干净（仅本任务文件），交付前 diff 越界自检通过。

## 9. 执行修正（2026-08-15，实施后追加）

1. **error compile-fail 门迁移并重新安置（DSH review P2 修复）**：原
   `cargo test -p routecodex-v4-error --doc` 在 error 移出 workspace 后不可运行
   （lib.rs 依赖 resolver `--extern` 注入的 base-node，cargo doc 无法单独解析）。
   首次迁移时该 gate 从 verification-map 删除，仅以 l2 全量调用 `classify(witness)`
   锁定 API 形状；DSH review P2-3 判定负向编译保护丢失，现重新安置为 resolver
   负向 rustc 门 `negative_error_classify_without_witness_compile_fails`
   （`v4/crates/routecodex-v4-build-link/tests/resolver_red_tests.rs`）：
   无 witness 调 `chain.classify()` 必须编译失败，带 witness 的正向片段必须编译成功。
   `v4_error_compile_fail_regression` 已恢复至 `v4/.appsdk/maps/verification-map.json`，
   命令改为 `cargo test -p routecodex-v4-build-link --test resolver_red_tests
   negative_error_classify_without_witness_compile_fails --manifest-path v4/Cargo.toml`；
   function-map `v4.error.mainline` 对该 gate 的引用随之恢复有效，不删除。
   `src/lib.rs` 的 `compile_fail` 文档保留为 API 契约说明，不再作为可执行 cargo doc gate。
2. **fixture 路径**：hermetic fixture 实际位于 `v4/tests/resources/active-link-fixture/`
   （沿用 Phase 1 模式），不是 §4.9 写到的 `v4/contracts/active-link/fixture`。
3. **index gen/verify 时序**：gen-index 依赖 Active artifact 已发布，必须在
   publish-active 之后运行；lifecycle 中 promote/freeze 阶段不跑 index gate。
