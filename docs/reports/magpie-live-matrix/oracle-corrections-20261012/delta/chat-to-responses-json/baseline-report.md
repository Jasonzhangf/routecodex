# Magpie Live Mock-Provider Baseline

- status: `passed`
- source status: `passed`
- unique cases: `1`
- entries: `1`
- passed: `1`
- failed: `0`
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
- fixture digest: `6954d6ec6d2b4c0090ec876bd274bd64b412534d4de009b94c51dbd536cc3d2b`
- config check exit: `not_run`
- config check and source declarations are setup evidence only; they are not live matrix success.

## Case Results

| case_id | entry | provider | transport | mode | status | diagnostic | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| chat-to-responses-json | openai_chat | responses | json | relay | passed | case flow assertions passed | captures/chat-to-responses-json-turn-1-provider.json, captures/chat-to-responses-json-turn-1-client.json |

## Base Matrix

| entry | provider | status | variants | case_ids |
| --- | --- | --- | --- | --- |
| openai_chat | openai_chat | not_covered | json/direct: not_run (0); sse/direct: not_run (0); json/relay (supplemental): not_run (0) |  |
| openai_chat | responses | not_covered | json/relay: passed (1); sse/relay: not_run (0) | chat-to-responses-json |
| openai_chat | anthropic | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| openai_chat | gemini | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| responses | openai_chat | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| responses | responses | not_covered | json/direct: not_run (0); sse/direct: not_run (0); json/relay (supplemental): not_run (0) |  |
| responses | anthropic | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
| responses | gemini | not_covered | json/relay: not_run (0); sse/relay: not_run (0) |  |
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

- none
## Infrastructure Failures

- none

## Cleanup

- complete: `true`
- cases: `[object Object]`

## Evidence References

- root: `/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/oracle-author/delta/chat-to-responses-json`
- root persistent: `true`
- `captures/chat-to-responses-json-turn-1-provider.json` (persistent: `true`)
- `captures/chat-to-responses-json-turn-1-client.json` (persistent: `true`)
