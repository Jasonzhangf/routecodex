# Final verification packet - candidate composition

Role: GCM candidate author, verification and integration preparation only.
This packet records the composed candidate, the checks that were run, and the
remaining product gaps. It is **not** a Review verdict. No commit, push, PR, or
merge has been made.

## 1. Candidate and base identities

| Item | Value |
| --- | --- |
| Worktree | `/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012` |
| Branch | `codex/magpie-live-matrix-20261012` |
| Source creation base | `88715b2fe74ce4e6254f4d29ef1528b6848d4dff` |
| Review base / latest `origin/main` | `f7fc9e17b9a0f7fb66f3dc906c8808634e551334` |
| HEAD after composition | `f7fc9e17b9a0f7fb66f3dc906c8808634e551334` (no source commit) |
| Composed merge commit (composition receipt) | `0933138b22613c151e4ddd016116a86802ab5b72` |

The composed merge commit is a temporary composition receipt in the staging
clone. It is not a delivery commit and is not referenced by the worktree.

## 2. Composition method and permission boundary

`git fetch origin` could not write
`/Users/fanzhang/Documents/github/routecodex/.git/worktrees/magpie-live-matrix-20261012/FETCH_HEAD`
(`Operation not permitted`). The shared worktree git dir is read-only in this
sandbox, so `git add`, `git merge`, and `git commit` cannot run in the real
worktree here. No elevation or bypass was attempted.

The latest main commit and remote-tracking ref were already present in the
shared object store, so no fetch write was needed for the merge input:

```text
git ls-remote origin refs/heads/main
# f7fc9e17b9a0f7fb66f3dc906c8808634e551334  refs/heads/main
```

Composition was therefore performed in a faithful temp clone that:

1. copied the workspace (excluding `.git`, `node_modules`, `target`);
2. used the shared object store as an alternate;
3. committed the dirty state, then merged `origin/main` with normal Git;
4. detached HEAD to the Review base `f7fc9e17` and staged the owned paths.

Staging clone: `/private/tmp/magpie-candidate-20261012.gqfRXd`
(path also recorded in `/private/tmp/magpie-candidate-path.txt`).

Merge result was conflict-free: `Auto-merging v3/package.json`,
`Merge made by the 'ort' strategy`. The version advanced to `0.90.4887` and the
four new `package.json` / `v3/package.json` scripts survived.

## 3. Staged candidate

Staged against the Review base `f7fc9e17`:

```text
files staged: 680  (588 delivery files + 92 verification packet / archive files)
deletions:    0
```

Staged path groups:

| Group | Files |
| --- | --- |
| `docs/reports/**` | 604 |
| `v3/fixtures/protocol-live-mock-matrix/**` | 53 |
| `v3/scripts/**` | 18 |
| `docs/goals/**` | 2 |
| `package.json`, `v3/package.json` | 2 |
| `scripts/tests/protocol-live-mock-support-selftests.mjs` | 1 |

No `node_modules`, `target`, `.worker-runs`, `events.jsonl`, `stderr.log`, or
`notes.md` is staged.

## 4. Commands and exits

| Command | Exit | Result |
| --- | --- | --- |
| `git ls-remote origin refs/heads/main` | 0 | `f7fc9e17...` |
| `git merge --no-edit origin/main` | 0 | conflict-free, `ort` strategy |
| `npm run test:protocol-live-mock-support` | 0 | 151 tests, pass 151, fail 0, skipped 0, 8/8 files |
| `git diff --cached --check` | 0 | clean |
| staged secret scan | 0 | no real key patterns; only `fake-loopback-token*` |

`npm test:protocol-live-mock-support` (without `run`) is not a valid npm verb
and exits non-zero with `Unknown command`; the correct invocation is
`npm run test:protocol-live-mock-support`.

Not run, by scope: full Rust suite, release build, install, production restart,
and the 48-case baseline re-run. Changed main paths do not touch this
delivery's helper/fixture contracts, so prior routing checks are reused.

## 5. Source hashes

All 13 declared hashes in
`oracle-author-delta-20261012/receipt.json` match the candidate source:

| File | sha256 (prefix) |
| --- | --- |
| `v3/scripts/tests/protocol-live-mock/assertions.mjs` | `62af585da7b7` |
| `v3/scripts/tests/protocol-live-mock/assertions.test.mjs` | `b8dce9800a5d` |
| `v3/scripts/tests/protocol-live-mock/protocol-semantics.mjs` | `41a3eea3b6ab` |
| `v3/scripts/tests/protocol-live-mock/protocol-semantics.test.mjs` | `f069125b11bb` |
| `v3/scripts/tests/protocol-live-mock/corpus.mjs` | `3e2d09d14ef7` |
| `v3/scripts/tests/protocol-live-mock/corpus.test.mjs` | `a86548d11d7d` |
| 7 `v3/fixtures/protocol-live-mock-matrix/cases/*.json` | match |

Key staged file hashes (sha256 prefix):

| File | sha256 (prefix) |
| --- | --- |
| `package.json` | `748b7dd90ddc` |
| `v3/package.json` | `4cc4bd1791b5` |
| `v3/scripts/verify-ci.mjs` | `a415b9143c3e` |
| `scripts/tests/protocol-live-mock-support-selftests.mjs` | `4407e6b00b24` |
| `v3/scripts/tests/v3-protocol-live-mock-matrix.mjs` | `709c60e54256` |

## 6. Runtime proof links

- initial strict baseline: `docs/reports/magpie-live-matrix/installed-baseline-20261012/`
- G4 delta: `docs/reports/magpie-live-matrix/delta-replay-20261012/`
- close-observation fix: `docs/reports/magpie-live-matrix/g4-fault-integrate-20261012/`
- oracle-author delta + triage: `docs/reports/magpie-live-matrix/final-verification/oracle-author-delta-20261012/`
- native echo control: `docs/reports/magpie-live-matrix/final-verification/native-positive-control-20261012/`

Runtime identities stay distinct: baseline used `0.90.4886`
(`282e05b7...`), delta replays used `0.90.4887` (`5c1672a5...`). No source SHA
is claimed as installed-binary provenance.

## 7. Remaining product gaps

Preserved, not fixed this round:

- `namespace-custom-complete-args` - confirmed empty client response.
- `responses-to-gemini-sse` - 0 provider attempts, keepalive then cut.
- `tool-followup-responses-to-chat` - observer fixed, strict wire/projection mismatch remains.
- `media-anthropic-older-turn-tool-image` - unresolved full role/order/tool-result semantics.
- `chat-to-gemini-sse` - `:generateContent` vs `:streamGenerateContent` coverage gap.

Triage (`oracle-author-delta-20261012/triage.json`) is author input, not a
verdict. Do not restate it as "36 bugs" or "187 defects".

## 8. Owned cleanup status

- baseline cleanup complete 48/48; delta cleanup complete 7/7; G4 and
  close-observation cleanup complete; native control child exit 0 with owned
  listeners and mock closed.
- staging clone retained at
  `/private/tmp/magpie-candidate-20261012.gqfRXd` for Review base mode.
- real worktree index not mutated (sandbox denied); no worker logs, build
  outputs, or run notes staged.
