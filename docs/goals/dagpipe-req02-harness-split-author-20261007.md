# REQ02 GCM harness split author evidence

## Scope and source

This delta moves the existing GCM consumer into six sibling modules and keeps
one public CLI entry. Runtime source, protocol behavior, CLI arguments, output
schema, exit policy, tool checks and sample assertions are unchanged.

The parent accepted the worker's exact final patch. Its SHA-256 is
`9763136da4f2ab5cf34f3b3ed654365b19dd3cfe7fdc304446473a0909eedd50`.
The source input is `6b3e7a5d8a1b5df8821447faaa081b50b402437d`.
The patch and logs are retained at:
`/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/req02-harness-split-r151/`.

The original worker exited 0 and wrote final node notes, but did not create
its promised result.md. Parent acceptance below uses the actual source,
commands, receipts and samples; it does not infer delivery from worker exit.

## Development and failure behavior

- Original CI run 37546511170, exact head 6b3, rejected the 1530-line new entry.
- The split entry and all six modules are below the applicable 500-line limit.
- Parent `npm run verify:file-line-limit` passed with checked=7.
- All seven files passed `node --check`; CLI help stdout matched the original.
- Missing arguments and unknown options retained exit 2 and identical stderr.
- The worker's controlled incomplete-child public CLI case returned exit 1
  with summary/events retained. It did not count missing tools as success.
- Parent staged the exact seven files and `git diff --cached --check` passed.
- The two unused imports were removed before parent acceptance. The frozen
  parent patch hash equals the worker final patch hash.

## Real consumer acceptance

Parent executed the split public CLI against the installed isolated candidate
at `http://127.0.0.1:45559/v1`, using two new clean consumer worktrees:

- `/Volumes/Intel/playground/routecodex/req02-split-gcm55-20261006-r157`
- `/Volumes/Intel/playground/routecodex/req02-split-gcm56-20261006-r157`

Both trees have exact HEAD 6b3. Both children used fresh ephemeral GCM sessions.
The real read-only MCP target was `mcpx.environment_read`, with arguments
`{"view":"current","workspace":"routecodex","sections":["runtime","os"]}`
and consumed pointers `/data/runtime/mcpx_version`, `/data/os/type`.

Each model completed actual multiline exec_command, native file-change Add and
Update receipts, exact patch content read-back, real MCP execution, results in
the subsequent request, model consumption and terminal completion. GPT-5.6's
declared exec_command path invoked the complete apply_patch heredoc; the client
emitted native file_change receipts. The sample check preserved that actual
dispatch identity. It did not relabel it as a custom tool.

Both public harness runs exited 0 with all eight checks true:
tool execution, result return, model consumption, terminal, sample binding,
bound history, marker bytes/hash and absence of unexpected worktree changes.

Raw evidence:

- `/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/req02-harness-split-r151/host-gcm55-r157.log` and .exit
- `/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/req02-harness-split-r151/host-gcm56-r157.log` and .exit
- `/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/req02-split-gcm55-r157/` summary/events/sample-binding
- `/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/req02-split-gcm56-r157/` summary/events/sample-binding
- `/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/req02-harness-split-r151/host-raw-sample-audit-r157.json`

The sample audit parsed all four raw stages for each of 15 bound requests
(8 for GPT-5.5, 7 for GPT-5.6). No stage was missing and no error.json artifact
was observed. Both bound-history proofs were true.

## Installed candidate binding

Installed CLI SHA-256:
`09f00cd77729a4014664b5cade09484cfd214ef4559c0b51ecabe69fce14a12c`.

The retained exact-6b3 build/install receipts identify that artifact. Parent
confirmed live PID 49587, candidate port 45559, version 0.90.4839 and loaded
Mach-O UUID `51F4BA19-877E-303F-A7C3-A1E13234B9B9`, equal to the installed file.

Initial status omitted the candidate's admin environment and returned
IdentityMismatch. The existing declaration names admin listener
127.0.0.1:45560, and the config owner declares ROUTECODEX_V3_ADMIN_BIND.
The same official status command with that environment returned running for
instance `v3-64cbe5e69c7c944e9b95` (exit 0). Logs:
`/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/req02-harness-split-r151/host-status-bound-r157.log` and .exit.

This test-only split did not alter the binary or require a runtime restart.
Production 4444 was not installed or restarted. This delta is ready for an
independent architecture review. It is not a claim that REQ02 is delivered.
