# Servertool Hook Skeleton Mainline Source

## Purpose

This page locks the target servertool standard processing skeleton. It is a review surface for how CLI lifecycle, response-side hooks, request-side hooks, required/optional hook rules, and verification gates must fit together before servertool TS business semantics can be deleted.

This page is not proof that the skeleton is implemented. The current call-map chain `servertool.hook_skeleton.mainline` is intentionally `binding pending` until Rust scheduler/code symbols exist.

Canonical sources:

- `docs/architecture/mainline-call-map.yml` (`chain_id: servertool.hook_skeleton.mainline`)
- `docs/design/servertool-rust-only-architecture.md`
- `docs/goals/servertool-rustification-implementation-plan.md`

Current registry state:

- `hub.servertool_rust_only_closeout` is already registered in `function-map.yml` / `verification-map.yml` as the closeout gate and hook-skeleton contract anchor.
- That closeout feature is not a runtime-anchored mainline owner. It only proves the gate / contract / review surface has landed.
- A future runtime owner feature such as `hub.servertool_hook_skeleton` must be added only when request/response runtime owner symbols, blackbox gates, and replay evidence exist.

Until then the mainline edges stay `binding pending`; do not invent canonical builders or pretend the closeout gate means the runtime mainline is anchored.

## CLI Lifecycle Boundary

Business execution remains client-visible CLI:

```text
servertool response decision
  -> client-visible exec_command
  -> client runs: routecodex hook run <toolName> --input-json <json>
  -> client returns ordinary tool result
  -> request-side hook parses/restores that result
  -> normal Hub request pipeline continues
```

Hook skeleton does not execute the client CLI. Hook skeleton governs injection, restore, intercept, schema validation, followup/reenter effect planning, and finalization.

## Response-Side Skeleton

```text
HubRespChatProcess03Governed
  -> ServertoolRespHook01Intercepted
  -> ServertoolRespHook02SchemaValidated
  -> ServertoolRespHook03HookResponseInjected
  -> ServertoolRespHook04FollowupPlanned
  -> ServertoolRespHook05ReenterDispatched
  -> ServertoolRespHook06ProjectionFinalized
  -> HubRespOutbound04ClientSemantic
```

### Response Hook Gate Contract

Response hooks are selected by skeleton-declared trigger gates, not by ad hoc
projection or dispatch patches. A hook may declare multiple response trigger
arms:

| Trigger Arm | Match | Schema Source | Required Outcome |
| --- | --- | --- | --- |
| `finish_reason=stop` | assistant response is trying to stop | assistant visible text / stop-schema fence (`<rcc_stop_schema>` or standalone stop-schema JSON code fence) | run stop schema gate before terminal projection |
| `finish_reason=tool_calls` + registered tool name | assistant emits a registered internal servertool call | matching tool call arguments | run the same schema gate before any client-visible projection |

For stopless, the skeleton-owned hook is `stop_message_auto` and the registered
internal tool name is `reasoningStop`. `reasoningStop` is model-facing/internal
only. It must never be returned to the client as a client-executable
`required_action` tool. After schema gate:

- terminal schema: convert to terminal stop, extract safe visible summary, strip
  internal tool artifacts, and return to normal `HubRespOutbound04ClientSemantic`;
- non-terminal / missing / invalid schema: project a client-visible
  `exec_command` that runs `routecodex hook run reasoningStop ...`;
- client tool result submit: request-side hooks must restore the model-visible
  pair as `reasoningStop -> function_call_output`, not preserve raw
  `exec_command` history as model-owned truth.

| Node | Required | Owns | Must Not Do |
| --- | --- | --- | --- |
| `ServertoolRespHook01Intercepted` | yes | normal/abnormal response intercept, stopless/internal-tool trigger detect | write client frame or build request |
| `ServertoolRespHook02SchemaValidated` | yes for schema-managed flows | stop schema / hook schema / tool argument schema validation | silently fix malformed schema or wrap invalid as success |
| `ServertoolRespHook03HookResponseInjected` | yes when feedback/client execution is needed | client-visible hook response or `exec_command` projection | execute client CLI or use server-side stopless followup |
| `ServertoolRespHook04FollowupPlanned` | optional | origin-snapshot backend followup effect plan | guess from polluted current payload |
| `ServertoolRespHook05ReenterDispatched` | optional | reenter/clientInject/providerInvoke IO effect plan | let TS decide retry/backoff/terminal policy |
| `ServertoolRespHook06ProjectionFinalized` | yes | post-hook/post-followup governed truth, internal strip, normal projection handoff | create a second servertool response projector |

## Request-Side Skeleton

```text
HubReqInbound02Standardized
  -> ServertoolReqHook01ResultParsed
  -> ServertoolReqHook02TextRewritten
  -> ServertoolReqHook03ToolInjected
  -> ServertoolReqHook04RequestFinalized
  -> HubReqChatProcess03Governed
```

| Node | Required | Owns | Must Not Do |
| --- | --- | --- | --- |
| `ServertoolReqHook01ResultParsed` | yes when tool result exists | CLI stdout/tool result parse and public hook result validation | recover stopless state from file/sessionDir/tmux |
| `ServertoolReqHook02TextRewritten` | optional | model-visible guidance rewrite from hook result/schema guidance | replay raw historical tool pairs or leak internal metadata |
| `ServertoolReqHook03ToolInjected` | yes for servertool-managed turns | request tool declarations, stop hook contract, tool constraints | read provider response or build followup |
| `ServertoolReqHook04RequestFinalized` | yes | final request semantic before HubReqChatProcess | write provider wire payload |

## Required / Optional Rules

- Every hook declares `required` or `optional`.
- Required hook missing, failed, or invalid output is fail-fast.
- Optional hook skipped must emit a no-op event.
- Optional hook must not fallback into another business path.
- Multi-hook scheduling is stable: `priority -> order -> id`.
- Duplicate hook id is fail-fast.
- Hook output is typed effect/event/projection, not direct provider/client payload mutation.

## Complete Case Matrix

Unit tests must cover:

| Case | Required Coverage |
| --- | --- |
| normal response | intercept -> finalize no unintended hook injection |
| abnormal/error response | explicit error event, no success projection |
| `finish_reason=stop` stop schema | stop-text/fence schema enters response hook gate before terminal projection |
| `finish_reason=tool_calls` `reasoningStop` | `reasoningStop.arguments` enters the same schema gate and is never client-visible as a raw required_action tool |
| empty schema / no_schema | schema deny event + hook response injection when managed flow requires feedback |
| invalid schema | schema deny event with structured reason/missing fields |
| malformed hook args | schema error event, fail-fast or feedback according to managed-flow contract |
| valid terminal schema | final stop allowed, no unnecessary continuation |
| non-terminal / still-running | hook response or guidance path continues, no premature terminal |
| already-terminal | no duplicate followup/reenter |
| CLI stdout success | result parsed, optional text rewrite, tool injection as needed |
| CLI stdout malformed | parse error event, no silent fallback |
| required hook missing | fail-fast |
| optional hook skipped | no-op event |
| multi-hook same phase | deterministic order and deterministic effect merge |

Blackbox tests must cover:

```text
client in
  -> provider out
  -> provider in
  -> response hook intercept/schema
  -> client-visible exec_command when needed
  -> client tool result
  -> request result parse/text rewrite/tool inject
  -> provider out
```

Backend followup/reenter blackbox must additionally cover:

```text
client in
  -> provider out
  -> provider in
  -> response hook followup plan
  -> reenter/clientInject/providerInvoke effect execution by TS IO shell
  -> post-followup governed truth
  -> normal client projection
```

Negative blackbox:

- same-protocol direct/provider-direct does not activate servertool hooks.
- stopless CLI never uses server-side followup/reenter.
- internal metadata/debug carriers never reach provider body or client normal response body.

## Current Status

`servertool.hook_skeleton.mainline` is `binding pending`.

Reason: current runtime still has TS transitional orchestration in servertool engine/server-side-tools/execution/followup dispatch surfaces. The target skeleton must not be marked anchored until Rust scheduler symbols and blackbox gates exist.

## Review Checklist

- Does the change keep client-visible CLI as the business execution lifecycle?
- Does response-side processing pass through intercept -> schema validate -> hook response inject -> optional followup/reenter -> finalize?
- Does the response hook gate cover both `finish_reason=stop` text/fence schema and `finish_reason=tool_calls` registered internal servertool calls such as `reasoningStop`?
- Does any client-visible continuation expose only shell `exec_command`, never raw internal `reasoningStop`?
- Does request-side processing pass through result parse -> optional text rewrite -> tool inject -> finalize?
- Are required/optional hooks declared and tested?
- Are normal, abnormal, empty schema, invalid schema, malformed args, terminal, non-terminal, already-terminal, and malformed CLI stdout cases covered?
- Does blackbox prove the mandatory client/provider roundtrip path before release?
- Is the mainline edge still `binding pending` until real Rust symbols exist?
