# REQ04 Target expansion foundation delivery

## Scope and source

This increment extracts the existing Target expansion owner into
`expand_v3_relay_target_candidates_from_opaque_hit`. The existing coordinator
consumes its typed result. The former inline implementation is removed.
It does not register or connect the full REQ04 Operator; formal node cutover
still follows REQ02 and REQ03.

Source checkpoint: `f3ab684deb419fef4fa3b21a81d272ccfcbea600`.
Base: `a678733c3d20c1e5bd1949f5a9e6e83042f41ca2`.
The next documentation commit changes no executable source or input fixture.

## Owner and behavior

The helper consumes the real `V3Router07OpaqueTargetHitOnce`, manifest and
deterministic sample. The existing Target interpreter produces
`V3Target09CandidateSetExpanded`. Expansion errors preserve the existing
stage, code and error source. Routing classification, health, selection,
execution mode, payload and tool mapping remain in their current owners.

The fixed request/response/error graphs and approved design are unchanged:
`docs/architecture/dagpipe/v3.operation_runner.{request,response,error}.graph.json`
and `docs/goals/dagpipe-req03-09-typed-boundary-design-20261005.md`.
This helper is preparation for the REQ04 node in that design.

## Author evidence

Evidence directory:
`/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/req04-target-owner`.

- `parent-policy.log/.exit`: 71/71, exit 0.
- `parent-public-routing.log/.exit`: public runtime routing consumer 7/7, exit 0.
- `parent-http.log/.exit`: actual aggregate HTTP success and failure 2/2,
  exit 0. Ordered provider selection preserves tool payload. Route failure
  keeps its typed diagnostic without a client Provider error body.
- `parent-build.log/.exit`: official CLI build 4836, exit 0. Source owner delta
  was transferred byte-for-byte into this latest-main candidate. The later
  fixture-only change does not alter the executable build source.
- `resumed-*.log/.exit`: affected architecture/map/admission and protocol
  compile-fail checks; applicable green receipts remain in the directory.
- `final-parity.log/.exit`: full public Responses-to-Chat runtime parity
  suite, 13/13, exit 0, with the final isolated typed auth fixture.
- `checkpoint.log/.exit`: normal protected Git hook and affected Rust compile
  PASS, exit 0. This is an author checkpoint, not merge evidence.

Parity diagnosis evidence is in the sibling `parity-session-isolation` directory.
Both clean main and this extraction failed the original full suite but passed
the single filtered case. The first divergence was Target exhaustion before
provider send. Independent fixture auth identities passed three full runs;
restoring the shared identity failed three runs. The final test changes only
typed authoring auth alias and target key. It retains all original assertions
and uses neither serialization nor product-state resets.

## Delivery boundary

The real aggregate HTTP harness covers this owner extraction's affected public
success and failure behavior. There is no new transport or tool conversion.
No default runtime installation or production restart is part of this narrow
foundation increment; no production-loaded-binary claim is made. Actual
exec, native apply_patch and MCP execution remains mandatory for full Operator
cutover. Review, CI, integration, remote receipt and owned cleanup are pending
at creation of this record. They must be reported separately.
