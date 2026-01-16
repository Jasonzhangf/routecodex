## CI Regressions (Tool Shape)

This folder stores **non-context** tool-shape regressions captured from real Codex samples.

- `apply_patch/`: JSON snapshots of apply_patch argument failures/fixes (format/json/prefix issues).
- These are intended for CI regression (deterministic inputs, no secrets).

Capture sources:
- User-local: `~/.routecodex/golden_samples/ci-regression/**`
- Repo: this folder (promoted via sync script)

