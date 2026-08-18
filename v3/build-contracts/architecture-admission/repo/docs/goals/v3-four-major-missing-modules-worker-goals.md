# V3 四个大型缺失模块并行 Worker Goals

这四个目标来自当前 V3 function/mainline/verification/resource maps、实现文档和
`.agent-collab` claim 状态。它们是可独立 claim 的大型模块，不再把已经完成的入口协议
registry、endpoint dispatcher、Virtual Router、协议 codec characterization 当成“缺失模块”。

命名统一使用中性的“V3 Hub 协议流水线”。现有 `relay` 字样只保留在已经发布的
`feature_id`、文件路径和 gate 名中，避免在并行开发期间擅自改动已消费的 contract ID。

## 并行边界

- Worker 1、2、3 可以立即并行；Worker 4 先完成 runtime/cutover readiness、依赖清单和
  防双路径 gate，只有前三个依赖满足且 Jason 明确授权后，才可执行 live cutover。
- 每个 worker 必须先刷新 `.agent-collab/PROTOCOL.md`，按自己的 `feature_id` claim，
  写独立 `actor.json`、`heartbeat.json`、`events.jsonl`、`evidence.jsonl`。
- Hub/Chat Process 只拥有协议、continuation、tool/history/servertool 治理；Server、
  transport、provider runtime 不得修补这些语义。
- 禁止 fallback、双 runtime、静默降级、payload/control side-channel 泄漏。
- 未获当前 goal 明确授权，不改 `~/.rcc`、provider credential、live config，不做全局安装、
  restart、release、P6 删除或 production cutover。

## Goal 1 — Responses Direct 远端 Continuation 完整接线

```text
/goal
目标：完成 `v3.responses_direct_remote_continuation_integration`，让 provider-owned response_id/previous_response_id 在 Responses Direct 下一轮按原 provider/model/auth 精确续接，并完成隔离、释放、失败和在线双轮证据。

说明：这是最终执行任务，不需要再为同一任务生成新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v3-responses-direct-remote-continuation-integration-plan.md

执行规范：
- 先刷新 `.agent-collab`，claim `feature_id:v3.responses_direct_remote_continuation_integration` 和对应 continuation resource；遇到现有 active claim 先 handoff，不覆盖。
- remote continuation 只在 Resp04 commit，只在下一轮 Req03 load/classify，并在 Req06 exact pin；禁止 Server、handler、transport、provider runtime 恢复 history/tool。
- Direct owner 不得续到 Hub relay/local owner；入口协议、owner、session/conversation、listener/group、provider/model/auth 任一不匹配都 fail-fast。
- 禁止 provider reselection、HTTP fallback、local materialize 补偿、第二 Runtime kernel和第二 response exit。

验证：
- 先红后绿的 remote continuation contract/store/runtime/server 正反测试
- `test/verify/red-fixtures` 的 V3 direct remote continuation gates
- V3 architecture/resource/module/Rust-only/fmt/clippy/workspace/diff gates
- 获授权后使用同一真实入口完成两轮 live replay，并核对原 provider/model/auth pin

完成标准：
- 第一轮 remote response truth 可提交，第二轮 tool output 只命中原 Direct owner 和精确 provider pin。
- success、failure、still-running、already-terminal、scope mismatch、expired/released 全部有正反证据。
- 无跨 owner 续接、无 history repair、无 fallback；未获 live 授权时只声明 source/controlled 完成。
```

## Goal 2 — Client-facing Responses WebSocket 入口

```text
/goal
目标：完成 `v3.responses_inbound_websocket_proxy`，让客户端通过 `/v1/responses` WebSocket 连入 RouteCodex，并复用唯一 V3 Responses Runtime 与既有 provider WebSocket transport owner。

说明：这是最终执行任务，不需要再为同一任务生成新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v3-responses-inbound-websocket-proxy-plan.md

执行规范：
- 先刷新 `.agent-collab`，claim `feature_id:v3.responses_inbound_websocket_proxy`；不得接管 provider/upstream WebSocket transport 的 socket/cache owner。
- Server 只拥有 client upgrade、frame transport、disconnect/cancel 和 client event projection；request/response/continuation/tool 语义仍进入唯一 V3 Runtime。
- WebSocket 失败不得切 HTTP；不得 full event materialize，不得在 Server 保存 provider socket state，不得创建第二 Runtime kernel。
- client frame、provider frame、metadata/debug/control resource 必须隔离；错误显式进入 V3 Error01-06。

验证：
- handshake、response.create、incremental event、tool、error、disconnect/cancel 正反测试
- `test/verify/red-fixtures` 的 V3 inbound WebSocket gates
- JSON/SSE/WebSocket 的唯一 Runtime 与唯一 response exit 架构门禁
- V3 resource/module/Rust-only/fmt/clippy/workspace/diff gates

完成标准：
- Controlled client WebSocket 可进入唯一 V3 Runtime/Provider path，并按原序返回事件。
- client socket 与 provider socket owner 物理分离；断连、取消、非法帧和 terminal 状态均显式处理。
- 无 HTTP fallback、无 Server 语义修补、无 side-channel 泄漏；live WebSocket 未验证时不声明 production ready。
```

## Goal 3 — 真实 Provider 兼容性与功能等价矩阵

```text
/goal
目标：完成 `v3.live_provider_compat_parity_closeout`，对 V3 的 endpoint × protocol × provider/model × transport × tool/image/error 建立 controlled 与真实 provider 双证据兼容矩阵，并修复唯一 provider runtime/codec owner 中的真实差异。

说明：这是最终执行任务，不需要再为同一任务生成新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v3-live-provider-compat-parity-closeout-plan.md

执行规范：
- 先刷新 `.agent-collab`，claim `feature_id:v3.live_provider_compat_parity_closeout`；每个 live case 先有等价 controlled fixture 和期望输出。
- provider-specific 差异只允许在对应 provider runtime/codec owner 修；Hub、Virtual Router、Server 禁 provider/model 特例。
- 真实 payload 语义必须等价，不得为提速裁剪请求/响应；metadata/debug/control 不得进入 provider/client normal payload。
- 未获授权只做只读 live probe；不得改 `~/.rcc`、credential、live config、全局安装、restart 或 release。

验证：
- 协议、JSON/SSE/WebSocket、普通/多轮 tool、servertool、image/attachment、error/reroute 兼容矩阵
- 每个 production-ready case 的 controlled fixture + 同入口真实 provider replay
- `verify:red-fixtures` 的 V3 live-provider compat gates
- V3 architecture/resource/module/Rust-only/fmt/clippy/workspace/diff gates

完成标准：
- 矩阵中的 verified、pending、blocked 均有 owner、样本和证据路径，可直接反查。
- 标记 production-ready 的 case 必须同时有 controlled 与真实 provider 证据。
- 所有真实差异回到唯一 provider runtime/codec 修复；无 Hub/VR 特例、无 fallback、无未经证据的完成声明。
```

## Goal 4 — 单一 Runtime 归一与 Production Cutover Readiness

```text
/goal
目标：完成 `v3.runtime_unification_production_cutover`，把已实现的入口协议、V3 Runtime、Target/Provider、managed lifecycle 和兼容证据收口成单一运行面，并锁住旧业务路径/P6 的退出条件和 production cutover gate。

说明：这是最终执行任务，不需要再为同一任务生成新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v3-runtime-unification-production-cutover-plan.md

执行规范：
- 先刷新 `.agent-collab`，claim `feature_id:v3.runtime_unification_production_cutover`；先审计 Goal 1-3 与现有 V3 feature 的证据，不在本模块重复实现它们。
- Runtime 归一不是 fallback：implemented entry 必须只进入一个 V3 runtime path；未实现入口必须显式 pending/fail-fast，禁止双跑、影子补偿和旧路径回落。
- Server/CLI/lifecycle 只负责 entry、manifest、process、transport 和 projection，不得拥有 request/response/tool/provider 业务语义。
- P6/旧路径删除、live config mutation、global install/restart/release/production replacement 必须等前置 gate 全绿并由 Jason 在当前 goal 明确授权。

验证：
- 单一 runtime entry、相邻节点、owner/query、旧路径复活和双路径红测
- Responses Direct、各 Hub 协议流水线、client WebSocket、local/remote continuation、servertool 的 controlled 聚合 replay
- cutover readiness manifest、rollback/recovery contract 和 prerequisite evidence audit
- V3 architecture/resource/module/Rust-only/static-hook/fmt/clippy/workspace/diff gates；获授权后再跑 global install、managed restart、health/models/sample/live replay

完成标准：
- 每个 implemented entry 都能反查唯一 V3 runtime path、owner、mainline、resource 和 required gates；未实现项显式 pending。
- business request 不可同时进入 V3 与旧 runtime，P6/旧业务 shortcut 有不可复活红测。
- 未获 production cutover 授权时只声明 cutover-ready；获授权且 live 证据全绿后，才声明 production replacement 完成。
```

## Worker 分配建议

| Worker | feature_id | 可立即执行 | 主要依赖 |
| --- | --- | --- | --- |
| 1 | `v3.responses_direct_remote_continuation_integration` | 是 | 既有 remote store/codec、Responses Direct |
| 2 | `v3.responses_inbound_websocket_proxy` | 是 | 既有 Responses Runtime、provider WebSocket transport |
| 3 | `v3.live_provider_compat_parity_closeout` | 是 | 已实现协议路径；live 权限决定闭环层级 |
| 4 | `v3.runtime_unification_production_cutover` | 先做 readiness | Goal 1-3 与现有 V3 gates；真实 cutover 需明确授权 |
