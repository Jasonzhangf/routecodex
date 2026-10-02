# Cooldown pool: manual add / release / probe + layout

feature_id: v3.admin_cooldown_manual_actions

## Goal

The Usage page cooldown panel is read-only and its two-column card grid wraps
badly at every width. Add three explicit operator actions and rewrite the panel.

1. **手动加入 (manual add)** — inject cooldown state for a triple
   `(provider_id, auth_alias, model_id)` so the runtime stops selecting it,
   exactly as a real typed provider failure would.
2. **手动解除 (manual release)** — clear matching cooldown/probe state. The
   store method and the remove endpoint already exist and are already wired
   end-to-end; the UI simply never called them.
3. **人工探测 (manual probe)** — force a recovery probe to run now instead of
   waiting for `next_probe_at_ms`.
4. **排版 (layout)** — replace the wrapping two-column card grid with a flat
   per-listener table that scales to many entries and to narrow viewports.

## Truth sources (do not duplicate)

- Current provider health/cooldown truth is `V3ProviderHealthStore` in
  `v3/crates/routecodex-v3-provider-responses/src/health.rs`.
  - `cooldown_entries(now_ms)` — projection read (`GET`).
  - `remove_cooldown_entry(provider_id, auth_alias, model_id, kind)` — release
    (already exists, already reachable).
- Probe scheduling truth is `provider_cooldown_probes`
  (`V3ProviderCooldownProbeState`), consumed by
  `V3ProviderHealthPolicy::run_due_provider_health_probes`
  (`v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs:488`).
  The 1-second driver loop is `v3/crates/routecodex-v3-server/src/lib.rs:644`.
- Persistence is `persist_cooldown_state` (`health/persistence.rs:329`). Every
  mutating store method must call it, so manual state survives restart.
- The listener endpoints are loopback-only
  (`v3/crates/routecodex-v3-server/src/webui_observability_endpoints.rs`).
- The Admin proxies them at `POST /api/observability/cooldown-pool` and adds
  `x-routecodex-admin-token` enforcement. The passthrough handlers live in
  `v3/crates/routecodex-v3-admin/src/api/observability/cooldown.rs` (145
  lines), wired by `api/observability.rs:57`.

## Design decisions (locked — do not re-litigate in review)

**D1. Manual probe advances the schedule; it does not invent a probe path.**
`trigger_probe_now` sets `next_probe_at_ms = Some(now_ms)` (leaving
`blocked_until_ms` intact) on the resolved probe key. The existing 1-second
loop then observes it as due and runs the same
`build_v3_provider_global_probe_target` / `probe_v3_provider_global_target`
path a scheduled probe uses. A manual click therefore cannot bypass the
provider wire, cannot run a probe that the ladder would refuse, and cannot
leave probe state inconsistent if the runtime is mid-tick.
Rationale: any design that executes the probe synchronously inside the HTTP
handler would duplicate the probe transport and the permit/generation
bookkeeping. That is a second implementation of an owned behaviour.

**D2. Manual add supports `auth_key` and `probe` kinds only.**
`session` cooldowns are keyed by
`V3ProviderFailureSessionKey { server_id, routing_group, session_id,
provider_runtime_identity }`. There is no operator-supplied session identity in
the UI and inventing one would create state no real session can clear, so
manual add rejects `session`. Manual *release* keeps supporting all three kinds
because it only matches existing keys.

**D3. Manual add duration is explicit and bounded.**
The request carries `duration_ms`. The store clamps it to
`1 ..= V3_COOLDOWN_MANUAL_MAX_MS` (24 h) and rejects anything outside rather
than silently coercing. `until_ms = now_ms + duration_ms`. A `probe`-kind add
sets `blocked_until_ms = until_ms`, `next_probe_at_ms = until_ms`, and starts
from ladder position 0, so the first recovery probe is due when the manual
cooldown expires. Manual state must be indistinguishable to the runtime from a
failure-driven cooldown of the same shape — no marker, no special case in
selection.

**D4. Manual add is idempotent per identity.** Adding to an identity that is
already cooled extends to the later of the two deadlines and keeps the higher
failure count; it does not stack duplicate entries (the store maps are keyed by
identity, so this falls out of the data model — do not add a second map).

**D4a. `auth_key` add must write the same pair a failure writes, and must
normalize the key to `model_id = None`.** Verified facts:
`record_provider_failure_action` writes *both* `auth_key_cooldowns` and a paired
`provider_cooldown_probes` entry at `(provider, auth, None)` (health.rs:631-650);
`provider_cooldown_persistence_entries` serializes **only**
`provider_cooldown_probes` (persistence.rs:304-327); startup restore rebuilds
**only** `provider_cooldown_probes` (health.rs:451-470); and
`global_availability_projection` blocks selection by reading
`provider_cooldown_probes` at the exact key (health.rs:1809+). Therefore a manual
`auth_key` cooldown that writes only the auth_key map would be non-durable,
would not match failure-driven shape, and would not block selection at all.
`auth_key` add writes the pair, at `model_id = None`, so the projection shows
`model_id: null` for those rows exactly as a real auth-key failure does.

**D4b. Probe-kind add on an existing entry extends; it does not reset.**
Extension preserves `probe_failure_count`, `probe_interval_ms`,
`probe_in_flight`, `long_probe_backoff` and the `observed_*` counters, and only
raises `blocked_until_ms` / `next_probe_at_ms` to the later deadline. This
honours D4 ("keeps the higher failure count") and the codebase's single-flight
invariant. A *fresh* add starts at ladder position 0 with
`probe_in_flight = false`.

**D5. The panel is a table, not a card grid.** One section per listener
(`server_id :port`), one row per identity, columns:
`Provider | Auth | Model | Kind | State | Remaining | Failures | Reason |
Actions`. Actions are per row: `Probe now` and `Release`. `Add cooldown` is one
button in the panel header that opens a form. At narrow widths the table
degrades by hiding `Auth`/`Model`/`Reason` into a disclosure line rather than
by horizontal scrolling.

**D6. Nothing in this change may alter selection behaviour beyond the store
state it writes.** No new branch in routing, no new fallback, no probe policy
change, no ladder change.

## Interface contract (freeze before parallel work)

### Listener (loopback-only), `v3/crates/routecodex-v3-server/src/webui_observability_endpoints.rs`

```
POST /_routecodex/health/cooldown-pool/add
  { provider_id: string, auth_alias?: string, model_id?: string,
    kind: "auth_key" | "probe", duration_ms: u64 }
  -> 200 { ok: true, applied: "<auth_key|probe>", provider_id, auth_alias,
           model_id, until_ms }
  -> 400 invalid body, or the store's invalid-manual error (bad kind,
         duration outside 1..=24h)
  -> 403 non-loopback
  -> 500 lock poisoned

POST /_routecodex/health/cooldown-pool/probe
  { provider_id: string, auth_alias?: string, model_id?: string }
  -> 200 { ok: true, scheduled: bool, provider_id, auth_alias, model_id }
       scheduled=false when no probe state exists for the identity
  -> 400 invalid body
  -> 403 non-loopback
  -> 500 lock poisoned
```

`GET /…/cooldown-pool` and `POST /…/cooldown-pool` (release) are unchanged.

### Store, `v3/crates/routecodex-v3-provider-responses/src/health.rs`

```rust
pub const V3_COOLDOWN_MANUAL_MAX_MS: u64 = 24 * 60 * 60 * 1000;

impl V3ProviderHealthStore {
    /// Manual operator cooldown. `kind` is "auth_key" or "probe"; anything else
    /// is rejected with a typed error and mutates nothing. `duration_ms` outside
    /// `1..=V3_COOLDOWN_MANUAL_MAX_MS` is rejected, not clamped.
    /// `kind = "auth_key"` writes the D4a pair at `model_id = None`.
    pub fn add_cooldown_entry(
        &self, provider_id: &str, auth_alias: Option<&str>, model_id: Option<&str>,
        kind: &str, duration_ms: u64, now_ms: u64,
    ) -> Result<u64, V3ProviderHealthError>;   // Ok(until_ms)

    /// Advance an existing probe to due-now. Ok(false) when the identity has no
    /// probe state.
    pub fn trigger_probe_now(
        &self, provider_id: &str, auth_alias: Option<&str>, model_id: Option<&str>,
        now_ms: u64,
    ) -> Result<bool, V3ProviderHealthError>;
}
```

Both take the write lock and call `persist_cooldown_state` when they mutate.

**Cross-crate visibility (verified constraint).** `mod health;` is private
(lib.rs:5), and the server crate has **no** production dependency on
`routecodex-v3-provider-responses` — `verify:v3-module-boundaries` fails if one
is added. So the server cannot name `V3ProviderHealthError` or
`V3_COOLDOWN_MANUAL_MAX_MS`. The store therefore also exposes a name-free
predicate so the server can map status without importing the enum:

```rust
impl V3ProviderHealthError {
    pub fn is_invalid_manual_cooldown(&self) -> bool;
}
```

Server mapping: `Err(e) if e.is_invalid_manual_cooldown()` → 400; other `Err` →
500. The 1..=24h bound and the kind allowlist live in exactly one place (the
store); the server does not re-validate them.

### Admin proxy, `v3/crates/routecodex-v3-admin/src/api/observability/cooldown.rs`

```
POST /api/observability/cooldown-pool/add    -> forwards to listener /add
POST /api/observability/cooldown-pool/probe  -> forwards to listener /probe
```
Same shape as the existing release handler: validate `port` is configured,
forward with the 2 s client, surface the listener's status and body verbatim.
Route registration is in `api/observability.rs` `routes()`.

### Frontend, `v3/admin-webui/app/views/usage.js`

The panel host is `<div class="panel" id="cooldown-panel">` in
`v3/admin-webui/requests.html:116`. Its page-scoped styles live in the inline
`<style>` block at `requests.html:9-36` (`.cooldown-grid`, `.cooldown-card`,
`.cooldown-card h4`, `.cooldown-remaining`). The rewrite replaces those rules;
`styles.css` stays the shared-skin file.

`state.cooldown` stays the single read model. Actions post through
`api()` from `core.js` (which already attaches the admin token) and then
re-run `loadCooldown()`. No optimistic local mutation of cooldown state.

## Parallel work split (disjoint write scopes)

| # | Owner | Write scope | Depends on |
|---|-------|-------------|-----------|
| T1 | backend-store | `v3/crates/routecodex-v3-provider-responses/src/health.rs` (+ its `#[cfg(test)]` mod) | — |
| T2 | backend-server | `v3/crates/routecodex-v3-server/src/webui_observability_endpoints.rs`, `v3/crates/routecodex-v3-server/src/lib.rs` (route table only) | T1 |
| T3 | backend-admin | `v3/crates/routecodex-v3-admin/src/api/observability/cooldown.rs`, `v3/crates/routecodex-v3-admin/src/api/observability.rs` (route table only) | T1, T2 |
| T4 | frontend | `v3/admin-webui/app/views/usage.js`, `v3/admin-webui/requests.html` (inline cooldown styles + panel markup only) | T1–T3 contract |

T4 may build the layout pass against the frozen interface above before T1–T3
land; it must not define its own endpoint.

## Acceptance evidence

1. `cargo test -p routecodex-v3-provider-responses` — store roundtrip:
   add → `cooldown_entries` shows it; add is idempotent and extends; probe
   advances `next_probe_at_ms`; release clears; manual state survives a
   persistence reload.
2. `cargo test -p routecodex-v3-admin` and the server's own tests.
3. `npm run verify:webui-smoke` — all five scripts still pass.
4. Live: `POST add` → entry appears in `GET`; `POST probe` → state becomes
   `probing` then resolves; `POST release` → entry gone.
5. Live: manual cooldown survives `rccv3 restart -c <config>`.
6. Screenshot of the rewritten panel at 1440 and 390.

## Hard constraints

- Loopback-only on new listener endpoints; admin token required on new admin
  endpoints.
- No change to provider failure policy, probe ladder, or routing selection.
- Per-file `edit` only. No Python/Node/Perl/sed/awk bulk semantic replacement.
- No `--no-verify`, no hook bypass.
- File size gate: every `v3/` `.rs` file stays <= 1500 lines
  (`verify:v3-file-size`), except the 13 shrink-only ratchet entries in
  `v3/config/v3-file-size-policy.json`. Relevant facts, verified:
  - `provider-responses/src/health.rs` is 2186 lines with a ratchet snapshot of
    **2411** — headroom exists, but prefer a new submodule.
  - `admin/src/api/observability/cooldown.rs` is 145 lines — plenty of room.
  - `admin/src/api/observability.rs` is 1396/1500 — **only 104 lines**. Do not
    add handler code there; route-table edits only.
  - The gate counts only `.rs` files under `crates` (tests excluded), so
    `admin-webui/app/views/usage.js` is not gated by it. Keep it readable
    anyway; the module-boundaries and smoke gates still apply.
