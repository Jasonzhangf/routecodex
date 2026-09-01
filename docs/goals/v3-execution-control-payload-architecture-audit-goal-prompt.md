# V3 执行生命周期与控制/负载隔离目标提示词

```text
/goal
目标：在唯一 worktree `/Users/fanzhang/Documents/github/routecodex/playground/v3-arch-audit` 中完成 V3 执行生命周期唯一化、Direct/Relay 有界 attempt 存储、控制/诊断/负载分离、错误归属与持久化热路径隔离整改，并交付可在线验收的全局架构审计闭环。

说明：这是最终执行任务，不需要再为同一任务生成新的提示词；直接按下列文档执行。

问题与证据：
- docs/goals/v3-execution-control-payload-architecture-audit-problem.md

目标设计：
- docs/goals/v3-execution-control-payload-architecture-audit-design.md

执行方案与 DoD：
- docs/goals/v3-execution-control-payload-architecture-audit-plan.md

执行规范：
- 只使用上述唯一 worktree/branch；先刷新 `.agent-collab` 并取得重叠 semantic claim 的 checked handoff，先激活 resource/function/mainline/module/verification contracts，再改 runtime。
- 一个 request controller、一份 immutable TargetPlan/attempt budget、一个 Error05 recovery 入口；控制状态只走 typed side-channel/Error 链，绝不进入或从业务 payload 重建。
- 禁止 fallback、silent strip、请求侧 cleanup、handler/SSE/outbound 补偿、临时 Runtime、完整 executor 重入、双路径兼容和脚本语义批量替换；旧错误实现接线后物理删除。
- 严格先红后绿；每个批次先做模块边界审查，写后做 diff 越界自检，再进入功能与 live 验证。

验证：
- 定向正反测试、真实 TCP SSE handoff、容量/并发/错误归属/持久化压力与 mutation gates。
- affected workspace + V3 architecture/resource/module/CI/build gates。
- global build/install、唯一 `routecodex restart`、全部配置端口 health、旧错误样本与同入口真实 replay。
- 上述证据完成后执行 AGY review；controller PASS 后精准 commit/push。

完成标准：
- 执行方案 DoD 全部满足；目标 maps 无 `design/binding_pending`，无临时 Runtime、第二重试控制器、无界 attempt buffer、提前成功提交、terminal 全快照热复制、local error→provider error、锁内同步磁盘 I/O或无界 request ledger。
- installed/live/真实 TCP/旧样本/并发容量证据与目标 commit一致，AGY controller PASS，剩余风险和未完成项为零；若存在阻塞，保留显式失败证据，不得降级宣称完成。
```
