# V3 Defect, Sample, and Resource Lifecycle

## Issue DAG

Use the project's canonical defect flow in `AGENTS.md` and issue contract in
`.appsdk/skills/appsdk-project-governance/SKILL.md`. This reference supplies the
per-issue DAG and the required post-restart Codex sample decision. Intake or
deduplicate every execution-bound defect and carry its authoritative bug ID
through its own worktree, evidence, review, merge, cleanup, and solution receipt.
The RouteCodex standard defect flow requires commit and merge to `main`; the
normal repair authorization in the global `AGENTS.md` covers commit, merge, and
push after the gates pass. The global host orchestrator owns the independent
review route and delivery order. A conflict, required-check failure, or rejected
merge/push remains an open disposition with its owner and recovery condition.

Do not begin issue execution until the canonical AppSDK intake/dedup returns an
authoritative bug ID. If intake is unavailable, report the exact blocker and
recovery condition before creating a worktree or doing issue work; do not invent
a shadow tracker or ID. The issue owner remains accountable for intake,
worktree, reproduction, fix, candidate validation, runtime evidence, cleanup,
and bug disposition. The independent overall review follows author verification
and applicable candidate runtime acceptance. The authorized delivery owner
performs commit/integration after review and applicable CI pass. Review pending
keeps the integration and bug close open; integration failures go to the delivery owner (the live
master only when Collab is active). The master
owns the separate residual-resource inventory, while each issue owner cleans
only that issue's resources.

Each issue run has one entry and one disposition exit:

```text
bug intake / dedup
-> clean issue worktree at playground/<issue-id> from latest origin/main
-> reproduce + feature DAG/map + first divergence + unique owner + red regression test
-> minimal owner-scoped fix
-> fetch/combine latest origin/main in the issue worktree
-> mapped tests/build + author E2E + candidate install/restart/replay when runtime-impacting
-> health + real-entry replay + post-restart sample audit
-> effective independent overall architecture review on the tested changes -> candidate commit
-> applicable PR CI PASS -> merge tested changes to clean main -> push + remote receipt
-> post-merge verification: runtime path rebuild/install/restart -> health -> real-entry replay -> sample audit; otherwise scoped consumer check
-> issue-owned resource cleanup + absence checks
-> one issue disposition receipt
```

Use the task branch, necessary diff and actual test/runtime results to describe
the tested changes. Do not freeze a candidate or add identity checks. A commit
is not the delivery merge and does not authorize integration. Source or upstream
changes require only affected validation; unchanged evidence remains usable.
Keep the work under the same bug ID. Do not silently reuse results for changed
behavior.
Review pending never means solved. Blocking findings require repair
and affected revalidation; a confirmed delivered regression follows the global
traceable revert/rebuild/restart/replay recovery contract.

The disposition node records `solved` only if every applicable gate, an effective independent review,
merge receipt, post-merge replay/sample audit, and owned-resource check passed.
Any failed gate, review finding, mainline drift requiring new validation, or
explicit cancellation reaches that same node as `open`, with cause, owner,
recovery condition, and retained-resource disposition. A later attempt starts a
new DAG run from the persisted bug record; it is not a back-edge in the prior
run. Keep an active or blocked issue's worktree. Do not emit a solved receipt or
clean resources still needed for recovery on an incomplete run.

Record actual tests, runtime entry, restart time when applicable and sample
window. Use ordinary Git operation receipts when integration occurs. Before
external release preparation, do not compute or compare SHA/checksums, create
hash manifests or frozen snapshots, or add candidate identity, byte comparison,
patch reconstruction or packaging gates. Release checks cover only actual
publication needs. If the issue does not change the installed runtime artifact,
mark install/restart not applicable; do not restart solely
to claim that a test-only or documentation change was loaded. If a managed
restart is otherwise required or performed, run the sample audit after it.

If candidate or post-merge samples expose a local request failure, deduplicate
or open its own bug and start an issue-bound run in that bug's own worktree. Do
not fold independent defects into the current issue. A sample matching this bug,
recurring from its known baseline, or introduced by its candidate fails this
issue's gate; independent known local failures require their own bug and
pre-candidate evidence before they can be excluded from the regression
comparison. Every repeated regression must have a focused regression test in the
mapped required gate.

## Issue Close Evidence

Before closing an AppSDK bug record, including one attached to a functional work
item, write the stable public-entry black-box test IDs and their exact execution
commands with `appsdk bug comment <id> -m <test IDs and commands>`. Read back with
`appsdk bug show <id> --json` and confirm the record. Close with `appsdk bug close`
only after that confirmation and every other applicable delivery condition pass.
Missing confirmation keeps the record open. This is the existing project close
requirement, not an additional check at each test or progress update.

## Post-Restart Codex Samples

After every managed restart, bind the audit window to the loaded runtime
identity. Resolve the canonical Codex sample store from the active configuration
and enumerate every configured Codex listener. Record the UTC start at managed
runtime readiness and the UTC end immediately after the validation replay
window, then inspect every sample created in that closed interval. If the
runtime identity or complete sample enumeration cannot be established, the
sample gate remains open. For each sample error, bind its provider probe to the
same provider, auth-key identity, and model as the payload request. Use the
typed provider-health probe result; a generic HTTP 2xx, log line, or debug
snapshot alone does not prove typed probe success. A probe is a separate request
at its recorded time; a later HTTP 2xx does not prove that an earlier payload
failure was local. Classify the attempt from its typed source, upstream status
and error details, retained wire evidence, and bound probe:

- **Local failure is demonstrated:** deduplicate or open its bug and fix it in
  that bug's own issue worktree. A
  matching/recurring failure or a regression introduced by the current
  candidate fails this issue's sample gate. An independent known local issue
  requires its own bug and pre-candidate evidence before exclusion from this
  issue's regression comparison.
- **A bound probe confirms the same upstream failure:** record an upstream
  exception to the local regression gate. A different probe failure does not
  establish the cause of the payload failure.
- **The attempt proves upstream capacity failure or transport failure:** retain
  that classification even if a later bound probe succeeds. An explicit
  provider account-unavailable error on HTTP 503 is capacity evidence; HTTP 5xx
  alone is not. A typed pre-response connection close is transport evidence.
  A confirmed repeat pattern still requires its declared provider policy/config
  fix and regression evidence; switching providers does not close that failure.
- **Cause is unresolved:** keep the sample gate open. Probe success plus payload
  failure, or a missing/unbound probe without independent causal evidence, does
  not establish either a local bug or an upstream exception.
- **Probe and payload both succeeded:** record the sample as passing.

With `error_samples_only`, a recovered request can persist only
`provider-failed-attempts.json` with `terminal_source: null`; ordinary request,
provider-bound and response snapshots are not retained. This is not a sample
enumeration failure and does not prove final client delivery. Record the missing
payload boundary and do not claim an exact replay. It does not excuse local
stage errors, internal 598/599, schema/parameter failures, terminal failures, or
unresolved causes. Investigate those from the retained evidence under the rules
above. Do not reconstruct missing business payloads from diagnostic records.

Replay the issue's exact failing sample, recurring samples, and relevant control
samples through the real entrypoint. Preserve the closed UTC window, sample and
request IDs, runtime identity, provider/auth-key/model binding, typed probe
outcome, provider-bound payload outcome, and client outcome in the receipt.
Upstream failures are not local fixes; unresolved and local errors are never
reported as passing samples.

## Resource Closeout DAG

Each issue owner removes only resources created for that issue and proves their
absence before its disposition receipt: its worktree, its `playground/<issue-id>`,
temporary files, logs, forwards, and issue-owned processes. Do not remove shared
runtime processes or another issue's resources. Verify the worktree is absent
from `git -C <repo> worktree list --porcelain`, `test ! -e <playground>` passes,
and this run's temporary resources are gone. Preserve the worktree if removal
fails because it is dirty or still in use; report the owner and blocker.

At project scheduling close, the master owns a separate single-entry,
single-exit residual-resource DAG:

```text
inventory remaining worktrees/playgrounds/tmp/logs/forwards/processes
-> bind each resource to owner and active/stale evidence
-> obtain the resource owner's authorized terminal disposition
-> remove only resources proven stale and authorized for cleanup
-> verify absence; retain unknown/active/other-owner resources with an open item
-> one residual-resource inventory receipt
```

When Collab is active, the Collab master owns this inventory. Its completion is
required before the master declares scheduling/resource closeout; it does not
block a separately complete issue receipt. Never delete an unknown, active, or
other-owner resource by assumption.
