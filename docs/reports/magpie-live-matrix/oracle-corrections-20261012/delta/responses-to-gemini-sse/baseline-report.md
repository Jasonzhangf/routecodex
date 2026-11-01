# Magpie Live Mock-Provider Baseline

- status: `baseline_completed_with_failures`
- source status: `baseline_completed_with_failures`
- unique cases: `1`
- entries: `1`
- passed: `0`
- failed: `1`
- not_run: `0`
- infra_failure: `0`
- duplicate case ids: none

## Identity Boundaries

### Runtime Identity

- kind: `installed`
- path: `/Users/fanzhang/.local/bin/rccv3`
- version: `rccv3 0.90.4887 (crate 0.1.0)`
- sha256: `5c1672a562c32c4c996b2ce6c83f552e8e271c4266256a34a0f4fc2a5847a563`

### Source / Candidate Identity

- repo: `unknown`
- source sha: `88715b2fe74ce4e6254f4d29ef1528b6848d4dff`
- fixture sha: `bfaedf18301d02a423bd5422d22e41432d231ab8`
- fixture digest: `27afdd718dcd692ca2fc7e75538f8d831e70736228b4a33758b60f9c03f70045`
- config check exit: `not_run`
- config check and source declarations are setup evidence only; they are not live matrix success.

## Case Results

| case_id | entry | provider | transport | mode | status | diagnostic | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| responses-to-gemini-sse | responses | gemini | sse | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client body_must text missing; client body_must status missing; client body_must output_items.0.type missing; client body_must output_items.0.role missing; client body_must output_items.0.content.0.type missing; client body_must output_items.0.content.0.text missing; semantic terminal missing from client output | captures/responses-to-gemini-sse-turn-1-provider.json, captures/responses-to-gemini-sse-turn-1-client.json |

## Base Matrix

| entry | provider | status | variants | case_ids |
| --- | --- | --- | --- | --- |
| openai_chat | openai_chat | not_covered | json/direct: not_run (0); sse/direct: not_run (0); json/relay (supplemental): not_run (0) |  |
| openai_chat | responses | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| openai_chat | anthropic | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| openai_chat | gemini | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| responses | openai_chat | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| responses | responses | not_covered | json/direct: not_run (0); sse/direct: not_run (0); json/relay (supplemental): not_run (0) |  |
| responses | anthropic | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| responses | gemini | covered_with_failures | json/relay: not_run (0); sse/relay: failed (1) | responses-to-gemini-sse |
| anthropic | openai_chat | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| anthropic | responses | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| anthropic | anthropic | not_covered | json/direct: not_run (0); sse/direct: not_run (0); json/relay (supplemental): not_run (0) |  |
| anthropic | gemini | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| gemini | openai_chat | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| gemini | responses | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| gemini | anthropic | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| gemini | gemini | not_covered | json/direct: not_run (0); sse/direct: not_run (0); json/relay (supplemental): not_run (0) |  |

## Boundary Scope

- none

## P2 Handoff

### provider_attempt_count

- `responses-to-gemini-sse`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client body_must text missing; client body_must status missing; client body_must output_items.0.type missing; client body_must output_items.0.role missing; client body_must output_items.0.content.0.type missing; client body_must output_items.0.content.0.text missing; semantic terminal missing from client output

## Infrastructure Failures

- none

## Cleanup

- complete: `true`
- cases: `[object Object]`

## Evidence References

- root: `/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/oracle-author/delta/responses-to-gemini-sse`
- root persistent: `true`
- `captures/responses-to-gemini-sse-turn-1-provider.json` (persistent: `true`)
- `captures/responses-to-gemini-sse-turn-1-client.json` (persistent: `true`)
