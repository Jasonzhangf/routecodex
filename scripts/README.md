# Build & Install Scripts

> **AGENTS.md rules apply** – always build shared modules first, never skip verification, never mix dev/release modes.

## Dev CLI (routecodex)

```bash
# 1. build sharedmodule first
npm --prefix sharedmodule/llmswitch-core run build

# 2. build host
cd - && npm run build:dev

# 3. install globally
npm run install:global
```

## Release CLI (rcc)

```bash
# 1. build sharedmodule first
npm --prefix sharedmodule/llmswitch-core run build

# 2. build release variant
npm run build:release

# 3. install globally
npm run install:release
```

## Verification

- Never use `ROUTECODEX_VERIFY_SKIP=1`; golden samples are up-to-date.
- CI runs `npm run build:dev && npm run build:release` with full verification.
