# Active key selection

This design implements the opt-in behavior in `routecodex-active-key-queue` v2.
Production activation is separate from source integration and candidate acceptance.

## Configuration

An existing server route pool can select a subset of declared account aliases.
Credentials remain in the Provider auth configuration.

```toml
[servers.example.routes.default]
selection = { strategy = "active_queue" }
active_keys = { members = [{ provider = "provider_name", alias = "account_a" }, { provider = "provider_name", alias = "account_c" }], retries = 3, on_failure = "tail" }
tiers = [[{ use = "provider_name/model_name" }]]
```

The example is a route-pool fragment. The server, Provider, model and aliases must
already exist. Only `account_a` and `account_c` participate in this pool. Explicit
target key/interface restrictions and route tiers still apply.

| Strategy | Selection behavior |
| --- | --- |
| `active_queue` | Keep the eligible queue head after success. |
| `round_robin` | Rotate fresh requests through eligible active members. |
| `sticky` | Prefer the session's accepted successful member. Rotate initial assignments for new sessions. |

An absent `active_keys` field preserves legacy scheduling. An explicit empty
`members` list activates no members. Inactive accounts never become implicit
fallback. The active list does not create routes or promote lower tiers.

A concrete account can occur in more than one pool or tier. The selected route
keeps the declaration occurrence that supplies it. Only that occurrence's pool
policy applies. A hold in one pool does not hold an independently declared
occurrence in another pool. Once this request closes a failed account episode,
its complete identity remains excluded across all declarations for that request.
Error observes eligible occurrences without moving queue cursors or assigning
affinity. A fresh active successor must pass Target selection and carry its
selection witness before dispatch.

`on_failure` is `hold` or `tail`; its default is `hold`. A held member waits for
manual release. A tail member can be selected by a later independent request
when queue order and health permit it. Neither action cycles an exhausted member
back into the same request.

## Failure counters and binding

The per-request retry budget and the shared failure streak have different scopes.
The default episode permits an initial dispatch plus at most three retries.
Known nonretryable failures and health exclusions can end it earlier.

The selection streak belongs to one listener, routing group, pool, Provider,
interface, model and auth alias. It survives early episode closure and independent
requests. The fourth consecutive delivery failure atomically:

1. Invalidates every session preference to that member in the selection scope.
2. Applies the configured hold or tail transition once.
3. Advances the member generation and resets its next-generation streak.

Three failures followed by accepted business success do not trigger a transition.
Accepted success resets the matching streak. An HTTP 2xx header or successful
background probe is not accepted business success.

| Typed outcome | Streak | Same-key recovery |
| --- | --- | --- |
| Ordinary real HTTP 429 or recoverable 5xx | Increment | Retry within episode budget and current health eligibility. |
| Confirmed auth/account/quota failure, HTTP 403, HTTP 400/422 | Increment after actual dispatch | End this episode and reselect without repeating the unchanged rejection. Preserve existing health rules, including the separate 403 threshold. |
| Provider timeout, reset or truncated body before business commit | Increment | Retry only if the typed cause and current eligibility permit it. |
| Response decode, post-filter empty result, unharvestable tool leakage or local response-processing failure after dispatch | Increment | End the episode and follow the existing typed Error recovery path. Synthetic 502/599 is not proof of account health failure. |
| Local request failure before Provider invocation | Unchanged | Use its existing local Error path. |
| Client cancellation or cancellation-induced transport abort | Unchanged | Stop only the cancelled request. |
| Accepted representable invalid model arguments, refusal or content_filter | Reset | Deliver the business result. Preserve paired next-turn tool error results. |
| Failure after business commit | No new recovery event | Never replay committed business content. |

The fourth failure can close an episode before its configured retry budget is
used. A later request cannot restart the shared streak merely by creating a new
episode. Queue counters never substitute for Provider health counters.

## Concurrency and persistence

Each actual attempt outcome is consumed once. Old member generations cannot
reset a new streak, rotate twice, recreate affinity or undo release. A tail
member can be eligible for a new request while an older episode is invalid;
Runtime checks the captured selection generation before dispatching a retry.
If an active bucket becomes unavailable between observation and choice, selection
continues to a declared eligible bucket or reports exhaustion. It cannot sample
the unavailable active bucket through legacy selection.

For one session, an older successful completion cannot replace a newer
successful binding. Accepted in-flight business responses remain deliverable
even when their selection feedback is stale.

Held members persist in a separate selection-state file. Retry budgets,
consecutive streaks and session preferences remain transient. Disk writes are
serialized outside the selection lock. Persistence failures remain explicit;
they do not silently release held members.

A failed hold-store write does not discard the applied in-memory transition.
Control status exposes the durability error while the business request continues
to an eligible successor. A tail transition does not write an unchanged held
set. Operator release still reports a failed durable write explicitly.

Runtime retains the source and complete HTTP witness of the last actual attempt
through planning and skipped retries. A new transport invocation replaces that
custody. A later actual truncation, transport or internal processing failure
therefore cannot project an earlier HTTP error.

## Controls and observation

The Routes page edits membership and strategy and displays queue state.
Its Release action targets one complete member on the selected listener.

Loopback listener controls:

```text
GET  /_routecodex/selection/active-keys
POST /_routecodex/selection/active-keys/release
```

The release body names `routing_group_id`, `pool_id`, `provider_id`,
`interface_id`, `model_id` and `auth_alias`. Release appends a held member to the
tail, resets its transient streak and advances its generation. It does not
restore old preferences, activate an inactive account, clear health cooldown or
trigger a probe. Releasing an unheld member is idempotent.

Status exposes configured aliases, concrete order and held members. Provider
health eligibility is a separate projection. It contains no credentials or raw
upstream bodies.

Admin resolves the Server-owned control address for the selected listener.
Specific loopback binds retain their actual address and port. Wildcards use
loopback in the same address family. A specific non-loopback business bind uses
a separate loopback companion with an OS-assigned port. The companion serves
only these selection controls and shares the listener's existing selection and
health handles. A narrow local endpoint record beside the canonical config
carries address and lifecycle ownership only. It carries no scheduling state.
Control startup/publication failure leaves business serving available and makes
control unavailability explicit. Aggregate shutdown, exec close and drop release
owned companion sockets/tasks and remove only their own endpoint records.

## Ownership and acceptance

Config compiles policy. Target expands the declared member universe and owns
selection, streaks and affinity. Server holds one state handle per listener and
exposes controls. Runtime/Error classifies actual attempts and reports outcomes.
Admin forwards controls and does not hold scheduling truth.

Deterministic state tests cover the third/fourth boundary, cross-request streaks,
success reset, neutral cancellation, stale outcomes, scope isolation and durable
holds. Public HTTP tests cover actual upstream alias order in Direct and Relay,
accepted business content and actual-final-attempt error provenance. The actual
Routes page must also pass isolated browser acceptance. Unit or static graph
results alone do not prove public-entry behavior or production activation.
