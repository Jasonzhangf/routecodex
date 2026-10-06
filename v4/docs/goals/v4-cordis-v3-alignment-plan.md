# V4 Cordis — V3 启动与状态语义对齐计划

## 目标与验收标准

使独立 `v4-cordis` tree 的启动、配置、managed lifecycle、console、请求身份计数和持久化 state 与 V3 真源语义一致，同时保留 V3 并行存在；不得合入全局 `main`。验收必须包含全局 binary 的真实启动、旧实例接管、5520 health、Chat/Responses JSON 与 SSE、跨重启计数连续性及 console 请求/响应打印。

## 范围与边界

In scope：V4 lifecycle、CLI start/restart/stop/repair-stale、简化启动配置、instance/state/manifest/log/request-id-counter 持久化、console attachment、server request identity、对应 maps/gates/tests。

Out of scope：修改 V3 产品代码、关闭或替换用户当前实例（直到明确进入 live cutover）、修改业务 payload、恢复本地 continuation、fallback 或静默清理。

## 设计原则

- 以 V3 实际实现和测试为语义真源，不凭名称推断。
- `start` 对齐 V3：精确释放旧 managed owner，写入 Starting，冷启动新 child；显式 `restart` 保留 V3 in-place exec 语义。
- 控制面 state、计数、console、错误链与业务 payload 物理隔离。
- state/config/record 读写失败必须 fail-fast；原子写入；禁止伪造、复制、fallback。
- 每个功能只有一个 owner；先 resource/function/mainline/verification map，再改代码。

## 技术方案与文件清单

- `v4/crates/routecodex-v4-lifecycle/`：启动状态机、instance ownership、state root、stale/reap、console attach。
- `v4/crates/routecodex-v4-cli/`：V3 对齐的简化启动参数与默认配置解析。
- `v4/crates/routecodex-v4-server/`：持久化 request-id counter、日窗口/总计数、原子写入与读取。
- `v4/crates/routecodex-v4-runtime-bin/`：managed lifecycle 调用、启动/请求/响应诊断输出。
- `v4/crates/*/tests/`：正反红测、跨重启 state 测试、console/接管黑盒测试。
- `.agent-collab/runs/`、`claims/`、`handoff/`、`merge-queue/`：并发任务证据与交付。

## 风险与规避

- 旧 child 脱离 TTY：用精确 owner record/socket 校验和交互 shell attach 测试锁定。
- stale record 或残留 child：只允许声明 PID/socket 的 bounded reap；禁止 broad kill。
- counter 文件损坏/并发写：显式错误、临时文件 + rename、正反测试。
- 历史 admission drift：先恢复当前 candidate 的治理输入，不伪造 record/artifact，不删除 gate。

## 测试计划

1. 先红：start 已有实例仍复用 PID、console 不接管、counter 重启归零、state 缺失/损坏未报错。
2. 定向正反测试：lifecycle、CLI blackbox、server counter、config parser、console output、SSE。
3. locked offline workspace build；release build。
4. 全局安装后仅使用 `rccv4 restart` 做 managed live 验证；按用户要求保留现有实例，不提前切换。
5. 5520 全端口 health、真实 Chat/Responses JSON/SSE、跨重启计数、终端 `▶/✅` 输出。
6. 主 tree 复验、AGY review、精确 commit/queue、push/tag；未满足前不得宣称完成。

## 实施步骤

1. 建立 run/claim，读取 V3/V4 maps、mainline 与现有 state schema。
2. 并行审计 lifecycle/config 与 request counter；各自写红测和 evidence。
3. 合并前先修唯一 owner，实现 V3 语义；执行 scope/diff 审计。
4. 在 `v4-cordis` tree 精确合并各独立 worktree，运行受影响 gates。
5. 完成 release、安装、managed live 验证与旧样本 replay。
6. AGY PASS 后提交、推送、打 milestone tag；保留 V3 与全局 main 不变。

## 完成定义（DoD）

- V4 start/restart/stop/repair-stale、简化配置、instance/state/manifest/log/counter 与 V3 语义一致且有机器门禁。
- 5520 真实请求可用；JSON/SSE 请求和响应在启动 console 实时可见。
- 重启不丢失计数；state 读取/写入异常显式失败。
- 所有并发任务均有 evidence、handoff、精确 merge queue；worktree 清理仅在主 tree 验证、AGY、push 完成后执行。
