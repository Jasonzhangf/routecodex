# G4 fault-integrate repair: closed-transport parse diagnostic

Task status: scoped repair complete and verified. No re-plan, delegation,
review, commit, or production action was taken. The only runtime action was the
explicitly authorized isolated `provider-error-exhaustion` replay.

## Root cause

`observeClientResult()` in `case-runner.mjs` stored the raw
`parseClientBody()` result as `observation` even when the parser reported
`ok:false` (for example `empty_body`). `assertClientResult()` then treated that
diagnostic object as a parsed payload, so a real zero-byte provider-exhaustion
close produced:

`expected closed transport but received a parsed observation`

## Change (owned files only)

- `v3/scripts/tests/protocol-live-mock/case-runner.mjs`
  - `observeClientResult()` keeps `observation` only when `parsed.ok === true`.
  - A failed parse is preserved separately as `parse_diagnostic`.
  - Client evidence records both `observation` and `parse_diagnostic`; the raw
    `client_response` still carries status, headers, bytes and body text.
- `v3/scripts/tests/protocol-live-mock/case-runner.test.mjs`
  - Added one test with two controls: a genuine zero-byte close with an
    `empty_body` diagnostic passes `transport=closed`; a real non-empty HTTP 200
    JSON body with the same `{ok:false,error:"empty_body"}` keys still fails the
    closed expectation and stays observable as a parsed observation.

## Verification

- `node --check` on both edited files: exit 0.
- `node --test --test-timeout=30000 v3/scripts/tests/protocol-live-mock/case-runner.test.mjs`:
  6 tests, 6 pass, 0 fail, 0 skipped, exit 0.
- `node --test --test-timeout=30000 v3/scripts/tests/protocol-live-mock/*.test.mjs`:
  146 tests, 146 pass, 0 fail, 0 skipped, exit 0.
- Isolated red control (copy under `/tmp`, old normalization restored): the new
  test fails with `expected closed transport but received a parsed observation`
  (expected `passed`, actual `failed`), exit 1. Temp copy removed after use.
- Live replay: `node v3/scripts/tests/v3-protocol-live-mock-matrix.mjs
  --case provider-error-exhaustion --binary-kind installed
  --evidence docs/reports/magpie-live-matrix/g4-fault-integrate-20261012
  --report-path .../provider-error-exhaustion-report.md`
  - exit 0, case status `passed`, 1 business attempt, provider body model
    `unavailable-model`.
  - Installed identity: `rccv3 0.90.4887`, sha256
    `5c1672a562c32c4c996b2ce6c83f552e8e271c4266256a34a0f4fc2a5847a563`.
  - Client evidence: `status=null`, empty body, `closed=true`,
    `observation=null`, `parse_diagnostic.error=empty_body`, no diagnostics.
  - Cleanup: `cleanup.complete=true`; child pid 61964 exited 0; primary and
    admin listeners closed; mock closed; config/state removed.

## Boundary

- `assertions.mjs`, fixtures, lifecycle, runtime and operator files were not
  edited. The `fault-integrate/result.md` owner note was not touched.
- `ps -p 61964` was denied by the sandbox (`operation not permitted`); no
  bypass was attempted. Process exit and listener closure are proven by
  `setup.json` and `lsof` checks instead.
