# REQ02 GCM harness correction result (2026-10-03)

## Status

- Harness correction: `COMPLETE`
- `node --check`: `PASS`
- `--help`: `PASS` (exit `0`)
- Missing-argument entry: `PASS` (exit `2`, no child request)
- Real GPT-5.5/GPT-5.6 consumer round: `UNVERIFIED`
- Runtime lifecycle action: `NOT APPLICABLE`; no model, daemon, restart, or
  endpoint request was run.

The original
`docs/goals/req02-gcm-roundtrip-harness-result-20261003.md` was retained for
comparison.

## Write Boundary

Changed files:

- `tests/blackbox/req02-tools/run-gcm-consumer.mjs`
- `tests/blackbox/req02-tools/README.md`
- `docs/goals/req02-gcm-roundtrip-harness-correction-result-20261003.md`

No product source, sample tree, daemon, model, network clone, or `curl` was
used. The `/tmp/codex-src-0.160.0` directory was not touched.

## Corrections And Source Basis

1. Exec sentinel ordering:
   `run-gcm-consumer.mjs:420` now prints the complete multi-line command with
   the sentinel as the final command line. `run-gcm-consumer.mjs:515` requires
   both the command and output to end at that sentinel while retaining the
   absolute tested worktree check.

2. Native patch receipt:
   `run-gcm-consumer.mjs:546` no longer searches `command_execution` for
   `apply_patch`. It requires completed `item.type=file_change` events with
   exact marker `changes[{path,kind}]` values in Add-then-Update order, then a
   later exec readback containing the exact byte count, content, and SHA-256.

   The pinned event source confirms the accepted shapes:
   `/Users/fanzhang/code/codex/codex-rs/exec/src/exec_events.rs:118,170-195`.
   `run-gcm-consumer.mjs:923` now validates the raw freeform patch and
   `custom_tool_call`/`function_call` identity from the exact bound
   request/response history. CLI `file_change` alone is not treated as proof
   of grammar text.

3. Explicit MCP contract:
   `run-gcm-consumer.mjs:38-40` adds required `--mcp-server`,
   `--mcp-tool`, and `--mcp-arguments` inputs. `run-gcm-consumer.mjs:620`
   compares `mcp_tool_call` `server`, `tool`, and `arguments` exactly, then
   reads the actual `structured_content`. The pinned event source defines
   those separate fields at
   `/Users/fanzhang/code/codex/codex-rs/exec/src/exec_events.rs:263-290`.

   The current profile truth is
   `/tmp/codex-worker-home/req02-gcm-harness-correction-20261003-r2/gcm.config.toml:89-90`
   with `[mcp_servers.mcpx]` and
   `url = "http://127.0.0.1:9090/mcp"`. The README recommendation is
   `mcpx` / `runtime_read` / `{"view":"capabilities"}`.

4. Model consumption:
   `run-gcm-consumer.mjs:596` derives observations from the actual structured
   content recursively, preserving the returned value types. The final agent
   message must contain every observed scalar value; the old arbitrary
   two-key/one-string rule was removed.

5. Codex CLI help preflight:
   `run-gcm-consumer.mjs:348` only records the CLI version as evidence. The
   fragile `codex exec --help` text-fragment matcher was removed; the child
   command remains the actual execution boundary and its error is retained in
   the summary.

## Parameter Checks

All commands were run with workdir:

`/Volumes/Intel/playground/routecodex/req02-gcm-roundtrip-harness-20261003`

```sh
node --check tests/blackbox/req02-tools/run-gcm-consumer.mjs
```

Result: exit `0`.

```sh
node tests/blackbox/req02-tools/run-gcm-consumer.mjs --help
```

Result: exit `0`; help lists the three explicit MCP inputs.

```sh
node tests/blackbox/req02-tools/run-gcm-consumer.mjs
```

Result: exit `2`; ten required options were reported missing before any child
request could be started.

```sh
node tests/blackbox/req02-tools/run-gcm-consumer.mjs --mcp-arguments not-json
```

Result: exit `2`; the invalid JSON argument was rejected before any child
request could be started.

Exact script SHA-256:

```text
766dfb1e068cda5d6f2549ef4debfe0f6907a7f2bc859f27285c2442763e93c6
```

Exact README SHA-256:

```text
49a03cebe02ad68b63ef4f6c77703f72e6ab0cefff102242eb61012ae4f1f8d0
```

## Remaining Gaps

- No candidate endpoint, candidate SHA, binary path/hash, or tested worktree
  was provided in this task.
- No real child JSONL, bound request/response history, or real MCP
  `structured_content` exists here, so the two-model consumer rounds remain
  `UNVERIFIED`.
- The new raw-patch identity and subsequent-request checks are implemented but
  cannot be called verified until a real isolated candidate run produces the
  exact bound samples.
- No baseline or sample-tree search was performed; absence is recorded rather
  than guessed.

## Next Transition

The parent must provide the exact isolated endpoint, candidate SHA, binary
path/hash, and tested worktree, then run the documented GPT-5.5 and GPT-5.6
commands with:

```text
--mcp-server mcpx
--mcp-tool runtime_read
--mcp-arguments '{"view":"capabilities"}'
```
