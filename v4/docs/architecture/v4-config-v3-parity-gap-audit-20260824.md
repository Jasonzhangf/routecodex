# V4/V3 parity gap audit — configuration-first reset

Date: 2026-08-24
Baseline: current V4 integration worktree HEAD (`8d94b2f2b`) and the live V3
7777 configuration at `/Volumes/extension/.rcc/config.v3.toml`.

## Corrected completion boundary

The following V4 evidence is real but is only independent runtime admission:

- Active-link, layer-batch, build, install, managed restart and V4 health pass;
- V4 Responses JSON/SSE and Chat relay smoke pass;
- V4 currently consumes a V4 authoring file and a compiled manifest.

It does not prove V4 product completion. The product completion contract requires
V3/V4 differential and live parity, followed by artifact freeze.

## Gap matrix

| Surface | V3 7777 baseline | V4 current | Status |
| --- | --- | --- | --- |
| Authoring format | `version=3`, `route_groups`, `pools`, `servers`, feature/error/debug policy | `version=4`, `runtime`, flat providers/routes | gap: import/compiler |
| Provider catalog | many providers, protocol-specific profiles, auth aliases/keys | one Responses-oriented provider candidate in live manifest | gap: multi-provider/model/auth |
| Protocols | Responses, OpenAI Chat, Anthropic and provider-specific wire protocols | Responses upstream plus Chat relay projection | gap: protocol coverage |
| Route selection | route group → pool → match/capability → priority/SWRR → target | model → flat route → priority target | gap: route semantics |
| Health/error policy | configured retry/cooldown/probe/action policies | typed error foundation; no V3-equivalent configured policy | gap: health/action |
| Continuation | direct/relay ownership and scoped multi-turn stores | not implemented by design; V3 `previous_response_id` remains closed | closed-by-decision |
| Tool/servertool/stopless | V3 production governance and multi-protocol projection | minimal V4 governance path | gap: semantic migration |
| Live evidence | 7777 real provider attempts and historical samples | one V4 canary provider replay | gap: differential/live |
| Product ledger | full V3 baseline | `source_only`, differential/live/artifact pending | gap: release eligibility |

## Configuration-first decision

The unique first implementation owner is `routecodex-v4-config`. It must produce
a deterministic V4 manifest from a typed V4 authoring model. A V3 import is an
explicit compiler input/projection, not a runtime dependency: V4 must never read
the V3 runtime, call V3, or merge two live configuration sources at startup.

The first slice will cover the V3 7777 Responses route group as a typed,
secret-free import fixture. It will preserve provider/model/protocol/auth-handle,
route-group/pool/match/priority and error-policy declarations in the V4 manifest.
Runtime selection and provider execution are separate follow-up owners and may
not be silently inferred from this config slice.

## Required gates for this slice

1. V3 fixture import positive: deterministic normalized manifest and stable hash.
2. Negative: unknown V3 fields, inline secret material, unsupported provider
   protocol, duplicate provider/model identity and unserved route target fail fast.
3. Differential: normalized V4 config retains every declared 7777 provider,
   model, route pool and policy; unexplained omissions are zero.
4. Isolation: no V3 runtime call, startup, write, or payload projection.
