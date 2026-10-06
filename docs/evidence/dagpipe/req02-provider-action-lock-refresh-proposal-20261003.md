# REQ02 Provider action caller lock refresh proposal

Status: proposed; no authorization record or audit lock has been changed.

## Concrete change

The lifecycle wrappers now carry the single request finalizer guard and delegate
to their resident execution functions. The provider error/recovery/permit/success
calls remain in those resident functions. The existing provider action map and
gate were synchronized with the actual callers; no provider policy, client
projection, transport behavior, or DAG node order was changed in this gate slice.

- Responses action callers: `execute_v3_responses_relay_runtime_resident`, in
  `hub_v1/responses_relay_runtime_inner.rs`.
- Shared Relay action callers: `execute_v3_relay_runtime_resident`, in
  `hub_v1/relay_runtime_core.rs`.
- The shared request-scope wrapper delegation is bound through its include file,
  `hub_v1/relay_runtime_core/request_scope.rs`.
- The gate still verifies the exact caller bodies and provider action edges.
  Wrapper calls cannot hide a missing resident call.

## Lock boundary

The project gate explicitly requires Jason manual authorization for changes to
this previously audited chain. The candidate author has not claimed that approval.

- Item: `chain:v3.provider_action_gate.mainline`.
- Lock owner: `docs/architecture/v3-architecture-audit-locks.yml`.
- Existing fingerprint:
  `sha256:78d79632e9ad17d590ec3c2f631ba01361706cea83a84914532e3e367c72531b`.
- Current mapped fingerprint reported by the verifier:
  `sha256:2c98f80e4310712b2cc10d509ec35bc7156c6ca457dd26adb2397fd8f2077231`.
- Proposed permission is limited to refreshing this caller synchronization lock
  and recording its real authorization. It does not waive implementation tests,
  real tool E2E, independent review, runtime acceptance, or merge gates.

## Evidence

- `.execution/req02-parent-mainline-r17.log`: caller surfaces synchronized;
  only this audited fingerprint remains rejected.
- `.execution/req02-provider-gate-parent-green-r13.log`: exact action edges pass.
- `.execution/req02-provider-gate-parent-fixtures-r13.log`: 59 forbidden
  mutations rejected, including wrapper masking of missing resident calls.
- `.execution/req02-parent-topology-r17.log`: topology passes, 403 checked Hub
  bindings after the three additional shared Relay caller anchors were updated.

Candidate is still the uncommitted REQ02 worktree at HEAD
`a9952cc748f417caa675025f20ae1e51323d0c79`; latest fetched origin/main is
`2fde74987ed8079c36961bd7bb0c8c07348cb4b9`. This proposal does not assert an
implementation review PASS or a delivered node.
