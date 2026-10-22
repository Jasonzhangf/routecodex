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

## Provider config contract

`provider/<id>/config.v2.toml` is the current V3 provider-directory input
format. The `v2` filename and `V2Provider*` Rust struct names are retained for
format compatibility; they do not select a V2 runtime, V2 root config reader,
or migration path. `V3ConfigStore` and `V3UserConfigStore` read only the exact
referenced Provider file and compile it into the V3 authoring and manifest
chain. No parse failure falls back to another file or format. The retired V2
root config compiler and V2 runtime are not supported.

## Boundary

- `v3/` is active production source.
- V2 retired source is not present in this repository and must not be restored
  as an active runtime, build, package, or default test surface.
- Do not add new top-level `src/v2`, `tests/v2`, `scripts/v2-consistency`, or
  `docs/v2-architecture` trees.
