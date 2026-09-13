# ServerTool CLI Lifecycle

## Scope

This contract covers ordinary RouteCodex servertools that are projected to
the client and executed through the normal tool loop. `apply_patch` remains a
native/freeform client tool and is excluded. Stopless, `reasoningStop`, and
`stop_message_auto` are retired and are not CLI tools in this lifecycle.

## State machine

```text
model response
  -> Resp03 identifies a registered client-exec servertool
  -> response projects an assistant exec_command tool call
  -> Codex client executes the public RouteCodex CLI
  -> one JSON result returns as the ordinary tool result
  -> the next model turn consumes that result
```

The projection preserves the original tool call id. RouteCodex does not
re-enter the pipeline, rename the result, or create a servertool-specific
response exit. The normal request/response Chat Process and continuation
boundaries remain the only owners of history and control state.

## CLI input contract

```text
routecodex servertool run <toolName> --input-json '<json-object>'
```

The input must be a JSON object containing only the registered tool's
business fields. Hidden tickets, session lookups, prompt text, RouteCodex
control state, and implicit fallback metadata are forbidden.

## CLI output contract

CLI stdout is one JSON object describing the validated client-exec projection
and its public command. It is not the business operation's execution result.
It must not contain internal runtime carriers, provider/auth/routing state, or
unregistered control fields. The client returns this projection output
unchanged as the normal tool result; request-side governance validates the
registered call/result pair before the next provider turn.

## Guards and ownership

- Unsupported tool names and non-object input fail explicitly.
- Servertool request hooks own call/result pairing and registered input
  governance at Req04.
- Servertool response hooks own registered response projection at Resp03.
- SSE remains framing/backpressure/closeout transport and owns no servertool
  semantics.
- Hook failures remain observable and must not be converted to a successful
  response or used to block RouteCodex startup when the independent hooks
  sidecar is unavailable.

## Verification

- focused servertool request/response governance tests;
- CLI input/output contract tests;
- Rust-only servertool owner and fixed-hook placement gates;
- controlled JSON/SSE tool-loop replay through the normal response exit.

The independent `codex-hooks` framework owns the official Stop hook, timer
hooks, and future memory hooks. Those hooks use the CodexApp input interface
for wake-up and are not implemented by this RouteCodex servertool CLI.
