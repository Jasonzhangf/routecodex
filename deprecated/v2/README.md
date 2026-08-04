# RouteCodex V2 Archive

This directory contains retired V2 authoring material preserved for historical
reference. It is not an active runtime, build, package, or default test surface.

Retirement metadata is recorded in `retirement-manifest.yml`. Active resource,
function, mainline, and verification maps must not bind files from this archive.

Archived content:

- `architecture/`: retired V2 design and migration documents.
- `consistency/`: retired V1/V2 comparison utilities.
- `monitoring/`: retired V2 dry-run monitoring utilities.
- `smoke/`: retired ad-hoc V2 provider smoke utilities.
- `src/`: retired V2 source notes.
- `tests/`: retired V2 consistency and protocol test sources.

Current development belongs in `v3/`. V3-owned legacy config compatibility,
including `v3/crates/routecodex-v3-config/src/v2_compat.rs`, remains active and
is intentionally not part of this archive.

Do not restore archived files to active root directories. If historical
material must be consulted, reference it in place and keep runtime changes in
the registered V3 owner.
