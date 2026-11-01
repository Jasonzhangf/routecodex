# V3 Provider Priority Schedule

## Contract

Each server may declare a daily peak schedule for selected providers. The
schedule is evaluated in the configured IANA timezone and changes only the
provider's effective priority inside the selected route pool.

```toml
[servers.routecodex_v3_4444.provider_priority_schedule]
timezone = "Asia/Shanghai" # default
peak_periods = [{ start = "09:00", end = "18:00" }]

[[servers.routecodex_v3_4444.provider_priority_schedule.providers]]
provider = "xcreate-paid"
peak_tier = 3
off_peak_tier = 1
```

`tier` is one-based: `1` is the highest priority and larger numbers are lower
priority. Peak windows use `[start, end)` semantics and may cross midnight,
for example `22:00` to `02:00`. An empty `peak_periods` list means that the
off-peak tier is always active.

The schedule is server-scoped. Its configured provider must exist in the
provider catalogue, and both configured tiers must exist in every simplified
route pool containing that provider. Invalid IANA timezones, malformed times,
duplicate provider entries, empty provider ids, and non-positive tiers are
rejected during config projection/validation.

The schedule applies only to declared route pools. Synthetic pools, including
`implicit:<capability>` capability pools and direct-provider pools, have no
declared tier list; they retain their intrinsic candidate priority and are not
adjusted by this schedule.

## Ownership and boundaries

- Config owns parsing, defaulting the timezone to `Asia/Shanghai`, validation,
  and manifest publication.
- Target owns local-time evaluation and effective-priority selection.
- Health/cooldown remains the availability input and is never changed by the
  schedule.
- Route-pool precedence remains stronger than provider priority. The schedule
  cannot move a candidate across route pools or make an unavailable/cooldown
  candidate selectable.
- The schedule is typed control state only. It must not enter request payloads,
  provider wire payloads, client responses, metadata, or debug-derived control
  state.

## Provider model availability windows

A provider model may declare its own availability window in the provider
catalogue. This is separate from the server-scoped priority schedule: the
schedule changes an eligible candidate's priority, while an availability
window decides whether the candidate is admitted at all.

```toml
[provider.models."deepseek-v4.1-flash-1017"]
availability = { timezone = "Asia/Shanghai", guard_minutes = 10, periods = [
  { start = "22:00", end = "08:00" },
] }
```

- An omitted `availability`, or an empty `periods` list, means the model is
  available at any time.
- Periods use `[start, end)` local-time semantics and may cross midnight.
- `guard_minutes` shrinks each period on both edges, so routing never starts a
  request in the minutes adjacent to a billable boundary. It must be between 0
  and 719, and a period whose length is not longer than twice `guard_minutes` is
  rejected during validation.
- Outside the window the candidate is excluded from selection and recorded as
  `<provider>:<interface>:<auth>:<model>:availability_inactive` in target
  diagnostics. It is not a fallback tier and never mutates provider health.
- The same window gates every real provider request, including recovery probes
  and the periodic probe sweep. A probe is never sent outside the window.
- A pool whose every candidate is outside its window reaches the declared
  exhaustion path immediately; it does not wait for the window to open.
