# V3 Install Interrupt Process-Group Test Design

## Goal

When the isolated V3 installer receives `SIGINT` or `SIGTERM`, every process created by the active install command must stop before its internally owned Cargo target is removed. No descendant may escape the cancellation boundary and continue using the removed target.

## Owner and boundary

- Feature: `v3.global_binary_install`
- Runtime owner: `v3/scripts/install-cli.mjs`
- Test owner: `v3/tests/scripts/install-cli-target-cleanup.spec.mjs`
- Allowed resources: the installer-owned Unix command process group and internally owned Cargo target
- Forbidden effects: broad host process termination, fallback installation, request/response/runtime payload changes, or resurrection of deleted root install scripts

## Lifecycle cases

1. Success removes an internally owned target.
2. Build failure removes an internally owned target.
3. An external target outside V3 is rejected and remains untouched.
4. Spawn failure rejects once and does not wait on an invalid process identity.
5. `SIGINT` terminates the exact owned command group, waits for its descendant to exit, removes the target, and exits with 130.
6. `SIGTERM` terminates the exact owned command group, waits for its descendant to exit, removes the target, and exits with 143.
7. A signal observed before command spawn prevents that command from starting.
8. Windows rejects before command spawn until a Job Object owner exists.

## White-box assertions

- Unix install commands spawn detached as process-group leaders and descendants inherit that exact group.
- Cancellation addresses the negative process-group ID, not a root PID or one-time descendant snapshot.
- Cleanup waits until the process group no longer exists; an `EPERM` existence probe means the group is still occupied, not that cleanup is safe.
- Windows rejects before command spawn; it never starts work that cannot satisfy the tree-cleanup contract.

## Module black-box assertions

- The descendant writes a ready marker without using `ps` or PGID introspection.
- The descendant observes the expected signal, exits while the owned target still exists, and writes an exit marker.
- The installer exits only after the descendant exit marker exists and then removes the owned target.
- A delayed descendant marker is never written after cancellation.
- Installer signal exit codes preserve shell conventions.

## Project black-box impact

- `npm --prefix v3 run test:install-cleanup`
- `npm --prefix v3 run test:distribution`
- `npm --prefix v3 run verify:v3-resource-map`
- `npm --prefix v3 run verify:v3-module-boundaries`
- `npm --prefix v3 run verify:v3-mainline-caller-flow`
- `npm --prefix v3 run install`

## Known gap

The process-group path is exercised on Unix. Windows installation remains explicitly unavailable until a Job Object implementation and Windows descendant lifecycle test exist.
