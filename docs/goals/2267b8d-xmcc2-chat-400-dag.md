# 2267b8d: XMCC2 Chat 400 request-path DAG

## Proxy contract and evidence

The client and Provider are separate failure domains. A Provider HTTP 400 is a typed input to the Error chain, **not** a client HTTP 400. The Error chain must select another eligible provider, update provider management according to the proved failure class, and keep the client session transport stable until a successful buffered response or a proxy-owned terminal decision. The client's next request must remain usable after a terminal decision. Provider body, status, identity, and raw diagnostic text do not pass through to the client as a provider error.

The saved `xmcc2.kimi-k3` failing shape has 193 projected Chat messages, 233 expanded tools, and 83 tool-call/result pairs by ID. Controlled same-entry probes found a 994,679-byte projected Chat body returned 200, while one with longer descriptions and 1,016,036 bytes returned upstream 400 `invalid_request_error`; the full shape also failed on `xmcc2.deepseek-v4.1-flash`. This is only a size-correlated hypothesis: token count and description length changed with byte count. The original 17:50 `gpt-5.5` request body was not saved; its log proves an XMCC2 400 and a subsequent provider switch, not identical fields to the pinned sample. No exact provider limit has been established.

## Single-entry, single-exit execution graph

```text
client JSON/SSE entry
 -> lossless Inbound -> request Chat Process -> Router -> Target candidate
 -> standard Outbound -> private Provider Compat -> Provider wire/transport
 -> complete buffered attempt
 -> success: response Chat Process/Outbound -> one client SSE/HTTP projection
 -> failure: Error01 source -> Error02 classification -> Error03 local action
             -> Error04 exhaustion -> Error05 execution decision
             -> Runtime releases this attempt's admission and buffers
             -> retry: Runtime asks Target for another eligible candidate;
                       same request and client session remain open
             -> terminal: Error06 proxy projection
 -> one client SSE/HTTP commit -> Runtime request resource closeout
```

The Error chain owns failure decisions; Runtime alone owns the attempt loop and the request/session closeout; Target selects only inside the selected route. A retry does not reenter Inbound, mutate client payload, infer control truth from logs, or commit provider response bytes to the client. Each failed attempt releases its own admission and buffers while Runtime retains the request and client session. A terminal decision or successful response meets at one client commit and one request resource closeout. Cancellation or client disconnect also reaches that Runtime closeout without another attempt. A failed candidate is excluded for the current request before another is selected. Persistent provider state changes only through typed provider-health policy; declared request-local compatibility failures are health-neutral and exclude only their candidate. An unconfirmed cause does not introduce a new health exemption or global cooldown.

## Current issue work

1. **Find the first rejected shape.** Preserve the full projected Chat body and provider raw response in local protected samples. Compare minimal controlled probes that vary one independent dimension at a time: serialized bytes with similar token count, token count with similar serialized bytes, per-description length, and tool count. Bind every probe to provider, auth alias, model, entry request ID, exact wire-byte count, upstream status, and client outcome. No field is removed from an actual client request to make it pass.
2. **Classify the failure in the Error chain.** An upstream 400 can be request-specific incompatibility, capacity, or provider policy. The raw status alone cannot decide global provider health. When the cause is known, the unique Error policy owner emits a typed request-local candidate exclusion or the correctly scoped provider management action. Target consumes that decision and selects the next compatible candidate. The successful provider response follows the normal response graph.
3. **Protect the client connection.** Provider attempts remain buffered before client commitment. Retry/reselection and provider probes must not terminate the client transport or expose raw provider errors. Exhaustion goes through Error05/06 as a proxy-owned terminal result; it does not copy the last provider HTTP status or body. The next client turn must still enter normally. JSON and SSE entrypoints obey the same decision graph.
4. **Capacity admission remains blocked.** Do not configure `max_wire_request_bytes`, add a hard gate, truncate history/tools/arguments, or cool XMCC2 globally based on the current size correlation. If byte-specific capacity is proved, separately review where final serialized bytes are measured and reused, how a typed capacity mismatch excludes exactly one candidate without consuming a sent-attempt budget or provider health, and how pinned/exhausted requests terminate. The cause-unconfirmed path keeps sending the full request and using the existing Error reselection path.

## Verification and delivery gates

- Design review must first confirm this Error/Target graph and its resource release edges; do not use review to discover the provider's unknown request limit.
- Red/green tests must cover provider 400 followed by a successful alternative, repeated same-shape attempts and the intended provider policy, a pinned/exhausted proxy terminal, no raw provider error in client JSON/SSE, and a successful next client turn on the same session. Preserve exact tool identities, arguments, results, and follow-up behavior.
- Black-box comparison uses the same 4444 `/v1/responses` entry for `gpt-5.5` and the pinned sample, with the provider-bound body and client terminal observed separately. A fallback 200 does not prove XMCC2 itself accepts the original request.
- Only a fully debugged, tested, real-entry verified candidate may enter independent implementation review. Merge, push, rebuild, install, official `rccv3 restart`, live replay, post-restart sample audit, and owned-resource cleanup require separate receipts.
