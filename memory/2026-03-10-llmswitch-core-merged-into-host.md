# llmswitch-core merged into host repo

Date: 2026-03-10
Tags: llmswitch-core, sharedmodule, host-repo, merged-layout, build, install, ci

## Summary

- `sharedmodule/llmswitch-core` no longer relies on an external symlink target for local development in this worktree; it is now stored as a real directory inside the host repo.
- The package boundary remains intact:
  - path stays `sharedmodule/llmswitch-core`
  - runtime package stays `@jsonstudio/llms`
- `sharedmodule/llmswitch-core-migrated` was repointed to the in-repo `llmswitch-core`.

## Required merged-layout fixes

- Added `sharedmodule/llmswitch-core/scripts/run-package-bin.mjs` so sharedmodule scripts resolve binaries from either:
  - its own `node_modules` in standalone mode
  - ancestor `node_modules` in merged host mode
- Updated `sharedmodule/llmswitch-core/package.json` to use the resolver helper for `typescript` and `c8`.
- Updated `sharedmodule/llmswitch-core/scripts/tests/run-matrix-ci.mjs` to use the same helper for `c8`.
- Added merged-layout ignore rules in `sharedmodule/llmswitch-core/.gitignore` for:
  - `.npm-cache/`
  - `rust-core/target/`
  - `.beads/`
  - `memory/`
  - `test/node_modules/`
  - `test/dist/`
- Added root `.gitignore` entry for `test-results/`.
- Added root devDependency `c8` so sharedmodule matrix coverage can run inside the host repo.

## Validation

- `node sharedmodule/llmswitch-core/scripts/tests/run-matrix-ci.mjs`
  - result: `✅ Matrix passed`
- `npm run build:dev`
  - result: passed, including global install, CLI health check, and managed restart

## Notes

- The main blocker after directory merge was not runtime code; it was sharedmodule script assumptions about local `node_modules`.
- Root `build:dev` also required the merged sharedmodule files to be added to git, otherwise `repo-sanity` failed on untracked files.
