# REQ02 GCM consumer harness

This directory contains the reusable consumer command for the REQ02 GCM
exec/apply_patch/MCP round trip. The harness is intentionally separate from
product code and does not start or restart any RouteCodex runtime.

## What it verifies

One invocation starts a fresh `codex exec --profile gcm` process against one
explicit isolated candidate endpoint. It validates all of these layers from
the child CLI JSONL and from the actual marker file:

1. `exec_command` execution: a completed command receipt with a complete
   multi-line command, absolute tested worktree, exit code, and tail sentinel.
2. Native patch execution: completed `file_change` Add then Update events for
   the exact marker path and order.
3. Result return: marker content and SHA-256 read back by a later
   `exec_command` receipt.
4. MCP execution: a real completed `mcp_tool_call` whose `server`, `tool`, and
   `arguments` exactly equal the explicit CLI inputs and whose
   `structured_content` is non-empty.
5. Model consumption: the final agent message contains the observed exec
   sentinel, marker content, marker SHA-256, MCP identity, and the observed
   scalar values at the explicitly configured result JSON pointers. The full
   structured result is retained in the raw receipt and summary.
6. Binding: the child `thread_id` is matched against
   `request.json:client_metadata.thread_id` under the exact endpoint port in
   `<RCC_HOME|$HOME/.rcc>/codex-samples/openai-responses/ports/<port>`.
7. Bound history: within those exact bound sample directories, the raw Add and
   Update patch text is present under a consistent `custom_tool_call` or
   `function_call` identity named `apply_patch`, and the MCP scalar results
   appear in a subsequent request. CLI `file_change` alone does not prove the
   freeform grammar text.

Exit code `0` is only possible when all layers pass. Exit code `0`, HTTP 200,
or `requires_action` alone is not a pass.

## Required arguments

```text
--endpoint <url>          isolated candidate base URL, for example
                          http://127.0.0.1:5555/v1
--candidate-sha <sha>     full 40-hex candidate commit SHA
--binary <path>           absolute candidate binary path
--binary-sha256 <sha>     full 64-hex SHA-256 of that binary
--model <model>           gpt-5.5 or gpt-5.6
--tested-worktree <path>  absolute tested worktree whose HEAD is the
                          candidate SHA
--evidence-dir <path>     absolute evidence output directory
--mcp-server <name>       exact MCP server name; current recommendation: mcpx
--mcp-tool <name>         exact MCP tool name; current recommendation:
                          runtime_read
--mcp-arguments <json>    exact JSON object arguments; current recommendation:
                          '{"view":"capabilities"}'
--mcp-observation-pointers <json>
                          result fields the model must consume; recommendation:
                          '["/data/runtime/version","/data/capability_version"]'
```

Optional:

```text
--codex-bin <path>        Codex CLI executable (default: codex)
--timeout-ms <ms>         child timeout (default: 900000)
```

The harness rejects port `4444`. It never edits the global Codex or RouteCodex
config and never prints auth/token values. The child receives an isolated
`CODEX_HOME` with symlinks only for `config.toml`, `gcm.config.toml`,
`auth.json`, and `AGENTS.md`.

## Provider override

The harness reads the active `$CODEX_HOME/gcm.config.toml` and base
`config.toml`, resolves the actual `model_provider`, and then passes:

```text
codex exec --profile gcm \
  -c 'model_providers.<resolved-provider-id>.base_url="<candidate-endpoint>"' ...
```

It does not infer the provider id from the profile name. The current local
truth is `model_provider = "gcm"` in `$CODEX_HOME/gcm.config.toml`, with
`[model_providers.gcm] base_url = "http://127.0.0.1:4444/v1"` in the base
config. That default endpoint is rejected; a distinct isolated candidate
endpoint is required.

The harness records the Codex CLI version as evidence only. It does not match
help text fragments or use a preflight state machine; the child command and
its actual execution error are the behavioral boundary. Effective routing is
still proven only by the future run's exact port sample binding and bound
request/response history.

## Exact commands

Run each model separately. Replace the placeholders with the parent-provided
candidate values.

GPT-5.5:

```sh
node tests/blackbox/req02-tools/run-gcm-consumer.mjs \
  --endpoint http://127.0.0.1:<isolated-port>/v1 \
  --candidate-sha <40-hex-candidate-sha> \
  --binary /absolute/path/to/candidate/rccv3 \
  --binary-sha256 <64-hex-binary-sha256> \
  --model gpt-5.5 \
  --tested-worktree /Volumes/Intel/playground/routecodex/<candidate-worktree> \
  --evidence-dir /Volumes/Intel/playground/routecodex/<candidate-worktree>/.execution/req02-gcm-gpt55 \
  --mcp-server mcpx \
  --mcp-tool runtime_read \
  --mcp-arguments '{"view":"capabilities"}' \
  --mcp-observation-pointers '["/data/runtime/version","/data/capability_version"]'
```

GPT-5.6:

```sh
node tests/blackbox/req02-tools/run-gcm-consumer.mjs \
  --endpoint http://127.0.0.1:<isolated-port>/v1 \
  --candidate-sha <40-hex-candidate-sha> \
  --binary /absolute/path/to/candidate/rccv3 \
  --binary-sha256 <64-hex-binary-sha256> \
  --model gpt-5.6 \
  --tested-worktree /Volumes/Intel/playground/routecodex/<candidate-worktree> \
  --evidence-dir /Volumes/Intel/playground/routecodex/<candidate-worktree>/.execution/req02-gcm-gpt56 \
  --mcp-server mcpx \
  --mcp-tool runtime_read \
  --mcp-arguments '{"view":"capabilities"}' \
  --mcp-observation-pointers '["/data/runtime/version","/data/capability_version"]'
```

Expected success:

- process exit `0`;
- `*.summary.json` has `"status": "PASS"`;
- `*.sample-binding.json` has at least one exact `request_id` and
  `history.ok: true`;
- `*.events.jsonl` contains `thread.started`, completed `command_execution`,
  native `file_change`, `mcp_tool_call`, `agent_message`, and
  `turn.completed`;
- the marker evidence file is exactly `REQ02_GCM_PATCH_UPDATED\n`.

Expected failure:

- any missing tool execution, result return, model consumption, sample
  binding, bound-history proof, marker hash, or unexpected worktree change
  returns non-zero;
- the child home and marker directory are retained and listed in the summary
  for recovery.

## Targeted harness checks

These do not start a model or daemon:

```sh
node --check tests/blackbox/req02-tools/run-gcm-consumer.mjs
node tests/blackbox/req02-tools/run-gcm-consumer.mjs --help
node tests/blackbox/req02-tools/run-gcm-consumer.mjs
```

The last command must exit non-zero before any child request is attempted.

## Current gap

There is no wired candidate endpoint or candidate binary in this task. The
actual two-model consumer runs are therefore `UNVERIFIED` here. The parent
must provide the exact isolated endpoint, candidate SHA, binary path/hash,
and tested worktree, then run the two commands above.
