# Direct / Relay cross-request provider error storm control plan

## 1. Goal and acceptance contract

Unify Direct, Relay, and Responses continuation provider-failure handling behind one
typed Rust policy and one cross-request action gate. Provider/runtime availability
errors must not reach the client while either the selected route pool or its explicit
default pool still has an eligible target.

The completed behavior must satisfy all of the following:

1. `Error04 -> Error05` is the only owner of retry, reselect, wait, exhaustion, and
   terminal projection decisions.
2. An isolated first provider failure blocks the next provider action for at least
   1 second.
3. Overlapping requests, queued waiters, or another provider failure before a
   successful response moves the scoped gate into sustained mode; each subsequent
   provider action is blocked for at least 5 seconds and only one action is admitted
   when the gate opens.
4. Direct, Relay, provider response decode/protocol failures, and Responses remote
   continuation all consume the same typed Error05 decision and shared gate.
5. Fresh normal requests do not consume an unrelated Error05 recovery lane. Only the
   current request's `WaitThenRetrySame` or `WaitThenReselect` transition may set the
   pending provider-action gate for its next attempt.
6. Error06 can only be constructed from a typed terminal Error05 decision proving:
   `routePoolRemainingAfterExclusion.is_empty() && !defaultPoolAvailable`.
7. `client_disconnect` remains health-neutral and does not reroute or project a
   provider 4xx. Client-input, unsupported protocol, deterministic configuration,
   and internal contract errors remain explicit non-provider error lanes.
8. No fallback, handler compensation, SSE repair, provider-specific Hub/VR branch,
   payload semantic trimming, or second policy center is introduced.

## 2. Scope

### In scope

- V3 Responses Direct transport and response-projection failure paths.
- V3 Responses/OpenAI Chat/Anthropic/Gemini Relay provider failure paths.
- Responses remote continuation provider affinity without policy bypass.
- V3 cross-request gate state, admission, health interaction, and observability.
- V2 Router Direct, Provider Direct, and Relay contract alignment with the same
  1-second/5-second semantics.
- Default-pool availability truth and terminal exhaustion proof.
- Traffic saturation as an explicit admission state, not an immediate provider
  reroute signal.
- Resource registry, function map, mainline call map, verification map, lifecycle
  manifest/wiki, architecture gates, tests, and live replay evidence.

### Out of scope

- Changing provider credentials, routing priorities, or model aliases to make tests pass.
- Repairing malformed provider payloads in Hub Pipeline, Virtual Router, handlers, or SSE.
- Treating malformed client input or internal configuration failures as provider failures.
- Adding a TS semantic implementation to llmswitch-core or V3.
- Reintroducing removed providers or changing normal request/response payload semantics.

## 3. Verified starting gaps

1. V3 Direct continuation transport and response-projection failures can return
   `error_output` before consuming the shared failure policy.
2. V3 waits are request-local `tokio::time::sleep`; no provider/group keyed
   cross-request gate prevents synchronized retry waves.
3. First Relay reselect and Direct reselect can execute with no wait.
4. Direct constructs `V3Error06ClientProjected` before terminality and reads a JSON
   decision string to decide whether to reselect.
5. Relay owns a separate `V3RelayProviderFailureDecision` and can project a pending
   old provider error when target resolution fails.
6. V2 runtime, maps, docs, and server help disagree between fixed 3 seconds, fixed
   5 seconds, and a `1s -> 2s -> 3s` cycle.
7. V2 waiter saturation can immediately emit `PROVIDER_TRAFFIC_SATURATED`.
8. V2 provider-direct currently declares one attempt, one provider, and no default tier.
9. Live `server-v3-5555.log` showed 69 `terminal_default_floor_exhausted` projections,
   commonly with `failure_count=1`, during one sustained malformed-SSE sequence.

These are starting evidence, not permission to patch the named callers independently.
Before implementation, re-open current sources and maps because the shared worktree may
have advanced.

## 4. Architecture and unique owners

### 4.1 Resource truth

Add or activate one machine-readable resource for the cross-request action gate before
changing runtime behavior:

```text
resource_id: error.provider_action_gate
key: server/routing-group + provider runtime identity + normalized error family
owner: Rust Error05 execution policy/runtime
truth: generation, mode, consecutive failures, FIFO waiter queue, next admission deadline,
       admitted generation, admitted permit owner
operations: record_failure, wait_for_admission, record_success, release_terminal,
            abandon_admission
```

This is a control side channel. It must never enter provider request bodies, client
responses, MetadataCenter, continuation payloads, snapshots used by live runtime, or
provider persistent state.

### 4.2 Typed Error05 decision

Replace string/JSON decision inspection and Direct/Relay-local enums with one typed
decision:

```text
WaitThenRetrySame
WaitThenReselect
ProjectTerminal
ClientDisconnected
RejectNonProviderError
```

Retry/reselect variants carry the gate key and admission generation. `ProjectTerminal`
must carry the route/default exhaustion proof. Only the terminal variant can be consumed
by the Error06 builder.

### 4.3 Gate state machine

- `Idle -> Isolated`: first scoped failure; earliest next admission is failure time + 1s.
- `Isolated -> Sustained`: a second failure arrives before success, or another request
  waits on the active gate; earliest next admission is latest failure time + 5s.
- `Sustained -> Sustained`: every additional failure advances the 5s deadline.
- A provider switch or a change in normalized error family inside an already active
  server/routing-group lane is still a subsequent failure and cannot restart at the
  isolated one-second delay.
- Only one request receives an admission permit per gate generation. Waiters must
  re-evaluate policy after wake-up; broadcasting all waiters into provider transport is
  forbidden.
- A fresh normal request does not inspect or consume an existing recovery lane. The
  current request enters the gate only after typed Error05 returns
  `WaitThenRetrySame` or `WaitThenReselect`.
- An admitted generation is owned by an explicit Rust permit. Wall-clock time is not
  cancellation evidence: a legal provider action or lazy SSE may exceed five seconds
  while retaining exclusive ownership. Provider success, provider failure, terminal
  commit, or permit drop/explicit abandon are the only release transitions.
- Permit drop/explicit abandon is health-neutral. It advances exactly one sustained
  generation, enforces a new five-second floor, and does not increment provider failure
  count or mutate provider health.
- A provider action that fails must release its caller-owned permit before entering or
  awaiting Error05 policy. Keeping the permit alive through terminal admission creates
  a circular wait: Error05 waits for ownership release while caller scope cannot release
  ownership until Error05 returns.
- A successful provider response resets consecutive-failure state. Resource cleanup TTL
  may remove an idle, waiter-free entry but must not create a semantic bypass.
- Cancellation removes only that waiter. `client_disconnect` must not mutate provider
  health or count as a provider failure.
- Terminal exhaustion advances the gate into a sustained generation and wakes existing
  waiters with a typed re-evaluation outcome. It must not remove the state as if success
  occurred, and it must not let an old selected target proceed directly to transport.
- Terminal Error06 projection is a gated provider action. It must consume an isolated
  one-second or sustained five-second admission before reaching the client. A success
  that resets the lane while a terminal projection waits forces the failed request to
  re-register its failure and wait again; it cannot release a stale error immediately.
- Fresh non-continuation requests do not consume old recovery state. Exact-pinned Direct
  continuation requests check the existing provider lane before resuming the pin; an
  absent lane is an immediate no-op, not a delay.

Use monotonic time. Do not hold a mutex across provider network I/O. Define bounded
resource cleanup, but a capacity limit must apply backpressure rather than emit a new
immediate reroute error.

### 4.4 Direct and continuation

Responses remote continuation may remain pinned when its protocol contract requires
provider affinity. Pinning changes the legal target set; it does not bypass Error01-05,
the shared wait gate, health recording, or terminal proof. Remove every direct
`error_output` path for provider/runtime availability errors that has not consumed a
typed terminal Error05.

### 4.5 Relay and target-resolution races

Relay must delete its duplicate provider-failure decision enum and consume the same
typed Error05 result as Direct. If reselect was chosen and target resolution then fails,
the resolution failure must enter its own correctly typed lane. It must not be replaced
with a stale pending provider error or force `candidates_remaining=0`.

### 4.6 V2 alignment

The new semantic owner must be Rust. Existing TS queue/executor code may remain only as
a thin bridge and I/O scheduler while migration is completed. Delete contradictory
delay sequences and expose one compiled 1s/5s contract to runtime, docs, maps, server
help, and tests. Provider-direct configuration must either provide a real explicit
default tier or fail configuration validation; it must not claim global reroute safety
while hard-coding `defaultTierAvailable=false`.

## 5. Expected source and contract surfaces

Confirm exact symbols from current maps before editing. Expected ownership surfaces are:

- `v3/crates/routecodex-v3-error/`
- `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs`
- `v3/crates/routecodex-v3-runtime/src/kernel.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs`
- Other V3 relay runtimes only through the shared Rust owner, without copied policy.
- `src/server/runtime/http-server/executor/request-executor-error-action-queue.ts`
  as a V2 thin bridge/migration surface, not a new semantic owner.
- `src/server/runtime/http-server/executor/request-executor-provider-failure-plan.ts`
- `src/server/runtime/http-server/direct-decision.ts`
- V2/V3 resource, function, mainline call, verification, manifest, and wiki registries.
- `docs/error-handling-v2.md` and
  `docs/goals/provider-error-reroutable-until-pool-and-default-empty.md`.

Do not edit all listed files by default. The implementation must first identify the
smallest unique owner and then physically remove duplicate/dead decision paths.

## 6. Test design

Red tests must be committed or otherwise preserved as failing evidence before runtime
implementation. Positive and negative cases must be paired.

### White-box state machine

- First failure admits no provider action before 1s.
- Second failure before success and an overlapping waiter both promote to 5s.
- Additional sustained failures extend the 5s deadline.
- Exactly one waiter receives each permit; no synchronized wake wave.
- A retry/reselect Error05 carries the exact gate key and recorded generation; a later
  failure for another provider/error family cannot replace that witness or redirect the
  waiter to the newest routing-group lane.
- A later failure in the same exact lane may coalesce the recorded generation into a
  newer sustained generation, but only through the original witness key; the consumer
  never performs a routing-group "latest lane" lookup.
- Success resets failure mode.
- Cancellation removes a waiter without changing health/failure count.
- An admitted action remains exclusive beyond five seconds while its permit is held.
- Explicit permit drop advances exactly one sustained generation after a new five-second
  floor, does not increase failure count, and does not permanently block later requests.
- Capacity pressure blocks or rejects in a non-reroutable admission lane; it never
  causes immediate provider pool scanning.

### Direct and continuation black-box

- Direct transport 401/403/429/5xx/timeout/malformed SSE with an alternative target:
  wait, reselect, return success, and never construct Error06 for the first failure.
- Direct response decode/projection provider failure follows the same result.
- Remote continuation preserves legal affinity but still waits and consumes Error05.
- Continuation with a failed/excluded pin follows the registered continuation contract;
  no direct projection or cross-protocol repair is allowed.
- With route and default candidates truly exhausted, Error06 is projected exactly once.
- A fresh Direct request bypasses an unrelated recovery lane, while the current
  request's retry/reselect attempt still consumes its own gate.

### Relay black-box

- Every supported Relay protocol uses the same 1s/5s gate and Error05 owner.
- Fresh Relay requests bypass unrelated recovery lanes; only a current-request
  retry/reselect attempt waits for admission.
- Target resolution race cannot project a stale pending provider error.
- Classifier, route-plan, target-expansion, and runtime/config target-resolution failures
  project their own typed Error01-05 source; only `V3TargetExhaustion` is authoritative
  route/default exhaustion evidence.
- Concurrent requests to one failing target are serialized and do not sweep the pool.
- A successful alternative response is not converted into an error.

### Contract and compile-fail gates

- Error06 builder rejects nonterminal Error05 at compile time.
- Direct/Relay-local failure decision enums and string decision inspection are banned.
- Provider errors cannot call Error06/error HTTP projection without terminal proof.
- Gate state cannot be placed in metadata, normal payload, continuation payload, or
  provider persistent health files.
- Maps cover every source file exactly once and real import/call edges match registries.
- Maps explicitly cover `ProviderRespInbound01Raw -> provider event codec ->
  response.completed | provider failure/Error05`; deleting either Direct or Relay
  provider-terminal parser edge must fail the machine gate.
- `response.done` and `[DONE]` remain client/transport projection only and cannot trigger
  provider semantic success, Stopless response governance, continuation mutation, or
  provider permit success.
- Required gates are connected to CI/build, not merely documented.

### Live controlled matrix

Use controlled upstream fixtures and the normal installed aggregate server path. Cover
401, 403, 429, 500/502/503/524, timeout, malformed SSE, response decode failure,
success-after-switch, still-running/nonterminal, already-terminal, and client disconnect.

Capture timestamps, request IDs, provider attempts, gate generation/mode, wait duration,
pool/default exhaustion proof, and client status. Run a concurrent burst proving:

- first action delay is at least 1s;
- sustained actions are at least 5s apart;
- only one provider action is admitted per generation;
- no provider error reaches the client before both pools are exhausted;
- terminal exhaustion produces one bounded client projection, not a response storm.

Do not trim real request or response semantics to make the replay faster.

## 7. Implementation order

1. Refresh `.agent-collab`; resolve or hand off the existing
   `gate_id:v3_p0_error_state_machine_unification` claim before overlapping edits.
2. Search MemoryPalace, then open resource/function/mainline/verification maps and current
   source. Mark stale or pending map entries explicitly.
3. Add the test-design document/manifest bindings and preserve minimal red evidence.
4. Add the Rust gate resource and paired state-machine tests.
5. Make Error05 typed and make Error06 terminal-only at the type boundary.
6. Route V3 Direct transport, response projection, continuation, and Relay through the
   unique policy/gate; physically delete duplicate decision paths.
7. Align V2 thin bridges, default-pool configuration truth, saturation lane, docs, and
   server help with the same compiled 1s/5s contract.
8. Run focused tests after each owner change, then architecture/build/workspace gates.
9. Build/install using the repository's canonical commands, restart the aggregate server
   exactly once through the approved locator, verify every member `/health`, and run the
   controlled live matrix plus an old malformed-SSE sample replay.
10. Update wiki/manifest/maps, `note.md`, `MEMORY.md`, and the reusable local skill;
    re-mine and verify retrieval when MemoryPalace is operational.
11. Run mandatory `codex --profile tcm review` with the prescribed review prompt.
    Resolve findings and repeat, up to five rounds, until semantic `VERDICT: PASS`.
12. Commit only task-owned files and preserve unrelated dirty worktree changes.

## 8. Risks and required safeguards

- A plain `sleep(5s)` per request does not prevent a wake wave; shared serialization is
  mandatory.
- A global gate would cause unrelated providers/groups to block each other; scope keys
  must be explicit and tested for isolation.
- Locking across network I/O can deadlock or collapse throughput; permits and state
  mutation must be short-lived.
- Provider health cooldown and action-gate delay are different resources. They may share
  classified evidence but cannot become duplicate policy owners.
- Continuation affinity cannot be silently discarded to obtain a successful reroute.
- Admission saturation cannot be mapped to provider failure or used to scan another pool.
- Existing active claims and dirty generated maps mean implementation should use a
  dedicated run/claim and precise patches, never checkout/reset cleanup.

## 9. Definition of done

The work is complete only when all of the following have evidence:

1. Direct, Relay, response decode, and continuation provider errors consume one typed
   Rust Error05 owner and one cross-request gate.
2. Positive and negative tests prove isolated 1s, sustained 5s, one-per-generation
   admission, explicit permit ownership/drop, fresh-request isolation, success reset,
   cancellation neutrality, and scope isolation.
3. Error06 is structurally impossible before typed terminal exhaustion.
4. Route/default alternatives are exhausted before any provider error projection.
5. V2 and V3 docs, runtime values, maps, help output, and tests expose one 1s/5s truth.
6. Focused tests, architecture gates, compile-fail gates, builds, and relevant workspace
   suites pass.
7. Installed aggregate live replay proves the full error matrix and concurrent burst
   behavior; old malformed-SSE reproduction no longer creates an error storm.
8. Required gates are wired into CI/build.
9. Mandatory Codex review reaches an unambiguous PASS with no P0/P1 blocker.
10. Evidence, project memory, local skill, and a precise task-only commit are complete.
