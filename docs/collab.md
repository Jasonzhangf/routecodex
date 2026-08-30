# collab workflow

This project uses the local `collab` daemon for multi-agent coordination.
The binary lives in `~/code/collab`; the installed command is
`~/.cargo/bin/collab`.

The daemon is detached and automatically restarted by normal commands when
its socket is unavailable. `collab init` creates/migrates the local
`.agent-collab/server` skeleton, so old projects need no manual repair. Use
`collab down` only for an explicit stop; use `collab up` to clear that stop and
start it again. Never start a second daemon.

## Runtime boundary

- Every registration must come from a live tmux pane or a live Herdr pane.
- The first registered pane fixes the project runtime (`tmux` or `herdr`).
- Later workers must use the same runtime; mixed tmux/Herdr projects are
  rejected, as are messages across runtimes.
- The runtime is part of the worker identity boundary, not a task preference.

The current master may migrate ownership before a restart:
`collab transfer-master <worker-id>`. To remove an old registration, use
`collab remove-worker <worker-id>`; active task owners must deliver or release
their task first. The master cannot remove itself.

## Roles

- First registered pane becomes `master`; every later pane becomes `worker`.
- Master creates tasks, reviews deliveries, merges, closes tasks, and cleans
  declared worktrees after merge. Master may claim an available task as its
  own owner and then follows the same deliver flow as a worker.
- Workers claim `available` tasks and work independently. They do not request
  claim approval and do not register tasks.
- Check identity with `collab role`, `collab who`, or `collab master`.
- If a message names a different role or owner, confirm identity first and
  return the owner contact; do not act outside your role.

## Task lifecycle

```
available -> working -> verifying -> reviewed -> delivered
          -> master merge -> close/cleanup -> closed
          -> rework -> working
```

Task records use a fixed shape:
`id / owner / feature_id / worktree_path / branch / base_commit / priority /
status`. Valid statuses are `available`, `working`, `verifying`, `reviewed`,
`delivered`, `rework`, `merged`, `closed`, and `cancelled`.

## Common commands

```sh
collab config                     # show .agent-collab/collab.json
collab config --heartbeat-minutes 45
collab up                         # clear explicit down and start daemon
collab down                       # explicit stop; disables auto-restart
collab who                        # workers + active task status
collab task status [task-id]      # board or one task
collab task register <id> --feature <feature-id> --worktree <path> \
  --branch <branch> --base-commit <sha> --priority p2
collab task claim <id>            # worker self-service
collab task deliver <id> --evidence "commit=<sha>; gates=pass"
collab task update <id> --status merged
collab task close <id>            # master; verifies merged/clean, releases claim
```

Master owns the fixed task contract and the project board. After merging a
delivered worker branch, run `collab task close <id>` to verify the merge,
remove the clean declared `./playground/` worktree, remove the merged branch,
and dispatch registered available tasks to idle workers. Then register the
next decomposed tasks from the new main commit and run `collab task dispatch`.
After every close, master re-analyzes the goal: publish and dispatch the next
tasks only when the goal is incomplete; publish nothing when it is complete.
Workers never share worktrees: claim one task, work in its declared clean
worktree, test, commit, and deliver; delivery keeps the claim held until the
master merges and runs `collab task close`. Only that close response releases
the claim and returns the available board for the worker's next claim only
after master close. A
worker remains registered after task closure.

## Message handling

On `[MAIL]`, read the body or `body-ref` first, confirm identity and task
ownership, decide collaborate/defer/reject/continue, and execute the required
state action. Send any substantive reply only through `collab send` or the
Collab MCP send operation; never type a message with tmux or paste it into a
pane. The daemon owns the complete text-plus-Enter transaction. If the daemon
is down, do not send a partial message or manually add Enter; restore the
daemon through the authorized path, then retry the same send. A notify does
not require a reply. A request requires one substantive reply. A reply from a
peer is work input, not a stop signal.

`collab inbox` and `collab msg <id>` query the durable local mailbox after a
tmux pane disappears; mailbox state remains authoritative.

## Heartbeat and dispatch

Only workers with an active claim receive heartbeats. `collab who` exposes
`active_task` and `active_status` for every worker, so master can dispatch to
idle workers without messaging busy ones.

`.agent-collab/collab.json` configures the heartbeat interval. The daemon
reloads it without a restart; invalid values fail closed to the default. Only
workers with an active claim receive heartbeat prompts. When working, ignore a
heartbeat and continue. When intentionally waiting at a safe breakpoint, use
`collab recv --timeout 300`; on timeout inspect the task next step and continue
without waiting. The tmux heartbeat uses literal text, waits two seconds, then
sends an explicit Enter.
