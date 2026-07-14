# V3 Virtual Router and Target Interpreter Plan

## Objective and acceptance

Complete P5 by implementing the Rust-only Virtual Router and Target Interpreter on top of the completed P0-P4 foundation, without sending an upstream Provider request.

Acceptance requires every request to resolve its listener route group, enter Virtual Router exactly once, select one opaque target, and remain inside Target interpretation until one concrete provider/auth/model candidate is selected or the entire selected target is exhausted. A route group must always expose a non-empty `default` pool. Provider availability is consumed through the P4 read-only projection; only the Target Interpreter may perform target-local reselection.

## Scope

In scope:

- listener-to-route-group resolution from the compiled V3 manifest;
- the initial `default` request classification required for Responses direct;
- one-shot Virtual Router target selection;
- typed opaque target references and route-selection evidence;
- recursive Target interpretation for concrete Provider targets and Forwarder targets;
- nested Forwarder expansion with the Config compiler's validated acyclic graph;
- priority, weight, and round-robin policies at the target level where they are declared;
- Provider availability queries at provider-instance, auth-key, and canonical-model scopes;
- target-local retry/reselection after a candidate failure or unavailability result;
- explicit `TargetPoolExhausted` escape into the P4 Error chain;
- deterministic state, fixtures, maps, Wiki, source gates, compile-fail tests, and CLI-visible diagnostic validation.

Out of scope:

- P6 Responses input/output normalization, Provider wire building, secret resolution, transport, JSON/SSE parsing, and `/v1/models`;
- any real upstream Provider request;
- additional request classifications beyond the first Responses-direct/default slice unless already required by the frozen Config contract;
- generic Anthropic, Gemini, OpenAI Chat, relay, continuation, servertool, or dynamic hooks;
- Virtual Router access to Provider health state or mutation APIs;
- returning from Target interpretation to Virtual Router while the selected target still has candidates;
- V2 compatibility, TypeScript runtime logic, fallback paths, or changes to live `~/.rcc` configuration.

## Design principles

1. Runtime owns the complete lifecycle. Virtual Router and Target Interpreter are typed adjacent nodes inside that lifecycle, never independent request lifecycles.
2. Virtual Router selects exactly one opaque target and never interprets Provider, auth, model, Forwarder membership, health, retry, or cooldown semantics.
3. Target Interpreter owns recursive target expansion and all selection below the selected opaque target. Internal failure is transparent to Virtual Router.
4. The only return from Target interpretation to the outer lifecycle is a concrete selected candidate or explicit full-target exhaustion.
5. Provider owns health truth. Target consumes only an immutable availability projection and cannot import or invoke health mutation APIs.
6. Config remains declaration-only. Runtime policy interpretation belongs to the owning routing/target modules; no module rereads `config.v3.toml`.
7. Priority, weight, and round-robin are deterministic under an explicit selection context. Randomness, counters, and clocks must be injectable and testable.
8. Every mainline node has one owner and every conversion is adjacent. No handler, Server, Debug, Error, or Provider shortcut may duplicate selection logic.
9. `default` is a mandatory explicit pool, not a hidden fallback. Selecting it is normal declared routing behavior; exhaustion remains an error.
10. Static hooks may observe registered nodes but cannot alter the fixed lifecycle topology or create dynamic routing branches.

## Technical design

### Lifecycle nodes

The P5 mainline must bind real Rust symbols to the existing V3 node IDs and add no shortcut edges:

```text
normalized request / listener scope
  -> route-group resolution
  -> request classification
  -> Virtual Router one-shot opaque target selection
  -> Target recursive interpretation
  -> concrete provider/auth/model candidate selection
  -> P6 provider terminal placeholder
```

Failure remains adjacent to the P4 error chain:

```text
candidate failure or unavailable projection
  -> Target-local action
  -> Target-local reselection while candidates remain
  -> TargetPoolExhausted only when the selected target is fully empty
  -> Error exhaustion/execution/client projection
```

### Virtual Router owner

The Virtual Router module must:

- consume a typed request classification, listener/server identity, and compiled route-group declaration;
- resolve exactly one route pool, initially the explicit `default` pool;
- select exactly one opaque target reference according to that pool's declared policy;
- emit a route decision containing stable IDs and selection evidence, not expanded Provider data;
- expose a one-hit counter/event suitable for Debug assertions;
- have no dependency on Provider health stores, availability projection, Provider wire types, or transport.

It must not recursively expand Forwarders, select credentials/models, retry candidates, or re-enter itself after selection.

### Target Interpreter owner

The Target Interpreter module must:

- consume the opaque target selected by Virtual Router;
- resolve a concrete Provider target directly or recursively expand a Forwarder target;
- interpret priority, weight, and round-robin only at the level where each policy is declared;
- track visited target IDs defensively and fail explicitly if a cycle reaches runtime despite Config validation;
- query Provider availability through the P4 read-only interface;
- return a concrete selection containing provider instance ID, auth handle ID, canonical model ID, base URL reference, and selection evidence;
- retain the selected target context across candidate failures so reselection never returns to Virtual Router;
- emit `TargetPoolExhausted` only when no candidate remains anywhere inside the selected target.

### Policy semantics

- Priority: examine tiers in ascending configured priority order; do not visit a lower tier while an available candidate remains in a higher tier.
- Weight: choose from the current eligible set using normalized positive configured weights and an injected deterministic sampler; zero/invalid weights must already be rejected by Config or fail explicitly at the contract boundary.
- Round-robin: maintain process-local cursor state keyed by the stable target/pool identity, with concurrency-safe increment and deterministic fixture reset.
- Single target/name mapping: resolve without inventing a second policy layer; canonical model identity and upstream model alias rules remain those compiled by Config.
- Nested Forwarder: each nested collection is one target to its parent. Its internal selection is transparent after the parent has selected it.

### Resource ownership

The resource registry must declare, at minimum:

- request classification;
- listener route-group binding;
- opaque route target decision;
- target interpretation context;
- eligible candidate set;
- deterministic policy state/sampler input;
- concrete provider/auth/model selection;
- target exhaustion fact;
- Provider availability projection dependency.

For every resource, document `resource_id`, sole owner, truth/projection classification, allowed operations, required intermediaries, forbidden direct relationships, and verification gates.

### Expected file surface

Exact paths and symbols must be discovered and anchored before implementation; do not fabricate bindings. Expected owner surfaces are:

- `v3/crates/routecodex-v3-virtual-router/`: classification and one-shot opaque target selection;
- `v3/crates/routecodex-v3-target/`: recursive expansion, policy evaluation, availability query, and local reselection;
- `v3/crates/routecodex-v3-runtime/`: adjacent orchestration and the P6 no-send terminal placeholder;
- `v3/crates/routecodex-v3-provider-responses/`: read-only availability implementation only; no transport call;
- `v3/crates/routecodex-v3-debug/`: static node/event/snapshot registration only;
- `v3/crates/routecodex-v3-error/`: consume target exhaustion facts through existing adjacent builders;
- V3 resource, function, mainline, verification, lifecycle manifest, Wiki, and test-design documents;
- architecture/source/compile-fail gates and deterministic fixtures.

If the repository uses different canonical crate names, update this section and the maps to the discovered truth before adding code.

## Risks and controls

| Risk | Control |
| --- | --- |
| Virtual Router is called again after candidate failure | typed one-shot route token, runtime hit assertion, negative integration fixture |
| Virtual Router starts interpreting target internals | opaque target decision type and dependency/source gate |
| Target mutates Provider health | read-only trait surface, crate dependency gate, compile-fail fixture |
| `default` becomes an implicit fallback | require explicit compiled pool ID and reject synthesized/default-on-error branches |
| Forwarder recursion creates a second lifecycle | one Target interpretation context and adjacent recursion inside its owner |
| Nested target failure escapes too early | exhaustion proof containing all visited eligible members and positive/negative reselection tests |
| Priority/weight/round-robin is nondeterministic | injected sampler/cursor context and stable fixtures |
| process-local round-robin state leaks across pools | cursor key includes stable route-group/target identity; cross-pool isolation test |
| Debug/Error carries routing truth | side-channel-only projections and serialization/dependency gates |
| P6 transport is accidentally activated | no-send terminal effect, mock transport panic/counter, source gate forbidding send invocation |
| duplicate selection logic appears in Runtime or Server | owner registry, function map, source scan, and call-map adjacency gate |

## Test plan

### White-box

- listener identity resolves exactly one configured route group;
- first-slice classification resolves the explicit `default` pool;
- Virtual Router selects one opaque target and increments its hit evidence once;
- concrete target interpretation returns the configured provider/auth/canonical-model identity;
- single-member Forwarder performs name mapping without extra lifecycle entry;
- nested Forwarders expand in declared hierarchy and reject runtime cycles explicitly;
- priority selection stays in the highest eligible tier;
- weighted selection follows deterministic sampler fixtures and excludes ineligible candidates;
- round-robin advances deterministically and remains isolated across target/pool keys;
- Provider availability projections for provider/auth/model scopes exclude only the affected candidates;
- target-local reselection preserves the original opaque route decision;
- full exhaustion emits one typed exhaustion fact and no concrete selection.

### Positive/negative pairs

- available default candidate / empty default pool contract rejection;
- one Virtual Router hit / attempted Virtual Router re-entry rejected;
- concrete target selected / unknown target reference rejected;
- nested Forwarder resolves / cyclic or dangling expansion rejected;
- high-priority candidate available / high tier exhausted then lower tier selected;
- positive weights selected / zero, negative, or empty eligible weight set rejected;
- round-robin progresses / separate pools do not share cursor state;
- one candidate unavailable then sibling selected / all internal candidates unavailable then exhaustion;
- target reads availability / target health mutation import fails to compile;
- Router selects opaque target / Router Provider-health dependency fails the gate;
- target exhaustion remains an error / no error is projected as success;
- P6 terminal placeholder reached / Provider transport send count remains zero.

### Module blackbox

- compiled Config manifest feeds Runtime without a second file read;
- a controlled request traverses Server/Runtime/Debug, hits Virtual Router once, resolves a nested target, and stops at the typed P6 placeholder;
- a controlled candidate failure triggers Error planning and Provider-owned health action execution, then Target-local reselection without Virtual Router re-entry;
- full selected-target exhaustion traverses all six P4 Error nodes;
- Debug snapshots show ordered P5 nodes without storing secrets or becoming business truth.

### Project blackbox

- build the actual V3 CLI;
- start the dedicated multi-listener fixture without touching V2 or live `~/.rcc` configuration;
- submit controlled Responses-shaped requests to both listeners;
- inspect Debug evidence for route-group identity, one Virtual Router hit, Target expansion, and P6 no-send terminal effect;
- exercise deterministic direct, Forwarder, priority, weight, round-robin, unavailable-candidate, and fully-exhausted fixtures;
- prove no upstream socket/request is opened;
- stop the exact CLI process with Ctrl-C and verify both fixture ports close.

## Implementation order

1. Refresh `.agent-collab`, claim the P5 feature/resources, and inspect MemoryPalace, resource map, function map, mainline call map, mainline source, verification map, and lifecycle Wiki.
2. Update the resource registry, function map, mainline call map, lifecycle manifest, verification map, Wiki, and this test design with real owner paths and node IDs.
3. Add red architecture/source/compile-fail gates for one-shot routing, opaque target boundaries, read-only availability, adjacent calls, no P6 send, and no duplicate owners; capture the red evidence.
4. Implement typed request classification and listener route-group binding.
5. Implement the Virtual Router's single opaque-target selection and static Debug hooks.
6. Implement Target interpretation for concrete and nested Forwarder targets.
7. Implement deterministic priority, weight, and round-robin policy helpers in their unique shared owner.
8. Bind the P4 Provider availability projection and implement Target-local reselection/exhaustion without Router re-entry.
9. Connect the result to the typed P6 no-send terminal placeholder and the existing Error chain.
10. Run formatting, clippy, unit/module/project tests, architecture review, actual CLI multi-port blackboxes, memory/evidence closeout, and an independent diff review if the collaboration protocol requires it.

## Definition of done

- P5 resources, owners, symbols, mainline edges, lifecycle manifest, Wiki, test design, and verification gates agree and are machine-checked.
- every controlled request resolves one listener route group and enters Virtual Router exactly once;
- Virtual Router returns only one opaque target and has no Provider-health or target-expansion dependency;
- Target Interpreter recursively resolves concrete/Forwarder targets and applies deterministic priority, weight, and round-robin policies at the declared level;
- Provider availability is read-only outside Provider, and target-local reselection never re-enters Virtual Router;
- the selected target returns one concrete provider/auth/canonical-model candidate or one explicit full-target exhaustion error;
- default pool selection, nested targets, cross-scope isolation, success/failure/non-terminal/already-terminal behavior, and all negative boundary tests are evidenced;
- the real V3 CLI multi-listener fixture demonstrates P5 routing and the P6 no-network terminal placeholder;
- P6 Provider transport and all P7 protocols/relay remain unimplemented and no upstream request is sent.
