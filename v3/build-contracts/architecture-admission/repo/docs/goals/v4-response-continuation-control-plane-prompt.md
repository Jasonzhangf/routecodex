/goal
目标：在 V4 响应链中完成 continuation control-plane 插件的真实接线，使 `continuation_commit` / `continuation_release` 通过 typed bridge 控制槽位写入并释放 `v4.scope.session` 的 `V4ScopeRegistry` 真相。

说明：本任务不需要再写新的提示词，直接按实现文档执行。你是 Worker B；Worker A 的 data-plane 插件已经完成。继续使用既有 clean worktree，不要重建、回滚或覆盖其他 worker 的改动。

实现文档：
docs/goals/v4-response-continuation-control-plane-plan.md

执行规范：
- 先刷新 `.agent-collab/`，核对本 run、claim、worktree、heartbeat、KILL_SWITCH；所有产品文件只在声明的 worktree 修改。
- 先读 V4 resource/function/mainline/verification maps 与 cordis-bridge/runtime owner，再补最小 red test；唯一真相仍是 `routecodex-v4-runtime::V4ScopeRegistry`。
- 只允许 `v4.scope.session` typed control slot、bridge runner、continuation control plugin descriptor/handle 及其契约测试；禁止用 DiagnosticFact、error_chain、debug/snapshot、normal payload 或 client wire 代替 continuation truth。
- `resp_chatprocess save -> next req_chatprocess restore` 区间保持不可变；禁止在 resp_outbound、SSE、handler、adapter、store transport、req_inbound 增加修补或恢复语义。
- 不做 fallback、silent strip、payload cleanup、provider 特例、第二 continuation store 或伪造 verifier 自洽；错误必须 fail-fast。
- 继续适配现有 Worker A 的标准插件变更；若 `standard-plugins/src/lib.rs` 有交集，只做 continuation descriptors/handles 的最小三方可合并改动，不覆盖 Worker A data-plane 实现。
- 不修改 V3、不启动/重启 RouteCodex、不改主 tree、不做全局安装；本轮只完成 V4 source/test/architecture evidence。

验证：
- cordis-bridge、runtime、standard-plugins 定向 cargo tests 与新增 continuation control-plane L2 正反测试；
- `verify-v4-standard-plugins`（含 `--red-self-test`）、cordis-bridge（如存在）、execution-binding、plane-isolation、skeleton/node-graph、resource-binding、relay-continuation、responses-direct gates；
- `git diff --check`，并执行模块边界自检；
- 将每条命令及结果写入 `.agent-collab/runs/20260818T171800Z-Macstudio-wb-continuation/evidence.jsonl`，完成后写 handoff JSON。

完成标准：
- bridge 接受并严格解析 `v4.scope.session` typed slot；
- runtime bridge runner 真实调用 `ScopeRegistry::bind` / `release`，正反测试锁住缺键、重复 bind、错误 scope/owner/protocol、release 后 restore 等边界；
- continuation descriptors 注册并绑定 `response_continuation`，不是 `response_chat_process`；
- `v4.scope.session` truth owner 与 normal payload/client wire 隔离保持不变；
- 所有定向测试和架构 gates 有证据，handoff 明确列出 Worker A 合并时需做的标准插件三方集成；
- 本任务完成后不要再生成新的 prompt，直接回报 worktree、改动文件、验证结果、剩余集成事项。
