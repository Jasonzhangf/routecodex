# Provider Request and Error Diagnosis

## When

Use for provider 4xx/5xx, wrong endpoint/model, malformed wire body, provider switch, pool exhaustion, or client-local disconnect after an earlier provider failure.

## A/B/C

1. A: minimal direct request to same provider/model/endpoint/auth.
2. B: exact captured provider-bound body to same provider; add transport auth/header only.
3. C: exact client request through same RouteCodex entry/runtime/config.

Do not change model, provider, key, protocol, history, or body between B and captured artifact.

| Result | Owner direction |
| --- | --- |
| A fails | provider/auth/model/endpoint baseline |
| A passes, B fails | provider-bound construction or request semantics |
| A and B pass, C fails before send | RouteCodex request/route/provider-runtime boundary |
| provider raw succeeds, client fails | response decode/governance/projection/framing |
| provider raw fails, later client disconnects | keep provider failure and transport-local disconnect separate |

## Request-Caused Failure Check (Do This First)

Question to answer first: is this provider 5xx caused by the request, or by the
provider/transport? Answer it with two minimal steps, in this order.

1. Minimal probe (A): smallest valid direct request to the same provider/model/endpoint/auth.
   This proves only whether the provider/auth/model/endpoint baseline is up.
2. Same-payload reproduction (B0): replay the exact provider-bound body **for the failing
   request id**, verbatim, to the same provider/model/endpoint/auth, adding only the transport
   auth/header. Do not add, remove, or reorder fields. Capture it via request dry-run
   (`x-routecodex-dry-run: provider-request`) or the installed runtime request snapshot.

   Critical: B0 must use the *error sample* — the provider-bound body actually sent for the
   failed request. Replaying a success sample, a different request id, a locally reconstructed
   body, or any body that did not fail does NOT test the error sample. If the error sample has no
   captured provider-bound body, obtain one first (replay the failed client payload through the
   same entry dry-run with `provider-request`, or enable provider-request snapshot for the next
   reproduction). Until the error sample is B0-tested, the failure remains UNVERIFIED.

Decision (this is the whole point of the two steps):

| Minimal probe A | Same-payload B0 | Conclusion |
| --- | --- | --- |
| fail | not needed | provider/auth/model/endpoint baseline down; NOT request-caused |
| pass | pass (error sample) | NOT request-caused; failure was transient or local (transport/runtime) |
| pass | fail | request-caused; only now go to shape bisection |

Do not start field-by-field bisection until A passes and B0 fails. A passing alone is NOT evidence
the provider is healthy for the real body; B0 failing alone (without A) is NOT evidence the request
is at fault. A B0 pass on a non-error sample proves nothing about the error sample and must be
reported as UNVERIFIED, not as exclusion.

## Shape Bisection (Only After A Passes And B0 Fails)

Now the failure is proven request-caused. Bisect by semantic field groups, not by arbitrary key
deletion:

- tools / tool schema shape (including namespace and custom formats)
- messages / history length and content
- text / response_format / structured output
- thinking / reasoning effort
- stream vs non-stream
- temperature / top_p / stop / max_tokens

Each reduced shape needs a control shape: keep the reduced fields valid and change only the
suspected semantic content. A failure that disappears when a field is removed and reappears when
that same field is re-added is a proven shape dependency. Record the full matrix — A, B0, each
reduced shape, each control shape — with raw status/body/event; do not conclude from one attempt.

Owner by the matrix:

- A pass, B0 fail, reduced shapes pass → provider-bound request semantics / wire projection;
  inspect outbound construction, not upstream health.
- A pass, B0 pass, C fail → RouteCodex request/route/provider-runtime boundary.
- A pass, B0 pass, C pass but the log still 5xx → transient upstream or projection race; do not
  claim request-caused.

Any “request-caused” or “request-shape related” claim must cite this A/B0/reduced/control matrix.

## Request Dry-Run

Use same entry and `x-routecodex-dry-run: provider-request`. Require final URL, headers, body, selected provider/model/protocol, and stopped-before-send evidence. A locally constructed codec body is not provider-bound pipeline evidence.

## Failure Chain

For every attempt record:

```text
request id -> candidate -> provider request -> raw status/body/event
-> typed Error source/class/action/decision -> next candidate or client projection
```

Do not merge errors from different attempts. A transport-local 499 does not replace an earlier provider 4xx/5xx.

## Closeout

1. Red exact failing shape and one control shape.
2. Patch first-divergence owner only.
3. Run mapped tests/gates.
4. Run `50-rcc-config-ssot.md` for install, config check, managed restart, and health proof.
5. Replay A/B/C and exact old sample. Report any upstream shape no longer reproducible as a remaining live gap.
