# Goal prompt: V3 SSE transport / JSON semantic decoupling

你是 RouteCodex V3 的实现 worker。完成 `v3.sse_protocol_codec_projection_boundary`：修复 provider SSE 与 client/runtime 的解耦，使 SSE 只做传输，所有业务判断在 provider JSON codec 之后完成。

## 目标

1. `routecodex-v3-sse` 只允许处理 bytes、行、字段、`data` 拼接、frame boundary、limits、idle、backpressure、disconnect、EOF；禁止读取 `event:` 做任何 provider/client 语义判断。
2. `event:` 是 opaque transport metadata；`data: [DONE]` 是非 JSON 标记，不能单独构成成功或 terminal。EOF、disconnect、idle、坏 frame 只能成为 transport outcome；没有 JSON terminal 必须显式失败。
3. provider JSON codec 是唯一业务语义入口：从 JSON/typed codec result 判断 failed/incomplete/cancelled/canceled/completed、tool、required_action、continuation、retry、reroute、health、availability 和 client projection。禁止 runtime/kernel/shared helper 自行实现 provider semantic parser。
4. client first-frame commit 是硬边界：commit 前 JSON provider failure 可进入 Error/health/selection/reselect；commit 后只能关闭当前 stream并更新 side-channel，禁止当前请求 reroute、rebuild、rewrite、修改 client payload/history/continuation/normal metadata/provider body。
5. 禁止 fallback、silent strip、请求侧 cleanup、handler/SSE/outbound 补偿；真实 payload 语义必须等价。

## 执行顺序

先读并遵守项目 `AGENTS.md`、`docs/goals/v3-sse-transport-json-semantic-decoupling-audit.md`、`docs/architecture/v3-resource-operation-map.yml`、`v3-function-map.yml`、`v3-mainline-call-map.yml`、`v3-verification-map.yml` 和 `.agent-collab/PROTOCOL.md`。刷新 run/heartbeat/claim，确认唯一 owner 和允许边界。

按以下顺序执行：

1. 固化最小红测：`event:` 与 JSON `type` 不一致时以 JSON 为准；`[DONE]`/EOF 无 JSON terminal 不得成功；commit 后 provider failure 不得当前请求重选或重建。
2. 在唯一 provider JSON codec owner 实现 typed outcome；SSE transport 只返回 opaque validated frame/data。
3. 接通 OpenAI Responses、OpenAI Chat、Anthropic、Gemini 及 direct/relay 所有入口；逐个删除 kernel/shared/server/SSE 层的 provider semantic parser 和 event-name 分支。
4. 同步 function/mainline/resource/verification maps、machine manifest、wiki/HTML 和 gate；把 gate 接入真实 build/CI 入口，不能只改文档。
5. 跑定向测试、workspace build/test、架构 gate；保存正向/反向证据。若存在非本任务 blocker（当前已知完整 workspace test 在 `v3/crates/routecodex-v3-cli/tests/h2_p6_controlled_replay.rs` 的 live fixture 处失败 `node trace header`，以及 dirty debug/provider-compat crate 的 Clippy/集成失败），记录精确路径、命令和影响，不改 unrelated 代码冒充通过。workspace compile 本身必须先通过。
6. 完成全局安装、按项目规则仅用 `routecodex restart` 重启，验证所有配置端口 `/health`，再用同入口真实旧样本验证运行版本与源码一致。
7. 最后使用 `codex-review` MCP review。默认 `codex --profile oauth`，随后 `cc`、`tcm`；只有明确最终 `PASS` 才能交付。review 后任何代码/测试/配置/运行修改都必须重新验证、安装、重启、在线验证和 review。

## 完成合同

只有同时满足以下条件才报告完成：

- SSE 源码没有 provider/client business decision，`event:` 不参与语义；
- 所有 JSON terminal/failure/tool/continuation 判断在对应 provider JSON codec；
- commit 前可按 Error/health/selection 处理，commit 后无当前请求 reroute/rebuild/rewrite；
- 红测先红后绿，正反测试、workspace/build、架构 gate、在线旧样本均有证据；
- 全局安装版本已重启并验证；
- MCP review 最终结论明确 `PASS`，无 P0/P1/blocking finding。

最终汇报只写：改动、根因证据、验证证据、剩余风险/未完成、review verdict。

当前审计基线：实现、定向测试、架构门禁、workspace compile、构建、安装、聚合重启、四端口健康检查和同入口 live replay 已有证据；最新 review 指出的 scoped global probe 与 `response.incomplete/incomplete_details` 缺口已补测。full workspace test 的无关 H2 live fixture、混合 dirty worktree 中的非本任务 review finding、以及 MCP review PASS 仍未闭合。不得把 `FAIL` 或 `binding_pending` 改写为完成信号。
