# V4 响应链插件合并集成计划

## 目标与验收

把 Worker A 的响应数据面插件（`response_inbound` / `response_outbound`）与 Worker B 的 continuation 控制面插件（`continuation_control`）合并在一个 clean worktree，并跑完 V4 source 架构 gate。

验收证据：
- 标准插件 descriptors 数量与源码一致，当前为 25（baseline 19 + Worker A 4 个响应 data-plane + Worker B 2 个 continuation）。
- `cargo test -p routecodex-v4-standard-plugins --locked` 全绿。
- `cargo test -p routecodex-v4-cordis-bridge --locked` 全绿。
- `node scripts/verify.mjs` 与 `node scripts/verify-red.mjs` 全绿。
- `git diff --check` 通过；模块边界自检通过。

## 范围

In scope：
- 合并两个 worker 已完成的 source/test/map/gate 变更。
- 修正三方合并时 `lib.rs`、`.appsdk` maps、resource map、standard-plugins verifier 的交集。
- 记录 evidence 与 handoff。

Out of scope（除非 Jason 显式授权）：
- V4/V3 全局 install、restart、live replay。
- commit、push、merge、DSH Review。
- 修改 V3 主 tree、V3 worktree 或其他 worker 未完成的 dirty worktree。

## 设计原则

1. 控制面只走 `v4.control.metadata_center` -> `v4.scope.session` typed bridge slot -> `ScopeRegistry`；normal payload 不得重建 continuation。
2. 数据面只走 `provider_raw -> parsed_response -> client_semantic -> SSE frame boundary -> client_frame`，节点只能相邻转换。
3. 不引入 fallback、silent strip、payload cleanup、handler/SSE/outbound 补偿。
4. 不把 runtime 加入 `v4/Cargo.toml` workspace；runtime 通过 build-link `test-consumer` 验证。

## 文件清单

- `v4/crates/routecodex-v4-standard-plugins/src/continuation_control.rs`
- `v4/crates/routecodex-v4-standard-plugins/src/response_inbound.rs`
- `v4/crates/routecodex-v4-standard-plugins/src/response_outbound.rs`
- `v4/crates/routecodex-v4-standard-plugins/src/lib.rs`
- `v4/crates/routecodex-v4-standard-plugins/tests/l2_continuation_control.rs`
- `v4/crates/routecodex-v4-standard-plugins/tests/l2_response_inbound_outbound.rs`
- `v4/.appsdk/maps/{function-map.json,mainline-call-map.json,module-registry.json,verification-map.json}`
- `v4/.appsdk/project.json`
- `v4/docs/architecture/v4-resource-operation-map.yml`
- `v4/scripts/architecture/verify-v4-standard-plugins.mjs`
- 依赖的 cordis-bridge / runtime / build-link / active-link 接线与契约变更

## 风险与规避

- 两个 worker 的 map/gate 交集：逐文件读取后用 `apply_patch` 合并，禁止脚本批量替换。
- descriptor 数量硬编码漂移：从合并后源码派生，不手写 `>= 25` 以外的魔法数字。
- verify-isolation 本地依赖解析：先 `npm install --no-package-lock`，确保 `v4/node_modules` 存在。

## 验证矩阵

| 类别 | 命令 |
|---|---|
| 定向 Rust | `cargo test -p routecodex-v4-standard-plugins --locked` |
| 定向 Rust | `cargo test -p routecodex-v4-cordis-bridge --locked` |
| 全量 V4 | `node scripts/verify.mjs` |
| 红测 | `node scripts/verify-red.mjs` |
| 红测专项 | `node scripts/architecture/verify-v4-standard-plugins.mjs --red-self-test` |
| 格式 | `cargo fmt --manifest-path Cargo.toml -p routecodex-v4-standard-plugins -- --check` |
| 静态 | `git diff --check` |

## 完成定义

- 组合 worktree 存在并声明 claim。
- evidence.jsonl 完整，handoff 指向 evidence。
- 未做未授权 install/restart/live/commit/merge/DSH Review。
- 汇报 worktree、改动文件、验证结果、剩余事项。
