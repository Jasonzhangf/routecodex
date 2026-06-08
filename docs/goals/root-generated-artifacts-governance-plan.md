# Root Generated Artifacts Governance Plan

## Scope

This plan governs files and directories created at the repository root of RouteCodex. It covers generated build outputs, test outputs, install/package outputs, local tool state, debug evidence, and accidental root clutter.

It does not redefine user runtime state under `~/.rcc`. `~/.rcc` remains the runtime/user-data root; the only `~/.rcc` rule relevant here is that repo scripts must not mirror runtime evidence back into the project root.

## Current Audit

Evidence collected on 2026-06-07 and updated on 2026-06-08:

- `git check-ignore -v` proves these root items are ignored generated/local state: `tmp/`, `bin/`, `lib/`, `.clock/`, `.codex-work/`, `.drudge/`, `.hypatia/`, `.hypatia_data/`, `.reasonix/`, `clock.md`, `entities.json`, `mempalace.yaml`, `hypatia`, `models/`, `tmp-route-sample.mjs`, `tmp-route-test.mjs`.
- `git ls-files` proved these suspicious root items were tracked, so they required source changes instead of local-trash deletion: `package/`, historical `nested/deep/ap003.txt`, `rcc`.
- `.git/info/exclude` currently ignores `webui/`, but `package.json`, `jest.config.js`, and `scripts/install-global.sh` treat `webui/` as source input. This is a local exclude hazard: ignored status alone is not sufficient deletion evidence.
- Existing `scripts/ci/repo-sanity.mjs` already enforces a fixed top-level layout, but its allowlist still preserves legacy exceptions such as `package`, `tmp`, `clock.md`, `models`, and `CACHE.md`.
- 2026-06-08 update: `scripts/pack-mode.mjs` and `scripts/pack-rcc.mjs` now write tarballs under `artifacts/pack/`; `scripts/install-global.sh` uses `artifacts/pack/install-global` inside its build root instead of `.install-pack`.
- 2026-06-08 update: tracked legacy `package/` and root `rcc` symlink were physically removed. `package.json files` no longer includes `rcc`, and install isolation no longer copies `package/` or `rcc`.
- 2026-06-08 update: local tool/index/model state was migrated out of root into approved local roots: `.agent-state/`, `.local-index/`, and `.cache/model-cache/`. `webui/` is no longer locally excluded and is treated as source.
- 2026-06-08 update: report scripts that defaulted to root `reports/` now default to `docs/reports/`, and `repo-sanity` locks scoped generated/local subroots so `artifacts/` only allows `pack/` and `.cache/` only allows `model-cache/`.

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
| `artifacts/pack/` | Packaging output | pack/install scripts | Approved generated root; root `*.tgz`, `.install-pack/`, and non-pack `artifacts/*` are forbidden |
| `bin/`, `lib/` | Local npm prefix residue | ignored, symlink to repo | Remove and prevent root local prefix usage |
| `package/` | Deleted tracked legacy release package residue | `git ls-files`, qoder package content, no active RouteCodex reference | Deleted on 2026-06-08; gate forbids reappearance |
| `nested/deep/ap003.txt` | Tracked self-test residue | `git ls-files`, apply_patch checklist sample | Deleted; checklist now uses `tmp/nested/deep/ap003.txt` |
| `rcc` | Deleted tracked CLI symlink | package bin already points to `dist/cli.js`; release pack mutates bin | Deleted on 2026-06-08; gate forbids reappearance |
| `webui/` | Source input hidden by local exclude | package/test/install references | Must not delete; fix local exclude separately |
| `.beads/` | Task state | `.beads/issues.jsonl` is truth | Track only `issues.jsonl`; runtime db/log disposable |
| `.agents/` | Local project skill truth | project rules and local skills | Keep local, ignored |
| `memory/`, `CACHE.md` | Project memory/cache | AGENTS memory contract | Keep local, ignored |
| `.local-index/` | External indexing state | Hypatia/MemPalace files migrated from root | Approved local root; root Hypatia/MemPalace files forbidden |
| `.agent-state/` | Agent/tool local state | `.reasonix/`, `.codex-work/`, `.drudge/`, `clock.md` migrated from root | Approved local root; old root state names forbidden |
| `.cache/model-cache/` | Model cache | root `models/bert` migrated without deletion | Approved local cache root; root `models/` and non-model-cache `.cache/*` are forbidden |
| `samples/` | Tracked/evidence samples | package/test usage | Keep as sample/evidence truth |
| `vendor/` | Project dependency/vendor input | tracked-visible root | Keep until owner audit proves obsolete |

## Root Layout Contract

Root is reserved for:

- project entry documents: `AGENTS.md`, `README.md`, `DELIVERY.md`, `MEMORY.md`, `note.md`;
- package/toolchain manifests: `package.json`, `package-lock.json`, `tsconfig*.json`, `jest.config.js`, `eslint.config.js`, `.gitignore`, `.gitattributes`;
- source/config/test/documentation roots: `src/`, `sharedmodule/`, `config/`, `configsamples/`, `docs/`, `scripts/`, `tests/`, `samples/`, `webui/`;
- local-only state roots explicitly approved by policy: `.beads/`, `.agents/`, `memory/`, `CACHE.md`;
- generated roots explicitly approved by policy: `dist/`, `node_modules/`, `tmp/`, `coverage/`, `test-results/`, `logs/`, and Rust workspace-local `target/` directories under their owning packages.
- generated roots explicitly approved by policy for packaging: `artifacts/pack/`.
- local-only roots explicitly approved by policy: `.agent-state/`, `.local-index/`, `.cache/model-cache/`.

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
| Pack/install tarballs | `artifacts/pack/` or OS temp | Root `*.tgz` is forbidden |
| Runtime debug logs | `logs/<feature>/` only for repo-local debug; otherwise `~/.rcc/logs/` | No root `.log` files |
| Runtime snapshots/errorsamples | `~/.rcc/codex-samples/`, `~/.rcc/diag/`, or configured snapshot root | Do not write runtime evidence to repo root |
| Local agent/tool state | `.agent-state/<tool>/` or tool home outside repo | No root `clock.md`, `entities.json`, `mempalace.yaml` |
| Search/model/index caches | tool home outside repo, `.local-index/<tool>/`, or `.cache/model-cache/` | Root `models/` is forbidden |
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

Status on 2026-06-08: path helper and pack/install path migration are complete; `webui/` local exclude hazard is corrected locally and `webui/` is source; `scripts/tool-classification-report.ts` and `scripts/analyze-tools-fileops.mjs` now default tracked report output to `docs/reports/`.

Phase 2: migrate legacy tracked clutter

- Decide whether `package/` still has an active packaging role. If not, delete it physically and update `package.json files` / install scripts. If yes, move it under `scripts/packaging/legacy-qoder/` with explicit owner docs.
- Keep `nested/deep/ap003.txt` deleted. The apply_patch self-test checklist must use `tmp/nested/deep/ap003.txt` or another disposable temp path.
- Replace root `rcc` symlink with a generated packaging artifact if package consumers no longer require a tracked root symlink.

Status on 2026-06-08: `package/` and root `rcc` are deleted; `nested/deep/ap003.txt` remains deleted.

Phase 3: consolidate tool state

- Move `.codex-work/`, `.reasonix/`, `.drudge/`, `.clock/`, `clock.md` to `.agent-state/<tool>/` or the tool's user home.
- Move Hypatia/MemPalace state (`.hypatia*`, `hypatia`, `entities.json`, `mempalace.yaml`) to a tool-specific home or `.local-index/<tool>/`.
- Write a model-cache policy for `models/`: either external cache home or an explicit `models/` keep rule with pruning command.

Status on 2026-06-08: root tool/index/model state migrated to `.agent-state/`, `.local-index/`, and `.cache/model-cache/`; root names are forbidden by gate.

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

Status on 2026-06-08: `repo-sanity` root allowlist is split and scans ignored root entries too, so ignored root residue cannot bypass layout checks. It also rejects old root report defaults, non-pack `artifacts/*`, and non-model-cache `.cache/*`.

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

- `webui/`, even if locally ignored;
- `samples/`;
- `vendor/`;
- `~/.rcc/diag` or `~/.rcc/codex-samples`.

2026-06-08 migration decisions:

- `package/` and root `rcc` were deleted after source reference audit.
- `models/`, Hypatia/MemPalace, and agent/tool state were migrated, not deleted.

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
