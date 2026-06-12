# Servertool CLI Projection Migration

## Objective

Migrate RouteCodex servertool execution from private server-side execution/followup to client-standard `exec_command` CLI execution.

Phase 1 keeps existing servertool injection and interception decisions, but changes the migrated execution path:

- Old path: RCC intercepts servertool, executes handler on server, then may run internal followup/reenter.
- New path: RCC intercepts servertool, projects a real client-visible `exec_command` tool call, client executes `routecodex servertool run <toolName> --input-json <json>`, then normal client tool-result flow continues.

There is no restoration store and no result remapping in the current design. The CLI call is a normal client tool call; its result remains an `exec_command` result.

## Non-Goals

- Do not remove current servertool tool injection in Phase 1.
- Do not remove current servertool interception in Phase 1.
- Do not change provider transport protocol.
- Do not use server-side followup/reenter for CLI-executed servertools in Phase 1.
- Do not fabricate client tool results or silently replace provider payload semantics.
- Do not map `apply_patch` to servertool CLI; `apply_patch` remains client-native/freeform.
- Do not implement old CLI restoration file IO, single-use restoration handles, restoration handle TTL, or model tool identity restoration.

## Target Protocol

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
             routecodex servertool run <toolName> --input-json <json>
  -> Codex client executes command
  -> client submits normal exec_command tool result
  -> HubReqInbound02Standardized
  -> normal request pipeline
```

## Projection Shape

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
          "id": "call_servertool_cli_<opaque>",
          "type": "function",
          "function": {
            "name": "exec_command",
            "arguments": "{\"cmd\":\"routecodex servertool run stop_message_auto --input-json '<json>'\"}"
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
- SSE must remain SSE when the original client requested SSE.
- Non-stream JSON must return the same semantic shape without switching a streaming request into JSON.
- Client-visible output must not contain internal metadata, `__rt`, snapshot/debug carriers, old restoration paths, `old_cli_`, or `old_cli_result_` markers.

## CLI Contract

```bash
routecodex servertool run <toolName> --input-json <json>
```

Rules:

- `<toolName>` must match `[A-Za-z0-9_.-]+`.
- `--input-json` must parse to a JSON object.
- stdout is the real client tool result; prefer concise JSON.
- stderr is diagnostic only.
- non-zero exit means failed tool execution.
- unsupported tools fail-fast with a clear error.
- no restoration files are written, read, consumed, restored, or cleaned up.

Phase 1 dispatcher supports:

- `stop_message_auto` / stopless continuation.
- `servertool_fixture` basic executor for generic projection coverage.

Other servertools remain unsupported until explicitly migrated.

## Reasoning Mapping

| Source | Reasoning content | CLI stdout |
|---|---|---|
| `finish_reason=stop` summary | Full stop summary / continuation reason | Short continuation JSON |
| `servertool_fixture` | Intercept explanation | JSON fixture result |
| Unsupported servertool | Error explanation if client-visible | CLI non-zero + stderr |

Reasoning must not contain internal old restoration paths, provider-private metadata, `__rt`, or debug snapshots.

For `stop_message_auto`, the reasoning text must be the intercepted assistant stop text/summary so the client can display what was swallowed by the stop interception. The client-visible CLI input must be status-only: `flowId`, `repeatCount`, and `maxRepeats`. The actual continuation prompt is internal request-side injection material and must not appear in the `exec_command` command line, CLI stdout, schema guidance, preview fields, or echoed input.

The stop continuation prompt is not a fixed `继续执行` string. It must be a heuristic status-audit prompt covering: current user goal, completed steps, completion/block status, suggested next action, evidence verification, issue cause, excluded factors, diagnostic order, and learned facts. Legacy prompts that only say `继续执行...` must be upgraded before CLI projection.

## Gap Review

### G1: Servertool engine must project, not execute, migrated tools

Required change:

- CLI-capable intercepted servertool calls become `ServertoolCliProjection01Planned`.
- Response-side path must not execute backend handlers for migrated tools.
- CLI dispatcher remains the only execution point for migrated tools.

### G2: Followup must be unreachable for migrated paths

Required change:

- Phase 1 CLI path returns client-visible `exec_command` and stops.
- Existing followup remains only for non-migrated legacy flows.
- Migrated stopless / fixture paths must not call `reenterPipeline` or `providerInvoker`.

### G3: Submit restoration is intentionally removed

Current design:

- Client submits the `exec_command` result as a normal client tool result.
- RouteCodex does not consume restoration handles and does not restore internal model tool identity.
- Any code path trying to load `old restoration store`, consume `old_cli_result_*`, or restore `modelTool` identity is old design and must be deleted.

## Tests / Gates

Required tests:

- Projection emits `exec_command` with direct CLI command and no old restoration markers.
- CLI dispatcher executes `stop_message_auto` and `servertool_fixture`.
- Unsupported servertool fails fast.
- SSE blackbox remains SSE and includes normal tool call frames.
- Static audit rejects `old restoration handle`, `old_cli_`, `old_cli_result_`, `old restoration store`, restoration helpers, and migrated-path `reenterPipeline/providerInvoker`.
- Provider/client payload leakage tests reject internal metadata, `__rt`, snapshot/debug carrier, and old CLI restoration markers.
- apply_patch remains native/freeform and is not registered as servertool.

## Phase 1 Completion Definition

- Stopless returns reasoning + `exec_command: routecodex servertool run stop_message_auto --input-json <json>`.
- Stopless CLI input includes only `flowId`, `repeatCount`, and `maxRepeats`; output reasoning preserves the intercepted stop text; request-side injection owns any heuristic status-audit prompt.
- Basic intercepted servertool fixture returns reasoning + `exec_command: routecodex servertool run servertool_fixture --input-json <json>`.
- CLI dispatcher executes both supported tools and fails fast for unsupported tools.
- No old CLI restoration design remains in docs, tests, or runtime code.
- No migrated path uses followup/reenter/providerInvoker.
- Streaming remains SSE.
- 10000 online samples prove the behavior when upstream provider is available.
