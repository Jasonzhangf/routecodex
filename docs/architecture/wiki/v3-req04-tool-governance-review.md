# V3 Req04 / Resp03 Tool Governance Review

## Purpose

This is the small-skeleton review surface for split request-side and response-side tool governance. Request lifecycle starts at the client SSE request. Response lifecycle starts at provider raw response and must pass compat before RespInbound normalization.

Canonical sources:
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-resource-operation-map.yml`
- `docs/architecture/v3-architecture-audit-locks.yml`
- `docs/architecture/wiki/v3-mainline-skeleton-sop.md`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs`

## Main Rule

Request lifecycle starts at Client SSE Request Start: server accept -> request normalization -> tool output pair normalization -> Req04 current-turn merge/governance -> ReqExecution handoff.

Response lifecycle is separate: provider raw -> provider response compat -> RespInbound normalization -> Resp03 text harvest -> complete/repair tool frames -> inspect finish_reason -> tool_call servertool hook -> ordinary tool governance for non-servertool tool_call -> RespOutbound projection -> client frame. A terminal stop remains an ordinary response. Responses continuation is retired: a non-empty `previous_response_id` fails before routing or provider transport.

Audit labels locked for generated HTML:
- Client SSE Request Start
- Server SSE Frame Accepted
- Request Normalization
- Tool Output Pair Normalization
- Req04 Chat Process Governance
- Merge Current Tool Surfaces
- Preserve Client Tool Feedback
- Request Tool Governance Flow
- Response Tool Governance Flow
- Provider Response Raw
- Provider Response Compat
- RespInbound Normalization
- Text Harvest First
- Complete / Repair Tool Frames
- Inspect finish_reason
- Tool-call Servertool Hook
- Ordinary Tool Governance
- Terminal Response Branch
- Request node logic
- Response node logic
- Error feedback is preserved
- Provider codec owns malformed provider fields
- Resp03 owns response governance
- Responses continuation is retired
- RespOutbound Client Semantic
- JSON to SSE Client Frame
- Diagnostics stay side-channel only

## Request Tool Governance Flow

```mermaid
flowchart TD
  A[Client SSE Request Start\ncomment: lifecycle starts when client sends SSE request] --> B[Server SSE Frame Accepted\ncomment: bind endpoint/request/port facts]
  B --> C[Request Normalization\ncomment: non-destructive protocol normalization]
  C --> D[Tool Output Pair Normalization\ncomment: normalize call_id/type adjacency and order]
  D --> E[Req04 Chat Process Governance\ncomment: govern current request; previous_response_id is already retired]
  E --> F[Merge Current Tool Surfaces\ncomment: merge top-level tools and additional_tools]
  F --> G[Preserve Client Tool Feedback\ncomment: current tool outputs are client/model feedback truth]
  G --> H[Inject Current Internal Tools\ncomment: append current turn controls without overwriting client tools]
  H --> I[Emit Req04 Governed Request\ncomment: hand off to ReqExecution05]
```

## Response Tool Governance Flow

```mermaid
flowchart TD
  A[Provider Response Raw\ncomment: provider raw response truth] --> B[Provider Response Compat\ncomment: provider-specific compat first]
  B --> C[RespInbound Normalization\ncomment: Hub response semantic]
  C --> D[Text Harvest First\ncomment: collect text/reasoning/delta before tool decisions]
  D --> E[Complete / Repair Tool Frames\ncomment: may correct finish_reason]
  E --> F[Inspect finish_reason]
  F -- tool_call --> G[Tool-call Servertool Hook\ncomment: servertool intercept first]
  F -- stop --> H[Terminal Response Branch\ncomment: preserve ordinary terminal response]
  F -- other --> K[Emit Resp03 Governed Semantic]
  G -- servertool intercepted --> I[Update Runtime Control Side-Channel]
  G -- not servertool --> J[Ordinary Tool Governance\ncomment: exec_command/apply_patch/client tools]
  J --> I
  H --> K
  I --> K
  K --> L[RespOutbound Client Semantic]
  L --> M[JSON to SSE Client Frame]
```

## Request node logic

| Node | 干什么 | 逻辑 |
| --- | --- | --- |
| Client SSE Request Start | Client sends SSE `/v1/responses` request. | Client-side stream intent starts request lifecycle; client SSE response must remain SSE. |
| Server SSE Frame Accepted | Server accepts HTTP/SSE request and binds endpoint/request/port facts. | Server captures raw facts only; no tool pairing or history repair. |
| Request Normalization | Non-destructively normalizes client protocol request into Hub normal payload. | Normalize protocol shape and stream intent only; no semantic trimming or text downgrade. |
| Tool Output Pair Normalization | Normalizes submitted tool outputs and their call_id/type adjacency. | Parse-error/unknown-tool/unsupported feedback is client feedback truth; preserve and order it. |
| Req04 Chat Process Governance | Owns current-turn tool output pairing, history governance, and servertool request hooks. | A non-empty `previous_response_id` is rejected before routing; Req04 never restores a continuation context. |
| Merge Current Tool Surfaces | Merges current request top-level `tools` and `input[].additional_tools.tools`. | Preserve original surface; `additional_tools` is Codex capability declaration surface. |
| Preserve Client Tool Feedback | Adds current client tool execution results to governed request truth. | Pair only by explicit protocol fields `call_id`/type; error feedback is model correction input. |
| Inject Current Internal Tools | Injects current-turn internal tools declared by the active tool policy. | At most once; append/augment current turn; do not clear system/developer/user context. |
| Emit Req04 Governed Request | Emits current-turn governed request truth to ReqExecution05. | Provider malformed fields are fixed in ReqOutbound/provider codec, not by deleting Req04 truth. |

## Response node logic

| Node | 干什么 | 逻辑 |
| --- | --- | --- |
| Provider Response Raw | Receives provider raw JSON/SSE response truth. | No governance or projection here. |
| Provider Response Compat | Applies provider-specific response compatibility. | Compat precedes RespInbound normalization and cannot own servertool or ordinary tool governance. |
| RespInbound Normalization | Normalizes compat output into Hub response semantic. | Establishes response semantic input only; finish_reason split and governance wait until Resp03. |
| Text Harvest First | Harvests text, reasoning, and accumulated deltas first. | Tool decisions must not run on incomplete text/delta state. |
| Complete / Repair Tool Frames | Completes or repairs tool frames that are determinable from response semantics. | This can correct finish_reason, for example stop -> tool_call, before branch selection. |
| Inspect finish_reason | Branches by corrected `finish_reason`. | `tool_call` enters the registered servertool hook; `stop` remains an ordinary terminal response. |
| Tool-call Servertool Hook | Runs servertool interception under `finish_reason=tool_call`. | Servertool intercept runs before ordinary tool governance. If intercepted, do not process as ordinary exec/apply_patch. |
| Ordinary Tool Governance | Governs non-servertool tool calls such as `exec_command`, `apply_patch`, and client tools. | Runs only after tool-call servertool hook passes through. |
| Terminal Response Branch | Preserves ordinary terminal response under `finish_reason=stop`. | Stop does not create a servertool projection. |
| Update Runtime Control Side-Channel | Updates servertool runtime state after the registered tool-call hook. | Side-channel only; no provider/client normal payload pollution. |
| Emit Resp03 Governed Semantic | Emits governed response semantic after branch convergence. | Response governance is complete at Resp03 exit; later nodes only project and frame. |
| RespOutbound Client Semantic | Projects governed response to client protocol semantic. | Projection only; no response governance and no error swallowing. |
| JSON to SSE Client Frame | Converts outbound client semantic to SSE frames for client SSE entry. | Framing only; no tool governance or response repair. |

## Resource Matrix

| Resource | Owner | Rule |
| --- | --- | --- |
| Client SSE request | Server entry / ReqInbound | Request lifecycle starts here; preserve client stream intent. |
| Client tool output result | Tool Output Pair Normalization / Req04 | Pair by explicit protocol call_id/type; preserve error feedback. |
| `previous_response_id` | ReqInbound fail-fast boundary | Reject before routing or provider transport; no local context, remote locator, or pinned-target resolution. |
| Client tool declarations | Request data plane / Req04 reader | Preserve by default; do not delete because a provider cannot consume the exact shape. |
| `additional_tools` | Codex capability declaration surface / Req04 reader | Preserve original Responses input surface; do not flatten or drop it for convenience. |
| Provider raw response | ProviderRespInbound01Raw | Must pass ProviderRespCompat02 before RespInbound normalization. |
| Provider response compat | ProviderRespCompat02ProviderCompat | Provider-specific response shape compatibility only; no response governance. |
| Text/tool-frame harvested response | Resp03 | Text harvest and tool frame completion happen before finish_reason split. |
| Tool-call servertool action | Resp03 tool_call branch | Servertool interception before ordinary tool governance. |
| Terminal response | Resp03 terminal branch | Preserve ordinary stop semantics without internal continuation. |
| Ordinary tool calls | Resp03 ordinary tool governance | Exec/apply_patch/client tools are governed after servertool pass-through. |
| Servertool runtime control | Metadata side-channel / ServerToolCenter | Read/update only at the registered servertool hook; never enter provider/client normal payload. |
| Provider malformed fields | ReqOutbound / provider codec owner | Provider codec owns malformed provider fields; fix provider-bound field generation before send. |

## Allowed Actions

- Server may accept client SSE and bind endpoint/request/port facts.
- ReqInbound may non-destructively normalize request protocol shape and stream intent.
- Req04 may normalize current tool output pairing by explicit call_id/type.
- Req04 may merge current tool declarations and current tool outputs into governed request truth.
- Req04 may inject internal tools only when the active tool policy allows.
- Response chain must run provider raw -> ProviderRespCompat02 -> RespInbound normalization before Resp03 governance.
- Resp03 may harvest text first, complete/repair tool frames, and correct finish_reason before branching.
- Resp03 may run the registered servertool hook for `finish_reason=tool_call`.
- Resp03 may preserve ordinary terminal semantics for `finish_reason=stop`.
- Resp03 may update servertool runtime control through side-channel resources.
- RespOutbound may project governed response semantic to client protocol.

## Forbidden Actions

- Start request audit at Req04 and omit client SSE / server accept / request normalization.
- Attempt Responses continuation, local restore, or remote locator resolution after `previous_response_id` is rejected.
- Delete non-RouteCodex tool calls or non-RouteCodex tool outputs.
- Delete by matching error text such as `failed to parse`, `unsupported`, `unknown tool`, or `malformed`.
- Delete only one side of a matching call/output pair.
- Skip ProviderRespCompat02 before RespInbound normalization.
- Make finish_reason branch decisions before text harvest and tool frame completion/repair.
- Treat the registered tool_call servertool hook as distinct from ordinary tool governance.
- Run ordinary exec/apply_patch/client-tool governance before tool-call servertool interception.
- Move response-side tool/servertool governance out of Resp03.
- Let outbound projection repair response semantics, tools, history, or prompt guidance.
- Repair provider-specific fields in Req04 or Resp03.
- Downgrade `tool_call` / `tool_output` into plain text.
- Put servertool/debug/snapshot metadata into provider body or client normal payload.

## Review Checklist

| Check | Expected |
| --- | --- |
| C1 | Request diagram starts at Client SSE Request Start. |
| C2 | Request diagram includes server accept and request normalization. |
| C3 | Request diagram includes tool output pair normalization before Req04 governance. |
| C4 | Responses continuation is retired before routing and provider transport. |
| C5 | Req04 governs only the current request payload and tool surfaces. |
| C6 | No request-side internal artifact-removal path is declared in this small skeleton. |
| C7 | No request-side internal artifact removal path is declared in this small skeleton. |
| C8 | Error feedback is preserved. |
| C9 | `additional_tools` reach provider-visible tools. |
| C10 | Response starts at provider raw and passes ProviderRespCompat02 before RespInbound normalization. |
| C11 | Resp03 text harvest and tool frame completion/repair happen before finish_reason split. |
| C12 | `finish_reason=tool_call` enters the registered servertool hook; `finish_reason=stop` remains an ordinary terminal response. |
| C13 | Ordinary tool governance runs only after tool-call servertool pass-through. |
| C14 | RespOutbound and JSON→SSE happen after Resp03 governance. |
| C15 | Provider-specific malformed fields are fixed in ReqOutbound/provider codec. |
| C16 | Metadata/debug remains side-channel only. |

## Required Red Fixtures

- Client SSE request lifecycle begins before Req04.
- Tool output pair normalization preserves parse-error `function_call_output`.
- Continuation revival is rejected before routing or provider transport.
- Req04 merges current request deltas without restoring continuation context.
- Preserve malformed ordinary `function_call`.
- Preserve unknown-tool feedback.
- Reject one-sided deletion of a paired call/output.
- Preserve `additional_tools`.
- Reject response graph without ProviderRespCompat02 before RespInbound normalization.
- Reject finish_reason split before text harvest and tool frame completion/repair.
- Reject merged servertool hook for stop and tool_call branches.
- Reject ordinary tool governance before tool-call servertool interception.
- Reject RespOutbound or JSON→SSE doing Chat Process governance.
- Keep provider malformed-field repair in codec/builder, not Req04 deletion.
- Reject metadata/control leaks into provider/client payload.
