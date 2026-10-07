# REQ09 typed provider-local boundary: author verification

Scope: the transport construction and typed failure handoff prerequisite in
`dagpipe-req03-09-typed-boundary-design-20261005.md` section 8. This is not
REQ09 Operator registration or full pipeline cutover. REQ02/REQ06 remain owned
by their separate leads; the request node sequence is unchanged.

## Current author acceptance after main363: 2026-10-06 19:56 UTC

The behavioral candidate is `58774075b6f3f7d1130f0ef92898516ebdf4eb88`.
Its merge parents are latest main `459004b113d31f79d818992509c1a1fb17639b66`
and prior reviewed candidate `dc5f3818fe2689b65c164cdf07674d81f71ef763`.
This receipt supersedes the historical acceptance below. This receipt edit
changes only this Markdown file; Rust, configuration, graphs and build inputs
remain identical to the behavioral candidate.

`RUN` is
`/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005`.

- Main363 source/maps composed normally. Only the two generated caller views
  conflicted, and the official renderer regenerated them from the composed maps.
  The existing `prepare_exec_attempt` method moved unchanged from `lib.rs` to
  `executors.rs`; its three actual caller bindings moved with it. There is one
  method definition and no behavior wrapper.
- `RUN/parent-main363-relocated-host-r73.log/.exit`: 192 PASS, exit0
  (Server lib188, optional Debug sink failure1, mixed Relay failure2 and
  terminal diagnostics1). The public cases verify no client Provider error
  body, complete typed Error evidence and an independent healthy request.
- `RUN/parent-main363-websocket-r70.log/.exit`: standard inbound WebSocket
  13 PASS, exit0. `RUN/parent-main363-debug-r69.log/.exit`: Debug30 PASS, exit0.
- `RUN/parent-main363-architecture-r72.log/.exit`: all43 architecture
  sub-gates PASS, exit0, after the method migration and official admission.
- `RUN/parent-main363-recovery-host-r79.log/.exit`: eight public HTTP cases
  PASS, exit0 (Direct local failures3, pool exhaustion/recovery3, Relay witness1,
  four-protocol recovery1). Complete exhaustion disconnects this request;
  recovery admits a later request. It does not wait to resume the exhausted
  request. Local constructor failures with a healthy remaining candidate
  reselect internally. Original source and actual attempt witnesses survive
  terminal evidence collection.
- `RUN/parent-main363-build-r75.log/.exit`: canonical V3 build PASS, exit0,
  version0.90.4839. `RUN/main363-install-r76.sha256`: built and installed CLI
  both `0218005ad9cb5dbfd8f0aa87f4b16bf143affac959fc2aed79e9aa4ed200995c`;
  hooks both `3e2c9b18c086a94efee55d82aef6c489191eba9d2f1bc97ef01758fa0e5174b1`.
- `RUN/main363-restart-r77.log/.exit`: one official restart of45559/admin45560,
  accepted→starting→running→completed, exit0. Health reports version0.90.4839.
  Managed PID49587 remains; `RUN/main363-loaded-image-r77.sample` records loaded
  Mach-O UUID `DB472F9B-4343-36CC-B051-13043DE9AFED`, equal to installed
  binary `dwarfdump --uuid`. This establishes loaded image identity.
- `RUN/gcm-main363-gpt55-r78` and `RUN/gcm-main363-gpt56-r78`: both real
  `gcm` consumers exit0 and all8 summary checks true. Inputs bind the exact
  behavioral SHA, CLI digest, isolated endpoint and separate clean worktrees.
  Bound raw histories prove complete exec, actual patch Add/Update/readback,
  real MCP `mcpx.environment_read`, consumed results and subsequent requests.
  MCP observations are `mcpx_version=0.9.18` and `os.type=darwin`.
- Actual tool declarations differ: gpt-5.5 uses `custom_tool_call/apply_patch`;
  gpt-5.6 uses `function_call/exec_command` with patch heredoc. Preserve each
  original declaration and complete arguments; do not infer type from model.

Author implementation, debug, development tests and public/E2E acceptance are
complete for this prerequisite candidate. Final independent review of this
latest-main composition remains pending. No main merge/push or production
4444 replacement is claimed. REQ02 and REQ07 node delivery remain incomplete.

## Historical author acceptance for candidate416: 2026-10-06

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

## Historical review and integration boundary

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

## PR367 provider-action CLI regression correction (2026-10-06)

The full provider candidate at `882c41a3492bd2095afafa255b966f1bf0c73c13`
has the main363 author evidence and independent PASS recorded above. CI run
37523821745 reported the provider-action red-fixture step failing. The same
public CLI command reproduced the failure on that exact source:

`npm run test:v3-provider-action-gate-red-fixtures`

RUN/provider-main363-red-fixtures-r86.log and .exit retain exit 1 with
`Responses Relay wire encoding failure bypasses typed provider failure handling:
verifier unexpectedly passed`. The wire gate's broad match crossed the wire
error arm and accepted the subsequent transport error arm introduced by the
typed-source fix. The existing mutation actually changed the wire arm, so
this was a verifier failure, not a missing mutation or a provider failure.

The source checkpoint `692a57a53472ef79d6c3cd20890e3f5cdc637c54` changes only
that verifier expression. It binds the existing wire match's first success
and error arms and cannot cross a completed statement into the transport
match. It changes no runtime source, graph, configuration, tool mapping,
or declared lifecycle behavior.

Author verification through the real verifier CLI and copied public fixture
surface passed:

- RUN/provider-action-gate-r87/red-fixtures.log and .exit: exit 0, all 56
  forbidden mutations rejected; the baseline verifier passes first.
- RUN/provider-action-gate-r87/admission.log and .exit: exit 0, 526 files.
- RUN/provider-action-gate-r87/gate.log and .exit: exit 0, 48 machine edges,
  actual callers and map/manifest/owner bindings agree.
- Normal checkpoint hook passed; the final diff has one verifier expression.

Runtime build, installed image, HTTP/WebSocket, exhaustion/recovery and both
real GCM tool consumers remain bound to the unchanged Rust/config/graph inputs
of the main363 candidate above. They are reused for this verifier-only delta;
no second build or restart is claimed. Independent delta review and a new
remote CI run are required before PR367 can merge. This correction does not
claim REQ02 or another operation node delivered.

## PR367 Gemini exhaustion fixture correction (2026-10-06)

CI run `37532692294` on exact head
`b229ba58201b4aa063629e6b275d9061bda3bac0` failed in
`uncommitted_sse_failure_enters_error_chain_and_provider_cooldown` after
20 other Gemini integration cases passed. Its old assertion required an
exhausted request to wait for recovery. The current contract terminates that
request and allows independent recovery to serve a later request.

- RUN/provider-ci-r125-failure.log retains the exact CI failure. The host
  single-case reproduction in provider-ci-r125-host-red.log/.exit repeats
  the same obsolete hold assertion, exit 101.
- A fresh GCM worker supplied a single test-file patch. Its compile and
  formatting checks passed; its runtime test stopped at sandbox loopback
  EPERM. That is not host behavior evidence.
- The first host run of the patch found a mistaken `expect_err` in the
  new fixture. This public runtime API already returns a classified internal
  terminal output. The author corrected the consumer to check its complete
  Error chain and typed `NoResponse` disposition. The failed host run is
  retained as provider-gemini-exhaustion-host-r127/host-full-green.log/.exit;
  its filename does not make the failed result green.
- The corrected fixture checks immediate termination, no success-transport
  consumption, no failed-attempt byte revival, exact provider cooldown,
  an actual HTTP Gemini semantic recovery probe and its endpoint, then an
  independent successful request with unchanged contents, tools, function
  call/result history and generation settings.
- RUN/provider-gemini-exhaustion-host-r127/host-focused-r2.log/.exit: 1 PASS,
  exit 0. host-full-r3.log/.exit: all 21 Gemini integration cases PASS,
  exit 0. Formatting and diff checks pass.

This correction changes only the integration fixture and this evidence
document. Runtime Rust source, graph, profile, configuration and transport
implementation remain unchanged from b229. Existing author Server HTTP/WS,
installed-runtime and actual GCM evidence above retains its original source
binding; no new build or restart is claimed for this test-only correction.
Independent delta architecture review and exact new-head CI remain required
before PR367 can merge. REQ02 remains incomplete.

## Chat exhaustion fixture alignment, 2026-10-06 r141

Input HEAD e85e349fae42baa3c2192d9da63382108737e2e7. CI run
37539962026 reproduced two obsolete held-request recovery expectations in
openai_chat_relay_runtime_integration.rs. Current exhaustion terminates the
current request; independent recovery serves a fresh request. Product source
is unchanged by this fixture correction.

Fresh GCM worker r139 changed only that integration fixture. The frozen
singlefile-owner.patch SHA256 is
79ee278937af6ab416b0f00b95659863d357e2c4c5734393a01c1afe77db106f;
the tested file blob is 04bab34bb4aaadd9cd88dbb8e032e9b614de8147.
Worker compilation passed; sandbox loopback EPERM did not prove behavior.

The parent host ran the complete public runtime integration consumer:
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs
-p routecodex-v3-runtime --test openai_chat_relay_runtime_integration
-- --test-threads=1. All 45 cases passed, exit 0. Raw evidence:
RUN/provider-chat-exhaustion-fixtures-r139/host-full45-r141.log and .exit,
where RUN is the external dagpipe-parallel-foundation-20261005 worker run.
The two corrected cases retain typed six-node terminal disposition,
zero success-transport consumption by the exhausted request, real local HTTP
failed/successful semantic probes, exact-identity cooldown, and fresh-request
normal transport after recovery. No case was removed.

This delta changes only the fixture and this evidence document. Existing
installed-runtime acceptance remains bound to its original product source.
No new runtime build/install/restart is claimed for this test-only delta.
Independent architecture delta review and new-head CI are pending.
