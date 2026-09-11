# Provider content-required 400 incident

Owner: routecodex-2. Task: v3-content-required-400-20260906.
Baseline: origin/main 6e86a7e606cae8d3e0915ce9b788d6ef2bdaf72b.
Scope: diagnose and repair the real 4444 Responses failure, build/install/restart,
then replay the same entry. Cooldown implementation remains routecodex-5 owned.

Source request: openai-responses-router-gpt-5.5-20260905T223117335-47509-4160.
Evidence directory (outside repository, contains real user history):
/Volumes/extension/.rcc/codex-samples/openai-responses/ports/4444/openai-responses-router-gpt-5.5-20260905T223117335-47509-4160/.
Both original attempts use goaichat /v1/messages, first glm-5.3 then qwen3.8-max.
Both report external 400 invalid_parameter_error: content field required.

## Diagnosis evidence

- The client has no empty message content. Provider wire has 162 messages and
  20 empty text blocks, including reasoning-only assistant turns before hosted
  tool search. Every message has a content field.
- A minimal original split reasoning/tool-call pair and joined control both
  returned 200 from the upstream. Empty text is not established as causal.
- Full original qwen body with basic API headers returned 200 and message_stop,
  both with a diagnostic output bound and with the unmodified original body.
- Full original body and original non-secret headers reproduced the exact 400.
- Removing beta alone or CLI identity alone still reproduced the same 400.
- Removing Accept with all other original headers returned 200. Basic headers
  plus Accept also returned 200. Both JSON Accept and original SSE Accept with
  a bounded output budget returned 200. An unbounded JSON Accept attempt timed
  out before response headers; that attempt is not success evidence.
- Decisive reverse control: original-no-limit-repeat uses the original full
  body and original non-secret headers without an output bound; it returned
  200, tool_use, and message_stop. Thus identical original request semantics
  have both failure and success evidence. Neither empty content, request
  headers, nor a missing output bound is established as a deterministic cause.
- The experimental header regression test was removed. No runtime fix is
  justified by these observations. Upstream intermittent rejection remains
  distinct from the local old-policy 400 health-neutral terminal bypass,
  which is in the worker-owned cooldown replacement scope.

Local diagnostic script: /tmp/rcc-content-400-diagnose.py. Per-variant raw
responses: /tmp/rcc-content-400-<variant>.json. Credentials are read from their
declared secret-file owner and are never copied to this document or stdout.

## Delivery evidence required

First-divergence proof; minimal owner regression red/green; mapped source gates;
build and installed binary identity; active config check; aggregate restart;
4444/7777/10000 health; same-entry real replay; AGY review; exact commit and
authorized main integration. Pre-change installed version was 0.90.4766, active
config /Volumes/extension/.rcc/config.toml. The latest-main rebuild/restart below
must not be reported as a payload bug fix. Initial install hit the local Node
dependency isolation gate; installing this worktree's V3 lockfile dependencies
resolved that gate. Since no runtime patch is retained, the experimental red
test is diagnosis evidence only, not a claimed red-to-green code repair.

## Rebuild and recovery verification

- V3 local lockfile dependency install invoked the standard install lifecycle:
  isolation and CLI distribution tests PASS, release build and install PASS.
- Installed 0.90.4767; runtime source baseline remains 6e86a7e60, with only the
  standard version operation modifying package.json/package-lock.json.
- Binary SHA256: 0f73aa4e9bc53c57c2129af652df26c61555d65626f9e891c8b98c4e38c44f33.
- Managed instance v3-0259edc1618dfa4bddf8 aggregate restart completed running.
  All 4444/7777/10000 health endpoints report 0.90.4767 and status ok.
- Original client body replayed byte-for-byte through 4444 /v1/responses:
  request openai-responses-router-gpt-5.5-20260905T225205295-47615-4266;
  ordinary routing selected cc-sol[key1].gpt-5.6-sol; HTTP 200 and
  response.completed in 12463.5 ms. This proves the entry recovered, not a
  post-restart goaichat route selection or a deterministic 400 code fix.
- Local logs: /tmp/rcc-content-400-npm-ci.log,
  /tmp/rcc-content-400-restart.log, /tmp/rcc-content-400-live.headers,
  /tmp/rcc-content-400-live.sse. Real payload evidence stays outside Git.
- Installation/live verification window released to routecodex-3 and notified
  routecodex-5. The latter owns playground/cool-0906; its test file-size issue
  is resolved (1446 lines), but full final gates and review remain pending.
