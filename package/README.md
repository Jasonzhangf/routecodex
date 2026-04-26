# RouteCodex CLI Packaging

This directory is used for CLI packaging and release artifacts only.

## Release CLI (rcc)

Release installs are now built from this repository source and installed globally as `routecodex` + `rcc` shim.

Build and install:

```bash
npm run install:release
```

## Dev CLI (routecodex)

The `routecodex` CLI is dev-only for iterative development.

For dev work:

```bash
npm run build:dev
npm run install:global
```

## Rules

- Release no longer depends on publishing legacy npm rcc tarballs.
- Do not mix release builds with the dev CLI.
- Do not commit build artifacts; `dist/` is emitted in CI.
