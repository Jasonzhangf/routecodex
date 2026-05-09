# Goal: apply_patch compatibility for multi-provider shell-authored patch flows

## 1. Goal Objective

Implement a single-source-of-truth compatibility layer for `apply_patch` so that different providers may emit their most reliable authoring shape — especially exact shell/heredoc forms — while RouteCodex deterministically normalizes those shapes back into canonical Codex `apply_patch` patch text before execution.

The final execution path must remain:

`HTTP server -> llmswitch-core Hub Pipeline -> canonical apply_patch tool payload -> existing validator/governor/execution path`

This goal is specifically for **shape repair** when the request already contains enough information.
It is **not** permission to perform semantic reconstruction.

---

## 2. Hard Constraints

1. **No fallback, no downgrade, no silent compensation.**
2. **No semantic guessing.**
   - do not guess hunk context
   - do not guess file content
   - do not guess rename intent
   - do not guess missing shell commands
   - do not infer a tool name from patch prose/body alone
3. **Shape repair only.**
   - wrapper extraction
   - field alias normalization
   - exact heredoc extraction
   - explicit `cd rel &&` path rebasing
   - absolute header relativization via explicit `workdir`
   - legacy header normalization
   - deterministic diff-envelope normalization
4. Final downstream payload must be canonical `apply_patch` JSON with canonical patch text.
5. Preserve semantic equivalence of the real patch payload.
6. Do not add provider-specific duplicate parsing logic unless a transport boundary strictly requires it.
7. Prefer Rust single-source-of-truth implementation over TypeScript duplication.
8. Every completion claim must include evidence.
9. If the shape is unsupported, surface explicit normalized error reason; do not guess-repair.
10. If the payload already contains enough information and only the **format/envelope is incomplete**, repair it.
11. Do not execute shell file writes as the real edit mechanism.
12. The canonical authoring target remains Codex `apply_patch`, even when compatibility accepts provider shell wrappers.

---

## 3. Why `/goal` is the right mode here

Based on Codex source and docs review:

- `/goal` attaches a persistent objective to the current thread.
- It supports a self-loop execution style rather than a single-shot command style.
- It is appropriate when the task must repeatedly cycle through:
  - analysis
  - design
  - modify
  - test
  - review
  - commit/readiness summary
- This task is a perfect `/goal` candidate because:
  - it spans source research + implementation + regression growth
  - it needs explicit success criteria
  - it needs repeated evidence checks before closure
  - it must keep scope tight while resisting semantic overreach

### Confirmed Codex `/goal` evidence

Codex source/docs inspected:
- `~/code/codex/codex-rs/tui/src/chatwidget/slash_dispatch.rs`
- `~/code/codex/codex-rs/tui/src/chatwidget/goal_validation.rs`
- `~/code/codex/codex-rs/core/src/goals.rs`
- `~/code/codex/codex-rs/app-server/README.md`

Confirmed behavior:
- `/goal <objective>` creates or sets a thread goal
- goal state persists on the thread
- status lifecycle is explicit
- token budget / usage accounting exists in Codex goal primitives
- goal continuation is designed for iterative completion, not one-turn completion

---

## 4. External reference conclusions that must drive this goal

### 4.1 Codex `apply_patch` source conclusions

Primary references inspected:
- `~/code/codex/codex-rs/apply-patch/src/invocation.rs`
- `~/code/codex/codex-rs/apply-patch/src/parser.rs`
- `~/code/codex/codex-rs/core/tests/suite/apply_patch_cli.rs`
- `~/code/codex/codex-rs/core/tests/suite/shell_snapshot.rs`
- `~/code/codex/codex-rs/core/tests/common/responses.rs`
- `~/code/codex/codex-rs/core/tests/suite/unified_exec.rs`

Conclusion:
Codex itself recognizes a **narrow, explicit compatibility surface**, mainly:
1. direct canonical patch body
2. exact shell heredoc wrapper
   - `apply_patch <<'PATCH' ... PATCH`
3. exact directory-prefixed shell heredoc wrapper
   - `cd subdir && apply_patch <<'PATCH' ... PATCH`

This means our compatibility target should mirror Codex’s **bounded shell compatibility**, not invent a free-form shell parser.

### 4.2 Hermes patch parser conclusions

Reference inspected:
- `~/github/hermes-agent/tools/patch_parser.py`

Conclusion:
- Hermes is intentionally looser and accepts broader malformed patch shapes.
- Hermes is useful as an inspiration for **envelope tolerance**.
- Hermes is **not** safe as a direct truth source here, because our requirement forbids semantic guessing.

Therefore:
- We may borrow Hermes’ attitude toward outer wrapper recovery.
- We must not borrow Hermes-style semantic completion or permissive inference where intent is ambiguous.

---

## 5. Unique correct implementation point

### Single-source-of-truth fix point

The unique correct implementation point is:

`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/compat_fix_apply_patch.rs`

### Why this is the only correct place

Because this native compatibility layer is already on the shared execution boundary used by:
- validator normalization
- request inbound stage2 semantic normalization
- tool governor request/response rewrite path
- compat action wrapper path

So fixing compatibility here means:
- one truth surface
- one error boundary
- one regression surface
- no provider-specific semantic drift

### Why other places are wrong/incomplete

1. **Provider prompt only** is insufficient:
   - it can improve emission quality
   - but it cannot guarantee compatibility for already-produced real-world malformed wrappers

2. **TS-only normalization** is wrong/incomplete:
   - it duplicates semantics away from the Rust truth surface
   - it risks drift between request path / response path / validator path

3. **Provider-specific parser branches** are wrong by default:
   - they multiply semantic entry points
   - they increase mismatch risk
   - they violate SSOT principles unless transport shape absolutely forces a local adaptation

Therefore this Rust file is the unique correct repair point.

---

## 6. Compatibility policy: what is allowed to be repaired

### Allowed shape repairs

These are allowed **only when the payload already contains enough information**:

1. Exact shell wrapper extraction
   - `bash -lc "apply_patch <<'PATCH' ... PATCH"`
   - `bash -c "apply_patch <<'PATCH' ... PATCH"`
   - `zsh -lc ...`
   - `zsh -c ...`
   - `sh -lc ...`
   - `sh -c ...`

2. Exact `cd rel && apply_patch <<...` extraction
   - only for safe relative paths
   - only for exact `cd <relative> && apply_patch ...`
   - no multi-command chaining

3. Broken JSON wrapper salvage
   - recover from string/object wrappers containing fields like:
     - `command`
     - `cmd`
     - nested `result`
     - nested `payload`
     - nested `data`
   - only when an explicit `apply_patch` wrapper exists

4. Explicit `workdir`-based path repair
   - relative header rebase for `cd rel && ...`
   - absolute patch header relativization when explicit `workdir` is present

5. Legacy/cosmetic patch envelope normalization
   - `*** New File:` -> `*** Add File:`
   - `*** Create File:` -> `*** Add File:`
   - deterministic marker cleanup
   - deterministic unified-to-apply_patch envelope repair when structure is explicit enough

### Forbidden repairs

These remain forbidden:

1. Guessing tool intent from body prose alone
2. Guessing `apply_patch` from a random shell body
3. Guessing missing `@@` hunk data
4. Guessing file path when absent
5. Guessing whether a file should be add/update/delete when not explicit
6. Guessing rename/move semantics from loose text
7. Guessing command sequencing from shell text
8. Parsing arbitrary shell programs in order to “discover” a patch

---

## 7. Canonical provider authoring rule

### Preferred upstream authoring shape

Different providers should be encouraged to use the syntax they are most stable at, but we should prefer the most deterministic subset.

#### First preference: canonical direct apply_patch payload

If the provider can emit canonical `apply_patch` arguments directly, prefer:

```text
*** Begin Patch
*** Update File: path/to/file.ts
@@
-old
+new
*** End Patch
```

#### Second preference: exact shell/heredoc compatibility shape

If a provider is more reliable when speaking shell text, prefer this exact bounded form only:

```sh
apply_patch <<'PATCH'
*** Begin Patch
*** Update File: path/to/file.ts
@@
-old
+new
*** End Patch
PATCH
```

Or when needed:

```sh
cd relative/subdir && apply_patch <<'PATCH'
*** Begin Patch
*** Update File: path/to/file.ts
@@
-old
+new
*** End Patch
PATCH
```

### Why standard shell/heredoc is the best compatibility bridge

Because it is:
- familiar to many providers
- easy to delimit deterministically
- compatible with Codex’s own narrow invocation shape
- recoverable without semantic guessing
- easy to reject when extra commands appear

### Explicit negative examples

These must be rejected, not repaired semantically:

```sh
echo hi && apply_patch <<'PATCH'
...
PATCH
```

```sh
if test -f a; then apply_patch <<'PATCH'
...
PATCH
fi
```

```sh
python write_file.py <<'PY'
...
PY
```

```text
{"input":{"cmd":"some shell that later maybe creates a patch"}}
```

Reason: once there is additional executable semantics, the system would need shell interpretation, which violates the no-guess boundary.

---

## 8. Required regression corpus policy

This goal must explicitly mine two evidence sources:

### 8.1 Codex samples

Use Codex source/tests to capture positive truth shapes:
- exact shell heredoc wrapper
- `cd rel && apply_patch` wrapper
- canonical patch body

These become control positives.

### 8.2 Error samples

Use RouteCodex real error samples to capture failure shapes from actual provider traffic.
At minimum include:
- real broken JSON wrapper containing
  - `cmd`
  - `workdir`
  - shell metadata
  - absolute file header
- shell extra-command negatives
- malformed/unsupported negatives that must remain blocked

### Regression policy

For each sampled case, classify as one of:
- `fixed_by_compat`
- `missing_changes`
- `unsupported_patch_format`
- other explicit known validator reason

The goal is not “make more things pass blindly”.
The goal is:
- make **compatible shapes** pass
- keep **unsafe/ambiguous shapes** failing explicitly
- prove the failure boundary did not get weaker in the wrong way

---

## 9. Required test matrix

The implementation is not complete unless all of the following are covered.

### Rust unit/contract tests

Must cover:
1. exact shell wrapper positive
2. exact `cd rel && apply_patch` positive
3. broken JSON wrapper with `cmd + workdir` positive
4. parsed object with `cmd + workdir` positive
5. nested result/payload/data command wrapper positive when patch shape is complete
6. noncanonical extra-command shell negative
7. direct extra-command shell negative
8. unsupported malformed patch negative
9. absolute path relativization against explicit workdir
10. legacy header normalization

### TS / validator / pipeline tests

Must cover:
1. validator accepts codex shell sample
2. validator accepts codex `cd && apply_patch` sample
3. validator accepts real provider broken wrapper sample
4. validator rejects extra-command shell wrapper
5. response path rewrites compatible shapes to canonical `apply_patch`
6. request stage2 records normalized shape rather than unstable raw wrapper
7. invalid shapes become guarded invalid payloads rather than raw silent pass-through

### Regression sample verifier

Must verify:
- samples marked `fixed_by_compat` now validate `ok: true`
- samples marked with failure reasons still fail with the same explicit reason
- any mismatch fails the verifier

---

## 10. Reliable self-loop workflow for `/goal`

Use this exact loop until exit criteria are met.

### Phase A — Analysis

Required actions:
1. read current RouteCodex AGENTS / routing docs / relevant skills
2. read `note.md`, `MEMORY.md`, and write fresh exploration notes into `note.md`
3. inspect Codex `/goal` source behavior
4. inspect Codex `apply_patch` invocation/parser/tests
5. inspect Hermes patch parser for envelope ideas only
6. inspect current RouteCodex compat/validator/governor chain
7. identify the single correct fix point
8. list allowed repair shapes vs forbidden guessing shapes

Required output of Phase A:
- evidence-backed scope statement
- unique correct fix point
- explicit non-goals
- concrete failing samples to use as regressions

### Phase B — Design

Required actions:
1. define canonical accepted compatibility shapes
2. define exact rejection boundary
3. define normalization order
4. define workdir/path repair rules
5. define test corpus additions
6. define how request and response path both inherit the same repaired truth

Required output of Phase B:
- a small deterministic repair grammar
- a test plan mapped 1:1 to supported shapes
- proof that no semantic guessing is introduced

### Phase C — Modify

Required actions:
1. modify only the Rust SSOT compat layer for new repair semantics
2. update TS validator/governor only where needed to consume that truth surface
3. keep changes surgical
4. do not add parallel semantic implementations
5. add/refresh regression fixtures from codexsamples and errorsamples

Required output of Phase C:
- minimal diff
- no duplicate parser semantics
- note.md updated with discoveries

### Phase D — Test

Required actions:
1. run focused Rust tests for changed compat branches
2. run full `compat_fix_apply_patch` Rust test group
3. run TS validator tests
4. run request/response governor tests
5. run direct sample check script
6. run regression verifier
7. if verifier requires build output, build the exact minimal module needed and rerun

Completion rule for Phase D:
- do not say “done” if any compatibility-positive sample is still failing
- do not say “done” if a formerly blocked negative now silently passes

### Phase E — Review

Required actions:
1. inspect final diff for scope creep
2. verify no provider-specific semantic duplication was added
3. verify all repairs are envelope/shape-only
4. verify unsupported cases still fail fast
5. confirm regression corpus reflects both positive and negative cases

Required review questions:
- Did we repair only when enough information was already present?
- Did we avoid inferring missing semantics?
- Did we keep the fix at the unique SSOT boundary?
- Did we improve real samples without weakening invalid-shape protection?

### Phase F — Commit readiness

Required actions:
1. prepare a summary of exact changed files
2. list evidence commands and their outputs
3. state whether the tree is ready for commit
4. if asked to commit, commit only the relevant files
5. never include unrelated workspace drift

---

## 11. Exit criteria

This `/goal` is complete only when all are true:

1. Rust SSOT compatibility fix is implemented.
2. Provider `cmd + workdir + absolute path` wrapper now normalizes successfully.
3. Codex exact shell wrappers still work.
4. Extra-command shell wrappers still fail explicitly.
5. Regression samples from codexsamples + errorsamples are present.
6. Jest / Rust / direct sample checks are green.
7. Regression verifier is green.
8. The final summary explains **why this is the unique correct modification point**.
9. The final summary explains **why the accepted new behavior is shape repair, not semantic guessing**.

---

## 12. Extremely detailed `/goal` prompt template

Use the following prompt directly with Codex `/goal`.

```text
/goal Build and verify a single-source-of-truth apply_patch compatibility layer for RouteCodex.

Objective:
Implement shape-repair-only compatibility for apply_patch so that different providers can emit their most reliable patch-authoring syntax — especially exact shell/heredoc wrappers — and RouteCodex deterministically translates compatible shapes back into canonical Codex apply_patch patch text before execution.

Mandatory truth sources:
1. Study Codex /goal source and behavior from:
   - ~/code/codex/codex-rs/tui/src/chatwidget/slash_dispatch.rs
   - ~/code/codex/codex-rs/tui/src/chatwidget/goal_validation.rs
   - ~/code/codex/codex-rs/core/src/goals.rs
   - ~/code/codex/codex-rs/app-server/README.md
2. Study Codex apply_patch source/tests from:
   - ~/code/codex/codex-rs/apply-patch/src/invocation.rs
   - ~/code/codex/codex-rs/apply-patch/src/parser.rs
   - ~/code/codex/codex-rs/core/tests/suite/apply_patch_cli.rs
   - ~/code/codex/codex-rs/core/tests/suite/shell_snapshot.rs
   - ~/code/codex/codex-rs/core/tests/common/responses.rs
3. Study Hermes patch behavior from:
   - ~/github/hermes-agent/tools/patch_parser.py
   Treat Hermes only as envelope-tolerance inspiration, not semantic truth.
4. Study RouteCodex native compat and validator path, with the default expectation that the unique correct fix point is:
   - sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/compat_fix_apply_patch.rs
   Only choose another point if you can prove this one is wrong.

Hard constraints:
- no fallback
- no downgrade
- no silent compensation
- no semantic guessing
- no shell file-write execution as the real edit path
- only shape repair when information is already sufficient
- preserve canonical downstream apply_patch payload
- keep Rust as SSOT whenever possible
- do not add provider-specific duplicate semantics

Required interpretation rule:
If the payload provides enough information and only the wrapper/format/envelope is incomplete, repair it.
If repair would require inferring missing semantics, reject it explicitly instead.

Accepted compatibility target shapes:
- canonical apply_patch patch body
- exact shell heredoc wrapper:
  bash|zsh|sh -lc|-c "apply_patch <<'PATCH' ... PATCH"
- exact shell heredoc wrapper with safe relative prefix:
  cd relative/path && apply_patch <<'PATCH' ... PATCH
- explicit broken JSON/object envelopes carrying cmd/command + workdir + patch wrapper
- deterministic absolute-header relativization using explicit workdir

Rejected shapes:
- shell wrappers with extra commands before apply_patch
- arbitrary shell scripts requiring interpretation
- patch prose without explicit wrapper/tool name
- missing hunk semantics that would require guessing
- missing file operation type that would require inference

Execution loop (must self-cycle until green):
1. Analysis
   - inspect source truth
   - inspect current repo path
   - record discoveries to note.md
   - list allowed repairs vs forbidden guesses
2. Design
   - define exact accepted wrapper grammar
   - define exact rejection boundary
   - map each accepted shape to one test
3. Modify
   - implement in Rust SSOT compat layer first
   - update TS validator/governor only as consumers of that truth
   - keep changes surgical
4. Test
   - add/expand Rust unit tests
   - add/expand TS validator/governor tests
   - mine codexsamples and real errorsamples into repo regression samples
   - run focused tests, then regression verifier
5. Review
   - inspect diff for semantic overreach
   - confirm unsupported shapes still fail fast
   - confirm compatible shapes now pass
6. Commit readiness
   - summarize exact files changed
   - summarize proof
   - state whether ready to commit

Mandatory regression evidence:
- include Codex positive samples for exact shell wrapper and cd+apply_patch wrapper
- include real provider errorsamples, especially broken JSON wrapper with cmd+workdir and absolute path header
- ensure the corpus proves the system got better, not weaker

Mandatory reporting format at the end:
1. What changed
2. Why the change point is uniquely correct
3. Which real sample shapes are now fixed
4. Which shapes remain intentionally rejected
5. Test evidence (Rust / Jest / regression verifier)
6. Any remaining blocker
7. Commit readiness

Do not stop at analysis. Keep looping until the accepted positives are green, the intentional negatives still fail explicitly, and the regression verifier is green.
```

---

## 13. Minimal execution commands checklist

Use these as the default evidence checklist for this goal:

```bash
# Focused Rust compat tests
cargo test -p router-hotpath-napi compat_fix_apply_patch -- --nocapture

# Direct validator sample check
npx tsx /tmp/apply-patch-compat-check.ts

# Targeted Jest
npm run jest:run -- --runInBand --runTestsByPath \
  tests/sharedmodule/tool-governor-apply-patch-rewrite.spec.ts \
  tests/sharedmodule/req-inbound-stage2-tool-shape-normalization.spec.ts \
  sharedmodule/llmswitch-core/tests/apply-patch-validator.test.ts

# Build sharedmodule dist if verifier needs it
cd sharedmodule/llmswitch-core && npm run build:ci

# Regression verifier
cd /Users/fanzhang/Documents/github/routecodex && node scripts/verify-apply-patch-regressions.mjs
```

---

## 14. Final review reminder

When closing this goal, explicitly state:

1. **Why this implementation is uniquely correct**
   - because the Rust compat layer is the shared SSOT boundary already consumed by validator, stage2 normalization, and governor paths
   - because prompt-only or TS-only fixes would leave split semantics

2. **Why this is shape repair rather than semantic guessing**
   - because every successful repair starts from an already explicit wrapper/tool shape
   - because no file content, hunk, rename, or shell intent is invented
   - because unsupported ambiguous shapes remain blocked with explicit reasons
