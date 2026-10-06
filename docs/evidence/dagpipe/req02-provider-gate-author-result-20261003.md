# REQ02 Provider Gate Author Result

## Scope

- Task: repair only the provider-action-gate architecture anchors after the
  Responses, Anthropic, and shared Relay lifecycle wrappers were split from
  their resident business bodies.
- Baseline: `HEAD=2fde74987ed8` plus the existing frozen parent snapshot.
- No business/runtime source was changed by this task.
- No runtime install, restart, commit, push, merge, or worktree change was made.
- This result proves static architecture binding only. It does not claim REQ02
  delivery, runtime behavior, or real tool E2E.

## Root Cause

The public gate was still binding provider failure, recovery, permit, and
success edges to the wrapper symbols. The real calls are in:

- `execute_v3_responses_relay_runtime_resident`
- `execute_v3_anthropic_relay_runtime_resident`
- `execute_v3_relay_runtime_resident`

The shared Relay wrapper is defined in
`relay_runtime_core/request_scope.rs` via `include!`, while the resident body
remains in `relay_runtime_core.rs`.

The Responses request-failure branch extraction also searched the wrapper body,
so it missed the real compat/wire branches in the resident body.

## Changes

- Retargeted the provider-action-gate machine edges to the resident symbols:
  - Responses edges `01, 02, 10, 20, 25, 45`
  - Anthropic edges `11, 21, 23, 26, 28, 46`
  - Shared Relay edges `12, 13, 22, 27`
- Kept each edge's existing `caller_file`, callee, status, owner, and
  exact-call witness. No gate count or admission rule was relaxed.
- Moved the Responses compat/wire branch body extraction to the resident
  function.
- Added explicit wrapper-to-resident delegation checks for Responses,
  Anthropic, and shared Relay. The shared wrapper check reads the included
  `request_scope.rs` file directly.
- Added negative fixtures that remove resident failure, recovery, and permit
  calls while placing a matching fake call in the wrapper. The gate must still
  fail from the resident body.
- Added a negative fixture for the shared wrapper-to-resident delegation and
  explicitly copied the new include file into the fixture surface.
- Synchronized the provider-action-gate chain in
  `v3-mainline-call-map.yml` and
  `v3.provider_action_gate.mainline.yml`.
- Recorded the resident/wrapper ownership lock in the provider-action-gate
  wiki.

## Verification

| Command | Exit | Evidence |
| --- | ---: | --- |
| `node v3/scripts/architecture/verify-v3-provider-action-gate.mjs` | 0 | `.execution/req02-provider-gate-green.log` |
| `node v3/scripts/tests/v3-provider-action-gate-red-fixtures.mjs` | 0 | `.execution/req02-provider-gate-red-fixtures-after-anchor-edit.log` |
| `node --check` on the three modified scripts | 0 | `.execution/req02-provider-gate-node-check.log` |
| `git diff --check` | 0 | `.execution/req02-provider-gate-diff-check.log` |

The green gate reports 48 required machine edges, all declared symbols found,
all caller bodies invoking their declared callees, and map/manifest bindings
synchronized. The negative suite reports 59 forbidden mutations rejected.

The pre-edit red run is preserved at
`.execution/req02-provider-gate-pre-edit.log`; its SHA-256 is identical to the
provided red log `.execution/req02-provider-action-anchors-red-r13.log`.

## Evidence Hashes

Current hashes are recorded in `.execution/req02-provider-gate-sha256.txt`.
The exact tracked-file diff is recorded in
`.execution/req02-provider-gate-modified.diff`.

## Boundary

This change fixes the static gate owner and its regression fixtures only.
Runtime build/install/restart, live provider replay, tool round-trip E2E,
review, merge, push, and REQ02 delivery remain outside this task.
