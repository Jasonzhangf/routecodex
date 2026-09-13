<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `node scripts/architecture/render-architecture-wiki-pages.mjs`. -->
# Servertool Ownership Map

This page is the current V3 review surface for ordinary registered servertools and `web_search`.
The V3 servertool contract has no server-side followup/reentry branch and no Stopless owner.

Source of truth:
- `docs/architecture/v3-function-map.yml` defines the active V3 owner and gates
- `docs/architecture/v3-resource-operation-map.yml` defines typed resource boundaries
- `docs/architecture/v3-mainline-call-map.yml` defines caller edges
- `docs/architecture/v3-verification-map.yml` defines required verification
- `docs/design/v3-servertool-center-skeleton.md` defines the active servertool skeleton
- `docs/design/servertool-cli-lifecycle.md` defines the client-exec CLI loop

Feature scope: `hub.servertool_*`

| feature_id | summary | owner crate | status | required gates |
| --- | --- | --- | --- | --- |
| `v3.servertool_center_skeleton` | 统一 ServertoolCenter（MetadataCenter）：管理 web_search / servertool CLI 的工具识别（当前是哪一个）、状态注册与状态机整体推进；hook 只在 Req04 请求治理与 Resp03 响应治理固定挂载点调用；数据面（SSE/payload）零控制逻辑。三段式：识别 -> 状态判断 -> 操作。 | `docs/design/v3-servertool-center-skeleton.md, v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs, v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs, v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs, v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs` | `design_locked_docs_and_maps` | `npm run verify:v3-resource-map`<br/>`npm run verify:v3-module-boundaries`<br/>`npm run verify:v3-mainline-caller-flow`<br/>`npm run verify:v3-architecture-docs`<br/>`npm run verify:v3-servertool-center-skeleton`<br/>`npm run test:v3-servertool-center-skeleton-red-fixtures` |

## Active owner boundary

- Owner source: `docs/design/v3-servertool-center-skeleton.md, v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs, v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs, v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs, v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs`
- Owner scope: 统一 ServertoolCenter（MetadataCenter）：管理 web_search / servertool CLI 的工具识别（当前是哪一个）、状态注册与状态机整体推进；hook 只在 Req04 请求治理与 Resp03 响应治理固定挂载点调用；数据面（SSE/payload）零控制逻辑。三段式：识别 -> 状态判断 -> 操作。
- Req04 owns request-side registered-tool governance; Resp03 owns response-side client-exec projection.
- The CLI validates a registered tool and emits a projection descriptor; Codex executes the projected command through the normal tool loop.
- The next request validates the ordinary tool-result pairing. RouteCodex does not re-enter a private servertool pipeline.

## Retired boundaries

- `ServertoolResp03RuntimeAction`, `ServertoolReq04FollowupBuilt`, server-side reentry, and the old followup result chain are historical audit terms, not active V3 owners.
- `routecodex hook run`, Stopless, `reasoningStop`, `stop_message_auto`, and stop-response interception are retired and must not be restored under another name.
- Official Stop, timer, and future memory hooks belong to the independent `codex-hooks` daemon/CodexApp framework; their wake-up messages do not enter V3 servertool orchestration.

## Review rule

Any new servertool behavior must bind to the V3 maps and the fixed Req04/Resp03 hooks. It must not add a second execution owner, private response exit, payload-carried control state, or server-side followup/reentry path.
