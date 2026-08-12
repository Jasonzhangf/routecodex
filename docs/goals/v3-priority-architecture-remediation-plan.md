# V3 优先级架构修复实施计划

status: execution_ready
date: 2026-08-12
owner: RouteCodex V3 architecture remediation

## 目标与验收标准

完成当前架构审计中最高优先级的三个阻断：

1. 补齐 `V3DebugManifest.full_codex_sampling` 所有 fixture，使 workspace compile/test 不因新 manifest 字段失败。
2. 完成 SSE transport 与 provider JSON semantic codec 的边界：`event:` 只能是 opaque transport metadata，不能参与 terminal、failure、completed、reroute 或 client projection 判断。
3. 完成 route-control typed facts 收口：原始 payload 只能在唯一 builder 解析，classifier 只消费 typed facts；移除 classifier 对业务文本直接产生控制路由的依赖，保留协议显式工具/能力事实。

最终必须满足：定向测试、workspace compile/test、架构 gates、build、global install、aggregate restart、全部端口 health、同入口在线旧样本和 Codex review 均通过；review 必须有明确 `VERDICT: PASS`。

## 范围与边界

### In scope

- `v3/crates/routecodex-v3-config` 的 manifest 类型及所有测试 fixture。
- SSE transport decoder、provider JSON codec、direct/relay semantic projection 的唯一 owner 路径。
- `v3/crates/routecodex-v3-route-classifier` 与 `v3/crates/routecodex-v3-runtime/src/nodes.rs` 的 current-turn typed facts。
- resource/function/mainline/verification maps、machine manifest、相关架构 gate 与测试设计。
- 与上述修改直接相关的 playground 红测和证据记录。

### Out of scope

- 不修改 provider endpoint、模型替换、fallback、retry policy、health policy，除非测试证明它们是上述边界修复的唯一 owner。
- 不恢复或引入 `deepseek-v4-flash` 以外的 opencode-go 模型。
- 不做请求/响应截断、脱敏、silent strip、payload cleanup、历史重写或 metadata 补偿。
- 不改动其他 worker 的无关功能；若 claim 冲突，先按 `.agent-collab/PROTOCOL.md` 交接或记录 blocker。

## 设计原则

1. 控制面与业务 payload 物理隔离；控制事实使用 typed carrier / side-channel，不能回写 payload。
2. SSE 只负责 bytes、lines、frame boundary、data 拼接、limits、idle、backpressure、disconnect、EOF。
3. provider JSON codec 是业务语义唯一入口；JSON `type` 是语义真源，`event:` 和 `[DONE]` 不产生语义 terminal。
4. classifier 只消费 typed current-turn facts；不能接收 raw `Value`，不能扫描业务文本重建 route-control state。
5. 无 fallback、降级、双路径补偿或吞错；错误必须进入统一 Error chain 并显式暴露。
6. 只做最小必要修改；不通过 handler、SSE、outbound 或客户端补偿掩盖 owner 越界。

## 技术方案与文件清单

### Manifest fixture

- 以 `V3DebugManifest` 的 canonical constructor/default 为优先；若无安全 constructor，则逐个补齐所有 struct literal。
- 用 `rg` 定位真实 fixture，逐文件读取后用 `apply_patch` 修改。
- 增加 compile contract，防止后续新增 required manifest field 后 fixture 静默失配。

### SSE / JSON boundary

- 由 transport decoder 输出 opaque validated frame/data。
- 删除以 `frame_event_type`、SSE `event:` 或 `[DONE]` 推断 provider terminal/failure/completed 的逻辑。
- 在唯一 provider JSON codec 中要求有效 JSON semantic `type`；缺失或非法时 fail-fast。
- 补正向/反向测试：JSON 与 `event:` 一致、JSON 与 `event:` 冲突、缺失 JSON type、`[DONE]`/EOF 无 JSON terminal、commit 前后 failure 行为。
- 校验 direct、relay、OpenAI Chat、OpenAI Responses、Anthropic、Gemini 所有入口只通过 codec outcome 做业务判断。

### Route-control typed facts

- 保持 raw request parse 只存在于 `build_v3_current_turn_route_facts` 或对应唯一 builder。
- `classify_route` 只接受 `V3CurrentTurnRouteFacts`。
- 删除 `current_user_text` 参与 route-control 判断的路径；协议显式 tool declaration、当前轮 tool output、image、long-context 等事实由 builder 生成 typed fields。
- 增加反向测试：历史轮文本、assistant reasoning、tool arguments 或普通用户文本变化不能改变 route-control；当前轮显式协议能力变化必须改变对应 route。
- 更新 map 与 gate，使旧 extractor、raw payload classifier 入参、非相邻调用都 fail。

## 风险与规避

- fixture 字段补齐可能暴露其他 dirty worker 的编译问题：只修 manifest contract 直接导致的 fixture，不修无关行为。
- 移除文本 route heuristic 可能改变历史行为：先固化现有行为样本，确认协议显式能力覆盖，再删除唯一旧路径；若业务语义无明确替代，停止并记录 design blocker，不偷偷改成 fallback。
- SSE commit 前后边界容易被 runtime/kernel 重建：用 JSON-authority 与 post-commit reverse tests 锁住，禁止在 handler/SSE/outbound 加补偿。
- dirty worktree 可能导致 review 混入其他变更：使用 claim、evidence 和精确 diff scope；review finding 若不属于本任务，记录 owner，不抢改。

## 测试计划

1. 先在 `playground/` 固化最小 red tests，并记录首次偏离、唯一 owner 和反向样本。
2. manifest fixture compile contract 与受影响 crate tests。
3. route-classifier、runtime nodes、target/virtual-router 定向 tests。
4. SSE transport、provider JSON codec、direct/relay projection 正反 tests。
5. workspace `cargo test --workspace --no-run`，再跑 workspace tests；无关 live fixture 失败必须保留精确证据。
6. resource/module/mainline/verification/architecture gates 与 `git diff --check`。
7. `npm run build:dev`，全局安装，使用唯一 aggregate `routecodex restart`，验证 config 中全部端口 `/health`。
8. 使用同入口真实旧样本做在线正反复测，确认运行版本与源码构建版本一致。
9. 最后执行 `codex-review` MCP，固定 `oauth -> cc -> tcm`；review 后任何修改都必须重新验证、安装、重启、在线复测和 review。

## 实施步骤

1. 刷新 `.agent-collab` runs、claims、heartbeat，确认 manifest、SSE、route-control 三个 owner。
2. 阅读并更新本计划引用的 resource/function/mainline/verification maps 和现有 SSE audit。
3. 固化三类 red tests：fixture compile、SSE JSON authority、route typed-facts boundary。
4. 先修 manifest fixture 编译阻断。
5. 修 SSE transport/JSON semantic boundary及其反向测试。
6. 修 route-control 文本依赖，保证 classifier 仍只有 typed facts 入参。
7. 同步 maps、manifest、wiki 和 gates，执行越界自检。
8. 执行完整验证矩阵、build、install、restart、health、live replay。
9. 执行 Codex review；FAIL 只修当前 task owner 范围内 finding，最多五轮；仍有非本 task blocker 必须停止并报告。
10. 只有 review 明确 PASS 后才提交和交付。

## 完成定义（DoD）

- workspace compile/test 不再因 `full_codex_sampling` fixture 缺失失败。
- `event:`、`[DONE]`、EOF、transport frame label 不再产生 provider/client 业务语义。
- provider JSON codec 是 terminal/failure/tool/continuation/client projection 的唯一语义入口。
- route classifier 无 raw payload 入参，无业务文本直接 route-control 推断；typed facts 边界有正反红测。
- 无截断、脱敏、silent strip、fallback、请求 cleanup 或 handler/SSE/outbound 补偿。
- 代码、maps、gates、安装版本、运行服务和在线样本一致。
- `.agent-collab` evidence 完整，Codex review 明确 `VERDICT: PASS`，无 P0/P1/blocking finding。
