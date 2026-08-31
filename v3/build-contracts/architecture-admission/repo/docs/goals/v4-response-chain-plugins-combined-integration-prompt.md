/goal
目标：核对并收尾 V4 响应链插件三方合并，证明 Worker A 数据面与 Worker B continuation 控制面在同一 clean worktree 中通过全部 V4 source 架构 gate。

说明：本任务不需要再写新的提示词，直接按实现文档执行。未获 Jason 显式授权，禁止 install/restart/live replay/commit/merge/DSH Review；只做 source evidence 与 handoff。

实现文档：
docs/goals/v4-response-chain-plugins-combined-integration-plan.md

执行规范：
1. 先刷新 `.agent-collab/`：runs、claims、handoff、merge-queue、KILL_SWITCH；只在声明 worktree 修改，不覆盖 Worker A/B 或 V3 dirty worktree。
2. 合并 Worker A `response_inbound/outbound` 与 Worker B `continuation_control` 到 `lib.rs`、maps、resource map、verifier；descriptor 数量从源码派生，不硬编码。
3. 控制面只能走 `v4.control.metadata_center` -> `v4.scope.session` typed bridge -> `ScopeRegistry`；normal payload 禁止重建 continuation。
4. 数据面只能相邻转换 `provider_raw -> parsed_response -> client_semantic -> SSE frame boundary -> client_frame`；禁止 fallback、silent strip、payload cleanup、handler/SSE/outbound 补偿。
5. 不把 runtime 加入 `v4/Cargo.toml` workspace；V3/main tree 不允许修改。

验证：
- `cargo test -p routecodex-v4-standard-plugins --locked` 与 `cargo test -p routecodex-v4-cordis-bridge --locked`
- `node scripts/verify.mjs`、`node scripts/verify-red.mjs`
- `node scripts/architecture/verify-v4-standard-plugins.mjs --red-self-test`
- `cargo fmt --check`、`git diff --check`

完成标准：
- 组合 worktree evidence.jsonl 完整，handoff 指向 evidence；所有 gate 有真实结果。
- 不 commit、不 push、不 merge、不 install/restart/live、不运行 DSH Review。
- 回报 worktree、改动文件、验证结果、剩余事项与下一步授权项。
