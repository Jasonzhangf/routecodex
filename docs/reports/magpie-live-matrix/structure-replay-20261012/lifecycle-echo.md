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
- sha256: `8ada72fbc951c9bf1cd505440769346c0179ce9166f50ad69fca10d0a09cfcad`

### Source / Candidate Identity

- repo: `unknown`
- source sha: `4597c4a0e82153d76eaca50c65b20242e8d076f9`
- fixture sha: `bfaedf18301d02a423bd5422d22e41432d231ab8`
- fixture digest: `0e9e06961603fb5148b86536dc035446de0c1a5c4a0ca98ae4be0eb78f49e353`
- config check exit: `not_run`
- config check and source declarations are setup evidence only; they are not live matrix success.

## Case Results

| case_id | entry | provider | transport | mode | status | diagnostic | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| tool-followup-responses-to-chat | responses | openai_chat | sse | relay | failed | provider request body differs from exact expected; provider body_must tools.0.function.name mismatch; provider body_must stream mismatch; client body_must output.0.content.0.text missing | captures/tool-followup-responses-to-chat-turn-1-provider.json, captures/tool-followup-responses-to-chat-turn-2-provider.json, captures/tool-followup-responses-to-chat-turn-1-client.json, captures/tool-followup-responses-to-chat-turn-2-client.json |

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

| case_id | entry | provider | transport | mode | status | first divergence | diagnostic | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tool-followup-responses-to-chat | responses | openai_chat | sse | relay | failed | provider_request_shape | provider request body differs from exact expected; provider body_must tools.0.function.name mismatch; provider body_must stream mismatch; client body_must output.0.content.0.text missing | captures/tool-followup-responses-to-chat-turn-1-provider.json, captures/tool-followup-responses-to-chat-turn-2-provider.json, captures/tool-followup-responses-to-chat-turn-1-client.json, captures/tool-followup-responses-to-chat-turn-2-client.json |

## P2 Handoff

### provider_request_shape

- `tool-followup-responses-to-chat`: provider request body differs from exact expected; provider body_must tools.0.function.name mismatch; provider body_must stream mismatch; client body_must output.0.content.0.text missing

## Infrastructure Failures

- none

## Cleanup

- complete: `true`
- cases: `[object Object]`

## Evidence References

- root: `/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/split-integrate/lifecycle-echo`
- root persistent: `true`
- `captures/tool-followup-responses-to-chat-turn-1-provider.json` (persistent: `true`)
- `captures/tool-followup-responses-to-chat-turn-2-provider.json` (persistent: `true`)
- `captures/tool-followup-responses-to-chat-turn-1-client.json` (persistent: `true`)
- `captures/tool-followup-responses-to-chat-turn-2-client.json` (persistent: `true`)
