# REQ02 Structural Gate Recovery Result

## Scope and ownership

- Task: structural gate recovery only.
- Base commit: `3a72ad81320b1c435b08c0d99343c7c22efa5197`.
- Owned writes in this task:
  - `v3/scripts/architecture/verify-v3-operation-runner-dagpipe.mjs`
  - `v3/scripts/tests/v3-operation-runner-red-fixtures.mjs`
  - `docs/goals/req02-structural-gate-result-20261003.md`
- Read-only peer inputs in this worktree: `docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml`,
  `docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml`, and `docs/architecture/v3-function-map.yml`.
  Their existing worktree diffs were not edited or reverted by this task.
- No commit, merge, push, install, restart, or runtime acceptance was performed.

## Input hashes

```text
3b0309e52adc05adffc44bac3901ea44e2fa2734f2d09e08fd67bc185424f417  docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml
f079c8a8416160a9751bfab626cca89c2281bd42c3283ed3564d4fd2d120878f  docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml
449a0300cafed6c0c558f63f0a7c8b9ba76f85e11470b343f86cef9eabc549fa  docs/architecture/dagpipe/v3.operation_runner.request.graph.json
2de3404f82b3430b7303359aa70e5ef74e3d4c09946df2a6e0ba1ee59f171ba2  v3/scripts/architecture/verify-v3-operation-runner-dagpipe.mjs
6d99b9988fbde21b12d4ace2f949021edcc6c250968e247d104c30ded4adc9b5  v3/scripts/tests/v3-operation-runner-red-fixtures.mjs
```

## Original red evidence

Before the verifier change, the current candidate gate itself exited 0, but the
new structural negative fixtures exposed the missing validation. The full
fixture command exited 1 and reported these five structural mutations as
`status 0` leaks:

```text
structure-binding-missing-transform
structure-binding-unknown-operator
structure-binding-wrong-direction
structure-binding-missing-typed-param
structure-binding-union-scalar-mismatch
```

`structure-binding-source-outside-inventory` already failed through the
existing exact protocol-inventory check; the new unified binding path now also
runs for structure rows, and the negative remains covered.

## Changes

- `verify-v3-operation-runner-dagpipe.mjs`
  - Extracted direction/typed/operator validation into one binding validator.
  - Runs binding validation for every explicit `params.direction_bindings`
    entry, including `structure_only + parent_owned` rows whose `consumers` is
    empty.
  - Preserves ordinary-row consumer matching and union `scalar_consumer`
    matching.
  - Requires structure bindings to declare a typed `transform_id`; validates
    registered `operator@version`, applicable direction, typed profile,
    required `source`/`destination`, and typed `shape`/`semantics`/
    `failure_class` through the existing profile checks.
  - Keeps exact source-inventory validation and does not add prefix matching,
    unknown-path exceptions, or runtime business-payload rejection.
- `v3-operation-runner-red-fixtures.mjs`
  - Added structural negative fixtures for missing transform, unknown
    operator, wrong direction, fake source, missing typed parameter, and union
    scalar mismatch.
  - Negative helper and mutation loop now require both non-zero exit status and
    the expected diagnostic.

## Verification receipts

All commands were run with this worktree as cwd.

```text
node --check v3/scripts/architecture/verify-v3-operation-runner-dagpipe.mjs
exit 0

npm run verify:v3-operation-runner-dagpipe
exit 0
[verify:v3-operation-runner-dagpipe] ok
- required graphs: 1
- deferred graphs present: 2
- operator_version checks: passed

npm run test:v3-operation-runner-red-fixtures
exit 0
valid-candidate: PASS
structure-binding-missing-transform: failed as expected
structure-binding-unknown-operator: failed as expected
structure-binding-wrong-direction: failed as expected
structure-binding-source-outside-inventory: failed as expected
structure-binding-missing-typed-param: failed as expected
structure-binding-union-scalar-mismatch: failed as expected
optional-string-omitted: PASS
optional-string-present: PASS
single-request-direction-binding: PASS
two-direction-profile-binding: PASS

git diff --check
exit 0
```

## Boundary and next transition

This result closes the structural compile-gate recovery only. It does not claim
REQ02 runtime behavior, public Server black-box acceptance, operator output,
media implementation, resource-runner behavior, or delivery. The parent owner
still owns consumer/Server integration acceptance and final resource closeout.
This task retains its own worktree and result file until the parent collects
the receipts.
