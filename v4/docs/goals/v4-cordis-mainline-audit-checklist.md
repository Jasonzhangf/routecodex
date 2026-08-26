# V4 Cordis 主线全局审计 Checklist

状态：`in_progress`。主计划：`v4/docs/goals/v4-cordis-mainline-migration-plan.md`。任务分派：`v4/docs/goals/v4-cordis-mainline-task-board.md`。

## 周期门禁（每个独立 task 必跑）

- [ ] 独立 run/claim/branch/worktree，从当前 V4 重构主树 HEAD 开始。
- [ ] 读取 resource/function/mainline/verification map、module registry、canonical docs。
- [ ] 记录 baseline、first divergence、最小 red test/sample；先红后绿。
- [ ] 唯一 owner 修改；禁止 fallback、silent strip、payload/control 混载、第二实现。
- [ ] diff 越界自检 → 定向测试 → locked build → 必要 install/restart/health/live replay。
- [ ] evidence.jsonl + handoff/merge-queue + checker。
- [ ] 精确合并 V4 重构主树；主树复验；milestone 结束后合并仓库 main、复验、同步。

## 全局阶段审计

- [ ] M00：迁移计划、ADR、epoch/catalog/control/outcome 合同；bypass ratchet；protected gate promotion；每个 milestone 独立 claim 表。
- [ ] M01：NativePlugin ABI、resolver、config、catalog exporter。
- [ ] M02：generic Cordis factory；真实 request/response Fiber mount/dispose。
- [ ] M03：Cordis daemon、typed socket、generation、heartbeat、reconcile。
- [ ] M04：prepare/commit/abort/drain/rollback；hash/stale/idempotency/lease。
- [ ] M05：唯一 ExecutionEngine；节点输出接线；删除第二 graph/registry。
- [ ] M06-M07：Responses JSON request/response 主线与 old/new differential。
- [ ] M08-M09：async server/provider transport 与零逐帧 IPC SSE。
- [ ] M10：Router/Error/Health/Continuation typed owner、scope、正反测试。
- [ ] M11：Chat/Anthropic/Gemini/WebSocket、tools/servertool/stopless/Admin。
- [ ] M12：全 protocol/provider/mode/state/lifecycle/concurrency parity、release、canary、drain、rollback。

## 最终不变量

- [ ] 无 active epoch 不接受业务请求；请求/SSE 全程固定 immutable epoch。
- [ ] Cordis 是 active plugin graph 唯一真源；Rust registry 只 resolve implementation。
- [ ] 数据面不经过 Cordis event bus；control/debug/error/scope 不进正常 payload。
- [ ] `runtime-bin` 无生产协议/路由/provider/retry/continuation/tool/projection 编排。
- [ ] 每 feature 达到 `production_integrated → differential_pass → live_pass → frozen`。
- [ ] V3 保持独立；无单请求 V3 fallback；切换需显式授权。

## 当前审计结论

- [x] M00-T00 迁移计划已纳入 V4 重构主树并闭合 ratchet canonical doc 引用：`3b62ffd9a`。

- [x] V4 已有 Cordis/NodeContainer/plugin plan/基础 maps 与 gates。
- [x] M00-T01 合同已合并 V4 重构主树：`aaf8b1f39`。
- [ ] M00-T02 ratchet 已合并主树，但 canonical live admission 仍被 5 个 upstream HTTP 502 样本阻塞。
- [x] M00-T03 审计面已合并 V4 重构主树：`c4d13d7b8`。
- [x] M00-T04 每个 milestone 独立 claim 表已建立并合并 V4 重构主树：`5e0090f9d`。
- [ ] M00-T05 live admission closeout：当前被 provider Responses WebSocket v2 endpoint 阻塞；不得以 HTTP continuation 或 fallback 替代。
- [ ] M00-T06 canonical B wire evidence：同 requestId provider-request/provider-response 诊断 bundle 尚待 task worktree 验证并合并。
