# Servertool CLI Projection Migration

## Objective

Migrate RouteCodex servertool execution from server-side execution/followup to client-standard `exec_command` CLI execution.

The first migration step keeps existing servertool injection and interception decisions, but changes the execution path:

- Old path: RCC intercepts servertool, executes handler on server, then may run internal followup/reenter.
- New path: RCC intercepts servertool, projects a real client-visible `exec_command` tool call, client executes `routecodex servertool ...`, then normal `submit_tool_outputs` carries the real tool result back.

This preserves client UI visibility, avoids swallowed summaries, and removes servertool's private execution hop before removing tool injection in later phases.

## Non-Goals

- Do not remove current servertool tool injection in Phase 1.
- Do not remove current servertool interception in Phase 1.
- Do not change provider transport protocol.
- Do not use server-side followup/reenter for CLI-executed servertools in Phase 1.
- Do not fabricate client tool results or silently replace provider payload semantics.
- Do not map `apply_patch` to servertool CLI; `apply_patch` remains client-native/freeform.

## Existing Owner Map

| Area | Current owner | Current behavior | Migration concern |
|---|---|---|---|
| Handler registry | `sharedmodule/llmswitch-core/src/servertool/registry.ts` | Registers tool-call and auto servertools | Keep for Phase 1 detection; later shrink to stop-only |
| Response orchestration | `sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.ts` | Calls servertool engine after provider response | Add CLI projection output mode |
| Engine | `sharedmodule/llmswitch-core/src/servertool/server-side-tools.ts` | Extracts tool calls, runs handlers, returns tool_flow/followup | Stop executing handlers directly for CLI-capable servertools |
| Execution shell | `sharedmodule/llmswitch-core/src/servertool/execution-shell.ts` | Runs handler plans and backend plans | Convert handler plans into CLI tickets instead of local execution |
| Followup | `sharedmodule/llmswitch-core/src/servertool/reenter-followup-block.ts` | Reenters Hub Pipeline after server-side execution | Not used for CLI-executed Phase 1 servertools |
| Stopless state | `stop-message-auto/*`, `stop-message-counter.ts` | Tracks stop budgets and followup prompts | Keep detection/budget; project continuation as CLI result loop |
| Client response projection | `src/server/handlers/handler-response-utils.ts` | Emits Responses/Chat/SSE frames | Must emit reasoning + standard `exec_command` tool call |
| Submit tool outputs | `src/server/handlers/responses-handler.ts` and request pipeline | Receives client tool outputs | Must recognize CLI ticket output and restore original servertool tool result shape before provider outbound when needed |

## Target Protocol

### Phase 1: Intercepted Servertool -> CLI Projection

```text
ProviderRespInbound01Raw
  -> HubRespInbound02Parsed
  -> HubRespChatProcess03Governed
  -> ServertoolCliProjection01Planned
  -> HubRespOutbound04ClientSemantic
  -> ServerRespOutbound05ClientFrame
       emits:
         - reasoning item/event with full summary or action explanation
         - exec_command tool_call:
             routecodex servertool run --ticket <ticketId>
  -> Codex client executes command
  -> client submit_tool_outputs
  -> HubReqInbound02Standardized
  -> ServertoolCliResult02Captured
  -> ServertoolCliResult03RestoredToolResult
  -> HubReqChatProcess03Governed
  -> normal provider outbound
```

### Why Result Restoration Is Needed

The client executes `exec_command`, but the provider/model may have originally emitted an internal servertool call such as `vision_auto` or `web_search_auto`.

Therefore the ticket must preserve both identities:

```json
{
  "ticketId": "stcli_...",
  "mode": "client_cli_projection",
  "clientTool": {
    "name": "exec_command",
    "callId": "rcc_cli_stcli_..."
  },
  "modelTool": {
    "name": "vision_auto",
    "callId": "call_model_..."
  },
  "presentation": {
    "reasoningText": "...",
    "stdoutPreview": "vision analysis complete"
  }
}
```

When `submit_tool_outputs` returns, RouteCodex must restore the result into the model's original tool-call identity before provider outbound:

```text
exec_command result call_id=rcc_cli_stcli_...
  -> ticket lookup
  -> restored tool result call_id=call_model_..., name=vision_auto
```

This is not followup. It is normal tool-result restoration for protocol symmetry.

Phase 1 scope is not stopless-only. It must include:

- stopless / `stop_message_auto` migration,
- the generic intercepted servertool projection skeleton,
- the `routecodex servertool run --ticket <ticketId>` CLI execution skeleton,
- at least one basic servertool tool-call execution fixture that proves projection -> CLI -> submit restoration works outside pure stop continuation.

### Exact Response Projection Shape

For `/v1/responses`, the client-visible response must stay in normal Responses semantics:

```json
{
  "object": "response",
  "status": "requires_action",
  "output": [
    {
      "type": "reasoning",
      "summary": [
        {
          "type": "summary_text",
          "text": "<full servertool summary or stop continuation reason>"
        }
      ]
    }
  ],
  "required_action": {
    "type": "submit_tool_outputs",
    "submit_tool_outputs": {
      "tool_calls": [
        {
          "id": "rcc_cli_stcli_...",
          "type": "function",
          "function": {
            "name": "exec_command",
            "arguments": "{\"cmd\":\"routecodex servertool run --ticket stcli_...\"}"
          }
        }
      ]
    }
  }
}
```

For `/v1/chat/completions`, the same semantic action projects as ordinary assistant `tool_calls` with `finish_reason=tool_calls`.

Rules:

- The projection is a `HubRespChatProcess03Governed -> HubRespOutbound04ClientSemantic` concern; servertool must not hand-write SSE frames.
- SSE must remain SSE when the original client requested SSE. A servertool projection must emit normal `response.output_item.*`, `response.required_action`, and `response.done` frames.
- Non-stream JSON must return the same semantic shape without switching a streaming request into JSON.
- The ticket path and internal metadata must not appear in `output`, `metadata`, provider payload, or client-visible debug fields. Only the opaque ticket id in the CLI command is visible.

### Submit Tool Outputs Restoration Shape

The client will submit a result for the `exec_command` call id:

```json
{
  "tool_outputs": [
    {
      "call_id": "rcc_cli_stcli_...",
      "output": "{\"ok\":true,\"kind\":\"servertool_continue\",\"summary\":\"continuing\"}"
    }
  ]
}
```

RouteCodex must consume the ticket and restore the provider-facing tool result:

```json
{
  "tool_outputs": [
    {
      "call_id": "call_model_...",
      "output": "{\"ok\":true,\"kind\":\"servertool_continue\",\"summary\":\"continuing\"}"
    }
  ]
}
```

Restoration rules:

- Match by `clientTool.callId`, not by parsing free text stdout.
- Restore `modelTool.callId` and `modelTool.name` exactly from the ticket.
- If no model tool call existed, use the synthetic model identity recorded at projection time; do not invent it during submit.
- Unknown, expired, already consumed, session-mismatched, or request-mismatched tickets fail fast with a structured error.
- The restored request then continues through the normal request pipeline; it must not call `reenterPipeline`, `providerInvoker`, or a response-side followup dispatcher.

## CLI Contract

### Command Shape

Use a short visible command:

```bash
routecodex servertool run --ticket <ticketId>
```

Do not pass large payloads on the command line. The ticket file is the payload source.

### Ticket Storage

Default location:

```text
~/.rcc/servertool/tickets/<ticketId>.json
```

Ticket requirements:

- Scoped by `requestId`, `entryEndpoint`, `sessionId`/`conversationId` when available.
- Contains original model tool identity.
- Contains client exec command call identity.
- Contains normalized CLI backend plan.
- Contains presentation text for reasoning/stdout preview.
- Has TTL and single-use semantics.
- Must not be copied into provider request body as metadata.

### CLI stdout/stderr

CLI stdout is the real client tool result.

Rules:

- Keep stdout concise and structured.
- Prefer JSON for functional tools.
- Pure continuation should print a short human-readable line.
- Full summary goes to reasoning, not stdout.
- stderr is diagnostic only; non-zero exit means failed tool result.

Example:

```json
{"ok":true,"kind":"servertool_continue","summary":"continuing after stop summary"}
```

## Reasoning Mapping

| Source | Reasoning content | CLI stdout |
|---|---|---|
| `finish_reason=stop` summary | Full stop summary, evidence, blocker, next step | Short continuation acknowledgement |
| `vision_auto` | Full vision summary or analysis explanation | Short JSON result + summary digest |
| `web_search` | Search digest and selected engine rationale | JSON search result payload |
| `memory/cache_auto` | Short memory action explanation | JSON write/noop result |
| Errors | Error explanation if client-visible | CLI non-zero + stderr/stdout error JSON |

Reasoning must not contain internal ticket paths, provider keys unless already client-visible, `__rt`, metadata carriers, or debug snapshots.

## Tool Classification

| Tool / flow | Phase 1 action | CLI? | Notes |
|---|---:|---:|---|
| `stop_message_auto` / stopless | Project to `exec_command` | Yes | Full summary as reasoning; CLI prints short continuation result |
| `vision_auto` | Project to `exec_command` | Yes | CLI performs vision backend using ticket payload |
| `web_search` | Project to `exec_command` | Yes | CLI performs search using ticket payload |
| `memory/cache_auto` | Project to `exec_command` | Yes | CLI performs write/noop using ticket payload |
| `apply_patch` | No servertool path | No | Keep native/freeform client apply_patch |
| normal client tools | No interception change | No | Pass through as today |

## Gap Review

### G1: Servertool engine currently executes handlers directly

Evidence:

- `runToolCallExecutionLoop` calls registered handlers.
- `materializeServertoolPlannedResult` executes backend plans.
- `executeServertoolBackendPlan` calls vision/web-search server-side.

Required change:

- Add a planning mode that turns handler/backend plans into `ServertoolCliProjection01Planned`.
- Do not execute backend plans on the server for CLI-capable tools.
- Keep handler business logic callable by the CLI executor, but move the response-side path from `execute` to `plan projection`.

### G2: Followup is coupled to execution outcome

Evidence:

- `resolveToolCallExecutionOutcome` picks `followupStrategy` and may reuse last execution followup.
- `reenter-followup-block.ts` owns server-side reentry.

Required change:

- Phase 1 CLI path must return client-visible `exec_command` and stop.
- `submit_tool_outputs` should drive the next model request through normal pipeline.
- Existing followup path remains only for non-migrated flows until removed.
- A migrated flow emitting `ServertoolCliProjection01Planned` must make followup state unreachable in the same response transaction.

### G3: Client-visible projection needs a new semantic node

Required new node:

```text
ServertoolCliProjection01Planned
```

Responsibilities:

- Create ticket.
- Build `exec_command` tool call.
- Build reasoning summary.
- Preserve model/client call identity mapping.

Forbidden:

- Execute local action.
- Build provider followup request.
- Write provider payload metadata.

### G4: Submit-tool-output needs result restoration

Required new node:

```text
ServertoolCliResult02Captured
  -> ServertoolCliResult03RestoredToolResult
```

Responsibilities:

- Detect `rcc_cli_*` call id or ticket marker.
- Load and consume ticket.
- Validate request/session scope.
- Restore original model tool call identity where protocol requires it.
- Normalize CLI stdout into original tool result content.

Forbidden:

- Start internal followup.
- Guess missing original tool identity.
- Silently accept unknown/expired tickets.

### G5: CLI subcommand does not exist yet

Required command:

```bash
routecodex servertool run --ticket <ticketId>
```

Implementation owner:

- CLI command shell in RouteCodex host.
- Semantics remain in llmswitch-core/Rust where already owned; TS CLI is IO shell.

### G6: Tests currently assert old followup semantics

Required updates:

- Keep old tests for non-migrated flows if any.
- Add red tests that Phase 1 migrated flows do not call `reenterPipeline`.
- Add request/response blackbox tests for `reasoning + exec_command`.
- Add submit restoration tests.

### G7: Reasoning projection is not a first-class contract

Current risk:

- Stopless summaries can be swallowed when `finish_reason=stop` is intercepted before client projection.
- If the summary is printed only by the CLI, the client may fold it as tool stdout and lose the full context.

Required change:

- Add a reasoning block to `ServertoolCliProjection01Planned`.
- Project full summary/explanation into Responses reasoning or Chat assistant content according to entry protocol.
- Keep CLI stdout short and functional; it is the tool result, not the summary carrier.

### G8: Ticket persistence and cleanup are not defined in runtime contracts

Current risk:

- A global ticket map can leak across ports, sessions, or restarts.
- Reusing a ticket would replay a tool result and corrupt tool-call pairing.

Required change:

- Persist tickets under `~/.rcc/servertool/tickets/`.
- Include `ticketVersion`, `createdAt`, `expiresAt`, `consumedAt`, `entryEndpoint`, `requestId`, `responseId`, `sessionId`, `conversationId`, `clientTool`, `modelTool`, and `executor`.
- Consume by atomic rename/write so the second submit fails.
- Add startup cleanup for expired consumed tickets; cleanup is maintenance only, not a fallback for correctness.

### G9: Tool injection final state differs from Phase 1

Current risk:

- Phase 1 still injects servertools, but the desired final state is mostly prompt/skill + normal client tools.
- Without explicit phase boundaries, old injection and old execution may both survive.

Required change:

- Phase 1 keeps injection/interception only to reduce migration blast radius.
- Phase 4 physically deletes migrated server-side execution paths.
- Phase 5 removes servertool tool-list injection except stop continuation if still required.
- `apply_patch` must remain excluded from servertool registry and use native/freeform client execution only.

### G10: Direct path and provider runtime must not participate

Current risk:

- Prior failures showed tool wire compatibility bugs when direct/provider payload paths tried to carry client tool shapes.

Required change:

- CLI projection belongs to Hub response governance and client response projection only.
- Provider runtime receives restored model tool results after submit; it never sees `exec_command` ticket metadata unless the original model actually called `exec_command`.
- Direct passthrough does not run response-side servertool projection; direct-compatible flows must stay direct or fail by contract.

## Detailed Implementation Plan

### Step 1: Contract and Red Tests

Add tests before implementation:

| Test | Expected red condition |
|---|---|
| `tests/servertool/servertool-cli-projection.spec.ts` | stop/servertool response still executes handler or followup instead of projecting `exec_command` |
| `tests/servertool/servertool-cli-result-restore.spec.ts` | submit result keeps `rcc_cli_*` instead of restoring original model call id |
| `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` | `/v1/responses` SSE misses reasoning or `response.required_action` |
| static audit in `tests/sharedmodule/servertool-active-js-shadow-audit.spec.ts` | migrated flow still calls `reenterPipeline` / `providerInvoker` |
| ticket negative tests | unknown/expired/consumed/mismatched ticket does not fail fast |

### Step 2: Rust Contract Types

Add Rust-owned contracts:

```text
ServertoolCliProjection01Planned
ServertoolCliResult02Captured
ServertoolCliResult03RestoredToolResult
```

Required builders/parsers:

```text
build_servertool_cli_projection_01_from_hub_resp_chatprocess_03
capture_servertool_cli_result_02_from_submit_tool_outputs
restore_servertool_cli_result_03_to_model_tool_result
```

Boundary:

- Rust owns decision, shape, call-id mapping, and fail-fast validation.
- TS may write/read ticket files and execute CLI IO.
- No provider-specific branches.

### Step 3: Ticket Store

Implement a narrow ticket store:

```text
~/.rcc/servertool/tickets/<ticketId>.json
~/.rcc/servertool/tickets/<ticketId>.consumed.json
```

Operations:

| Operation | Behavior |
|---|---|
| `writeTicket(ticket)` | fail if path exists; write with restrictive permissions |
| `readTicket(ticketId)` | validate schema and TTL |
| `consumeTicket(ticketId, clientCallId, scope)` | validate scope, atomically mark consumed, return ticket |
| `cleanupTickets(now)` | remove expired consumed tickets only |

No in-memory map is allowed as the only truth.

### Step 4: CLI Command

Add:

```bash
routecodex servertool run --ticket <ticketId>
```

CLI behavior:

1. Load ticket.
2. Validate executable kind and expiry.
3. Execute the servertool backend action.
4. Print concise stdout JSON.
5. Print diagnostics to stderr only.
6. Exit non-zero on failure.

The CLI must not build provider followup requests or call `/v1/responses` internally.

### Step 5: Response Projection

In response governance:

1. Detect migrated servertool action or stop continuation.
2. Build `ServertoolCliProjection01Planned`.
3. Write ticket.
4. Project reasoning + `exec_command` tool call through normal outbound.
5. Stop the current response at `requires_action` / `tool_calls`.

Hard fail if projection cannot write a ticket; do not fall back to server-side execution.

### Step 6: Submit Restoration

In submit-tool-output/request inbound:

1. Detect `call_id` matching `rcc_cli_*`.
2. Capture `ServertoolCliResult02Captured`.
3. Consume ticket and validate scope.
4. Restore original model tool result as `ServertoolCliResult03RestoredToolResult`.
5. Continue normal request pipeline.

Hard fail if any submitted `rcc_cli_*` output cannot be restored.

### Step 7: Stopless First Migration

Stopless is the first migrated flow because it fixes the swallowed-summary problem directly:

```text
finish_reason=stop
  -> stop schema gate decides continue
  -> reasoning = full stop summary + required next action
  -> exec_command = routecodex servertool run --ticket stcli_stop_...
  -> CLI stdout = {"ok":true,"kind":"servertool_continue","summary":"continue"}
  -> submit restores synthetic stop continuation tool result
  -> next model turn proceeds normally
```

The consecutive stop counter remains owned by stop-message core. A non-stop response, normal tool call, or real progress resets the counter.

### Step 8: Tool Family Migration

Migration order:

1. `stop_message_auto` / stopless.
2. `memory/cache_auto`.
3. `web_search`.
4. `vision_auto`.

Each family must ship with:

- ticket schema fixture,
- CLI stdout fixture,
- reasoning fixture,
- submit restoration fixture,
- no-followup/no-reenter red test,
- online 10000-port sample capture where applicable.

### Step 9: Physical Deletion

After a migrated family is green:

- Delete its response-side server execution branch.
- Delete its followup coupling.
- Delete stale tests that require old behavior.
- Keep only CLI executor and projection/restoration contracts.

This is required by the repository dead-code rule; disabling old code is not sufficient.

## Phase Plan

### Phase 0: Contract Tests First

Add failing tests:

1. `finish_reason=stop` emits reasoning + `exec_command` CLI call.
2. Projected command is `routecodex servertool run --ticket <id>`.
3. Ticket contains model tool identity and client tool identity.
4. CLI-projected servertool does not call `providerInvoker` or `reenterPipeline`.
5. `submit_tool_outputs` for `rcc_cli_*` restores original model tool result.
6. Unknown/expired ticket fails fast.

### Phase 1: CLI Ticket + Projection

Implement:

- Ticket writer/reader with TTL and single-use consume.
- `ServertoolCliProjection01Planned` type and builder.
- Response projection to `exec_command`.
- Reasoning event/item projection.
- CLI command `routecodex servertool run --ticket <id>`.
- Basic servertool CLI dispatcher skeleton.
- Stopless executor plus one basic servertool fixture executor.

Keep:

- Existing injection.
- Existing interception.
- Existing registry.

Disable for migrated CLI path:

- Direct handler execution.
- Backend plan execution.
- Server-side followup/reenter.

### Phase 2: Submit Result Restoration

Implement:

- `ServertoolCliResult02Captured` parser at submit-tool-output/request inbound.
- `ServertoolCliResult03RestoredToolResult` builder.
- Scope validation by ticket.
- stdout JSON normalization.
- Fail-fast for mismatched call id/session/request.

### Phase 3: Migrate Tool Families

Order:

1. `memory/cache_auto`.
2. `web_search`.
3. `vision_auto`.

`stop_message_auto` / stopless and the generic servertool CLI execution skeleton are Phase 1 requirements, not Phase 3 work.

Each tool requires:

- CLI ticket schema.
- CLI executor implementation.
- stdout contract.
- reasoning mapping.
- submit restoration fixture.

### Phase 4: Remove Server-Side Execution

After all migrated flows pass:

- Delete direct servertool backend execution for migrated handlers.
- Delete servertool followup use for migrated handlers.
- Keep registry only as detection/projection owner until Phase 5.

### Phase 5: Remove Tool Injection Except Stop

Final target:

- Only `finish_reason=stop` is intercepted for forced continuation.
- Other tools are documented in prompts/skills and use normal client tools or explicit CLI commands.
- Remove servertool tool-list injection and old servertool-native tool surface.

## Rollout Matrix

| Phase | Enabled behavior | Disabled behavior | Exit evidence |
|---|---|---|---|
| 0 | red tests only | no runtime change | tests fail for missing projection/restoration |
| 1 | ticket + projection for stopless | server-side stopless followup for migrated path | blackbox sees reasoning + `exec_command` |
| 2 | submit restoration | provider sees `rcc_cli_*` call ids | provider request contains original model call id |
| 3 | memory/web/vision CLI | server-side backend execution for migrated tools | per-tool CLI + submit fixtures pass |
| 4 | migrated old code deleted | dead execution branches | static audit has no old calls |
| 5 | prompt/skill tool use only except stop | broad servertool injection | tool-list injection audit passes |

## Acceptance Gates

### Unit / Red Tests

- `ServertoolCliProjection01Planned` builds ticket + exec_command.
- `ServertoolCliResult03RestoredToolResult` restores original call id/name.
- CLI stdout parser rejects malformed JSON for structured tools.
- Ticket consume is single-use.
- Expired ticket fails fast.

### Blackbox

- `/v1/responses` stop response returns SSE reasoning + exec_command.
- Client submit of CLI result continues through normal provider request.
- No `servertool.followup.lifecycle` log for CLI-projected flow.
- No internal metadata/ticket path leaks into provider request body.
- Streaming requests remain SSE through projection and error paths.
- 10000-port MiniMax path validates that the client executes `exec_command` and receives a visible tool result instead of looping on missing feedback.

### Static Gates

- Migrated flow source must not call `executeVisionBackendPlan`, `executeWebSearchBackendPlan`, `runReenterFollowup`, or `providerInvoker` from response-side execution.
- No provider-specific branches in projection/remap logic.
- No `apply_patch` servertool registration.
- No direct/provider-runtime import from CLI projection or result restoration modules.
- No ticket path / `__rt` / internal metadata carrier in outbound provider snapshot fixtures.

## Observability

Required logs:

```text
[servertool.cli.project] requestId=... ticketId=... modelTool=... clientCallId=...
[servertool.cli.exec] ticketId=... status=... elapsedMs=...
[servertool.cli.restore] requestId=... ticketId=... originalCallId=...
```

Required samples:

- ticket snapshot in debug-only sample root, not provider body.
- client response sample with reasoning + exec_command.
- submit_tool_outputs sample with restored model tool result.

## Open Questions

1. Whether stopless pure continuation should restore to an original model tool call or use a synthetic internal model tool identity.
   - Recommended Phase 1 answer: synthetic internal identity is allowed only if the response was `finish_reason=stop` with no model tool call.
2. Whether CLI should output plain text or JSON for stopless.
   - Recommended Phase 1 answer: JSON stdout with a short `summary` string; client still displays it compactly.
3. Whether web_search/vision should execute provider calls from CLI directly or via local RCC control API.
   - Recommended Phase 1 answer: CLI reads ticket and invokes the same underlying core-owned executor without going through HTTP provider followup. If provider access requires RCC runtime, the command may call a dedicated local control endpoint, but that endpoint is execution-only and must not construct followup.
