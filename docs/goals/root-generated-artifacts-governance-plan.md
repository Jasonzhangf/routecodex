# Root Generated Artifacts Governance Plan

## Scope

This plan governs files and directories created at the repository root of RouteCodex. It covers generated build outputs, test outputs, install/package outputs, local tool state, debug evidence, and accidental root clutter.

It does not redefine user runtime state under `~/.rcc`. `~/.rcc` remains the runtime/user-data root; the only `~/.rcc` rule relevant here is that repo scripts must not mirror runtime evidence back into the project root.

## Current Audit

Evidence collected on 2026-06-07:

- `git check-ignore -v` proves these root items are ignored generated/local state: `tmp/`, `bin/`, `lib/`, `.clock/`, `.codex-work/`, `.drudge/`, `.hypatia/`, `.hypatia_data/`, `.reasonix/`, `clock.md`, `entities.json`, `mempalace.yaml`, `hypatia`, `models/`, `tmp-route-sample.mjs`, `tmp-route-test.mjs`.
- `git ls-files` proves these suspicious root items are tracked, so they must be migrated by a source change, not deleted as local trash: `package/`, `nested/deep/ap003.txt`, `rcc`.
- `.git/info/exclude` currently ignores `webui/`, but `package.json`, `jest.config.js`, and `scripts/install-global.sh` treat `webui/` as source input. This is a local exclude hazard: ignored status alone is not sufficient deletion evidence.
- Existing `scripts/ci/repo-sanity.mjs` already enforces a fixed top-level layout, but its allowlist still preserves legacy exceptions such as `package`, `tmp`, `clock.md`, `models`, and `CACHE.md`.

Current root classification:

| Path | Class | Evidence | Decision |
|---|---|---|---|
| `dist/` | Build output | `tsconfig.json outDir`, Vite `outDir` | Keep for dev, clean through build script only |
| `sharedmodule/llmswitch-core/dist/` | Core build output | core `tsconfig.json outDir` | Keep for dev, clean through core build script only |
| `node_modules/` | Dependency output | package manager | Keep local, ignored |
| `sharedmodule/llmswitch-core/rust-core/target/` | Rust build output | Cargo target, large rebuild cost | Keep local, ignored |
| `tmp/` | Test/runtime temp | Jest session artifacts | Must be disposable |
| `test-results/`, `sharedmodule/**/test-results/` | Test output | scripts write snapshots/matrix output | Must be disposable |
| `coverage/` | Coverage output | Jest coverage config | Must be disposable |
| `.install-pack/`, root `*.tgz` | Packaging output | install/pack scripts | Must move to temp or `artifacts/pack/` |
| `bin/`, `lib/` | Local npm prefix residue | ignored, symlink to repo | Remove and prevent root local prefix usage |
| `package/` | Tracked legacy release package residue | `git ls-files`, qoder package content | Migrate or delete in dedicated cleanup slice |
| `nested/deep/ap003.txt` | Tracked self-test residue | `git ls-files`, apply_patch checklist sample | Delete or move into `tests/fixtures/` in dedicated cleanup slice |
| `rcc` | Tracked CLI symlink | `package.json files`, `pack:rcc` flow | Keep until packaging entry is redesigned |
| `webui/` | Source input hidden by local exclude | package/test/install references | Must not delete; fix local exclude separately |
| `.beads/` | Task state | `.beads/issues.jsonl` is truth | Track only `issues.jsonl`; runtime db/log disposable |
| `.agents/` | Local project skill truth | project rules and local skills | Keep local, ignored |
| `memory/`, `CACHE.md` | Project memory/cache | AGENTS memory contract | Keep local, ignored |
| `.hypatia/`, `.hypatia_data/`, `hypatia`, `entities.json`, `mempalace.yaml` | External indexing state | Hypatia/MemPalace files | Do not silently delete; migrate to `.local-index/` or tool home |
| `.reasonix/`, `.codex-work/`, `.drudge/`, `.clock/`, `clock.md` | Agent/tool local state | ignored local state | Migrate to `.agent-state/` or tool home; root files forbidden afterwards |
| `models/` | Model cache | 3.2G ignored local cache | Do not delete without explicit cache policy |
| `samples/` | Tracked/evidence samples | package/test usage | Keep as sample/evidence truth |
| `vendor/` | Project dependency/vendor input | tracked-visible root | Keep until owner audit proves obsolete |

## Root Layout Contract

Root is reserved for:

- project entry documents: `AGENTS.md`, `README.md`, `DELIVERY.md`, `MEMORY.md`, `note.md`;
- package/toolchain manifests: `package.json`, `package-lock.json`, `tsconfig*.json`, `jest.config.js`, `eslint.config.js`, `.gitignore`, `.gitattributes`;
- source/config/test/documentation roots: `src/`, `sharedmodule/`, `config/`, `configsamples/`, `docs/`, `scripts/`, `tests/`, `samples/`;
- explicit packaging compatibility entries: `rcc` until replaced by a non-root packaging entry;
- local-only state roots explicitly approved by policy: `.beads/`, `.agents/`, `memory/`, `CACHE.md`;
- generated roots explicitly approved by policy: `dist/`, `node_modules/`, `tmp/`, `coverage/`, `test-results/`, Rust `target/`.

Everything else requires a documented owner and a gate update before it may exist at root.

## Source Write Path Rules

All code that writes files must choose one of these roots:

| Use case | Required root | Notes |
|---|---|---|
| TypeScript build output | `dist/` or package-local `dist/` | Never emit side-by-side `src/**/*.js`, `.d.ts`, `.js.map` |
| Web UI build output | `dist/daemon-admin-ui/` | `webui/` remains source input |
| Core build output | `sharedmodule/llmswitch-core/dist/` | Native node artifacts must live under core `dist/native/` |
| Rust build output | Cargo `target/` | Do not copy `.node` into source directories |
| Test temp | `tmp/<suite>/` or OS temp via `fs.mkdtemp(os.tmpdir())` | If evidence is needed after test, promote to `test-results/<suite>/` |
| Test reports | `test-results/<suite>/` | Never write ad-hoc root JSON or logs |
| Coverage | `coverage/` | Owned by test/coverage tooling |
| Pack/install tarballs | OS temp or `artifacts/pack/` | Root `*.tgz` is forbidden |
| Runtime debug logs | `logs/<feature>/` only for repo-local debug; otherwise `~/.rcc/logs/` | No root `.log` files |
| Runtime snapshots/errorsamples | `~/.rcc/codex-samples/`, `~/.rcc/diag/`, or configured snapshot root | Do not write runtime evidence to repo root |
| Local agent/tool state | `.agent-state/<tool>/` or tool home outside repo | No root `clock.md`, `entities.json`, `mempalace.yaml` |
| Search/model/index caches | tool home outside repo or `.cache/<tool>/` | `models/` needs explicit cache policy before cleanup |
| Generated docs/reports meant to be tracked | `docs/reports/`, `docs/audits/`, `docs/goals/` | No ad-hoc root Markdown except approved entry docs |

Rules for implementations:

- No script may default an output path to `process.cwd()` plus an ad-hoc filename. It must use a named helper or an explicit approved root.
- Any script option named `--output`, `--out`, `--dump`, or `--report` must resolve relative paths under the appropriate approved root unless an absolute path is passed intentionally.
- Package scripts must not create root `bin/` or `lib/` as a local npm prefix. Local CLI shims go to `$HOME/.local/bin` or npm global prefix.
- Build scripts must clean only their owned output root. They must not sweep unrelated ignored roots.
- Tests must clean their own `tmp/<suite>/` directory or use OS temp directories. Persistent evidence belongs in `test-results/<suite>/`.
- Runtime code must never use repo root as fallback for user data. User data root is `~/.rcc` via the existing user-data path helpers.

## Required Source Refactors

Phase 1: stop new root clutter

- Add a shared path helper for repo-local generated paths, for example `scripts/lib/repo-output-paths.mjs`.
- Move root pack outputs from `scripts/pack-mode.mjs` / `scripts/pack-rcc.mjs` to OS temp or `artifacts/pack/`.
- Make report/debug scripts default to `docs/reports/`, `test-results/`, `logs/`, or `~/.rcc` instead of root.
- Remove local npm-prefix assumptions that create `bin/` and `lib/` under the repo.
- Fix `.git/info/exclude` or document that local `webui/` exclusion is invalid for this repo.

Phase 2: migrate legacy tracked clutter

- Decide whether `package/` still has an active packaging role. If not, delete it physically and update `package.json files` / install scripts. If yes, move it under `scripts/packaging/legacy-qoder/` with explicit owner docs.
- Delete `nested/deep/ap003.txt` or move it into `tests/fixtures/apply-patch/ap003.txt`; update the apply_patch checklist accordingly.
- Replace root `rcc` symlink with a generated packaging artifact if package consumers no longer require a tracked root symlink.

Phase 3: consolidate tool state

- Move `.codex-work/`, `.reasonix/`, `.drudge/`, `.clock/`, `clock.md` to `.agent-state/<tool>/` or the tool's user home.
- Move Hypatia/MemPalace state (`.hypatia*`, `hypatia`, `entities.json`, `mempalace.yaml`) to a tool-specific home or `.local-index/<tool>/`.
- Write a model-cache policy for `models/`: either external cache home or an explicit `models/` keep rule with pruning command.

Phase 4: tighten gates

- Split `repo-sanity` root allowlist into `sourceRoots`, `generatedRoots`, `localStateRoots`, and `temporaryLegacyRoots`.
- Remove legacy exceptions from the allowlist only after the corresponding phase is migrated.
- Add a root generated-path gate that scans scripts/runtime source for forbidden root writes:
  - root `*.tgz`;
  - root `*.log`;
  - root ad-hoc `*.json` outputs;
  - root `bin/` / `lib/` creation;
  - side-by-side TS emit under `src/**`;
  - output defaults equal to `process.cwd()` without an approved subroot.

## Cleanup Policy

High-confidence disposable items may be deleted after `git check-ignore` evidence:

- `tmp/`
- `test-results/`
- `sharedmodule/**/test-results/`
- `.install-pack/`
- root `*.tgz`
- `.DS_Store`
- root `bin/` and `lib/` when they are only local npm-prefix symlink residue
- `tmp-*` root scratch files

Do not delete without a dedicated migration decision:

- tracked `package/`, `nested/`, `rcc`;
- `webui/`, even if locally ignored;
- `models/`;
- `samples/`;
- `vendor/`;
- `.hypatia*`, `hypatia`, `entities.json`, `mempalace.yaml`;
- `~/.rcc/diag` or `~/.rcc/codex-samples`.

## Verification

After any root governance change, run at least:

```bash
node scripts/ci/repo-sanity.mjs
git status --short --ignored --untracked-files=all -- . | sed -n '1,160p'
git diff --check
```

If source scripts or runtime path helpers change, also run:

```bash
npx tsc --noEmit --pretty false
```

If build/install paths change, add:

```bash
npm run build:min
npm run install:global
routecodex --version
rcc --version
```

## Completion Criteria

- Root has no unexplained generated/local files outside the fixed contract.
- Every script-generated output has an owning approved root.
- `repo-sanity` distinguishes source, generated, local state, and temporary legacy exceptions.
- Temporary legacy exceptions (`package/`, `nested/`, root `rcc` if retired) are either deleted or moved with owner documentation.
- Root clutter cannot reappear without a failing gate.
