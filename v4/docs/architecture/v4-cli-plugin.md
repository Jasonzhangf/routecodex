# V4 CLI Plugin

状态：`contract_bound`。Owner：`routecodex-v4-cli-plugin`。
合同：`v4/contracts/cli-plugin.contract.json`。

## Scope

`rccv4-plugin` is a deterministic, read-only projection of the active V4
standard plugin library. It exposes version, plugin descriptors, resource
registry, node permissions, the aggregate surface, and category counts.

The CLI consumes `routecodex-v4-standard-plugins` through the declared
`v4.cli.standard_library_projection` resource. It does not start or stop a
server, bind a port, read runtime configuration, manage processes, or mutate
runtime state.

Unknown plugin and node identifiers fail with a non-zero exit code. List and
projection output is derived from the typed registry and remains deterministic.

## Commands

```text
rccv4-plugin version
rccv4-plugin list-plugins
rccv4-plugin describe-plugin <plugin-id>
rccv4-plugin list-resources
rccv4-plugin node-permissions <node-id>
rccv4-plugin surface
rccv4-plugin categories
```

The build artifact is `rccv4-plugin` under AppSDK's module `lib` root, produced
from the Cargo release binary and copied to
`generated/modules/routecodex-v4-cli-plugin/lib/`.

## Verification

- `v4_cli_plugin_l2_regression`: locked unit tests, release build, and
  `scripts/test-cli-plugin.mjs` subprocess smoke coverage for all seven
  commands plus unknown-plugin/node failures.
- `v4_parity_gate_cli_plugin`
- `v4_parity_gate_cli_plugin_red`

## Review evidence producer

`scripts/appsdk-project-lifecycle-adapter.mjs --module routecodex-v4-cli-plugin`
owns pre-review observations for this CLI. It requires a clean named owner
worktree, compiles through AppSDK, runs the declared regression, installs the
compiled executable into an isolated prefix, then runs all command smoke tests
against that installed path. `deployment_operations` is `["install"]`: this
read-only command has no daemon or restart operation.

The producer retains transcripts with the installed executable and binds the
candidate, compiled artifact, environment and entrypoint into its evidence.
It refuses existing candidate/validation records rather than overwriting
history. Other modules fail before any mutation until their real producer is
implemented. Review, merge, promotion and freeze remain separate operations;
this adapter does not emit their records or infer their success.

Run `node --test scripts/test-lifecycle-adapter.test.mjs` for failure-boundary
regressions. The command smoke test accepts `--binary <installed-path>` and
fails if that file cannot execute; it never substitutes the source binary.
# Source integration and release evidence

`verify:ci` / `verify:local` select contract-mode runtime admission and AppSDK
`verify --admission`. They run the full workspace, architecture/red, Active-linked
consumer and index/isolation matrix, but do not certify historical deployment or
publish/freeze evidence. Explicit `verify` retains full AppSDK `verify` and live
runtime admission. Source merge is not release/freeze approval.

During the 2026-09-05 integration, the unchanged base-node EffectivenessRecord
predates its referenced replay evidence. Full SDK verification correctly rejects
that history with `POST_ARCHITECTURE_EFFECTIVENESS_EVIDENCE_MISMATCH`. The record
and Protected archives are preserved; source integration must not describe this
as repaired, grant publication, or rewrite historical timestamps.
