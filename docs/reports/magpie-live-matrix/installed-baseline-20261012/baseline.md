# Magpie Live Mock-Provider Baseline

- status: `baseline_completed_with_failures`
- source status: `baseline_completed_with_failures`
- unique cases: `48`
- entries: `48`
- passed: `12`
- failed: `36`
- not_run: `0`
- infra_failure: `0`
- duplicate case ids: none

## Identity Boundaries

### Runtime Identity

- kind: `installed`
- path: `/Users/fanzhang/.local/bin/rccv3`
- version: `rccv3 0.90.4886 (crate 0.1.0)`
- sha256: `282e05b774026bbbea7ceb8cdeaee9364576b13e61396be30e97950587680851`

### Source / Candidate Identity

- repo: `unknown`
- source sha: `88715b2fe74ce4e6254f4d29ef1528b6848d4dff`
- fixture sha: `bfaedf18301d02a423bd5422d22e41432d231ab8`
- fixture digest: `a1a6d142e16aad2fefa98954dd53e221cbce1f3d9a391b7383596a6095b6b999`
- config check exit: `not_run`
- config check and source declarations are setup evidence only; they are not live matrix success.

## Case Results

| case_id | entry | provider | transport | mode | status | diagnostic | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| anthropic-to-anthropic-json | anthropic | anthropic | json | direct | failed | provider body_must messages.0.content mismatch | captures/anthropic-to-anthropic-json-turn-1-provider.json, captures/anthropic-to-anthropic-json-turn-1-client.json |
| anthropic-to-anthropic-sse | anthropic | anthropic | sse | direct | passed | case flow assertions passed | captures/anthropic-to-anthropic-sse-turn-1-provider.json, captures/anthropic-to-anthropic-sse-turn-1-client.json |
| anthropic-to-chat-json | anthropic | openai_chat | json | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must content.0.text missing; client body_must stop_reason missing; semantic terminal missing from client output | captures/anthropic-to-chat-json-turn-1-provider.json, captures/anthropic-to-chat-json-turn-1-client.json |
| anthropic-to-chat-sse | anthropic | openai_chat | sse | relay | passed | case flow assertions passed | captures/anthropic-to-chat-sse-turn-1-provider.json, captures/anthropic-to-chat-sse-turn-1-client.json |
| anthropic-to-gemini-json | anthropic | gemini | json | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must content.0.text missing; client body_must stop_reason missing; semantic terminal missing from client output | captures/anthropic-to-gemini-json-turn-1-provider.json, captures/anthropic-to-gemini-json-turn-1-client.json |
| anthropic-to-gemini-sse | anthropic | gemini | sse | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client body_must text missing; client body_must stop_reason missing; semantic terminal missing from client output | captures/anthropic-to-gemini-sse-turn-1-provider.json, captures/anthropic-to-gemini-sse-turn-1-client.json |
| anthropic-to-responses-json | anthropic | responses | json | relay | passed | case flow assertions passed | captures/anthropic-to-responses-json-turn-1-provider.json, captures/anthropic-to-responses-json-turn-1-client.json |
| anthropic-to-responses-sse | anthropic | responses | sse | relay | failed | client body_must text missing | captures/anthropic-to-responses-sse-turn-1-provider.json, captures/anthropic-to-responses-sse-turn-1-client.json |
| chat-to-anthropic-json | openai_chat | anthropic | json | relay | failed | provider body_must system.0.text mismatch | captures/chat-to-anthropic-json-turn-1-provider.json, captures/chat-to-anthropic-json-turn-1-client.json |
| chat-to-anthropic-sse | openai_chat | anthropic | sse | relay | failed | client body_must text missing; client body_must finish_reason missing; semantic terminal missing from client output | captures/chat-to-anthropic-sse-turn-1-provider.json, captures/chat-to-anthropic-sse-turn-1-client.json |
| chat-to-chat-json | openai_chat | openai_chat | json | direct | passed | case flow assertions passed | captures/chat-to-chat-json-turn-1-provider.json, captures/chat-to-chat-json-turn-1-client.json |
| chat-to-chat-sse | openai_chat | openai_chat | sse | direct | passed | case flow assertions passed | captures/chat-to-chat-sse-turn-1-provider.json, captures/chat-to-chat-sse-turn-1-client.json |
| chat-to-gemini-json | openai_chat | gemini | json | relay | failed | provider body_must contents.0.role mismatch; provider body_must contents.0.parts.0.text mismatch; provider auth missing or empty for gemini carrier; client status missing for completed response; client body_must choices.0.message.content missing; client body_must choices.0.finish_reason missing; semantic terminal missing from client output | captures/chat-to-gemini-json-turn-1-provider.json, captures/chat-to-gemini-json-turn-1-client.json |
| chat-to-gemini-sse | openai_chat | gemini | sse | relay | failed | provider path /v1beta/models/gemini-model:generateContent not in expected paths [/v1beta/models/gemini-model:streamGenerateContent]; provider body_must contents.0.parts.0.text mismatch; provider auth missing or empty for gemini carrier; client body_must text missing; client body_must finish_reason missing; semantic terminal missing from client output | captures/chat-to-gemini-sse-turn-1-provider.json, captures/chat-to-gemini-sse-turn-1-client.json |
| chat-to-responses-json | openai_chat | responses | json | relay | failed | provider body_must instructions mismatch; provider body_must input.0.role mismatch; provider body_must input.0.content.0.text mismatch | captures/chat-to-responses-json-turn-1-provider.json, captures/chat-to-responses-json-turn-1-client.json |
| chat-to-responses-sse | openai_chat | responses | sse | relay | failed | client body_must usage.prompt_tokens missing | captures/chat-to-responses-sse-turn-1-provider.json, captures/chat-to-responses-sse-turn-1-client.json |
| gemini-to-anthropic-json | gemini | anthropic | json | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; semantic terminal missing from client output | captures/gemini-to-anthropic-json-turn-1-provider.json, captures/gemini-to-anthropic-json-turn-1-client.json |
| gemini-to-anthropic-sse | gemini | anthropic | sse | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output | captures/gemini-to-anthropic-sse-turn-1-provider.json, captures/gemini-to-anthropic-sse-turn-1-client.json |
| gemini-to-chat-json | gemini | openai_chat | json | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; semantic terminal missing from client output | captures/gemini-to-chat-json-turn-1-provider.json, captures/gemini-to-chat-json-turn-1-client.json |
| gemini-to-chat-sse | gemini | openai_chat | sse | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output | captures/gemini-to-chat-sse-turn-1-provider.json, captures/gemini-to-chat-sse-turn-1-client.json |
| gemini-to-gemini-json | gemini | gemini | json | direct | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; client body_must usageMetadata.promptTokenCount missing; semantic terminal missing from client output | captures/gemini-to-gemini-json-turn-1-provider.json, captures/gemini-to-gemini-json-turn-1-client.json |
| gemini-to-gemini-sse | gemini | gemini | sse | direct | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output | captures/gemini-to-gemini-sse-turn-1-provider.json, captures/gemini-to-gemini-sse-turn-1-client.json |
| gemini-to-responses-json | gemini | responses | json | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; semantic terminal missing from client output | captures/gemini-to-responses-json-turn-1-provider.json, captures/gemini-to-responses-json-turn-1-client.json |
| gemini-to-responses-sse | gemini | responses | sse | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output | captures/gemini-to-responses-sse-turn-1-provider.json, captures/gemini-to-responses-sse-turn-1-client.json |
| media-anthropic-older-turn-tool-image | anthropic | openai_chat | json | relay | failed | provider body_must messages.4.content mismatch | captures/media-anthropic-older-turn-tool-image-turn-1-provider.json, captures/media-anthropic-older-turn-tool-image-turn-1-client.json |
| media-gemini-function-response-file | gemini | openai_chat | json | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; semantic terminal missing from client output | captures/media-gemini-function-response-file-turn-1-provider.json, captures/media-gemini-function-response-file-turn-1-client.json |
| media-gemini-function-response-image | gemini | openai_chat | sse | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output | captures/media-gemini-function-response-image-turn-1-provider.json, captures/media-gemini-function-response-image-turn-1-client.json |
| namespace-custom-complete-args | responses | openai_chat | sse | relay | failed | provider body_must tools.0.function.name mismatch; provider body_must tools.1.function.name mismatch; client status missing for completed response; client body_must item.type missing; client body_must item.name missing; client body_must item.namespace missing; client body_must item.call_id missing; client body_must item.arguments missing; provider attempt count 0 != scripted 1 for turn 2; provider business attempt missing for turn 1; client body_must output.0.content.0.text missing; client body_must status missing | captures/namespace-custom-complete-args-turn-1-provider.json, captures/namespace-custom-complete-args-turn-2-provider.json, captures/namespace-custom-complete-args-turn-1-client.json, captures/namespace-custom-complete-args-turn-2-client.json |
| provider-error-exhaustion | openai_chat | openai_chat | json | direct | failed | expected closed transport but received a parsed observation | captures/provider-error-exhaustion-turn-1-provider.json, captures/provider-error-exhaustion-turn-1-client.json |
| provider-fault-stream-cut | openai_chat | openai_chat | sse | direct | failed | provider attempt count 1 != scripted 2 for turn 1; provider attempt count 1 != asserted 2 for turn 1; client body_must choices.0.message.content missing; client body_must choices.0.finish_reason missing; semantic terminal missing from client output | captures/provider-fault-stream-cut-turn-1-provider.json, captures/provider-fault-stream-cut-turn-1-client.json |
| reasoning-provided-signature-not-invented | anthropic | gemini | json | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must content.0.text missing; client body_must stop_reason missing; semantic terminal missing from client output | captures/reasoning-provided-signature-not-invented-turn-1-provider.json, captures/reasoning-provided-signature-not-invented-turn-1-client.json |
| reasoning-signature-anthropic-to-gemini | anthropic | gemini | json | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must content.0.text missing; client body_must stop_reason missing; semantic terminal missing from client output | captures/reasoning-signature-anthropic-to-gemini-turn-1-provider.json, captures/reasoning-signature-anthropic-to-gemini-turn-1-client.json |
| responses-to-anthropic-json | responses | anthropic | json | relay | passed | case flow assertions passed | captures/responses-to-anthropic-json-turn-1-provider.json, captures/responses-to-anthropic-json-turn-1-client.json |
| responses-to-anthropic-sse | responses | anthropic | sse | relay | failed | client body_must text missing | captures/responses-to-anthropic-sse-turn-1-provider.json, captures/responses-to-anthropic-sse-turn-1-client.json |
| responses-to-chat-json | responses | openai_chat | json | relay | failed | client body_must output.0.content.0.text missing | captures/responses-to-chat-json-turn-1-provider.json, captures/responses-to-chat-json-turn-1-client.json |
| responses-to-chat-sse | responses | openai_chat | sse | relay | failed | client body_must text missing; client body_must finish_reason missing | captures/responses-to-chat-sse-turn-1-provider.json, captures/responses-to-chat-sse-turn-1-client.json |
| responses-to-gemini-json | responses | gemini | json | relay | failed | provider body_must contents.0.role mismatch; provider body_must contents.0.parts.0.text mismatch; provider auth missing or empty for gemini carrier; client body_must output.0.content.0.text missing; client body_must status missing; semantic terminal missing from client output | captures/responses-to-gemini-json-turn-1-provider.json, captures/responses-to-gemini-json-turn-1-client.json |
| responses-to-gemini-sse | responses | gemini | sse | relay | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client body_must text missing; client body_must finish_reason missing; semantic terminal missing from client output | captures/responses-to-gemini-sse-turn-1-provider.json, captures/responses-to-gemini-sse-turn-1-client.json |
| responses-to-responses-json | responses | responses | json | direct | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must output.0.content.0.text missing; client body_must status missing; client body_must usage.input_tokens missing; semantic terminal missing from client output | captures/responses-to-responses-json-turn-1-provider.json, captures/responses-to-responses-json-turn-1-client.json |
| responses-to-responses-sse | responses | responses | sse | direct | failed | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client body_must text missing; client body_must status missing; semantic terminal missing from client output | captures/responses-to-responses-sse-turn-1-provider.json, captures/responses-to-responses-sse-turn-1-client.json |
| same-protocol-relay-chat-to-chat-json | openai_chat | openai_chat | json | relay | passed | case flow assertions passed | captures/same-protocol-relay-chat-to-chat-json-turn-1-provider.json, captures/same-protocol-relay-chat-to-chat-json-turn-1-client.json |
| terminal-content-filter | openai_chat | responses | json | relay | passed | case flow assertions passed | captures/terminal-content-filter-turn-1-provider.json, captures/terminal-content-filter-turn-1-client.json |
| terminal-length | openai_chat | openai_chat | json | direct | passed | case flow assertions passed | captures/terminal-length-turn-1-provider.json, captures/terminal-length-turn-1-client.json |
| tool-followup-responses-to-chat | responses | openai_chat | sse | relay | failed | tool_followup: echo consumer requires exactly one observed call | captures/tool-followup-responses-to-chat-turn-1-provider.json, captures/tool-followup-responses-to-chat-turn-1-client.json |
| unregistered-request-field-continuation | openai_chat | openai_chat | json | direct | passed | case flow assertions passed | captures/unregistered-request-field-continuation-turn-1-provider.json, captures/unregistered-request-field-continuation-turn-1-client.json |
| unregistered-response-field-preserved | openai_chat | openai_chat | json | direct | passed | case flow assertions passed | captures/unregistered-response-field-preserved-turn-1-provider.json, captures/unregistered-response-field-preserved-turn-1-client.json |
| usage-cache-writes-chat-entry | openai_chat | anthropic | sse | relay | failed | client body_must text missing; client body_must finish_reason missing; client body_must usage.prompt_tokens missing; client body_must usage.completion_tokens missing; client body_must usage.total_tokens missing; client body_must usage.prompt_tokens_details.cache_write_tokens missing; client body_must usage.prompt_tokens_details.cached_tokens missing; semantic terminal missing from client output | captures/usage-cache-writes-chat-entry-turn-1-provider.json, captures/usage-cache-writes-chat-entry-turn-1-client.json |
| usage-missing-or-null-preserved | openai_chat | openai_chat | json | direct | passed | case flow assertions passed | captures/usage-missing-or-null-preserved-turn-1-provider.json, captures/usage-missing-or-null-preserved-turn-1-client.json |

## Base Matrix

| entry | provider | status | variants | case_ids |
| --- | --- | --- | --- | --- |
| openai_chat | openai_chat | covered | json/direct: passed (1); sse/direct: passed (1); json/relay (supplemental): passed (1) | chat-to-chat-json, chat-to-chat-sse, same-protocol-relay-chat-to-chat-json |
| openai_chat | responses | covered_with_failures | json/relay: failed (1); sse/relay: failed (1) | chat-to-responses-json, chat-to-responses-sse |
| openai_chat | anthropic | covered_with_failures | json/relay: failed (1); sse/relay: failed (1) | chat-to-anthropic-json, chat-to-anthropic-sse |
| openai_chat | gemini | covered_with_failures | json/relay: failed (1); sse/relay: failed (1) | chat-to-gemini-json, chat-to-gemini-sse |
| responses | openai_chat | covered_with_failures | json/relay: failed (1); sse/relay: failed (1) | responses-to-chat-json, responses-to-chat-sse |
| responses | responses | covered_with_failures | json/direct: failed (1); sse/direct: failed (1); json/relay (supplemental): not_run (0) | responses-to-responses-json, responses-to-responses-sse |
| responses | anthropic | covered_with_failures | json/relay: passed (1); sse/relay: failed (1) | responses-to-anthropic-json, responses-to-anthropic-sse |
| responses | gemini | covered_with_failures | json/relay: failed (1); sse/relay: failed (1) | responses-to-gemini-json, responses-to-gemini-sse |
| anthropic | openai_chat | covered_with_failures | json/relay: failed (1); sse/relay: passed (1) | anthropic-to-chat-json, anthropic-to-chat-sse |
| anthropic | responses | covered_with_failures | json/relay: passed (1); sse/relay: failed (1) | anthropic-to-responses-json, anthropic-to-responses-sse |
| anthropic | anthropic | covered_with_failures | json/direct: failed (1); sse/direct: passed (1); json/relay (supplemental): not_run (0) | anthropic-to-anthropic-json, anthropic-to-anthropic-sse |
| anthropic | gemini | covered_with_failures | json/relay: failed (1); sse/relay: failed (1) | anthropic-to-gemini-json, anthropic-to-gemini-sse |
| gemini | openai_chat | covered_with_failures | json/relay: failed (1); sse/relay: failed (1) | gemini-to-chat-json, gemini-to-chat-sse |
| gemini | responses | covered_with_failures | json/relay: failed (1); sse/relay: failed (1) | gemini-to-responses-json, gemini-to-responses-sse |
| gemini | anthropic | covered_with_failures | json/relay: failed (1); sse/relay: failed (1) | gemini-to-anthropic-json, gemini-to-anthropic-sse |
| gemini | gemini | covered_with_failures | json/direct: failed (1); sse/direct: failed (1); json/relay (supplemental): not_run (0) | gemini-to-gemini-json, gemini-to-gemini-sse |

## Boundary Scope

| case_id | entry | provider | transport | mode | status | first divergence | diagnostic | evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| media-anthropic-older-turn-tool-image | anthropic | openai_chat | json | relay | failed | provider_request_shape | provider body_must messages.4.content mismatch | captures/media-anthropic-older-turn-tool-image-turn-1-provider.json, captures/media-anthropic-older-turn-tool-image-turn-1-client.json |
| media-gemini-function-response-file | gemini | openai_chat | json | relay | failed | provider_attempt_count | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; semantic terminal missing from client output | captures/media-gemini-function-response-file-turn-1-provider.json, captures/media-gemini-function-response-file-turn-1-client.json |
| media-gemini-function-response-image | gemini | openai_chat | sse | relay | failed | provider_attempt_count | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output | captures/media-gemini-function-response-image-turn-1-provider.json, captures/media-gemini-function-response-image-turn-1-client.json |
| namespace-custom-complete-args | responses | openai_chat | sse | relay | failed | provider_request_shape | provider body_must tools.0.function.name mismatch; provider body_must tools.1.function.name mismatch; client status missing for completed response; client body_must item.type missing; client body_must item.name missing; client body_must item.namespace missing; client body_must item.call_id missing; client body_must item.arguments missing; provider attempt count 0 != scripted 1 for turn 2; provider business attempt missing for turn 1; client body_must output.0.content.0.text missing; client body_must status missing | captures/namespace-custom-complete-args-turn-1-provider.json, captures/namespace-custom-complete-args-turn-2-provider.json, captures/namespace-custom-complete-args-turn-1-client.json, captures/namespace-custom-complete-args-turn-2-client.json |
| provider-error-exhaustion | openai_chat | openai_chat | json | direct | failed | client_response | expected closed transport but received a parsed observation | captures/provider-error-exhaustion-turn-1-provider.json, captures/provider-error-exhaustion-turn-1-client.json |
| provider-fault-stream-cut | openai_chat | openai_chat | sse | direct | failed | provider_attempt_count | provider attempt count 1 != scripted 2 for turn 1; provider attempt count 1 != asserted 2 for turn 1; client body_must choices.0.message.content missing; client body_must choices.0.finish_reason missing; semantic terminal missing from client output | captures/provider-fault-stream-cut-turn-1-provider.json, captures/provider-fault-stream-cut-turn-1-client.json |
| reasoning-provided-signature-not-invented | anthropic | gemini | json | relay | failed | provider_attempt_count | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must content.0.text missing; client body_must stop_reason missing; semantic terminal missing from client output | captures/reasoning-provided-signature-not-invented-turn-1-provider.json, captures/reasoning-provided-signature-not-invented-turn-1-client.json |
| reasoning-signature-anthropic-to-gemini | anthropic | gemini | json | relay | failed | provider_attempt_count | provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must content.0.text missing; client body_must stop_reason missing; semantic terminal missing from client output | captures/reasoning-signature-anthropic-to-gemini-turn-1-provider.json, captures/reasoning-signature-anthropic-to-gemini-turn-1-client.json |
| terminal-content-filter | openai_chat | responses | json | relay | passed | unknown | case flow assertions passed | captures/terminal-content-filter-turn-1-provider.json, captures/terminal-content-filter-turn-1-client.json |
| terminal-length | openai_chat | openai_chat | json | direct | passed | unknown | case flow assertions passed | captures/terminal-length-turn-1-provider.json, captures/terminal-length-turn-1-client.json |
| tool-followup-responses-to-chat | responses | openai_chat | sse | relay | failed | tool_followup | tool_followup: echo consumer requires exactly one observed call | captures/tool-followup-responses-to-chat-turn-1-provider.json, captures/tool-followup-responses-to-chat-turn-1-client.json |
| unregistered-request-field-continuation | openai_chat | openai_chat | json | direct | passed | unknown | case flow assertions passed | captures/unregistered-request-field-continuation-turn-1-provider.json, captures/unregistered-request-field-continuation-turn-1-client.json |
| unregistered-response-field-preserved | openai_chat | openai_chat | json | direct | passed | unknown | case flow assertions passed | captures/unregistered-response-field-preserved-turn-1-provider.json, captures/unregistered-response-field-preserved-turn-1-client.json |
| usage-cache-writes-chat-entry | openai_chat | anthropic | sse | relay | failed | client_response | client body_must text missing; client body_must finish_reason missing; client body_must usage.prompt_tokens missing; client body_must usage.completion_tokens missing; client body_must usage.total_tokens missing; client body_must usage.prompt_tokens_details.cache_write_tokens missing; client body_must usage.prompt_tokens_details.cached_tokens missing; semantic terminal missing from client output | captures/usage-cache-writes-chat-entry-turn-1-provider.json, captures/usage-cache-writes-chat-entry-turn-1-client.json |
| usage-missing-or-null-preserved | openai_chat | openai_chat | json | direct | passed | unknown | case flow assertions passed | captures/usage-missing-or-null-preserved-turn-1-provider.json, captures/usage-missing-or-null-preserved-turn-1-client.json |

## P2 Handoff

### client_response

- `anthropic-to-responses-sse`: client body_must text missing
- `chat-to-anthropic-sse`: client body_must text missing; client body_must finish_reason missing; semantic terminal missing from client output
- `chat-to-responses-sse`: client body_must usage.prompt_tokens missing
- `provider-error-exhaustion`: expected closed transport but received a parsed observation
- `responses-to-anthropic-sse`: client body_must text missing
- `responses-to-chat-json`: client body_must output.0.content.0.text missing
- `responses-to-chat-sse`: client body_must text missing; client body_must finish_reason missing
- `usage-cache-writes-chat-entry`: client body_must text missing; client body_must finish_reason missing; client body_must usage.prompt_tokens missing; client body_must usage.completion_tokens missing; client body_must usage.total_tokens missing; client body_must usage.prompt_tokens_details.cache_write_tokens missing; client body_must usage.prompt_tokens_details.cached_tokens missing; semantic terminal missing from client output

### provider_attempt_count

- `anthropic-to-chat-json`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must content.0.text missing; client body_must stop_reason missing; semantic terminal missing from client output
- `anthropic-to-gemini-json`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must content.0.text missing; client body_must stop_reason missing; semantic terminal missing from client output
- `anthropic-to-gemini-sse`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client body_must text missing; client body_must stop_reason missing; semantic terminal missing from client output
- `gemini-to-anthropic-json`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; semantic terminal missing from client output
- `gemini-to-anthropic-sse`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output
- `gemini-to-chat-json`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; semantic terminal missing from client output
- `gemini-to-chat-sse`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output
- `gemini-to-gemini-json`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; client body_must usageMetadata.promptTokenCount missing; semantic terminal missing from client output
- `gemini-to-gemini-sse`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output
- `gemini-to-responses-json`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; semantic terminal missing from client output
- `gemini-to-responses-sse`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output
- `media-gemini-function-response-file`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must candidates.0.content.parts.0.text missing; client body_must candidates.0.finishReason missing; semantic terminal missing from client output
- `media-gemini-function-response-image`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must text missing; client body_must finishReason missing; semantic terminal missing from client output
- `provider-fault-stream-cut`: provider attempt count 1 != scripted 2 for turn 1; provider attempt count 1 != asserted 2 for turn 1; client body_must choices.0.message.content missing; client body_must choices.0.finish_reason missing; semantic terminal missing from client output
- `reasoning-provided-signature-not-invented`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must content.0.text missing; client body_must stop_reason missing; semantic terminal missing from client output
- `reasoning-signature-anthropic-to-gemini`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must content.0.text missing; client body_must stop_reason missing; semantic terminal missing from client output
- `responses-to-gemini-sse`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client body_must text missing; client body_must finish_reason missing; semantic terminal missing from client output
- `responses-to-responses-json`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client status missing for completed response; client body_must output.0.content.0.text missing; client body_must status missing; client body_must usage.input_tokens missing; semantic terminal missing from client output
- `responses-to-responses-sse`: provider attempt count 0 != scripted 1 for turn 1; provider attempt count 0 != asserted 1 for turn 1; provider business attempt missing for turn 1; client body_must text missing; client body_must status missing; semantic terminal missing from client output

### provider_request_shape

- `anthropic-to-anthropic-json`: provider body_must messages.0.content mismatch
- `chat-to-anthropic-json`: provider body_must system.0.text mismatch
- `chat-to-gemini-json`: provider body_must contents.0.role mismatch; provider body_must contents.0.parts.0.text mismatch; provider auth missing or empty for gemini carrier; client status missing for completed response; client body_must choices.0.message.content missing; client body_must choices.0.finish_reason missing; semantic terminal missing from client output
- `chat-to-gemini-sse`: provider path /v1beta/models/gemini-model:generateContent not in expected paths [/v1beta/models/gemini-model:streamGenerateContent]; provider body_must contents.0.parts.0.text mismatch; provider auth missing or empty for gemini carrier; client body_must text missing; client body_must finish_reason missing; semantic terminal missing from client output
- `chat-to-responses-json`: provider body_must instructions mismatch; provider body_must input.0.role mismatch; provider body_must input.0.content.0.text mismatch
- `media-anthropic-older-turn-tool-image`: provider body_must messages.4.content mismatch
- `namespace-custom-complete-args`: provider body_must tools.0.function.name mismatch; provider body_must tools.1.function.name mismatch; client status missing for completed response; client body_must item.type missing; client body_must item.name missing; client body_must item.namespace missing; client body_must item.call_id missing; client body_must item.arguments missing; provider attempt count 0 != scripted 1 for turn 2; provider business attempt missing for turn 1; client body_must output.0.content.0.text missing; client body_must status missing
- `responses-to-gemini-json`: provider body_must contents.0.role mismatch; provider body_must contents.0.parts.0.text mismatch; provider auth missing or empty for gemini carrier; client body_must output.0.content.0.text missing; client body_must status missing; semantic terminal missing from client output

### tool_followup

- `tool-followup-responses-to-chat`: tool_followup: echo consumer requires exactly one observed call

## Infrastructure Failures

- none

## Cleanup

- complete: `true`
- cases: `[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object],[object Object]`

## Evidence References

- root: `/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012/docs/reports/magpie-live-matrix/installed-baseline-20261012`
- root persistent: `true`
- `captures/anthropic-to-anthropic-json-turn-1-provider.json` (persistent: `true`)
- `captures/anthropic-to-anthropic-json-turn-1-client.json` (persistent: `true`)
- `captures/anthropic-to-anthropic-sse-turn-1-provider.json` (persistent: `true`)
- `captures/anthropic-to-anthropic-sse-turn-1-client.json` (persistent: `true`)
- `captures/anthropic-to-chat-json-turn-1-provider.json` (persistent: `true`)
- `captures/anthropic-to-chat-json-turn-1-client.json` (persistent: `true`)
- `captures/anthropic-to-chat-sse-turn-1-provider.json` (persistent: `true`)
- `captures/anthropic-to-chat-sse-turn-1-client.json` (persistent: `true`)
- `captures/anthropic-to-gemini-json-turn-1-provider.json` (persistent: `true`)
- `captures/anthropic-to-gemini-json-turn-1-client.json` (persistent: `true`)
- `captures/anthropic-to-gemini-sse-turn-1-provider.json` (persistent: `true`)
- `captures/anthropic-to-gemini-sse-turn-1-client.json` (persistent: `true`)
- `captures/anthropic-to-responses-json-turn-1-provider.json` (persistent: `true`)
- `captures/anthropic-to-responses-json-turn-1-client.json` (persistent: `true`)
- `captures/anthropic-to-responses-sse-turn-1-provider.json` (persistent: `true`)
- `captures/anthropic-to-responses-sse-turn-1-client.json` (persistent: `true`)
- `captures/chat-to-anthropic-json-turn-1-provider.json` (persistent: `true`)
- `captures/chat-to-anthropic-json-turn-1-client.json` (persistent: `true`)
- `captures/chat-to-anthropic-sse-turn-1-provider.json` (persistent: `true`)
- `captures/chat-to-anthropic-sse-turn-1-client.json` (persistent: `true`)
- `captures/chat-to-chat-json-turn-1-provider.json` (persistent: `true`)
- `captures/chat-to-chat-json-turn-1-client.json` (persistent: `true`)
- `captures/chat-to-chat-sse-turn-1-provider.json` (persistent: `true`)
- `captures/chat-to-chat-sse-turn-1-client.json` (persistent: `true`)
- `captures/chat-to-gemini-json-turn-1-provider.json` (persistent: `true`)
- `captures/chat-to-gemini-json-turn-1-client.json` (persistent: `true`)
- `captures/chat-to-gemini-sse-turn-1-provider.json` (persistent: `true`)
- `captures/chat-to-gemini-sse-turn-1-client.json` (persistent: `true`)
- `captures/chat-to-responses-json-turn-1-provider.json` (persistent: `true`)
- `captures/chat-to-responses-json-turn-1-client.json` (persistent: `true`)
- `captures/chat-to-responses-sse-turn-1-provider.json` (persistent: `true`)
- `captures/chat-to-responses-sse-turn-1-client.json` (persistent: `true`)
- `captures/gemini-to-anthropic-json-turn-1-provider.json` (persistent: `true`)
- `captures/gemini-to-anthropic-json-turn-1-client.json` (persistent: `true`)
- `captures/gemini-to-anthropic-sse-turn-1-provider.json` (persistent: `true`)
- `captures/gemini-to-anthropic-sse-turn-1-client.json` (persistent: `true`)
- `captures/gemini-to-chat-json-turn-1-provider.json` (persistent: `true`)
- `captures/gemini-to-chat-json-turn-1-client.json` (persistent: `true`)
- `captures/gemini-to-chat-sse-turn-1-provider.json` (persistent: `true`)
- `captures/gemini-to-chat-sse-turn-1-client.json` (persistent: `true`)
- `captures/gemini-to-gemini-json-turn-1-provider.json` (persistent: `true`)
- `captures/gemini-to-gemini-json-turn-1-client.json` (persistent: `true`)
- `captures/gemini-to-gemini-sse-turn-1-provider.json` (persistent: `true`)
- `captures/gemini-to-gemini-sse-turn-1-client.json` (persistent: `true`)
- `captures/gemini-to-responses-json-turn-1-provider.json` (persistent: `true`)
- `captures/gemini-to-responses-json-turn-1-client.json` (persistent: `true`)
- `captures/gemini-to-responses-sse-turn-1-provider.json` (persistent: `true`)
- `captures/gemini-to-responses-sse-turn-1-client.json` (persistent: `true`)
- `captures/media-anthropic-older-turn-tool-image-turn-1-provider.json` (persistent: `true`)
- `captures/media-anthropic-older-turn-tool-image-turn-1-client.json` (persistent: `true`)
- `captures/media-gemini-function-response-file-turn-1-provider.json` (persistent: `true`)
- `captures/media-gemini-function-response-file-turn-1-client.json` (persistent: `true`)
- `captures/media-gemini-function-response-image-turn-1-provider.json` (persistent: `true`)
- `captures/media-gemini-function-response-image-turn-1-client.json` (persistent: `true`)
- `captures/namespace-custom-complete-args-turn-1-provider.json` (persistent: `true`)
- `captures/namespace-custom-complete-args-turn-2-provider.json` (persistent: `true`)
- `captures/namespace-custom-complete-args-turn-1-client.json` (persistent: `true`)
- `captures/namespace-custom-complete-args-turn-2-client.json` (persistent: `true`)
- `captures/provider-error-exhaustion-turn-1-provider.json` (persistent: `true`)
- `captures/provider-error-exhaustion-turn-1-client.json` (persistent: `true`)
- `captures/provider-fault-stream-cut-turn-1-provider.json` (persistent: `true`)
- `captures/provider-fault-stream-cut-turn-1-client.json` (persistent: `true`)
- `captures/reasoning-provided-signature-not-invented-turn-1-provider.json` (persistent: `true`)
- `captures/reasoning-provided-signature-not-invented-turn-1-client.json` (persistent: `true`)
- `captures/reasoning-signature-anthropic-to-gemini-turn-1-provider.json` (persistent: `true`)
- `captures/reasoning-signature-anthropic-to-gemini-turn-1-client.json` (persistent: `true`)
- `captures/responses-to-anthropic-json-turn-1-provider.json` (persistent: `true`)
- `captures/responses-to-anthropic-json-turn-1-client.json` (persistent: `true`)
- `captures/responses-to-anthropic-sse-turn-1-provider.json` (persistent: `true`)
- `captures/responses-to-anthropic-sse-turn-1-client.json` (persistent: `true`)
- `captures/responses-to-chat-json-turn-1-provider.json` (persistent: `true`)
- `captures/responses-to-chat-json-turn-1-client.json` (persistent: `true`)
- `captures/responses-to-chat-sse-turn-1-provider.json` (persistent: `true`)
- `captures/responses-to-chat-sse-turn-1-client.json` (persistent: `true`)
- `captures/responses-to-gemini-json-turn-1-provider.json` (persistent: `true`)
- `captures/responses-to-gemini-json-turn-1-client.json` (persistent: `true`)
- `captures/responses-to-gemini-sse-turn-1-provider.json` (persistent: `true`)
- `captures/responses-to-gemini-sse-turn-1-client.json` (persistent: `true`)
- `captures/responses-to-responses-json-turn-1-provider.json` (persistent: `true`)
- `captures/responses-to-responses-json-turn-1-client.json` (persistent: `true`)
- `captures/responses-to-responses-sse-turn-1-provider.json` (persistent: `true`)
- `captures/responses-to-responses-sse-turn-1-client.json` (persistent: `true`)
- `captures/same-protocol-relay-chat-to-chat-json-turn-1-provider.json` (persistent: `true`)
- `captures/same-protocol-relay-chat-to-chat-json-turn-1-client.json` (persistent: `true`)
- `captures/terminal-content-filter-turn-1-provider.json` (persistent: `true`)
- `captures/terminal-content-filter-turn-1-client.json` (persistent: `true`)
- `captures/terminal-length-turn-1-provider.json` (persistent: `true`)
- `captures/terminal-length-turn-1-client.json` (persistent: `true`)
- `captures/tool-followup-responses-to-chat-turn-1-provider.json` (persistent: `true`)
- `captures/tool-followup-responses-to-chat-turn-1-client.json` (persistent: `true`)
- `captures/unregistered-request-field-continuation-turn-1-provider.json` (persistent: `true`)
- `captures/unregistered-request-field-continuation-turn-1-client.json` (persistent: `true`)
- `captures/unregistered-response-field-preserved-turn-1-provider.json` (persistent: `true`)
- `captures/unregistered-response-field-preserved-turn-1-client.json` (persistent: `true`)
- `captures/usage-cache-writes-chat-entry-turn-1-provider.json` (persistent: `true`)
- `captures/usage-cache-writes-chat-entry-turn-1-client.json` (persistent: `true`)
- `captures/usage-missing-or-null-preserved-turn-1-provider.json` (persistent: `true`)
- `captures/usage-missing-or-null-preserved-turn-1-client.json` (persistent: `true`)
