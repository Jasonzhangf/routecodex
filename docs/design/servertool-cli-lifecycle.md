# Servertool CLI Lifecycle

## Scope

`servertool CLI` is the client-visible execution path for RouteCodex servertools that should run through the normal client tool loop. `apply_patch` is excluded and remains native/freeform client tooling.

## State Machine

```text
model response
  |
  v
[S0 candidate]
  - resp_chatprocess detects servertool tool_call or stopless auto hook
  |
  v
[S1 projected]
  - response is projected to assistant tool_call:
    tool: exec_command
    cmd: routecodex hook run <toolName> --input-json '<json>'
  - reasoning carries the full stop/servertool summary
  - content remains empty
  |
  v
[S2 client executed]
  - Codex client executes exec_command normally
  - routecodex CLI prints one JSON object to stdout
  |
  v
[S3 tool result returned]
  - client sends stdout back as ordinary exec_command tool result
  - RouteCodex does not rename, restore, or ticket-match the result
  |
  v
[S4 next model turn]
  - model consumes normal tool result
  - stopless CLI result must not trigger another stop_message_auto projection in the same lifecycle
```

## CLI Input Contract

Command:

```text
routecodex hook run <toolName> --input-json '<json-object>'
```

Common fields:

- `flowId`: servertool flow id when invoked from an auto flow.
- Tool-specific fields are passed as JSON object fields; no ticket, hidden handle, or metadata lookup is allowed.
- Only protocol-independent continuation may be persisted outside the current request/tool roundtrip. Ordinary stopless CLI projection must not introduce writeback files or sessionDir identity coupling.

`stop_message_auto` fields:

- `flowId`: must be `stop_message_flow`.
- `repeatCount`: current consecutive stop count after this projection is consumed.
- `maxRepeats`: active stopless repeat cap.
- `continuationPrompt`, `stdoutPreview`, schema guidance, and full internal input are forbidden in client-visible CLI input.

## CLI Output Contract

CLI stdout is a single JSON object:

```json
{
  "ok": true,
  "kind": "stop_message_auto",
  "tool": "stop_message_auto",
  "summary": "stopless continuation ready",
  "repeatCount": 1,
  "maxRepeats": 3
}
```

The stdout object is intentionally ordinary `exec_command` output. It is not remapped to private servertool metadata and must not echo prompt text, schema guidance, preview text, or full input.

## Guards

- If current request history already contains a `stop_message_auto` CLI tool result, stopless must not project another `stop_message_auto` call for that same lifecycle.
- The guard only scans tool-result-like records (`function_call_output`, `tool_result`, `tool_message`, or `role=tool`) and must not trigger on tool declarations or ordinary JSON fields.
- Unsupported CLI tool names fail fast.
- CLI input must be a JSON object.
- Request-side injection owns the heuristic continuation prompt based on state; CLI projection only carries status.

## Verification

- Projection contract: `tests/servertool/cli-projection-runtime-shell.spec.ts`
- CLI command contract: `tests/cli/servertool-command.spec.ts`
- Rust-only executor gate: `npm run verify:servertool-rust-only`
- Lifecycle blackbox: `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts`
- Old restoration removal: `tests/servertool/servertool-cli-result-restore.spec.ts`
