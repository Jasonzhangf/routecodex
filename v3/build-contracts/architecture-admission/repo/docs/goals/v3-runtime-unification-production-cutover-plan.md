# V3 Runtime Unification and Production Cutover Plan

## 1. 目标与验收标准

目标：把 V3 已完成的入口协议、Runtime、Provider transport、managed lifecycle 和 live/provider 兼容证据收口成单一可切换运行面，形成可审计的 V3 runtime 归一、P6/旧路径退出条件和 production cutover gate。

验收标准：

- 所有已实现入口协议只通过 `V3 Entry Protocol Endpoint Binding -> single V3 Runtime entry -> Target/Provider owner -> Server response projection` 进入业务执行。
- Foundation/P6 placeholder、old direct/relay bridge、test-only runtime shortcut 均不再承载 production business path；未实现协议必须显式 `pending_not_implemented`。
- Direct、Relay、client inbound WebSocket、servertool/local continuation、remote continuation、provider WebSocket transport 的 owner 边界保持唯一，不互相补偿。
- Cutover checklist 能区分 source/controlled/live/global-install/production evidence；未验证项保持 explicit pending。
- 任何 P6/旧路径物理删除、live config 迁移、global install、restart、production replacement 必须有本目标内明确授权和回滚/恢复证据；否则只交付 cutover-ready 文档和 gates。

## 2. 范围与边界

In scope：

- 新 feature：`v3.runtime_unification_production_cutover`。
- 单一 runtime entry 审计：Responses Direct、Anthropic Relay、OpenAI Chat Relay、Gemini Relay、client inbound WebSocket、managed lifecycle。
- P6/foundation placeholder 退出清单、旧路径/shortcut/source gate、red fixture。
- live 5555 / production replacement 的 prereq checklist、health/version/model/capability/sample replay matrix。
- maps、manifest、wiki、verification gate、architecture review surface。

Out of scope：

- 补写工具/servertool 多轮 parity；它归 `v3.relay_tool_servertool_multiturn_parity_closeout`。
- 补写 client inbound WebSocket implementation；它归 `v3.responses_inbound_websocket_proxy`。
- 真实 provider quirk 修复和 compat matrix；它归 `v3.live_provider_compat_parity_closeout`。
- provider credentials、live config mutation、global install/restart/release/production replacement，除非 Jason 在当前执行 goal 中明确授权。

## 3. 设计原则

- Runtime 归一不是 fallback：所有入口要么进入唯一 V3 runtime entry，要么显式 pending/fail-fast。
- P6/placeholder 只能作为未实现状态或 dry-run/test terminal effect，不得继续承载 business path。
- Server/CLI/lifecycle 只拥有 IO 与进程控制，不拥有 request/response/tool/history/provider semantics。
- Cutover evidence 分层记录：source gate、controlled replay、live provider、global install、managed restart、production replacement 不互相替代。
- 删除旧路径前先证明无生产引用、无 hidden test dependency、无 unresolved rollback dependency；删除必须物理删除并用 red fixture 防复活。

## 4. 技术方案与文件清单

必须先查：

- `docs/goals/v3-entry-protocol-endpoint-binding-parallel-goals-plan.md`
- `docs/goals/v3-relay-tool-servertool-multiturn-parity-closeout-plan.md`
- `docs/goals/v3-responses-inbound-websocket-proxy-plan.md`
- `docs/goals/v3-live-provider-compat-parity-closeout-plan.md`
- `docs/architecture/wiki/v3-responses-direct-mainline.md`
- `docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md`
- V3 function/mainline/verification/resource maps 与 manifests。

候选实现面：

- `v3/crates/routecodex-v3-runtime/src/kernel.rs`
- `v3/crates/routecodex-v3-runtime/src/foundation.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1*`
- `v3/crates/routecodex-v3-server/src`
- `v3/crates/routecodex-v3-lifecycle/src`
- `v3/crates/routecodex-v3-cli/src`
- `scripts/architecture/verify-v3-runtime-unification-production-cutover.mjs`
- `scripts/tests/v3-runtime-unification-production-cutover-red-fixtures.mjs`
- `docs/architecture/manifests/v3.runtime_unification.production_cutover.yml`
- `docs/architecture/wiki/v3-runtime-unification-production-cutover.md`

## 5. 风险与规避

- 风险：为切流临时保留双路径 fallback。规避：source gate 禁止 business request 同时经过 V3 runtime 与旧 direct/relay/P6 business path。
- 风险：P6 删除过早破坏 dry-run/test/未实现 pending。规避：先分类 P6 角色，保留合法 terminal effect，物理删除 business shortcut。
- 风险：live/global evidence 被 source gate 冒充。规避：cutover manifest 每个 case 必填 evidence level 和 sample/run id。
- 风险：Server/lifecycle 为 production convenience 补协议语义。规避：Server/CLI/lifecycle forbidden-source gate。
- 风险：并行 worker 未完成时误切 production。规避：把 tool parity、inbound WS、live compat 三项作为 prerequisite gates；未绿不得 production replacement。

## 6. 测试计划

- Source topology：entry binding 到 runtime entry、target/provider、server projection 的唯一调用链。
- Negative red fixtures：P6 business shortcut、dual runtime entry、Server semantic repair、CLI direct provider send、lifecycle runtime semantics、old bridge revival。
- Controlled replay：Responses Direct、Anthropic Relay、OpenAI Chat Relay、Gemini Relay、servertool/local continuation、remote continuation、client inbound WebSocket。
- Live readiness：`/health.version`、`/v1/models` capability、JSON/SSE/WebSocket smoke、provider error、tool/image、disconnect/cancel。
- Production cutover gate：global install surface、managed restart aggregate health、old sample replay、rollback/restart evidence。
- Architecture gates：resource/function/mainline/verification maps、module boundaries、Rust-only、static hook、fmt、clippy、workspace、diff。

## 7. 实施步骤

1. 刷新 `.agent-collab`，claim `feature_id:v3.runtime_unification_production_cutover`。
2. 查 MemoryPalace、maps、wiki、manifest，列出当前所有 V3 entry/runtime/placeholder/old path。
3. 建立 `runtime_unification.production_cutover` manifest，给每条入口标 evidence level、owner、required gate、blocking prerequisite。
4. 写 red fixtures，先证明 dual path、P6 business shortcut、Server semantic repair 等违规能被抓住。
5. 只在唯一 owner 中收窄 runtime entry/placeholder/cutover gate；不补 provider/tool/WS/live compat 业务缺口。
6. 在三个 prerequisite worker 绿后，跑 controlled matrix 和 cutover readiness gate。
7. 若 Jason 明确授权 live cutover：执行 global install、managed restart、health/model/sample replay、rollback evidence；否则停在 cutover-ready 并列出缺口。
8. 同步 maps/wiki/MEMORY/skill lessons，做 architecture review。

## 8. 完成定义

- V3 runtime 归一 manifest 可查询，所有 implemented entry 都有唯一 runtime path。
- P6/old business shortcut 被 gate 锁住；合法 pending/dry-run terminal effect 边界清楚。
- Cutover prerequisites 与 blocker list 明确，不能把未验证项冒充 production ready。
- 如果本轮未获 live cutover 授权：完成状态只能是 `cutover-ready source/controlled`，不能声明 production replacement。
