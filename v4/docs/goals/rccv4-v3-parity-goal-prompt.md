/goal
目标：以当前 V4 worktree 的 HEAD/tree 为唯一基线，完成 RCCV4 对 V3 7777 选定生产语义的完整闭环；同一层所有独立实现全部 source-green 后再由单一 integration owner 接线，最终完成 5520 安装、聚合重启、在线差分、AGY review 与整包 V4 提交。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
v4/docs/goals/rccv4-v3-parity-completion-plan.md

执行规范：
- 只在当前声明的 V4 playground worktree 工作；V3/main 不读写、不接线、不替换。
- 先查 MemoryPalace、resource/function/mainline/verification maps；每个功能只有一个 Rust owner，配置只经 compile/validate/load 进入 typed manifest。
- 先红后绿；同层未全绿禁止接线。禁止 fallback、双真源、请求侧 cleanup、silent strip、控制面进入业务 payload、handler/SSE/outbound 补偿和 provider 特例。
- runtime 只消费 typed product manifest；provider failure 只能进入 ErrorErr01-06 与 session-scoped availability/reselect owner，不能由 handler 临时补偿。
- review 不阻塞无依赖的独立开发；未完成安装/重启/在线 replay 前不得启动 review；FAIL 只回唯一 owner 修复并重跑受影响验证。

验证：
- 定向正反测试、architecture/red、active-link、workspace cargo test/build。
- 用 `npm --prefix v4 run install:global` 安装 V4 产物，随后仅使用全局 `rccv4 restart`，验证 5520 及配置内全部 listener `/health`；禁止用 `routecodex` 作为 V4 生命周期证据。
- 同 requestId V3 7777 ↔ V4 5520 真实 replay：raw request → provider-bound request → raw response → client projection；unexplained_diff 必须为 0。
- 运行 AGY review；只接受零 P0/P1 的 PASS。

完成标准：
- 无 source-only/lived-pending 配置字段；所有 route/provider/auth/error/protocol/availability/lifecycle 语义均由 V4 typed owner 实际消费。
- 同层 source-green → 单 owner 接线顺序完整；V3/main 未被触碰；无 fallback、payload 控制泄漏或未解释差分。
- live 运行版本与候选提交一致，全部 required gates、在线证据、AGY PASS 落盘后，检查精确 staged change set，一次性提交完整 V4。
