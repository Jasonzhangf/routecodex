# REQ09 typed provider-local boundary: author verification

Scope: the transport construction and typed failure handoff prerequisite in
`dagpipe-req03-09-typed-boundary-design-20261005.md` section 8. This is not
REQ09 Operator registration or full pipeline cutover. REQ02/REQ06 remain owned
by their separate leads; the request node sequence is unchanged.

## Current author acceptance: 2026-10-06

This section supersedes the older artifact and runtime receipt below. The
behavioral code candidate is `41696142610b76d365bc73c9c89653d04c105a97`, composed
with latest `origin/main d8a609335ad35e0913bace2b4409037b09ad3573`. This subsequent
receipt edit changes documentation only; compare it to that candidate before
reusing its tests and installed artifact.

- The Relay attempt witness fix, common terminal diagnostic calls, removal of
  obsolete `Option<Response>` diagnostic coupling and physical owner split are
  integrated in the behavioral candidate. The common evidence owner is
  `terminal_error_evidence.rs`; the boxed dispatch adapter is in `executors.rs`.
  Neither owns Provider selection, health, client response or disposition.
- `RUN/parent-diagnostic-split-host-r50.log/.exit`: Server lib188 plus three real
  HTTP targets4, all192 PASS, exit0. These cover the four Relay protocols,
  received-HTTP-to-local-failure transitions, same-request Error01-Error06
  evidence, no-response closeout and a real optional Debug filesystem failure.
- `RUN/parent-diagnostic-split-ws-r51.log/.exit`:2 public WebSocket cases PASS.
  `RUN/parent-diagnostic-split-ws-r52.log/.exit`: standard inbound WebSocket
  target13 PASS. All207 author cases used the behavioral candidate's unchanged
  Rust source; subsequent changes before checkpoint were map/lock/view metadata.
- The existing source-only reverse diagnostic test remains
  `RUN/parent-relay-diagnostic-reverse-r43.log/.exit`: the fixed consumer failed
  when only the diagnostic source increment was reversed, then source restore
  succeeded. The public fixture asserts the actual `error_chain` field in order,
  rather than mistaking execution `node_trace` for the independent Error chain.
- `RUN/parent-diagnostic-architecture-r55.log/.exit` has42/43 passing sub-gates.
  Its sole failure was the affected raw-evidence audit lock/view. The scoped
  already-authorized refresh was rendered and recompiled; the affected umbrella
  gate then passed in `RUN/parent-diagnostic-architecture-docs-r61.log/.exit`.
  The original r55 exit1 is retained, not rewritten as a full-CI exit0.
- All three existing operation graphs validate. This proves topology, not
  Operator registration or downstream migration.
- `RUN/parent-candidate416-build-r63.log/.exit`: canonical full V3 build PASS.
  `RUN/candidate416-install-r64.sha256`: build/installed CLI both
  `69f1fb8066a27c116fb7a965f4729c592d130f3344362c8e43d94095bc9fc3e2`;
  build/installed hooks both
  `375167ecbe05175ea9ebe8cbb0b61cb9238ab13fda3179444dd6c4fafa4668dd`.
- `RUN/candidate416-restart-r65.log/.exit`: one official restart of45559/admin45560,
  accepted through running/completed, exit0. Status is running and health200.
  Managed exec retains PID49587; its executable inode411283715/device0x1000018
  matches the newly installed binary. PID continuity is not a stale-image claim.
- `RUN/gcm-candidate416-gpt55-r2/*.summary.json` and
  `RUN/gcm-candidate416-gpt56-r2/*.summary.json`: both PASS, child exit0, all eight
  checks true, bound to the exact behavioral SHA and installed digest above.
  Each has its own clean same-SHA worktree. Exec, Add/Update patch execution,
  exact MCP `environment_read` arguments/results, model consumption, complete
  follow-up history and same-thread raw samples are verified. Preserve each
  client's actually declared tool identity; do not force a custom declaration
  when the client executes its patch through its declared executor.
- The first parallel harness attempts remain FAIL: both had all seven tool and
  history checks true, but shared a worktree and detected the other run's marker.
  Separate worktrees fixed the test isolation without modifying the harness,
  weakening its side-effect assertion, changing source, or restarting again.

Final independent architecture review, remote integration and production
acceptance remain pending. This receipt does not mark any additional node
delivered. Author stage conclusions and exact receipts are in `RUN/notes.md`.

## Candidate and provenance

- Tested code commit: `10ff3c49e18d33680b08a35d160a2d92c030eade`.
- Base: `origin/main 3ee73753f5b638c863f0870994b9aea57ae15e87`.
- Worktree: `/Volumes/Intel/playground/routecodex/dagpipe-req09-combined-20261005`.
- All task evidence: `/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005` (RUN below).
- Official post-witness build: `npm --prefix v3 run build`, exit 0,
  version `0.90.4836`; RUN/parent-post-witness-build-r10.log and .exit.
- Installed isolated binary SHA256:
  `5ed26e247c06e0717409d7f52c59681353fe64491b3aa347eb0bead6c5d81a26`.
  Stable entry: current HOME/.rcc/candidates/dagpipe-req09-20261005/bin/rccv3.
- Hooks binary SHA256:
  `d5e1bedc65a70825ab5bc70d7063d058f8a3f6cd50f7d9d70f50d7b004fe1724`.
  Both installed files cmp-identical to this candidate's v3/dist/bin.
- Real isolated Server HTTP entry `127.0.0.1:45559`, admin `45560`,
  loaded binary above, PID49587 at acceptance. RUN/candidate45559-start-r13.log,
  candidate45559-health-r13.json, candidate45560-admin-r13.json.
- This receipt adds documentation only after the tested source commit.
  Reuse the author evidence only when the subsequent diff leaves all tested
  source, build inputs, configuration, and installed binaries unchanged.
  Bind the final documentation commit through a recorded source-equivalence check.

## Behavior and causality

A real first-attempt HTTP401 followed by a locally missing auth secret exposed
stale `last_external_http` from the earlier attempt. The correct Error guard
panicked because a ProviderLocalFailure cannot own an external HTTP witness.
The client then waited10s. This was reproduced through public Server HTTP.

The Direct attempt owners now reset the witness when a new candidate is admitted.
Each send error replaces it with that actual attempt's Option, including None.
Selection exhaustion before a new attempt preserves its actual preceding witness.
The source identity is preserved through one existing typed Error chain;
there is no payload control wrapper, error-string classification, guard weakening,
or response-level suppression.

Causal evidence in RUN/direct-attempt-witness:

- parent-mixed-green-r4.log/.exit: repaired source, real HTTP, PASS1/1.
- parent-mixed-reverse-red-r5.log/.exit: reverse ONLY owner.patch with the
  same fixture, original witness panic and10s timeout, exit101.
- owner.patch restored; both owner files cmp-identical to frozen files.
- parent-affected-public-r6.log/.exit: Direct3/3, mixed1/1, Relay1/1
  (four public protocols), exit0.
- parent-runtime-lib-final-r7.log/.exit: Runtime1163PASS,0FAIL,1existingignored.
- parent-architecture-final-r8.log/.exit: architecture43/43 sub-gates, exit0.

Other current author evidence in RUN:

- parent-websocket-affected-r14.log/.exit: real public WebSocket Relay success
  and Direct handoff consumers,2/2PASS.
- Existing Provider payload-fidelity and public Error/REQ05 consumer results
  are retained in RUN/notes.md with their exact source inputs. They are
  foundation evidence, not proof of Operator/caller migration.

## Actual client tool round trips

The existing unchanged harness is
RUN/gcm-harness-contract/final-harness/run-gcm-consumer.mjs.
It validates actual execution, full command and patch text, patch read-back,
exact MCP arguments/structured observations, result return, model consumption,
subsequent request pairing and frozen same-thread raw samples.

- gpt-5.5: RUN/gcm-candidate10ff-gpt55-harness.log/.exit and
  gcm-candidate10ff-gpt55/*.summary.json, PASS, all8checks true.
  Native apply_patch Add/Update both executed;8request IDs frozen.
- gpt-5.6: RUN/gcm-candidate10ff-gpt56-r2-harness.log/.exit and
  gcm-candidate10ff-gpt56-r2/*.summary.json, PASS, all8checks true;
  6request IDs frozen. The actual client fallback metadata did not declare
  native apply_patch. It sent complete patch text through exec_command's
  apply_patch heredoc and the native executor returned actual file-change
  receipts. The proxy preserved that declared identity. This is not proof
  of a native apply_patch declaration on gpt-5.6; gpt-5.5 covers that path.
- gpt-5.6 r1 remains FAIL in RUN/gcm-candidate10ff-gpt56.
  Client request history already contained a truncated large MCP capabilities
  JSON, so full history parsing could not prove pairing. The smaller real
  environment_read method in r2 preserved every result; no proxy output was
  trimmed and no assertion was relaxed.
- Current product worktree is clean after exact failed marker receipt removal.
  Old failure evidence and child home are retained for controlled cleanup.

## Review and integration boundary

Author debug, developer tests, isolated installed artifact and actual HTTP/WS
and two-model client tool consumption precede final architecture review.
Use independent oauth/gpt-6.1-sol for the exact base-to-candidate change.
Review has not yet passed. No merge/push/production replacement is claimed.

Separately, the main3ee public legal Chat->Responses cooled-pool consumer
reproduced an existing selector wait (2controls PASS,1newcase FAIL within1.5s).
RUN/exhaustion-chat-consumer-20261006-r2/parent-chat-public-r1.log/.exit.
The approved exhaustion design and separate GCM selector/maps workers own
that fix. This prerequisite does not change that selector and does not
claim the overall exhaustion defect or any pipeline node complete.
