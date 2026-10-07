# Debug shared-state fixture author evidence

## Exact source and scope

Base candidate: `b8d3de30e128f604c8bd3eb9134bd8f353c9bae7`.
Only the debug shared-state case and dedicated helper in
`v3/crates/routecodex-v3-server/tests/multi_listener_server.rs` changed.
Final source blob: `4149265a1ac15f2f9024802dced469f428522c37`.
No product code, runtime config, health algorithm, assertion policy or
production lifecycle changed.

## Cause and correction

The previous debug test required a live successful node snapshot from a
request that terminates before provider execution because its provider auth
key is absent. A Relay-only change did not fix that contract; the parent real
HTTP run still failed with snapshot_count 0.

The dedicated fixture now preserves that original no-response failure and
adds an independent declared Relay provider with its own auth environment
and a real successful public HTTP request in the same aggregate. The two
requests exercise failure evidence and live snapshot evidence separately.
The status raw_request_count becomes exactly 2. All existing snapshot,
live, redaction, logs, Virtual Router dry-run and no-send assertions remain.

The success response is asserted as HTTP 200, completed and output_text ok.
The real upstream capture is asserted for model, full input text and auth.
Exactly one success-provider capture is allowed. Both aggregate and upstream
shut down, and the fixture-owned success environment key is removed.

The missing V3_TEST_KEY is deliberate fixture input for the failing provider;
it is not a product auth change. TEST_LOCK serializes these environment users.
The complete suite confirms that subsequent public cases still pass.

## Parent author acceptance before review

Command, from the exact candidate tree:

```sh
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test multi_listener_server -- --test-threads=1 --nocapture
```

Result: exit 0; 101 passed, 0 failed, 0 ignored. This includes the exact
changed public HTTP/debug/dry-run case and the following serial cases.

Raw log and receipt:

- `/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/provider-chat-exhaustion-fixtures-r139/host-debug-final-full101-r158.log`
- `/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/provider-chat-exhaustion-fixtures-r139/host-debug-final-full101-r158.exit`

The earlier 101-pass source blob 7ffc is not used to prove this final source.
The new full run binds the exact final 4149265 source on b8d3.

Worker sandbox EPERM receipts are retained separately at
`/Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005/debug-fixture-final-delta-r156/records/`.
They are not reported as product failures or PASS. The parent accepted the
worker's exact single-file patch, verified matching source bytes, and ran
the real host suite above.

`git diff --check` passed. This test-only correction requires no binary
installation or runtime restart. Production 4444 was not changed.
Independent architecture review is the next gate; PR367 remains unmerged.
