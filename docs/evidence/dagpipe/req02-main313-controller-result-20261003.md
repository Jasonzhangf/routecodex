# REQ02 main313 controller result

Date: 2026-10-03. Overall node status: **INCOMPLETE**.

## Delivered author slice

Latest-main input `50ba5e540869f4021d40e884dcf629b9e59ffc95` was combined in an
independent task worktree with the previous REQ02 dirty source using three-way
application. The original worktree and snapshot are preserved. See
`req02-main313-input-binding-20261003.md` for source and evidence provenance.

The stale required Direct test name was corrected to
`responses_direct_provider_http_error_never_reaches_the_client`. The combination
map is byte-identical to the bounded GCM author's result; SHA-256 is
`8b3eeac1620a87a58c4a93966ccc547172e5345fb8bf0f935efa891229eb449a`.
Generated caller-flow Markdown and HTML also compare byte-identical. Operation
configuration, resource map and 403 Hub caller bindings pass their static checks.

Current-input author tests:

| Boundary | Actual result | Evidence |
| --- | --- | --- |
| Four request-scope public consumer suites | 16 PASS, exit0 | `.execution/terminal-suite1.log`; original GCM raw records the command exit |
| Server provider-terminal unit cases | 2 PASS, exit0 | `.execution/terminal-suite2.log`; original GCM raw records the command exit |
| Full real Server HTTP/SSE/WS entry suite, owned HOME | 77 PASS, exit0, no filters | `.execution/terminal-suite3-owned-home.log` and `.exit` |
| Actual CLI Chat Direct/Relay isolation, owned HOME | 13 PASS, exit0, no filters | `.execution/terminal-suite4-owned-home.log` and `.exit` |

Total executed in these four successful suites: **108 PASS / 0 FAIL**.
The CLI tests built and invoked this tree's candidate `rccv3`; they do not prove
installation, the new REQ02 caller or GCM native tool execution.
Author receipt: `req02-main313-terminal-author-result-20261003.md`, SHA-256
`227624de2179e664469439a69fdc89dcdae251f2c6f7f43ad8f6a7f01d9b9a01`.

## Failed observations retained

The shared-HOME full candidate suite returned exit101 with 70 PASS / 7 startup
ENOENT failures. Its serial seven-case subset had 5 PASS / 2 startup failures.
The same main-only baseline also had startup ENOENT failures. The first baseline
wrapper used a reserved zsh variable and failed to retain the true exit; its retry
was stopped by the controller after the shared sample-root ownership gap was
found. These records remain failed/incomplete; the isolated green result does
not erase them or claim a product sample-store concurrency fix.

Server startup calls `enforce_listener_retention`, which scans global request
directories. Shared HOME therefore exposed this test run to other sample writers
and retention. The positive owned-HOME run removed those tested startup failures;
serialism alone was not sufficient in the seven-case negative subset. This is
evidence for the test environment isolation decision, with the precise production
race owner still outside the current implementation slice.

Baseline evidence is now archived at `.execution/baseline-author/archive/`,
including `baseline-controller-disposition.md`. Its temporary clean source
worktree was removed, checked absent on disk and absent from worktree registration.

## Remaining hard dependencies

1. The user-owned external REQ06 candidate still lacks
   `project_canonical_request(canonical, compiled_profile, inverse, history, attempt_identity) -> ProjectedRequest`.
   Its Direct implementation still reads a complete business request from a
   control slot. The existing explicit ownership instruction forbids this task
   from taking over or creating a second projection implementation. No external
   source was imported and no native Desktop bridge is available to deliver a
   new instruction to that owner.
2. `chain:v3.provider_action_gate.mainline` is manually locked. The source caller
   synchronization passes, but the caller-flow verifier correctly exits1 because
   the previously requested explicit Jason authorization is still absent.
   Fingerprints remain `78d79632...72531b` -> `2c98f80e...77231` as detailed in
   the original `req02-provider-action-lock-refresh-proposal-20261003.md`.
   No lock or approval record was changed, and no duplicate approval request sent.

The combination is not a frozen reviewed candidate. REQ02 actual caller
replacement, two-model exec/apply_patch/MCP full round trips, final architecture
umbrella/review, install/restart/live samples, commit/merge/push and node delivery
remain **UNVERIFIED**. REQ03 has not started. Production 4444 was untouched.

## Owned resources

- All five GCM processes from this slice exited or were explicitly stopped;
  cancelled workers' shell exit0 is not a task completion receipt.
- Five temporary worker HOME directories were removed after their raw JSONL and
  stderr were retained in task evidence.
- Clean baseline worktree was archived and removed with non-force Git cleanup.
- The maps worktree removal returned128 because of modified/untracked imported
  task files. It remains preserved at
  `/Volumes/Intel/playground/routecodex/dagpipe-req02-main313-maps-20261003`;
  `.execution/maps-worktree-cleanup-attempt.log` records the exact refusal.
  No force deletion or reset/restore/stash was used.
- The original dirty candidate and new combined candidate remain active evidence
  and implementation resources. Resource closeout is therefore **INCOMPLETE**.

State transition: this turn made real author/integration progress. After the
available slice, the same REQ06/lock conditions still prevent any authorized
dependent implementation or delivery. Resume at those dependencies, reuse the
bound successful tests where inputs remain equivalent, and do not repeat baseline
shared-HOME probes or unchanged green checks.
