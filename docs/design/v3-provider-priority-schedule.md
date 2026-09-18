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
