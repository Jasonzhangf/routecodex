# V3 Codex Sample Retention And Snap Scope Test Design

## Contract

- `feature_id`: `v3.codex_sample_retention_snap_scope`
- Config publishes Debug runtime settings plus a non-authorable, default-false Codex-sample authorization field.
- CLI/lifecycle are the only writers of per-start Codex-sample authorization:
  - no snapshot flag: runtime sample persistence disabled, regardless of authoring default;
  - `--snap`: Debug snapshots and Relay sample persistence enabled, Direct sample persistence disabled;
  - `--snapall`: Debug snapshots plus Direct and Relay sample persistence enabled.
- No-flag startup does not disable unrelated Debug runtime features such as provider-request dry-run.
- Server is the only filesystem owner for `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/`.
- Authorized sample payloads are enqueued to one Debug-owned worker behind a 64-job and 64-MiB serialized-payload budget; a completion barrier waits for all previously accepted writes.
- Queue overload and oversized payloads are logged and retained as request/file-qualified failures without rejecting a passable business request.
- A completion barrier reports a snapshot without draining the failure ledger; worker shutdown drains the bounded ledger and returns an omitted-count summary when needed.
- Server startup starts the persistence worker only after fallible listener preparation and before listener tasks begin accepting requests.
- Aggregate shutdown and exec preparation return residual persistence failures; managed stop records them in terminal status and exec restart reports them while preserving handoff checkpoints.
- Provider request/response snapshots pass through Debug redaction and payload budgets before filesystem IO.
- Debug checks the final serialized artifact against a hard 64 KiB limit; recursive estimates alone are not sufficient.
- Relay and Direct SSE samples retain only a Debug-owned bounded prefix, append an explicit truncation marker, and write only at initial capture plus terminal EOF/error.
- Each endpoint/port retains at most 100 request directories. Server startup enforces the cap even when live capture is disabled, and every later sample write re-enforces it. Eviction affects debug artifacts only.
- Live client/provider payloads, routing, continuation, errors, and MetadataCenter remain unchanged.

## Lifecycle Tests

1. Config white-box:
   - omitted `snapshot_direct` publishes `true` for config compatibility;
   - explicit `snapshot_direct = false` publishes `false`.
   - compiled `codex_samples` authorization is always `false` before CLI/lifecycle publication.
2. CLI black-box:
   - help exposes `--snap` and `--snapall`;
   - flags conflict;
   - blank `--snap-stages` is rejected;
   - no-flag startup preserves configured Debug runtime behavior while publishing `codex_samples_enabled=false`;
   - managed `--snap` runtime status reports Direct snapshots disabled;
   - managed `--snapall` runtime status reports Direct snapshots enabled.
3. Server white-box:
   - 101 distinct request directories leave exactly 100;
   - oldest directory is removed and newest remains;
   - multiple files for one request still count as one sample;
   - provider snapshot persistence redacts sensitive/base64 content and preserves bounded diagnostic shape.
   - adversarial wide sensitive objects remain at or below the final serialized 64 KiB limit;
   - Relay/Direct SSE capture memory is bounded and does not synchronously rewrite the full artifact per chunk;
   - missing/blank `HOME` fails authorized persistence and startup retention explicitly.
4. Server black-box:
   - startup with capture disabled still reduces 101 pre-existing request directories to 100;
   - Relay under `--snap` writes request/provider/response samples;
   - Direct under `--snap` writes no sample directory;
   - Direct under `--snapall` writes request/response samples.

## Positive / Negative Locks

- Positive: Relay diagnostics remain available; `--snapall` preserves explicit full capture.
- Negative: no snapshot flag cannot write any new sample; default `--snap` cannot write Direct; restart cannot leave more than 100 pre-existing request directories; provider media/auth cannot reach disk unredacted.
- Failure: filesystem, queue-budget, and redaction/persistence failures remain explicit debug errors; queue pressure cannot become a client error or payload fallback.
- Boundaries: tests saturate the queue, drop a barrier reply, and exceed the failure-ledger cap to prove each resource and failure report stays bounded.

## Verification Order

1. Focused red tests.
2. Focused Config/Debug/Server/CLI green tests.
3. Real HTTP/SSE success with a forced sample-store filesystem failure; assert the subsequent aggregate shutdown or exec-preparation result retains request ID, artifact name, and reason.
4. `npm run verify:v3-debug-payload-budget` plus its red fixtures.
5. V3 architecture and format gates.
6. V3 build.
7. Global `npm run install:v3`.
8. Aggregate restart and all member `/health`.
9. Live Relay/Direct replay for `--snap`; controlled `--snapall` replay.
10. Codex review only after installed live evidence.
   - no flag reports Codex-sample persistence disabled even when config authoring enables Debug snapshots;
