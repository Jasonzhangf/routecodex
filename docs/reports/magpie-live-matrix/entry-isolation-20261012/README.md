# V3-local support suite entry

The support suite driver now lives only at
v3/scripts/tests/protocol-live-mock-support-selftests.mjs. Root npm test/verify
commands delegate to the existing V3 names. V3 npm and verify-ci call the local
driver. The former root implementation is removed.

The original isolation gate rejected two V3 package scripts that referenced
../scripts/. That true positive is fixed in source; the gate and forbidden-root
red fixture remain unchanged. One report test used cwd-dependent v3/fixtures
and failed after the proper V3 cwd change. It now resolves the same literal
fixture directory from import.meta.url; assertions and fixtures are unchanged.

Both public entries pass all 159 original test identities across 15 files, with
zero skips/todo or duplicates. The original positive isolation gate and red
control pass. Driver sorting, discovery, single Node invocation, syntax check,
timeouts and spawn/nonzero/signal propagation are preserved.

Local validation installs only V3's locked YAML dependency using the repository
CI's declared npm ci --ignore-scripts recipe. This prevents the unrelated
production CLI installation lifecycle. Mandatory tests, isolation positive/red
checks, CI and Git hooks still run normally. No production install/restart,
permissions change, runtime Rust or operator change is part of this delivery.

Historical raw reports and old entry hashes remain versioned records. This
delta updates the current owner and fixes entry behavior. Existing unchanged
live matrix/echo evidence is reused; no new runtime success is inferred.
