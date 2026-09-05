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
