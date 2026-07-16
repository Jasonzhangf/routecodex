# V3 Live Provider Compat Parity Closeout Plan

## 1. 目标与验收标准

目标：建立并绿化 V3 面向真实 provider 的 compat parity matrix，区分 controlled/source 已完成和 live/provider 真实兼容未证明的部分，确保 V3 在切流前覆盖主要协议、transport、工具、图片和错误场景。

验收标准：

- 形成 endpoint × protocol × provider/model × transport × tool/image/error 的机器可读兼容矩阵。
- 每个 live case 先有 controlled fixture，再用真实 provider 或授权 live profile 重放。
- provider-specific 差异只在 provider runtime/codec owner 解决，不进入 Hub Pipeline 或 Virtual Router。
- 401/402/403/429/5xx、SSE body-level failure、malformed provider body、disconnect/cancel 均进入 Error01-06 或对应 typed provider error。
- 未验证项保持 explicit pending，不被标记为 production ready。

## 2. 范围与边界

In scope：

- 新 feature：v3.live_provider_compat_parity_closeout。
- Responses Direct、Responses Relay、Anthropic Messages、OpenAI Chat、Gemini 的 JSON/SSE/WebSocket compat matrix。
- 真实 provider quirks：request shape、stream framing、tool deltas、image/multimodal payload、rate/billing/quota errors、provider error bodies。
- Codex client protocol alignment：/v1/models capabilities、Responses WebSocket beta header、Responses HTTP/WS event shape。
- Live replay evidence、samples/log review、failure classification 和 owner routing。

Out of scope：

- client-facing inbound WebSocket proxy implementation；它归 v3.responses_inbound_websocket_proxy。
- Direct remote continuation state machine implementation；它归 v3.responses_direct_remote_continuation_integration。
- V2 config compatibility/importer、P6 deletion、production cutover。
- 未授权的 ~/.rcc mutation、credential mutation、global install/restart。

## 3. 设计原则

- controlled 证据不能冒充 live/provider 证据；每个结论必须标明证据层级。
- live replay 只能验证真实 provider 行为，不允许为绕过 provider 缺陷改真实用户配置。
- provider quirk 修复只落在对应 provider runtime/codec owner；Hub/VR 禁 provider-specific 分支。
- compat 不是 fallback；不兼容必须红测、显式错误、唯一 owner 修复。
- 请求/响应语义等价；允许清理 debug/snapshot，禁止裁剪真实 payload。

## 4. 技术方案与文件清单

必须先查：

- docs/design/v3-system-definition.md
- docs/architecture/v3-verification-map.yml
- docs/architecture/v3-function-map.yml
- docs/architecture/v3-mainline-call-map.yml
- docs/architecture/wiki/v3-hub-relay-fixed-pipeline.md
- docs/goals/v3-responses-websocket-v2-transport-hardening-plan.md
- docs/goals/v3-responses-direct-remote-continuation-integration-plan.md
- docs/goals/v3-relay-tool-servertool-multiturn-parity-closeout-plan.md

候选实现面：

- provider runtime/codec owners under v3/crates/routecodex-v3-provider-*
- protocol runtime owners under v3/crates/routecodex-v3-runtime/src/hub_v1*
- server thin IO tests under v3/crates/routecodex-v3-server/tests
- live replay scripts under scripts/tests or scripts/architecture
- docs/architecture/manifests/v3.live_provider_compat.parity.yml
- resource binding v3.live_provider_compat.matrix
- scripts/architecture/verify-v3-live-provider-compat-parity.mjs
- scripts/tests/v3-live-provider-compat-parity-red-fixtures.mjs

## 5. 风险与规避

- 风险：live provider 临时故障被误判为 V3 bug。规避：controlled fixture 与 live sample 双证据；provider HTTP/error body 原样归档。
- 风险：为 live 通过修改真实配置。规避：只读 live probe；需要配置变更时输出 patch/plan 并停止等待授权。
- 风险：provider-specific 修复污染 Hub/VR。规避：source gate 禁止 Hub/VR provider key/model 特判。
- 风险：SSE/WS 错误被 HTTP status 200 掩盖。规避：body-level failure guard 与 stream error replay。
- 风险：模型能力目录不全导致 Codex 请求形态错误。规避：/v1/models capability live/client replay。

## 6. 测试计划

- Matrix：Responses Direct/Relay、Anthropic、OpenAI Chat、Gemini × JSON/SSE/WS × text/tool/image/error。
- Controlled：每个 live case 必须先有 loopback/fixture，锁 provider wire 与 client projection。
- Live：授权 profile 上重放最小真实样本，记录 request id、samples、server log、provider response。
- Error：401/402/403/429/5xx、SSE response.failed/error、malformed body、timeout、disconnect、cancel。
- Capability：/v1/models 与 Codex request builder 所需字段对齐。
- Gates：focused tests、live replay verifier、architecture/resource/module/Rust-only/fmt/clippy/workspace/diff gates。

## 7. 实施步骤

1. 刷新 .agent-collab，claim feature_id:v3.live_provider_compat_parity_closeout。
2. 生成 compat matrix manifest，给每个 case 标明 owner、required gate、evidence level。
3. 对未验证项先写 controlled fixture 和 red gate。
4. 逐项 live replay；只读真实配置，不改 credential/config。
5. 对真实失败按唯一 owner 修复或标 explicit pending。
6. 同步 maps/wiki/manifest/evidence，生成 production readiness blocker list。
7. 做 architecture review，确认无 fallback、无 provider-specific Hub/VR 分支、无 payload 泄漏。

## 8. 完成定义

- live/provider compat matrix 可查询，verified/pending/blocker 状态明确。
- 所有 declared production-ready case 均有 controlled + live 双证据。
- 未完成项不冒充完成；阻塞切流的 provider/protocol/transport/tool/image/error 缺口被列成明确 owner backlog。

## 9. 2026-07-16 partial live 5555 closeout

Authorized live closeout installed the current source globally, restarted the managed V3 5555
instance, and verified the final live profile responses + openai_chat with real provider replay.
Evidence: .agent-collab/runs/20260716T032203Z-Macstudio.local-73370-compatresume/logs/live-provider-matrix-20260716T033635Z/summary.json.

Verified live cases:

- /v1/models capability catalog for gpt-5.6-sol with required Codex request-builder fields.
- Responses Direct JSON and SSE.
- Responses Direct client-facing WebSocket on GET /v1/responses with
  OpenAI-Beta: responses_websockets=2026-02-06.
- OpenAI Chat Relay JSON and SSE on /v1/chat/completions.

Remaining blockers stay explicit: Anthropic Messages final-profile endpoint_not_enabled,
Gemini Generate Content final-profile endpoint_not_enabled, and live
401/403/5xx/timeout provider-error samples. Controlled error evidence now covers 401/403/5xx/timeout
through `npm run verify:provider-failure-ban-blackbox`: failing primary is excluded once, backup/default
is hit, and the client does not receive an early terminal provider error. No live config mutation,
credential mutation, or P6 deletion is claimed.

## 10. 2026-07-16 Gemini live blocker recheck after 60d0c90f4

After 60d0c90f4, globally installed rccv3 snapshot 0.90.3935 was used to restart the
managed 5555 instance from /Volumes/extension/.rcc/config.5555.v2.toml. Gemini Generate
Content JSON and SSE probes both returned typed HTTP 501 endpoint_not_enabled at
V3Server03HttpRequestRaw with Error01-06 projection before provider send. The sanitized config
summary contains no Gemini provider endpoint, so the remaining Gemini live gap is an unauthorized
profile blocker, not the old runtime bug that routed /generateContent to the default OpenAI target.

Evidence:

- .agent-collab/runs/20260716T092257Z-Macstudio.local-29305-geminilive/logs/clean-live/rccv3_managed_restart_after_60d0c90f4.log
- .agent-collab/runs/20260716T092257Z-Macstudio.local-29305-geminilive/logs/clean-live/post_restart_health_process.log
- .agent-collab/runs/20260716T092257Z-Macstudio.local-29305-geminilive/logs/clean-live/live_gemini_json_sse_after_restart_60d0c90f4.txt
- .agent-collab/runs/20260716T092257Z-Macstudio.local-29305-geminilive/logs/clean-live/live_gemini_after_restart_config_logs.txt

## 11. 2026-07-16 Responses Relay live 5555 closeout

Globally installed rccv3 snapshot 0.90.3935 was used to start the managed 5555 instance from
/Volumes/extension/.rcc/config.5555.v2.toml after source cutover. Evidence:
.agent-collab/runs/20260716T110035Z-Macstudio.local-31201-f5633c/logs/live-provider-matrix-20260716T114218Z/summary.json.

Verified live cases:

- /v1/models capability catalog for gpt-5.6-sol with required Codex request-builder fields.
- Responses Relay JSON on POST /v1/responses: HTTP 200, exact marker, fixed Req01-Req09/Resp01-Resp06 trace, no Direct/P6 markers.
- Responses Relay SSE on POST /v1/responses: HTTP 200, exact marker, response.completed, fixed Req01-Req09/Resp01-Resp06 trace, no Direct/P6 markers.
- Responses Direct client-facing WebSocket on GET /v1/responses with OpenAI-Beta: responses_websockets=2026-02-06.

Boundary at this stage: current POST /v1/responses is Relay after source cutover, so Direct JSON/SSE was
still backed by same-day pre-cutover production evidence from
.agent-collab/runs/20260716T032203Z-Macstudio.local-73370-compatresume/logs/live-provider-matrix-20260716T033635Z/summary.json.
Section 12 supersedes this Direct JSON/SSE freshness gap with a temporary non-production Direct 5555 replay.
No credential mutation, P6 deletion, or full production cutover is claimed.

## 12. 2026-07-16 Responses Direct fresh 5555 closeout after V3 non-production authorization

Jason clarified that V3 5555 is non-production for this task and authorized connection, config, restart,
and live replay work without waiting for extra approval. A temporary native V3 Direct config was generated
from /Volumes/extension/.rcc/config.5555.v2.toml, validated with `rccv3 config check`, used only for the
Direct replay, then removed after the original /Volumes/extension/.rcc/config.5555.v2.toml Relay instance
was restored. Evidence:

- Direct fresh replay: .agent-collab/runs/20260716T121255Z-Macstudio.local-15204-6ffb1ba1/logs/direct-fresh-live-20260716T122025Z/summary.json
- Relay restoration replay: .agent-collab/runs/20260716T121255Z-Macstudio.local-15204-6ffb1ba1/logs/relay-restored-live-20260716T122141Z/summary.json

Verified live cases:

- Responses Direct JSON on POST /v1/responses: HTTP 200, marker V3_DIRECT_FRESH_JSON_OK, Direct/P6 node trace, no Relay trace.
- Responses Direct SSE on POST /v1/responses: HTTP 200, marker V3_DIRECT_FRESH_SSE_OK, response.completed, Direct/P6 node trace, no Relay trace.
- Responses Direct client-facing WebSocket on GET /v1/responses: response.completed, marker V3_DIRECT_FRESH_WS_OK.
- Restored /v1/models on the original config: HTTP 200 with required Codex request-builder fields for gpt-5.6-sol.
- Restored Responses Relay JSON/SSE on POST /v1/responses: HTTP 200, fixed Req01-Req09/Resp01-Resp06 trace, no Direct/P6 markers.

Boundary: no provider credential mutation, no persistent original 5555 config mutation, no P6 deletion, no
two-turn remote continuation/tool_outputs exact-pin live replay, and no full production cutover is claimed.
The direct temporary config existed only to produce fresh Direct JSON/SSE/WS evidence on the non-production
V3 5555 listener, and the listener was restored to the original Relay profile before closeout.

Follow-up blocker evidence: `.agent-collab/runs/20260716T125019Z-Macstudio-75061-1d19c963/provider-ws-upgrade-summary.json`
probed 13 configured Responses providers x 4 provider-side WebSocket candidates with configured auth and
`OpenAI-Beta: responses_websockets=2026-02-06`; 0/52 returned HTTP 101. This keeps
`remote_continuation_two_turn_live=false` until a provider-verified Responses WebSocket v2 endpoint is available
and a real two-turn exact-pin replay succeeds.
