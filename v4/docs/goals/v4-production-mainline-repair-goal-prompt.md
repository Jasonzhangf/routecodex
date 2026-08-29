# Goal: Complete V4 Cordis Production Mainline Repair

在 `v4-cordis` 分支完成 V4 Cordis 生产主线修复。最终四条入口（Responses JSON/SSE、Chat relay JSON/SSE）必须全部经过唯一 `Skeleton -> NodeContainer -> NodePluginPlan -> typed plugins` 请求/响应链；`runtime-bin` 只能 bootstrap/wiring/lifecycle/error dispatch。

执行约束：

1. 先执行 `v4-production-mainline-repair-strategy.md` 的 Stage 0：读取 resource/function/mainline/verification maps，补齐唯一 owner 与真实 caller/callee 边；先写并运行 red gates，证明当前 runtime-bin 旁路、丢弃 request output、直接 helper 编排确实失败。红测和 function map 未完成前禁止改产品代码。
2. 并行启动 T02/T03/T04/T05，各自独立 claim/worktree；T02/T03 不共享文件写入，T04/T05 分别负责 Direct/Relay 模型映射与字段改写插件。T01 完成后才开始实现任务。
3. Request chain 必须产出并被 runtime-bin 消费 typed semantic/wire carrier；禁止原始 body、`project_chat_request_to_responses`、`build_protocol_wire`、业务 router/provider helper 旁路进入 transport。
4. Response chain 必须是 provider raw -> RespInbound -> RespChatProcess -> RespOutbound -> client frame 唯一主线；SSE 只做 framing/transport。
5. 控制信号只走 event/typed side-channel；业务 payload 不得携带 control，payload 不得反向重建 control；共享 payload bytes/borrowed view 仅用于开销优化，不得裁剪语义。
6. 所有修复必须 red-first、正反测试成对、无 fallback、无 silent strip、无 handler/SSE/outbound 补偿。每个 worker 完成后运行定向测试、build、diff-check，写 evidence/handoff/merge queue，通知 master。
7. 集成顺序固定：精确合并 worker commit 到 `v4-cordis` -> 主树 map/gate 复验 -> release build -> 全局安装 -> `rccv4 restart` -> 全端口 health -> 四入口真实 replay -> `codex -p rcm` -> AGY review PASS -> commit/push/tag。不得触碰 V3 或全局 `main`。
8. appsdk/admission、Active artifact、integration receipt 若阻塞，master 必须修复当前 tree 的真实 owner/record graph；禁止复制、伪造、allowlist、fallback 或放宽 gate。

完成信号：

- 所有 red gates 在修复后转绿；function/mainline/verification maps 与真实源码一致。
- runtime-bin direct business helper=0，四入口 production NodeContainer coverage=100%。
- cargo locked/release build、global install、restart、health、Responses/Chat JSON/SSE、`codex -p rcm` 全部有证据。
- AGY controller PASS；最终变更已推送 `v4-cordis` 并打 milestone tag。
