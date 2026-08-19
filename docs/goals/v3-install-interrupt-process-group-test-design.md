# V3 Install Interrupt Process-Group Test Design

## Goal

When the direct V3 installer receives `SIGINT` or `SIGTERM`, every process created by the active install command must stop before its internally owned Cargo target is removed. No descendant may escape the cancellation boundary and continue using the removed target.

## Owner and boundary

- Feature: `v3.global_binary_install`
- Runtime owner: `scripts/install-v3-cli.mjs`
- Test owner: `tests/scripts/install-v3-cli-target-cleanup.spec.mjs`
- Allowed resource: the installer's internally owned Cargo target
- Forbidden effects: broad host process termination, fallback installation, request/response/runtime payload changes

## Lifecycle cases

1. Success removes an internally owned target.
2. Build failure removes an internally owned target.
3. An explicitly supplied target remains untouched.
4. Spawn failure rejects once and does not wait on an invalid process identity.
5. `SIGINT` terminates the exact owned command group, waits for all descendants, removes the target, and exits with 130.
6. `SIGTERM` terminates the exact owned command group, waits for all descendants, removes the target, and exits with 143.
7. A signal observed before command spawn prevents that command from starting.

## White-box assertions

- Unix install commands are process-group leaders and descendants inherit that exact group.
- Cancellation addresses the negative process-group ID, not a one-time descendant snapshot.
- Cleanup waits until the process group no longer exists.
- Windows rejects before command spawn until a Job Object owner is implemented; it never starts work that cannot satisfy the tree-cleanup contract.

## Module black-box assertions

- A descendant scheduled to write into the target after cancellation never writes its marker.
- The owned target is absent only after the command group has exited.
- Installer signal exit codes preserve shell conventions.

## Project black-box impact

- `npm run test:install-v3-target-cleanup`
- `npm run test:v3-cli-distribution`
- `npm run verify:v3-resource-map`
- `npm run verify:v3-module-boundaries`
- `npm run install:v3`

## Known gap

The process-group path is exercised on Unix. Windows installation remains explicitly unavailable until a Job Object implementation and Windows descendant lifecycle test exist.
