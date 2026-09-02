# V3 Provider Adaptive Health, Cooldown, Probe

## Goal

Unify provider-key health, cooldown, and recovery probe into one Rust-owned,
provider-owned state machine. A provider key enters cooldown after three
consecutive provider-health failures. Probe timing adapts to recent error rate
and observed recovery time. Control state stays in the typed health side
channel; it never enters request/response payload or protocol metadata.

## Current evidence

- `V3ProviderHealthStore` owns key health, cooldown, and probe state.
- `V3ProviderKeyHealthStore` is now a type alias/projection compatibility surface;
  it owns no state or persistence.
- `V3ProviderGlobalSubscriptionHealthStore` and `V3ProviderCooldownCoordinator`
  are retired; runtime probe orchestration enters `V3ProviderHealthStore`.
- `probe_backoff_ms` owns the fixed probe ladder 30s/1m/3m/15m/1h/3h, looping
  after the 3h step; `adaptive_probe_interval_ms` keeps error-rate and recovery
  EWMA diagnostics for the no-configured-policy cooldown-duration source.
- Managed runtime initialization loads the provider-owned cooldown pool before
  listener readiness; malformed state fails startup explicitly.

## Design decision

`V3ProviderHealthStore` is the single runtime owner. Its per-key state stores:

- consecutive provider-health failure count;
- bounded rolling/EWMA failure rate;
- bounded EWMA recovery duration;
- cooldown generation and probe-in-flight state;
- next probe deadline and last classified failure for diagnostics.

`routecodex-v3-error` continues to classify errors only. Runtime maps the typed
classification to one state transition. Virtual Router consumes availability
projection only. Probe transport remains in the existing provider probe owner.

Cooldown and probe use one deadline: a blocked key is unavailable until its
single `next_probe_at_ms`; only a successful probe clears the block.

## Adaptive policy

Defaults are bounded and deterministic:

- trigger: 3 consecutive provider-health failures (adaptive score to 0) for the
  same `(provider_id, auth_alias, model_id)` key block the key for every session;
  while the probe entry exists, only a successful probe (or an explicit operator
  removal) resurrects the key;
- cadence: fixed ladder 30s / 1m / 3m / 15m / 1h / 3h. The first probe is due
  30s after the block; each failed probe advances to the next step; after the
  3h step the ladder loops back to 30s.
- the adaptive score (`0.6 * failure_rate + 0.4 * recovery_factor`) is a
  diagnostic signal and, without a configured policy, the cooldown-duration
  source; it never reschedules the probe ladder;
- successful probe records recovery duration, resets streak, and removes
  cooldown state;
- state is persisted by the provider cooldown coordinator and loaded on managed
  restart; a ready-time startup probe is required before re-admission.

The score is a scheduling signal only. It never changes error classification,
retry policy, payload, provider credentials, or route semantics.

## Test design

White-box positive/negative pairs:

1. two failures remain available; third same-key failure blocks;
2. interleaved different keys do not combine; same-key different error codes do
   combine;
3. success resets consecutive streak; unrelated/session success cannot revive a
   different key;
4. no recovery history starts at 1m; fast recovery lowers the next score;
5. high error rate or slow recovery raises schedule through 5m/15m/1h/3h/5h;
6. failed probe keeps key blocked and reschedules; successful probe alone
   restores availability;
7. concurrent probe acquisition is single-flight; stale completion fails;
8. restart loads persistent cooldown and startup probes each loaded key once;
9. malformed/zero policy fails fast; no silent default or fallback;
10. typed state never appears in provider wire/client payload or metadata.

Required gates: provider-responses focused tests, runtime policy tests, config
contract tests, resource/module-boundary/payload-isolation gates, V3 build,
global install, managed restart, all configured listener health checks, and
same-entry live replay. DSH Review starts only after all gates pass.

## Implementation plan

### Acceptance criteria

1. Implementation lives only on branch `codex/v3-provider-adaptive-probe`.
2. Exactly one Rust owner manages provider-key health, cooldown, and probe state.
3. Same `(provider_id, auth_alias, model_id)` key enters cooldown after three consecutive provider-health failures.
4. Error-rate and recovery-time history affect the next probe deadline.
5. Intervals are bounded: `1m, 5m, 15m, 1h, 3h, 5h`.
6. Time expiry never restores availability; successful typed probe is required.
7. Failed probes keep the key blocked and reschedule from new score.
8. Different keys/sessions cannot combine counters or revive each other.
9. Classification stays in `routecodex-v3-error`; routing stays in Virtual Router; transport stays at probe boundary.
10. Health control state never enters request/response payload, provider wire, client body, or protocol metadata.
11. New state is persisted by the single provider cooldown coordinator;
    malformed state is not silently discarded.

### Scope

In scope: provider-responses health/probe state, runtime orchestration,
adaptive policy/config contract, focused tests, architecture maps/gates, and
verification evidence.

Out of scope: error classification meaning, unrelated retry policy, Virtual
Router ordering/default-pool policy, protocol conversion, credentials, live
provider config, and client payload/error projection changes.

### Technical plan

1. Make `V3ProviderHealthStore` the sole owner.
2. Store per-key streak, attempt/failure counters, failure-rate EWMA, recovery-duration EWMA, generation, probe deadline, and single-flight state.
3. Physically retire duplicate transitions in `V3ProviderGlobalSubscriptionHealthStore` and `V3ProviderCooldownCoordinator` after caller/dependency proof.
4. Keep one typed transition: `Error02Classified -> record failure -> score -> cooldown/probe deadline -> permit -> result -> history -> availability`.
5. Use one blocked/probe deadline; only successful probe clears generation.
6. Use bounded score `0.6 * failure_rate + 0.4 * normalized_recovery_time`; no recovery history starts at 1m; score bands select the ladder.
7. Validate all policy values at config compilation; malformed values fail fast.
8. Update resource/function/mainline/verification maps and generated wiki in lockstep.

### Target files

`v3/crates/routecodex-v3-provider-responses/src/{health.rs,key_health.rs,provider_cooldown_probe.rs,probe_backoff.rs,provider_global_health.rs,global_cooldown.rs}`;
runtime health/probe callers; config internal policy; focused Rust tests;
`docs/architecture/v3-{resource-operation-map,function-map,mainline-call-map,verification-map}.yml`;
related manifests/wiki.

### Verification matrix

- Red/green tests: threshold, key isolation, score, recovery timing, failed-probe reschedule, successful-probe-only recovery, single-flight, stale generation, restart reset, payload isolation.
- Focused provider-responses/runtime/config tests; touched Rust format and diff checks.
- Resource map, module boundary, function-map, mainline, side-channel, payload-boundary, and V3 architecture gates.
- Global V3 install, one aggregate `routecodex restart`, all configured listener health checks, same-entry real replay, canonical sample evidence.
- Only after all above pass: DSH Review. Review FAIL remains blocking; never bypass it.

### Risks and mitigations

- Duplicate owner leaves fixed cooldown: source/map red fixtures plus dependency proof before deletion.
- Metrics cross key/session: full provider-key identity plus process-local generation.
- Expiry revives provider: availability requires successful probe.
- Control leakage: typed side-channel only plus payload-isolation red fixtures.
- Dirty main tree contaminates evidence: dedicated clean worktree only; unrelated files untouched.

### Ordered execution

1. Refresh maps/source/evidence.
2. Add red tests.
3. Implement sole health owner.
4. Migrate adjacent runtime callers.
5. Delete duplicate owners after dependency proof.
6. Run focused tests, build, architecture gates.
7. Install, aggregate restart, health checks, same-entry live replay.
8. Inspect diff boundaries and update evidence.
9. Run DSH Review only now; any post-review code/config/test change invalidates PASS and requires verification/review again.

### Definition of done

Branch contains complete implementation, synchronized docs/maps/gates, passing
tests, build/install/restart/live evidence, and DSH `VERDICT: PASS`. Only then
may it enter merge review. No commit, merge, push, or claim release before
that evidence exists.
