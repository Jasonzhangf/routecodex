# V3 Virtual Router Full-Function Completion Plan

## Objective

Complete the V3 Virtual Router routing-decision surface while preserving the fixed Hub lifecycle:
consume typed request facts plus the published Config manifest, resolve the listener routing group,
evaluate route-pool matches, compile the matched pool plus the mandatory default floor into one
opaque selection plan, and perform exactly one visible target hit. Target expansion, provider/key
availability, provider failure handling, retry, cooldown, and client error projection remain outside
Virtual Router.

## Current evidence and known gaps

- P5 already proves listener routing-group resolution, explicit non-empty `default` pool, priority,
  weighted and round-robin target selection, a non-clone one-hit pool token, and one opaque target
  result.
- Target Interpreter already proves nested forwarder expansion, provider-owned availability reads,
  Target-local candidate reselection, and full exhaustion without Virtual Router re-entry.
- Current Runtime always calls `resolve_default_pool`; request facts are recorded but do not select a
  non-default route pool.
- Current Config route-pool types do not yet expose the complete pool-match declaration surface.
- The complete path must satisfy both contracts: Virtual Router hits once, and a matched optional
  pool cannot cause final exhaustion while the mandatory default floor still has selectable content.

## Scope

### In scope

- Typed request facts used by routing: listener/server ID, routing group, entry protocol, requested
  client model/alias, declared feature/capability requirements, and other contract-approved routing
  facts already present in the normalized request or internal control carrier.
- Deterministic route-pool match declarations compiled by Config and consumed read-only by Virtual
  Router.
- Match evaluation, precedence, ambiguity rejection, and explicit no-match behavior.
- Mandatory non-empty `default` pool as the routing floor for every routing group.
- A single immutable route-selection plan that captures the matched optional tier, default floor,
  selection policy, and opaque targets before the one visible hit.
- Priority, weighted, and round-robin selection with deterministic tests and isolated cursor state.
- Exactly one `V3Router06... -> V3Router07...` consumption; the one-shot token cannot be cloned or
  reused for a second hit.
- A typed handoff to Target Interpreter that contains opaque target identity and tier provenance but
  no expanded providers, keys, health state, or provider-specific semantics.
- Explicit typed routing errors for missing/disabled server, missing routing group, malformed or
  ambiguous match declarations, impossible match facts, empty required floor, and selection-plan
  exhaustion.
- Resource/function/mainline/verification map bindings, Wiki review surface, red fixtures, focused
  tests, Runtime integration tests, and controlled CLI routing probes.

### Out of scope

- Target graph expansion or provider/model/key candidate construction.
- Provider availability reads, health mutation, cooldown, quota, concurrency, retry, or error
  classification.
- Provider transport, protocol conversion, request/response Chat Process, continuation, Relay, or
  servertool execution.
- Provider-family/ID/model-prefix routing branches.
- V2 compatibility mode, `~/.rcc` migration, global install, production replacement, Hub v1
  cutover, or P6 deletion.

## Routing contract

```text
V3HubReqChatProcess04Governed / current normalized P6 request facts
  -> VR classify listener and routing group
  -> evaluate all declared non-default pool matches
  -> choose zero or one matched pool deterministically
  -> combine matched optional tier + mandatory default floor into one immutable selection plan
  -> consume the one-shot plan exactly once
  -> emit one opaque target handoff
  -> Target Interpreter expands/reselects internally
```

Rules:

1. No match selects the default floor; it is not an error and does not use a fallback code path.
2. Multiple equally valid matches are rejected unless the Config contract provides an explicit,
   deterministic precedence that resolves them before runtime.
3. The default floor is part of the original selection plan. It is not obtained by re-entering
   Virtual Router after a provider or target failure.
4. Virtual Router never sees provider health, auth-key state, provider errors, retry counts, or
   expanded Forwarder members.
5. Target failure can only continue inside the already selected opaque target plan. It cannot ask
   Virtual Router to classify or hit again.
6. If the selected optional tier and default floor reference the same semantic target, the compiled
   plan must deduplicate it deterministically without changing declared order or weight semantics.
7. Request protocol payload fields remain data-plane facts. Internal route decisions and selected
   tier identity remain typed control resources and must not be written into provider/client bodies.

## Implementation order

1. Refresh collaboration claims and coordinate the Config pool-match schema handoff with the active
   Config/Server worker.
2. Audit the V2 routing/config source only as behavior evidence; write a field-by-field V3 match and
   precedence contract before changing runtime code.
3. Update V3 resource map, function map, mainline call map, test design, and verification map with
   honest `binding_pending` entries for new match/selection-plan resources.
4. Add red fixtures for missing default floor, ambiguous matches, provider-specific branches,
   health access from VR, second-hit reuse, direct Target expansion, silent no-match fallback, and
   Server-local route selection.
5. Implement shared pure match predicates and deterministic ordering helpers in the unique shared
   Rust owner; Virtual Router module only orchestrates them.
6. Implement typed pool-match evaluation and immutable optional-plus-default selection-plan build.
7. Preserve the one-shot non-clone hit token and emit exactly one opaque target handoff.
8. Integrate the plan with the existing Target Interpreter without moving candidate expansion,
   availability, error, or retry semantics into Virtual Router.
9. Add positive/negative unit, module blackbox, Runtime blackbox, and actual V3 CLI routing probes.
10. Promote map bindings only for verified symbols and adjacent caller/callee edges; run architecture
    review and record evidence before handoff.

## Test design

### Positive

- No non-default match selects the default floor with one VR hit.
- One protocol/model/feature match selects the declared pool and captures the default floor in the
  same immutable plan.
- Priority selection chooses the lowest declared priority deterministically.
- Weighted selection respects positive weights with deterministic samples.
- Round-robin advances only within its routing-group/pool identity and does not cross listeners.
- Nested Forwarder target remains opaque to VR and expands only in Target Interpreter.
- Failure of the first internal provider causes Target-local reselection without a second VR hit.
- Optional-tier exhaustion can continue through the already captured default floor without VR
  re-entry; final exhaustion occurs only when the whole captured plan is empty.

### Negative

- Missing/empty default floor fails Config/startup validation.
- Ambiguous equal-precedence pool matches fail explicitly.
- Malformed routing facts fail explicitly and do not silently select another pool.
- Unknown client model/alias follows the declared no-match/default contract; it is not repaired or
  rewritten by VR.
- A second attempt to consume the route-selection token fails at compile time or is impossible by
  visibility/type construction.
- VR cannot import Provider availability/health/error modules or inspect provider IDs/families.
- Target cannot call Virtual Router after the opaque handoff.
- Selected route/tier/control metadata never appears in provider wire payload or client response.

## Required verification

- Focused Config pool-match declaration tests owned by the Config/Server worker or accepted handoff.
- Virtual Router unit tests for matching, precedence, default floor, priority, weighted,
  round-robin, deduplication, and one-shot consumption.
- Target/Runtime integration tests proving one VR hit across success, provider failure, optional-tier
  exhaustion, default-floor continuation, and total exhaustion.
- Compile-fail tests for second hit, VR health imports, Target -> VR re-entry, and Server route
  selection.
- Controlled V3 CLI multi-listener probes showing listener-specific routing groups and exact route
  decisions without Provider-family conditions.
- `npm run verify:v3-architecture-docs`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run verify:v3-rust-only`
- `npm run test:v3-source-gate-red-fixtures`
- `npm run test:v3-compile-fail`
- `npm run test:v3-p5-router-target`
- `npm run test:v3-p5-server-blackbox`
- `npm run test:v3-responses-direct-blackbox`
- `npm run test:v3-vr-full-function-cli`
- `npm run verify:v3-cargo-fmt`
- `npm run verify:v3-clippy`
- `npm run test:v3-workspace`
- `npm run build:v3-cli`

## Completion definition

- Every request resolves one listener routing group, evaluates the declared match rules, builds one
  immutable optional-plus-default selection plan, and consumes that plan exactly once.
- Default is always present as the routing floor and is not implemented as a second VR pass or
  runtime fallback branch.
- Virtual Router emits only an opaque target handoff; Target alone expands and reselects candidates.
- Provider health/error/retry semantics remain outside VR, and Hub/VR contain no Provider-specific
  conditions.
- Positive and negative tests prove success, no-match/default, ambiguous match, provider failure,
  optional/default exhaustion, total exhaustion, and second-hit prevention.
- This phase does not claim Relay, continuation, other protocol Provider execution, Hub v1 cutover,
  P6 deletion, global install, or production replacement.

## V2 source audit and V3 field contract

V2 is evidence for user-visible routing behavior, not an implementation template. Its current
selection engine mixes route classification, Provider Registry access, Forwarder expansion,
availability, health, cooldown and instruction handling. V3 must preserve only the declaration and
selection semantics below while retaining the stricter VR/Target/Provider owners defined above.

| Concern | V2 source evidence | V3 contract |
| --- | --- | --- |
| Listener isolation | `routePolicyGroup` filters pools and rejects untagged pools for an explicitly requested group | server manifest resolves exactly one routing group before pool matching; round-robin cursor includes server/listener identity |
| Route identity | classifier produces a route name and always includes `default` as the floor candidate | non-default pools carry explicit match declarations; `default` has no match predicate and is always captured in the first plan |
| Pool ordering | tiers carry stable ID and priority; V2 parsing sorts tiers deterministically | every non-default match has explicit precedence; equal best precedence is an ambiguity error |
| Pool policy | tier `mode` and load-balancing policy select priority/weighted/round-robin behavior | one closed `selection.strategy` enum is compiled by Config and consumed by shared Rust selection functions |
| Targets | a pool contains ordered opaque target references | VR preserves target opacity and declared order; Forwarder/provider expansion belongs only to Target Interpreter |
| Weights | weights are pool-local selection inputs | weighted mode requires positive compiled weights and deterministic sample selection |
| No match | V2 route queue eventually reaches `default` | V3 no-match selects the already captured mandatory default floor as a normal result, never as error fallback |
| Primary exhausted | V2 has a separate primary-to-backup plan owner | V3 captures optional plus default in one immutable initial plan; Target consumes remaining tiers without VR re-entry |
| Availability | V2 selection reads Provider Registry, health, exclusions and cooldown | prohibited in V3 VR; Target/Provider/Error owners consume availability and failure state after the opaque handoff |
| Forwarder | V2 expands Forwarders during selection | prohibited in V3 VR; nested expansion and internal reselection remain Target-only |

The V3 Config handoff must compile this minimal pool-match declaration:

- `precedence`: explicit integer used only to order matching non-default pools; lower values win and
  only an equal best value is ambiguous;
- `entry_protocol`: optional closed protocol predicate (`responses`, `anthropic`, `gemini`,
  `openai_chat`);
- `models`: optional non-empty set of client-visible model IDs or aliases;
- `required_capabilities`: optional non-empty set whose entries must all be present in typed request
  facts;
- `min_input_tokens` / `max_input_tokens`: optional inclusive range over the deterministic request
  token estimate.

At least one predicate is required for every non-default pool. The `default` pool cannot declare
match or precedence. Provider ID, Provider family, key, health, quota, cooldown, retry, transport,
Forwarder members and runtime error state are not legal match fields. Unknown fields remain a hard
Config parse failure through `deny_unknown_fields`.

The accepted Config handoff is implemented by `V3RoutePoolMatchAuthoringConfig` and compiled into
`V3RoutePoolMatchManifest`. Config rejects a `default` match declaration, a non-default pool without
`match`, a missing explicit precedence, an unknown entry protocol, duplicate/unknown capabilities,
an empty predicate set, and an inverted token range. Config remains declaration-only: request fact
evaluation and precedence selection occur only inside Virtual Router.
