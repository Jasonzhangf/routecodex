# V3 Module Decomposition SOP（巨型文件拆解标准作业程序）

Status: active SOP, executing Phase 3 server crate module split (direct_frame active).
Plan truth: `docs/goals/v3-god-file-decomposition-plan.md`.
Feature id: `v3.module_decomposition`（`docs/architecture/v3-function-map.yml`）.
Review surface: `docs/architecture/wiki/html/v3-mainline-caller-flow.html`.
Lock manifest: `docs/architecture/v3-architecture-audit-locks.yml`.

## 适用范围

拆解以下生产文件时必须走本 SOP，任何 worker 不得绕过：

- `v3/crates/routecodex-v3-server/src/lib.rs`（8540 行）
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs`（7338 行）
- `v3/crates/routecodex-v3-runtime/src/kernel.rs`（2969 行）
- Phase 5 可选：`routecodex-v3-lifecycle/src/lib.rs`、`hub_v1/anthropic_codec.rs`

## 关键事实（执行前必须知道）

1. **Locked 链会被触碰。** 以下 audited_locked 链有边锚定在上述文件
   （`caller_file`/`callee_file` 计入 chain fingerprint）：
   - `v3.server.startup`（6 边）
   - `v3.responses_direct.required_mainline`（7 边）
   - `v3.debug_error_foundation.mainline`（4 边）
   - `v3.entry_protocol_endpoint_binding.mainline`（2 边）
   - `v3.servertool_hook_skeleton_lifecycle`（2 边）
   - `v3.sse.transport_boundary`（1 边）
   文件路径一变 fingerprint 即变，`verify:v3-mainline-caller-flow` 红灯，
   除非同一变更集内在 `v3-architecture-audit-locks.yml` 追加
   `manual_authorizations` 记录（`authorization_id`、`item_id`、
   `fingerprint_before`、`fingerprint_after`、`approved_by: Jason`）并刷新
   locked_items fingerprint。**每个触碰 locked 链的 Phase，提交前必须取得
   Jason 对该 Phase 授权记录的确认。**
2. **非 locked 链正常改。** `v3.server.managed_lifecycle`、
   `v3.models.capability_catalog`、relay 各链等 plain 链的边随搬移同提交
   更新即可，无需授权记录。
3. **map 先行于代码。** 护栏 27a/29：call map 禁伪造 symbol。新模块文件
   在代码搬入前不存在，因此 map 的 `caller_file`/`callee_file` 修改只允许
   出现在**代码搬移的同一提交**内，禁止提前批量改 map。

## 每 Phase 标准步骤（逐条执行，不许跳）

1. **协作占用**：刷新 `.agent-collab/`（活跃 runs、claims、KILL_SWITCH），
   `mkdir .agent-collab/claims/v3.module_decomposition` 占用；已被占用则避让。
   新建 `runs/<run_id>/` 并落 actor/heartbeat。
2. **记忆与 map 检索**：MemoryPalace → `v3-resource-operation-map.yml` →
   `v3-function-map.yml` → `v3-mainline-call-map.yml` → 源文件确认符号现状。
3. **搬移**（剪切，不复制）：
   - 新模块文件 ≤1500 行；crate 根 `pub mod` + `pub use` 门面保持公共路径。
   - 旧位置代码在同一提交内物理消失；禁 deprecated 转发、禁注释保留。
4. **同一提交内 map 同步**：
   - `v3-function-map.yml`：owner_file/entry_symbols/allowed_paths 更新，
     `v3.module_decomposition` feature 下该 Phase 条目从 pending 改 active。
   - `v3-mainline-call-map.yml`：受影响边的 `caller_file`/`callee_file`
     改到新模块路径；新增阶段函数补相邻边（status=anchored，真实 symbol）。
   - `npm run render:v3-mainline-caller-flow` 重渲染 md/html。
   - 触碰 locked 链时：按上文追加 manual_authorizations + 刷新 fingerprint。
   - 涉及 debug side-channel（console/live_snapshot）时：
     `v3-resource-operation-map.yml` 登记 projection/debug resource 与禁止边。
5. **验证栈**（Phase 内全绿才允许提交）：
   - `cargo +stable fmt --manifest-path v3/Cargo.toml --all -- --check`
   - `npm run verify:v3-file-size`（Phase 0 落地后；棘轮白名单同步下调）
   - `npm run test:v3-workspace`
   - `npm run verify:v3-mainline-caller-flow`
   - `npm run verify:v3-resource-map`
   - `npm run verify:v3-module-boundaries`
   - `npm run verify:v3-rust-only`
   - `npm run verify:v3-architecture-docs`
   - `npm run test:v3-compile-fail`
   - `git diff --check`（仅本 Phase 触碰路径）
6. **提交纪律**：一个 Phase 一个提交；`git add` 逐路径，禁批量 add/checkout；
   不触碰其他 worker 的脏文件（当前含 `kernel.rs`、
   `responses_direct_remote_continuation_integration.rs`、`package.json` 冲突）。
7. **证据落盘**：`runs/<run_id>/evidence.jsonl` + `note.md` 追加
   （改了什么/怎么验证/剩余风险/下一步）；释放 claim。
8. **全部 Phase 完成后 live 闭环**：`npm run install:v3` → `rccv3 config check`
   → `rccv3 restart` → 4444/5555/10000 `/health` → provider-request dry-run →
   JSON/SSE live smoke → 日志窗口扫描（无 capability_mismatch /
   provider_response_sse_empty / debug sink failed）。

## 禁止事项（红线）

- 禁复制后保留旧副本；禁 `03a`/`03_1` 式节点插号；禁新 wrapper 组合命名
  （`execute_v3_*_with_*_and_*` 三段以上）。
- 禁在 map 中写不存在的 symbol/路径；未搬移完成的条目只能标 pending。
- 禁改节点语义、错误码、retry/health/continuation 判定——本 SOP 只授权搬移
  与入口收敛。
- 禁绕过 locked 链授权流程直接改 fingerprint。

## Phase → map 更新对照表

| Phase | function map 动作 | call map 动作 | lock 授权 |
|---|---|---|---|
| 0 尺寸 gate | `v3.module_decomposition` 增加 gate 条目转 active | 无 | 无 |
| 1 死 wrapper 删除 | entry_symbols 移除被删 symbol | 无（死 wrapper 不在 map 内，删前复核） | 无 |
| 2 ExecutionEnv 收敛 | entry_symbols 换为唯一入口 | 指向旧 wrapper 的边改指唯一入口 | `v3.responses_direct.required_mainline` 可能触碰 → 需要 |
| 3 Server 拆模块 | server 相关 feature 的 owner_file/allowed_paths 逐步换新路径 | 33 条 server/lib.rs 锚定边逐步改路径 | 6 条 locked 链 → 每步需要 |
| 4 主函数节点化 | 新阶段函数补 entry_symbols | 补相邻边（anchored） | relay/direct 相关 locked 链 → 需要 |
| 5 lifecycle/codec | lifecycle feature owner_file 更新 | `v3.server.managed_lifecycle` 7 边改路径 | plain 链，无需 |
