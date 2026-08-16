# V4 Active-Only Artifact Linking — Test Design

Design ID: `V4-ACTIVE-LINK-001`
Date: 2026-08-15
Scope: red tests must precede formal implementation; this design is the required
pre-implementation test contract for the BaseNode first-consumer layer
(`routecodex-v4-edge`).

## 1. Lifecycle under test

```text
freeze/publish (appsdk, unchanged)
  -> Active artifact + records (immutable)
  -> resolver (routecodex-v4-build-link) compiles index from Active + records
  -> consumer link surface (rustc --extern via resolver)
  -> edge build/test through Active surface only
```

No runtime code is touched; verification is the actual build consumer path
(edge build + l1 tests). Where a gate changes (workspace build entrypoint,
edge regression), the gate wiring change is part of the same change set and is
itself verified by CI.

## 2. White-box tests (resolver unit)

| test | positive | negative (red) |
|---|---|---|
| identity parse | artifact.json + current.json + freeze record resolve exact identity | malformed/missing identity -> ActiveLinkErr01 |
| manifest/index | deterministic index; manifest_hash stable across regen | schema/unknown field -> ActiveLinkErr02 |
| artifact presence | rlib path exists under active root | version absent -> ActiveLinkErr03 |
| artifact hash | recomputed sha256 matches artifacts[].hash | flipped byte -> ActiveLinkErr04 |
| public API hash | recomputed per appsdk algorithm matches record | record tamper -> ActiveLinkErr05 |
| source commit | freeze record source_commit_or_tag matches | commit mismatch/absent -> ActiveLinkErr10 |
| target triple | rustc host == index target | cross-target request -> ActiveLinkErr06 |
| dependency closure | recursive dep identities match dependency_hashes | dep hash/version swap -> ActiveLinkErr07 |
| path safety | all components regular, inside active root | symlink / `..` escape -> ActiveLinkErr09 |
| records | freeze/promotion/review/evidence graph present | stale/absent record -> ActiveLinkErr10 |
| immutability | resolver opens read-only; consumer write rejected | write attempt -> ActiveLinkErr11 |

Baseline red evidence already captured (playground, 2026-08-15):

| negative case | current evidence |
|---|---|
| tampered rlib byte | recomputed hash `1bc81f4e…` != recorded `8d2c8214…` |
| missing Active version | `active-v9` artifact.json absent (MISSING_ACTIVE_V9) |
| target mismatch | requested x86_64-apple-darwin vs host aarch64-apple-darwin |
| symlink | playground `evil-link.rlib` detected as symlink |
| stale/missing record | mutable config has no freeze record (FREEZE_RECORD_MISSING) |
| frozen-source path edge live today | `cargo test -p routecodex-v4-edge --test l1_edge` passes via Cargo path dep (red for future forbidden-edge gate) |

## 3. Module black-box tests (edge, first consumer)

Positive:

- edge builds with resolver-emitted `--extern routecodex_v4_base_node=<active rlib>` and no Cargo path dep.
- `l1_edge` regression passes from the Active surface.
- public API black-box consumer (like the playground `consumer.rs`) compiles and runs without reading frozen source.

Negative:

- Cargo path edge `routecodex-v4-base-node = { path = "../routecodex-v4-base-node" }` is mechanically rejected by the architecture gate (red test: gate fails while edge manifest still carries the edge).
- resolver rejects consumer reads of Playground/Protected/Generated.

## 4. Project black-box gates

- `cargo fmt --all -- --check`
- `cargo test --workspace` (frozen consumers through resolver entrypoint)
- `cargo build --release --workspace` (same entrypoint)
- `appsdk verify v4` and `appsdk verify --admission v4`
- module regressions: base-node l0 (12), edge l1 (11), control l2 (15), error l2 (23), config l2 (15), error doc compile-fail
- Active/Protected/record graph hash audit; architecture gate for unregistered/duplicate resolver edges
- CI job `v4-appsdk-admission` (macOS admission) plus the `v4-build` job (macos-14) running
  V4 canonical `verify:ci` (resolver gate + forbidden-edge scan integrated)

## 5. Known gaps recorded

- Existing frozen artifacts have no `target_triple`; index binds host triple for existing versions; future freezes record target explicitly.
- `public_api_hash` is artifact-entry derived (reproducible today: recompute matches `95f9248e…` for base-node); true API-surface extraction is a future-freeze item.
- Edge is frozen; if rebuilding through the resolver changes edge artifact bytes, a deliberate re-freeze (evidence -> review -> promotion -> freeze) is required with Jason-approved reason.
- Workspace gate amendment (resolver entrypoint) is part of the same change set.

## 6. Historical-version identity selection amendment

Design ID: `V4-ACTIVE-RESOLVE-PREFILTER-001`

When more than one immutable Active version exists, dependency selection is by
the exact `dependency_hashes[].artifact_hash`, not by directory order. The
resolver first reads each candidate's recorded artifact hash, rejects duplicate
matches as ambiguous, and only then runs the complete resolver validation for
the unique matching version. A matching candidate still must pass artifact
recomputation, record graph, target, dependency closure, and rustc validation.

Paired gates:

- positive: a current dependency resolves even when an older nonmatching
  version has archived records;
- negative: duplicate matching hashes are rejected as ambiguous;
- negative: no matching version remains `ActiveLinkErr07`;
- negative: stale records on the selected version remain
  `ActiveLinkErr10`—prefiltering never bypasses selected-version validation.
