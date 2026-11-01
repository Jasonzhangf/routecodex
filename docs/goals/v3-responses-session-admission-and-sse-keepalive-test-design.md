# V3 Independent Requests And SSE Keepalive Test Design

The latest user requirement replaces the former same-session/conversation
serialization contract. All requests independently enter Runtime. Keep real
identities unchanged. The Server owns framing, explicit maintenance and each
request's activity custody; it must not own a business-session mutex.

The authoritative lifecycle is
`docs/architecture/manifests/v3.responses_session_admission.mainline.yml`.
The contract is `docs/architecture/wiki/v3-responses-session-admission.md`.

## Public HTTP Regression

1. Keep the first upstream request held. Send a second independent connection
   with matching session and conversation. It must reach upstream before release.
2. Repeat with only session matching and only conversation matching.
3. Cover explicit native Direct and actual Chat Relay; assert the upstream wire
   protocol and real successful business output, not just client 200 or SSE head.
4. Receive the second upstream request before cancelling the first client.
   The second must still complete its own business response.
5. Preserve configured key capacity. A busy identity must not block alternatives.
6. Acquire explicit maintenance before issuing a new request. It must pause
   dispatch; cancelling maintenance must resume it. Already accepted work retains
   delivery rights while restart preparation does not wait for it to drain.
7. Keep activity unit tests for maintenance cancellation, ownership and drain.
   Preserve successful body EOF → front flush custody and error/drop release.

The original same-session, session-only and conversation-only public tests were
RED under the removed mutex. Record the same-entry GREEN and retained controls.

## SSE Transport Regression

Retain the existing keepalive gate and its typed Config05 interval. Transport
comments never create model events or alter business bytes. EOF/error/drop stops
the timer. Keepalive must not change Error-chain classification or provider
payload projection. Keep the existing invalid/empty/zero/non-UTF8 config and
retired environment-variable negative tests.

Tests run only in explicit test entrypoints. No test, self-check, diagnostic probe
or test-only clock may enter production startup.

## Delivery

Build and applicable runtime acceptance precede independent overall review.
Formal restart, listener health, original-entry replay and sample audit are
separate evidence. A candidate GREEN does not prove production has loaded it.
Preserve unresolved historical request causes as UNKNOWN when raw samples expired.
