# REQ02 mixed history and tool namespace integration receipt

Status: the mixed-history/namespace slice is integrated into the isolated parent
candidate and its listed public regressions pass. REQ02 is INCOMPLETE; no new
production caller wiring, implementation review, merge, push, install, or restart
is claimed.

## Candidate identity

- Parent: `/Volumes/Intel/playground/routecodex/dagpipe-req02-cutover-20261002`.
- Branch: `codex/dagpipe-req02-cutover-20261002`.
- HEAD: `a9952cc748f417caa675025f20ae1e51323d0c79`, with task-owned dirty/untracked
  candidate content. HEAD alone does not identify the candidate tree.
- Latest fetched origin/main: `2fde74987ed8079c36961bd7bb0c8c07348cb4b9`.
  Source composition has not yet completed the final Git ancestry merge.
- Final slice inputs: `req02-mixed-parent-final-r17.sha256` in this directory.

## Completed source changes

1. Responses explicitly registers its observed Chat-compatible `messages`
   contribution. One compiled fold consumes `messages` then `input` before
   instructions flush and immutable request-pair publication.
2. Equivalent representations across the two sources alias one canonical
   occurrence while retaining all original source associations. Equal entries
   within one source, differing opaque outputs, unknown-field conflicts, and
   partial non-tool overlap remain distinct.
3. Instruction inverse selectors remain bound to instructions; only configured
   history contributions receive folded message indices.
4. Chat-style tool results do not acquire a guessed function/custom kind.
   Explicit kind conflicts remain distinct; custom patch text stays complete.
5. The shared OpenAI tool-call handler preserves the original namespace value
   in typed history, including absent versus explicit null. No model guessing
   or tool parameter interpretation was added.
6. Removed the unused item-path copy/assertion; original paths remain in inverse
   and history. Mixed sources are handled within REQ02, without another decoder,
   protocol pipeline, node, or control payload mirror.
7. Maps/profile inventory and review surfaces are synchronized with actual
   resident caller bodies; the typed error-chain constraints remain enforced.

## Bound results

| Boundary | Result | Raw evidence |
| --- | --- | --- |
| Seven public normalization/tool/mixed suites | 26 passed, exit 0 | `.execution/req02-parent-mixed-public-r16.log` |
| Ten image/response/resource consumer suites | 35 passed, exit 0 | `.execution/req02-parent-all-consumers-r16.log` |
| Additional two-protocol namespace consumers | 4 passed, exit 0 | `.execution/req02-parent-namespace-presence-r16.log` |
| Parent operation-runner development tests | 51 passed, exit 0 | `.execution/req02-parent-mixed-runtime-operation-r16.log` |
| Request graph static topology | 9 nodes, 9 edges, 9 waves; exit 0 | `.execution/req02-parent-request-graph-r16.log` |
| Operator/profile gate, resource map, Provider action | exit 0; 48 real caller edges | `.execution/req02-parent-operation-r17.log`, `req02-parent-resource-map-r17.log`, `req02-parent-provider-action-r17.log` |
| Hub file topology after caller-map correction | exit 0; 403 bindings | `.execution/req02-parent-topology-r17.log` |
| Parity aggregate, its semantics and remote namespace contract | exit 0; 132 forbidden mutations rejected | `.execution/req02-parent-parity-ci-r17.log` |
| Existing HTTP Chat-to-Responses tool round trip | 1 passed, exit 0 | `.execution/req02-parent-http-roundtrip-r17.log` |
| Existing WebSocket runtime/completed entry | 1 passed, exit 0 | `.execution/req02-parent-ws-roundtrip-r17.log` |
| Existing HTTP provider JSON entry | 1 passed, exit 0 | `.execution/req02-parent-http-provider-lock-released-r17.log` |
| Existing Direct provider-failure/default filter | No test executed (0 passed, 76 filtered out); acceptance missing | `.execution/req02-parent-http-direct-failure-r17.log` |
| Current Direct real terminal HTTP error entry | 1 passed, exit 0 | `.execution/req02-parent-http-direct-real-error-r17.log` |
| Current Direct provider failure/reselection entry | 1 passed, exit 0 | `.execution/req02-parent-http-direct-reselect-r17.log` |

The HTTP/WS cases use the existing runtime consumers. They do not establish the
new normalization caller cutover or real GCM gpt-5.5/gpt-5.6 exec/apply_patch/MCP
execution and follow-up acceptance.

The obsolete Direct filter was replaced in the verification map by the two
current Direct tests listed immediately below it. Both actually executed and
passed; the original zero-test invocation remains recorded as non-evidence.

The isolated implementation tree additionally ran full runtime lib: 1139 passed,
0 failed, 1 pre-existing ignored. That run preceded the later removal of unused
item-path storage and formatting; the affected final parent operation-runner
tests are listed separately above.

## Causal evidence and failed attempts

- Original custom namespace public red: typed history was `None` while input
  namespace was `Some("functions")`.
- Returning the namespace recording point to its old `None` condition made both
  explicit-null protocol cases fail again: 2 passed / 2 failed, exit 101.
- Restoring the verified library (byte-identical `cmp`) returned all four cases
  to green. Raw red/green files are preserved in this evidence directory.
- The initial complete architecture umbrella returned exit 1, 37/40 green.
  Two failed areas are now corrected with the targeted results above. It has
  not been reported as a final complete-umbrella PASS.
- One additional HTTP test invocation returned exit 86 before running its case:
  another canonical Cargo test owned the same target lock. The owner was this
  task's parity aggregate. After its exit 0 and lock release, the same test ran
  successfully. No lock was deleted and no product retry/fallback was added.

## Remaining gates

1. `chain:v3.provider_action_gate.mainline` manual audit lock refresh. The project
   gate requires Jason authorization; the proposed before/after fingerprints and
   exact scope are in `req02-provider-action-lock-refresh-proposal-20261003.md`.
   No authorization has been fabricated and the lock remains unchanged.
2. The externally owned REQ06 worktree still lacks the admitted
   `project_canonical_request(...) -> ProjectedRequest` helper. Its native request
   mirror/control slot is not accepted or imported. The parent has not created a
   second projection implementation.
3. Final latest-main composition, actual caller replacement, isolated full
   HTTP/WS/Direct/Relay/JSON/SSE paths, both GCM models' actual three-tool round
   trips, candidate build/install/restart/live samples, independent architecture
   review, clean main integration/remote receipt, and final owned cleanup.

## Worker resource receipts

Both new GCM workers exited 0; their exact contributions, logs, and raw JSON
events are preserved in the parent. Their task-specific CODEX_HOME directories
were removed, with `test ! -e` passing. The dirty candidate worktrees remain
available for the unfinished REQ02 integration; no other owner's worktree or
process was removed. The shared 4444 runtime was not installed, stopped, killed,
or restarted during this slice.
