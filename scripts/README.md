# Build & Install Scripts

> `AGENTS.md` rules apply: no fallback, no mixed dev/release semantics, and no success claims without live evidence.

## Dev Install (`routecodex`)

```bash
npm run install:global
```

Properties:

- Owner: `scripts/install-global.sh`
- Mode: dev
- Runtime source: global npm package + local `sharedmodule/llmswitch-core` dev link
- Verification: CLI availability; callers still need scoped restart + `/health` for runtime-change closure

## Release Install (`rcc`)

```bash
npm run install:release
```

Properties:

- Owner: `scripts/install-release.sh`
- Mode: release snapshot
- Runtime source: `~/.rcc/install/current`
- Verification: script itself performs isolated build, dependency preparation, `rcc restart --port ${ROUTECODEX_INSTALL_VERIFY_PORT:-5520}`, and `/health`

## Removed Legacy Scripts

- `scripts/install.sh` and `scripts/quick-install.sh` are deleted intentionally.
- They were destructive or misleading second implementations and must not be restored.

## Verification

- Never use `ROUTECODEX_VERIFY_SKIP=1`; golden samples are up-to-date.
- CI/build callers must still run the task-specific gates required by the active change.
