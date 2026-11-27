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

A fresh selection that loses its supplying occurrence returns to Target. It
does not mark an unsent identity as a failed delivery. An untouched declaration
of that identity can still serve the request. A pending retry after an actual
failure has different custody: losing its witness closes that failed episode
and excludes the full identity for the rest of this request. A tail transition
cannot grant that request a new episode or retry budget.

Runtime request control retains the last actual failure's identity, canonical
typed source and complete HTTP witness across Direct/Relay handoffs. Selection,
invalidation and handoff do not replace it. The next actual transport invocation
does replace it. An independent local error keeps its own terminal cause.
Error alone qualifies real final HTTP projection.

A consumed failed recovery trial ends the request's active episode, including
the final-only health-neutral case. No-send health contention causes selection
invalidation and leaves Provider failure accounting and another owner's trial
untouched. Plans without an active pool rank the existing merged candidate view.
Their provider-priority schedule uses that same merged view to build its tier
table. Active plans retain occurrence-local schedule tiers.

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
| Ordinary request in a known conversation receives a complete real HTTP 400 with exact `session_turn_limit_exceeded` | Increment once after actual dispatch | End the episode. Exclude all aliases of that Provider for this conversation. Usable compact clears only the observed restrictions, as described below. Keep Provider health separate. |
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

Estimated-turn and conversation-restriction filters run before dispatch. They
consume no retry budget or delivery failure. A usable compact clears only the
conversation restrictions observed when it began. Its accepted business success
also resets its own matching active streak. Compact never releases another held
member or restores an obsolete binding. Manual queue release does not clear a
conversation restriction.

Provider cooldown recovery uses an exclusively owned real business attempt when
its minimum time and cadence are due. Runtime validates active membership, the
selection generation and retry budget before acquiring that trial. A held key
cannot acquire it. Other requests immediately use eligible declared successors.
Only a complete accepted business success settles the health trial. Failed
trials retain their cooldown and can end an active retry episode early. Queue
release changes no health restriction or recovery cadence.

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

Config derives one shared control location under
`<canonical-parent>/.active-key-control/<canonical-basename>/listener/`.
The basename remains its original legal filesystem component. Listener bytes
are split into chunks of at most 60 bytes, encoded as lowercase hex and prefixed `s-`,
then followed by the fixed `endpoint.json` leaf. Each generated component is
bounded and distinct under case-insensitive lookup. Every byte is encoded. Ordinary
`config.toml` symlinks retain their canonical config scope.

Only Server creates these directories and publishes the record. Its owner
removes the matching record and prunes empty scoped directories up to and
including the `.active-key-control` boundary. It never recursively removes them.
A foreign record, another listener and a longer listener's continuation path
remain untouched. Publication failures preserve their actual error and close
only the failed companion. Admin path discovery creates nothing.

Storage opens the valid canonical parent once, then traverses only bounded
components through directory handles. Composed path strings are diagnostic
addresses, not filesystem syscall inputs. A stable `.active-key-control.lock`
file in that parent serializes publication and compare/remove/prune, including
directory preparation. Reads take a shared lock. Server creates the lock file
without truncation; Admin opens an existing one. The empty lock file belongs
to the shared config namespace and remains after an individual endpoint closes.
No lock spans HTTP, Provider or business-routing work.

Asynchronous discovery, publication and explicit cleanup use a one-second lock
acquisition deadline. They poll the OS try-lock with an asynchronous timer.
Opening handles and complete locked transactions run outside the business worker.
Cancellation or expiry before acquisition leaves no waiter that can mutate later.
An acquired transaction finishes before its result is reported. Discovery timeout
returns an explicit control 503. Only actual NotFound permits absent-record handling.
Business accept starts before the bounded publication batch.

Port-scoped release matches each actual listener's ID and bound address. It closes
only that listener's control owner. Failed stopped owners remain retryable on the
same port request; siblings continue serving. Managed acknowledgement follows the
cleanup outcome. Explicit shutdown and exec close report control cleanup separately
from sample persistence. Synchronous Drop tries cleanup once, then reports any
retained record. It never waits for a lock or creates a detached cleanup task.

Actual managed restart uses borrowed exec preparation. It captures exact endpoint
ownership in the existing typed exec envelope without changing original files or
transports. Rejected exec and pre-exec cancellation retain the original controls.
After verified managed-owner adoption, the successor compares and replaces only
the complete inherited record under its namespace transaction. It retires inherited
addresses no longer used, preserves foreign records and retains unresolved cleanup
responsibility. Ordinary startup still creates records exclusively. Queue and health
state do not enter this transport handoff. Managed startup supplies its declared
canonical config even when no Admin listener is enabled.

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
