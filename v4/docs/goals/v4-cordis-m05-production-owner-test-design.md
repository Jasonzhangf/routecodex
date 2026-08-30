# M05-R01 Cordis production execution owner test design

Status: `red_first`.

## Lifecycle

```text
Cordis compiled ExecutionEpochBundle
  -> PrepareEpoch
  -> Rust candidate validation/smoke
  -> CommitEpoch
  -> ActiveEpochStore active pointer
  -> request admission RuntimeLease/EpochLease
  -> ExecutionEngine
  -> leased NodeContainer plan
  -> HandleRegistry
  -> adjacent NodeExecutionFrame
  -> terminal/failure
```

Cold start owns `ActiveEpochStore::empty()`. Before the first valid Cordis commit, business admission fails closed. Commit changes only the active pointer; an admitted request retains its original immutable bundle until terminal/drop.

## White-box contracts

1. Runtime startup cannot construct, publish, or activate a production `NodeContainer`.
2. Runtime cannot own a `NodeSpec`/chain/plugin-id dispatch graph or sort compiled plans.
3. Cordis cold-start prepare uses an explicit empty base and commit publishes the exact validated candidate.
4. `ActiveEpochStore` supports first commit, later stale-base detection, abort, drain, rollback, and old-lease retention.
5. `ExecutionEngine` consumes the admitted `EpochLease`; each node executes through the lease-bound `NodeContainer` and the single `HandleRegistry`.
6. Node output data/control becomes the adjacent input. Control resources never enter normal payload.

## Module black-box contracts

- Current production source must fail architecture gates while it contains local `ActiveEpochStore::new`, runtime `NodeContainer::declare/publish`, `NodeSpec.plugins`, `execute_local_plugin`, or a request path that does not consume `EpochLease::execute`.
- Removing any adjacent edge in `Cordis CommitEpoch -> ActiveEpochStore -> request admission -> ExecutionEngine -> EpochLease execute` must fail.
- Missing handle, stale base, hash drift, duplicate transaction mismatch, no active epoch, disposed epoch, and undeclared node must fail explicitly.
- Positive execution proves exact Cordis order, one execution per node, adjacent frame propagation, and same lease identity through terminal.

## Project black-box contracts

- Managed V4 starts with a Cordis-committed epoch or reports not-ready; it never manufactures a local graph.
- Chat and Responses JSON/SSE use the same committed epoch and emit no internal control fields in provider/client payload.
- Publish/drain/rollback during an in-flight stream affects only new admissions.

## Required gates

- `v4_parity_gate_execution_binding` plus red self-test.
- `v4_parity_gate_node_graph` plus red self-test.
- `v4_parity_gate_cordis_host` plus red self-test.
- node-container epoch and NodeContainer positive/negative tests.
- runtime ExecutionEngine/runtime/runtime-bin tests.
- resource/function/mainline/verification map gates and plane-isolation gate.
- release build, global install, `rccv4 restart`, 5520 health, Chat/Responses JSON/SSE live replay, then AGY Review.

## Known non-goals

- No local/relay continuation restoration.
- No Cordis per-request, per-node, or per-SSE-frame interpretation.
- No runtime-bin router/provider/health refactor in this M05 slice except wiring required to consume the committed epoch; broader orchestration shrink remains the following milestone.
