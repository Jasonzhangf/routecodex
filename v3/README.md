# RouteCodex V3

V3 is the primary RouteCodex implementation. New runtime, routing, protocol,
provider, lifecycle, CLI, and architecture work belongs in this workspace and
its registered root-level support scripts.

## Primary entry points

- Rust workspace: `v3/Cargo.toml`
- CLI crate: `v3/crates/routecodex-v3-cli`
- Installed command: `rccv3`
- Default config: `~/.rcc/config.v3.toml`
- Architecture maps: `docs/architecture/v3-*.yml`
- Mainline review surface: `docs/architecture/wiki/v3-mainline-caller-flow.md`

## Build and verify

```bash
npm run verify:v3-architecture-ci
npm run test:v3-workspace
npm run install:v3
rccv3 --help
```

For validation-only root builds, disable package version mutation:

```bash
ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base
```

## Boundary

- `v3/` is active production source.
- `deprecated/v2/` is historical reference only and is not an active runtime,
  build, package, or default test surface.
- V3-owned compatibility readers such as `v2_compat.rs` and support for
  `config.v2.toml` remain active inside V3. They translate legacy config input
  into V3 contracts and must not be moved into the archive.
- Do not add new top-level `src/v2`, `tests/v2`, `scripts/v2-consistency`, or
  `docs/v2-architecture` trees.
