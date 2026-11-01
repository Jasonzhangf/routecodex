# Long-horizon P0/P1 bug patrol plan

## 1. Goal and acceptance contract

Keep the RouteCodex V3 project continuously free of open P0 defects and drive P1
defects to closure, while keeping worker capacity loaded and the repository
resource-clean. This is a standing master goal, not a one-shot fix.

The completed behaviour must satisfy all of the following:

1. Every open `P0` bug in the git-bug tracker is either closed with merge +
   installed-runtime evidence, or explicitly parked with a recorded external
   blocker and a named unblock condition.
2. `P1` bugs are pulled and dispatched in priority order whenever worker
   capacity is free; no idle worker while an unblocked `P0`/`P1` exists.
3. Each fix follows the project standard defect delivery flow: duplicate check,
   independent clean worktree from latest `origin/main`, red-first regression
   test, single-owner minimal fix, mapped gates, independent review, merge to
   local `main`, rebuild/install/restart when runtime-affecting, same-entry live
   replay, then worktree/branch cleanup.
4. Evidence levels stay separate: source, test, build, install, restart,
   health, same-entry replay, review, merge, remote receipt. No later level is
   inferred from an earlier one.
5. After each cycle, `playground/` contains no worktree whose branch is fully
   merged into `main` and which no live task owns; each removal is an explicit,
   reversible action that preserves unmerged and dirty work.

## 2. Scope

### In scope

- Open `P0` and `P1` bugs in the RouteCodex git-bug tracker.
- V3 runtime, protocol projection, provider execution, routing, lifecycle, and
  the gates that bind those owners.
- Worker dispatch, task lifecycle, worktree/branch cleanup, and resource
  release for the above.

### Out of scope

- `P2` and below, unless they block a `P0`/`P1` fix or the release path.
- V4 work not attached to an open `P0`/`P1` bug.
- Unapproved scope expansion, releases, and irreversible operations.
- Autonomous speculative refactors when the bug backlog is drained.

## 3. Standing cycle

Each master wake runs the same loop until the terminal condition:

1. Reconstruct durable truth: `collab master status`, open bug list by
   priority, task registry, worker state, and worktree merge status.
2. For each open `P0`, then `P1`: confirm duplicate status, owner, allowed and
   forbidden paths, delivery and test conditions.
3. Dispatch to a live eligible peer through
   `collab subagent dispatch` with a stable request id, mandatory `DoD`,
   exact gate commands, and forbidden outcomes. Never hand a worker an
   ambiguous assignment.
4. Verify real results against controller verdicts and repository state, not
   worker self-report or chat tone.
5. Drive merge, rebuild/install/restart, same-entry replay, cleanup, and bug
   closure in that order for each verified candidate.
6. Reclaim resources: remove merged and idle worktrees, close finished managed
   subworkers, keep unmerged or dirty work intact and reported.

## 4. Stop conditions

The cycle pauses only for a true external gate: human approval for irreversible
operations, releases, cost, or new unapproved scope. There is no CLI command to
put a master on hold; the master pauses by not dispatching further work and
reporting a structured proposal (the gate, its unblock condition, and the
options) to the user, who is the only authority that can clear it. It stops when
no open `P0`/`P1` remains and no unblocked downstream work exists; at that point
the master reports completion and proposes next steps to the user instead of
starting speculative work.

## 5. Required evidence per bug

- bug id and duplicate-check result;
- worktree path, branch, base SHA, candidate SHA, tree SHA;
- red test name and its pre-fix failure output;
- green commands with observed results;
- mapped gate results, including the project architecture gate;
- independent review task id and controller verdict;
- merge receipt and resulting `main` commit;
- rebuild/install artifact hash, restart state, listener health, and
  same-entry replay result for runtime-affecting fixes;
- cleanup receipt and any preserved work with the reason it was preserved.
