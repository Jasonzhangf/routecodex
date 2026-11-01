# Provider Request and Error Diagnosis

## When

Use for provider 4xx/5xx, wrong endpoint/model, malformed wire body, provider switch, pool exhaustion, or client-local disconnect after an earlier provider failure.

## A/B/C

1. A: minimal direct request to same provider/model/endpoint/auth.
2. B: exact captured provider-bound body to same provider; add transport auth/header only.
3. C: exact client request through same RouteCodex entry/runtime/config.

Do not change model, provider, key, protocol, history, or body between B and captured artifact. Reuse an existing bound result; run only the missing comparisons needed to distinguish the current hypothesis. The table gives diagnosis directions, not root-cause proof. A successful switch or a failing minimal request does not replace investigation of the original failure.

| Result | Owner direction |
| --- | --- |
| A fails | provider/auth/model/endpoint baseline |
| A passes, B fails | provider-bound construction or request semantics |
| A and B pass, C fails before send | RouteCodex request/route/provider-runtime boundary |
| provider raw succeeds, client fails | response decode/governance/projection/framing |
| provider raw fails, later client disconnects | keep provider failure and transport-local disconnect separate |

## Request Dry-Run

Use same entry and `x-routecodex-dry-run: provider-request`. Require final URL, headers, body, selected provider/model/protocol, and stopped-before-send evidence. A locally constructed codec body is not provider-bound pipeline evidence.

## Failure Chain

For every attempt record:

```text
request id -> candidate -> provider request -> raw status/body/event
-> typed Error source/class/action/decision -> next candidate or exhausted transport termination
```

Do not merge errors from different attempts. A transport-local 499 does not replace an earlier provider 4xx/5xx. Only business content enters client projection; the Error chain does not project a client error payload.

## Closeout

1. Red exact failing shape and one control shape.
2. Patch first-divergence owner only.
3. Run mapped tests/gates.
4. Reuse the main skill's applicable config/install/restart/health evidence; details are in `50-rcc-config-ssot.md`.
5. Replay the exact failing sample through the real entry. Repeat only A/B/C comparisons whose inputs changed or whose evidence remains missing. Report an upstream shape that is no longer reproducible as a remaining live gap, not a confirmed fix.
