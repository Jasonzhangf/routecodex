# RouteCodex CLI Packaging

This directory is used for CLI packaging and release artifacts only.

## Release CLI (@jsonstudio/rcc)

Release builds must use the npm-published `@jsonstudio/llms` dependency and the `rcc` binary.

Build and pack:

```bash
node scripts/pack-mode.mjs --name @jsonstudio/rcc --bin rcc
```

Publish the generated tarball:

```bash
npm publish jsonstudio-rcc-*.tgz
```

## Dev CLI (routecodex)

The `routecodex` CLI is dev-only and must never be published to npm.

For dev work:

```bash
npm run build:dev
npm run install:global
```

## Rules

- Do not publish `routecodex` to npm.
- Do not mix release builds with the dev CLI.
- Do not commit build artifacts; `dist/` is emitted in CI.
