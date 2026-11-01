# Magpie live mock-provider matrix - final verification packet

Status: author-prepared packet for one whole independent Review. No Review
verdict, commit, push, PR, or merge has been taken. The raw baseline is not
modified by this packet.

This packet makes the P1 live mock-provider baseline and its later author
corrections durable and portable. It contains test infrastructure and evidence
only. No runtime, operator, provider, or production file is changed.

## 1. Identity boundaries

Source identity and runtime identity are separate facts. A source SHA never
proves the provenance of an installed binary.

| Layer | Value |
| --- | --- |
| Worktree creation base | `88715b2fe74ce4e6254f4d29ef1528b6848d4dff` |
| Latest `origin/main` combined | `f7fc9e17b9a0f7fb66f3dc906c8808634e551334` (PR #390, raw reasoning content preserve) |
| Candidate merge commit (composed here) | `0933138b22613c151e4ddd016116a86802ab5b72` |
| Magpie reference repo | `https://github.com/yetone/magpie` |
| Magpie reference SHA | `bfaedf18301d02a423bd5422d22e41432d231ab8` (MIT, notice at `v3/fixtures/protocol-live-mock-matrix/LICENSE.magpie`) |

Installed runtime identities are deliberately distinct:

| Run | Binary | Version | sha256 |
| --- | --- | --- | --- |
| Original 48-case baseline | `/Users/fanzhang/.local/bin/rccv3` | `0.90.4886` | `282e05b774026bbbea7ceb8cdeaee9364576b13e61396be30e97950587680851` |
| Delta replays (oracle-author, G4) | `/Users/fanzhang/.local/bin/rccv3` | `0.90.4887` | `5c1672a562c32c4c996b2ce6c83f552e8e271c4266256a34a0f4fc2a5847a563` |

The candidate merge contains no runtime source change of our own. The only
runtime source delta brought in by the merge is upstream main's
`responses_sse_tree.rs` reasoning-content change (PR #390), which is not part of
this delivery's proof and was not rebuilt or installed here.

## 2. Initial strict baseline (raw, unchanged)

Path: `docs/reports/magpie-live-matrix/installed-baseline-20261012/`

- unique cases: `48`
- passed: `12`
- failed: `36`
- not_run: `0`
- infrastructure failures: `0`
- runner failures: `0`
- product assertion mismatches: `187`
- cleanup: `complete = true` for all 48 cases

These 36 failures are raw observations. They are **not** 36 confirmed operator
bugs, and the 187 mismatches are **not** 187 defects. See section 4.

## 3. Author fix and delta results

The helper suite is the targeted author suite for this change:

```text
npm run test:protocol-live-mock-support
# 151 tests, pass 151, fail 0, skipped 0, 8/8 node test files (exit 0)
```

Oracle-author delta replays (installed `0.90.4887`), archived under
`oracle-author-delta-20261012/delta/`:

| case | status | provider attempts | note |
| --- | --- | --- | --- |
| anthropic-to-anthropic-json | passed | 1 | strict oracle corrected |
| chat-to-anthropic-json | passed | 1 | strict oracle corrected |
| chat-to-responses-json | passed | 1 | strict oracle corrected |
| chat-to-responses-sse | passed | 1 | Responses text/status read from real fields |
| responses-to-anthropic-sse | passed | 1 | strict oracle corrected |
| responses-to-chat-sse | passed | 1 | strict oracle corrected |
| responses-to-gemini-sse | failed | 0 | keepalive then cut, no provider attempt |

Result: 6 passed / 1 failed, cleanup complete for 7/7. The single remaining red
case is a preserved product observation, not a harness pass.

G4 / close-observation delta replays (installed `0.90.4887`), archived under
`docs/reports/magpie-live-matrix/delta-replay-20261012/` and
`docs/reports/magpie-live-matrix/g4-fault-integrate-20261012/`:

| case | status | provider attempts | note |
| --- | --- | --- | --- |
| provider-fault-stream-cut | passed | 2 | distinct same-tier identities, recovered response |
| provider-error-exhaustion | passed | 1 | real 429, empty closed client, no error payload |
| chat-to-chat-json | passed | 1 | single-candidate control |
| tool-followup-responses-to-chat | failed | 2 | observer bug fixed; strict wire/projection mismatch remains |

## 4. Triage is author input, not a verdict

`oracle-author-delta-20261012/triage.json` classifies the 36 raw baseline
failures into buckets. It is an input to Review, not a Review finding:

| Bucket | Count |
| --- | --- |
| wire-representation delta, needs contract clarification | 5 |
| fixture / oracle / test-infrastructure author defect | 6 |
| confirmed product observation | 21 |
| unresolved product observation | 4 |

Do not restate this as "36 bugs" or "187 defects". Two examples must stay
unresolved at full-semantics level rather than wire-only level:

- `namespace-custom-complete-args`: the mock callee is advertised in wire tools
  with complete arguments, but the client received zero bytes; the fixture also
  pairs a `stream=false` request with an SSE mock. Mechanism unresolved.
- `media-anthropic-older-turn-tool-image`: image-byte preservation alone does
  not prove full role, order, and tool-result semantics for the older turn.

## 5. Runtime gap candidates (unchanged vs unresolved)

This round preserves product gaps; it does not fix runtime operators.

| case | classification | state |
| --- | --- | --- |
| `namespace-custom-complete-args` | confirmed product observation | empty client response, 0 bytes |
| `responses-to-gemini-sse` | unresolved product observation | 0 provider attempts, keepalive then cut |
| `tool-followup-responses-to-chat` | product observation | strict wire/projection mismatch after observer fix |
| `media-anthropic-older-turn-tool-image` | unresolved full semantics | not reducible to image bytes |
| `chat-to-gemini-sse` | coverage gap | provider used `:generateContent`, expected `:streamGenerateContent` |

The dominant real observation reported by triage is that outbound projection to
the Gemini target (and the Gemini entry path) plus `anthropic -> openai_chat`
are not wired in the installed build. This is an author classification and
needs Review confirmation.

## 6. Fault same-tier identity proof

`provider-fault-stream-cut` now declares two providers in one pool tier, each
with one auth key and the same model. The replay proves:

- exactly 2 business provider POSTs, both wire model `chat-model`;
- Authorization order `fake-loopback-token-mock-chat-a` then
  `...-mock-chat-b`, one of the two declared orders, so this is a distinct
  identity reselection and not a same-candidate retry;
- `candidate_identity_receipts.tier_count = 1` with two declared candidates;
- the client received the complete recovered response with no cut and no `EOF`.

## 7. Empty-close regression

`g4-fault-integrate-20261012/` fixes an observer bug in `case-runner.mjs`:
`observeClientResult()` stored a failed parse as `observation`, so a real
zero-byte close was read as a parsed payload and the strict
`transport = "closed"` check failed. The fix keeps `observation` only when the
parse succeeds and records `parse_diagnostic` separately. A red control with the
old normalization fails as expected; a real non-empty HTTP 200 body still fails
the closed expectation. After the fix, `provider-error-exhaustion` passes with a
real 429, empty body, `closed = true`, and no provider error payload.

## 8. Actual echo live roundtrip (native positive control)

`native-positive-control-20261012/` archives a native `openai_chat -> openai_chat`
direct control that runs through the real loopback RCC entry:

- turn 1 SSE completes `call_direct_echo_control` / `echo` / `{"text":"control-42"}`;
- the consumer executes echo once and submits `control-42`;
- turn 2 shows the second provider POST with the same call id and the paired
  tool result `control-42`;
- client HTTP 200, `behavior_pass = true`, owned listeners and mock closed.

Boundary: the control was captured against an earlier helper revision
(`protocol-semantics.mjs` `57b41ee9`, `case-runner.mjs` `20cee0cb`,
`lifecycle.mjs` `a0b6155b`). The current helper revision is
`41a3eea3` / `4db6b3d0` / `e900bfeb`. The control is retained as a product-level
roundtrip proof; it is not re-bound to the current helper revision.

## 9. Standard source fixture changes

The oracle-author changed 6 owned helper/test files and 7 fixtures. Those
fixture changes are contract-based corrections, not golden edits to turn a case
green:

- Responses SSE fixtures use `status` and message / `output_text` fields;
- the Chat usage fixture adds `stream_options.include_usage = true` and keeps
  the original usage golden;
- `assert_tool_executed_once` must bind to the actual echo consumer, so static
  namespace history cannot claim a tool ran.

All 13 declared source hashes in `oracle-author-delta-20261012/receipt.json`
match the candidate source.

## 10. Repro commands and raw paths

```sh
# targeted author suite
npm run test:protocol-live-mock-support

# one delta replay (installed binary, isolated loopback)
node v3/scripts/tests/v3-protocol-live-mock-matrix.mjs \
  --case <case_id> --binary-kind installed \
  --evidence <evidence_dir> --report-path <report.md>
```

Raw and archived paths:

- initial baseline: `docs/reports/magpie-live-matrix/installed-baseline-20261012/`
- G4 delta: `docs/reports/magpie-live-matrix/delta-replay-20261012/`
- close-observation fix: `docs/reports/magpie-live-matrix/g4-fault-integrate-20261012/`
- oracle-author delta + triage: `docs/reports/magpie-live-matrix/final-verification/oracle-author-delta-20261012/`
- native positive control: `docs/reports/magpie-live-matrix/final-verification/native-positive-control-20261012/`

## 11. Cleanup

- Original 48-case baseline cleanup: complete, 48/48.
- Oracle-author delta cleanup: complete, 7/7.
- G4 delta and close-observation cleanup: complete.
- Native positive control cleanup: child exit 0, both owned listeners closed,
  mock closed, config/state removed.

No production service, real provider config, or shared listener was touched.
The Magpie reference clone is retained for P2/P3.
