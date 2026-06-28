# Hub Pipeline Boundary Audit Cleanup Plan

## 目标与验收标准

目标：按 `Server <-> Hub Pipeline <-> Provider` 边界审计并清理架构漂移，确保 inbound/outbound 只做相邻节点语义归一/投影，SSE 只做传输，Chat Process 承载 tool/continuation/servertool/stopless 语义，server 只连接客户端请求/响应与 pipeline。

验收标准：
- `ReqInbound/RespInbound` 只做入口/上游响应解析与标准化，不承载 tool governance、continuation restore/save、servertool/stopless 语义。
- `ReqOutbound/RespOutbound` 只做 provider/client 协议投影，不做历史修复、schema 判断、tool 注入、continuation 决策。
- `SSE` 只做 frame write、keepalive、timeout、client close、error frame、snapshot/transport closeout。
- `Server handler/runtime` 只做 HTTP request/response glue、transport closeout、opaque bridge IO。
- 发现重复实现、死语义、错误 helper 时物理删除，并同步 function map / verification map / gate。

## 范围与边界

In scope:
- `docs/architecture/function-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/architecture/verification-map.yml`
- `src/server/handlers/*`
- `src/server/runtime/http-server/*`
- `src/modules/llmswitch/bridge/*`
- `sharedmodule/llmswitch-core/src/conversion/hub/*`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/*`
- architecture gate scripts under `scripts/architecture/*`
- focused tests under `tests/red-tests`, `tests/server/handlers`, `tests/sharedmodule`

Out of scope:
- Provider-specific runtime behavior unless it crosses Hub/server/SSE ownership boundaries.
- Broad provider config changes.
- Live restart or production migration unless the code cleanup touches runtime behavior and requires live replay.
- Unrelated dirty work in the current worktree.

## 设计原则

- 唯一主线：`HTTP server -> Hub Pipeline -> Virtual Router -> Provider Runtime -> upstream`。
- Hub request chain：`ServerReqInbound01ClientRaw -> HubReqInbound02Standardized -> HubReqChatProcess03Governed -> VrRoute04SelectedTarget -> HubReqOutbound05ProviderSemantic -> ProviderReqOutbound06WirePayload`。
- Hub response chain：`ProviderRespInbound01Raw -> HubRespInbound02Parsed -> HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic -> ServerRespOutbound05ClientFrame`。
- 只允许相邻节点转换；禁止跨节点 shortcut、同义 DTO、重复 builder/parser。
- Chat Process owns tool governance, servertool, stopless, continuation restore/save, schema/tool judgment, semantic repair.
- SSE/transport/log/sample 只能做证据面，不能做语义 owner。
- 禁止 fallback、静默吞错、保留死代码。

## 技术方案

1. 先查 owner/map：
   - `docs/architecture/function-map.yml`
   - `docs/architecture/mainline-call-map.yml`
   - `docs/architecture/verification-map.yml`
   - `docs/architecture/wiki/mainline-call-graph.md`
2. 按四类路径审计：
   - inbound/outbound stage：查是否出现 tool/schema/continuation/servertool/stopless 语义。
   - Chat Process：确认语义 owner 是否在 Rust/native owner，TS 是否仅薄壳/桥接。
   - SSE/server handler：查 semantic tokens、finish reason/probe/required_action/continuation/tool/schema logic。
   - server runtime/direct：区分 direct provider-owned continuation 特例与 relay Chat Process continuation。
3. 对每个违规点：
   - 先定位唯一 owner。
   - 加/更新红测或静态 gate，先证明当前可抓违规。
   - 把逻辑迁到 owner 或删除错误逻辑。
   - 物理删除死 helper、旧 facade、过时 gate 引用。
   - 同步 function map / verification map / mainline map。
4. 对 binding pending：
   - 不伪造 symbol。
   - 只补已验证 caller/callee。
   - 无法绑定时记录 pending 和下一步 gate。

## 风险与规避

- 风险：把 direct provider-owned continuation 误删为 server 越权。
  - 规避：按 `continuationOwner=direct|relay` 分流；direct same-provider continuation 单独审计。
- 风险：SSE gate 只查旧文件，实际失效。
  - 规避：gate 必须先能运行，并绑定当前真实文件。
- 风险：只修测试不修 owner。
  - 规避：每个 cleanup 必须有 map owner + source anchor + gate 证据。
- 风险：误改用户/其他 worker dirty changes。
  - 规避：只改本目标相关文件；提交时只 stage 本轮文件。

## 测试计划

Architecture gates:
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-nonadjacent-conversion`
- `npm run verify:architecture-thin-wrapper-only`
- `npm run verify:server-function-map-boundary`
- `npm run verify:responses-handler-single-bridge-surface`
- `npm run verify:responses-sse-business-module`
- `npm run verify:function-map-compile-gate`

Focused tests:
- `npm run jest:run -- --runTestsByPath tests/red-tests/server_responses_sse_surface_single_owner.test.ts tests/red-tests/server_responses_sse_business_module_contract.test.ts tests/server/handlers/handler-response-sse-wrapper-contract.spec.ts --runInBand`
- Add or update focused tests for any newly found owner violation.

Build:
- `npx tsc -p tsconfig.json --noEmit --pretty false`
- `npm run build:base` when touched files affect runtime bridge/native exports.

Live/replay:
- If runtime behavior changes beyond static cleanup, replay a real old sample or run the target live endpoint probe before claiming closure.

## 实施步骤

1. Read `AGENTS.md`, `~/.codex/USER.md`, `note.md`, `docs/agent-routing/00-entry-routing.md`, `.agents/skills/rcc-dev-skills/SKILL.md`, and referenced owner/gate docs.
2. Build an audit table: layer, allowed responsibility, forbidden responsibility, files, owner feature, required gates.
3. Run current gates first; classify failures as gate drift, code violation, map drift, or binding pending.
4. Fix gate drift before using gate results as evidence.
5. For code violation, add/update red test or static gate, then migrate/delete at unique owner.
6. Synchronize docs/maps/tests in the same change set.
7. Run focused tests, architecture gates, TypeScript, and live/replay if runtime behavior changed.
8. Record findings in `note.md`; promote only verified reusable conclusions to `MEMORY.md` or local skill lessons when durable.

## 完成定义

- No SSE/server handler semantic owner drift remains in checked paths.
- Inbound/outbound stages have no tool/schema/continuation/servertool/stopless business logic outside allowed Rust owners.
- All touched architecture gates run and pass.
- Any remaining `binding pending` edges are explicitly documented and not reported as complete.
- `note.md` contains evidence, commands, residual risks, and next owner-targeted cleanup tasks.
