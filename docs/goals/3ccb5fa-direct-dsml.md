# 3ccb5fa: Direct DSML response hook

Current delivery status belongs to canonical issue `3ccb5fa` and PR #425.
The version-specific observations below are historical evidence, not a live
status mirror. Build, install, load, behavior, review and merge remain separate
claims in their actual receipts.

The existing response graph is SESE and remains unchanged. The observed path is
Responses Direct, with DSML already in inferai's raw output_text. The registered
Direct response hook owns conversion; Relay Chat Process is outside this fix.

The hook reads current request tool declarations and complete response output.
Tool identities must come from the existing shared declaration registry and
the exact attempt inverse binding, including nested namespaces and supported
discovery channels. A separate narrower declaration walk is not authoritative.
It converts complete, representable DSML envelopes into native calls, preserving
text before and after each envelope, string whitespace, JSON parameter types,
native items, extensions, call identities and matching follow-up results.
Quoted, fenced and opaque-associated examples remain unchanged. Recognized
executable markup that cannot be harvested rejects the complete attempt through
the existing typed response-processing Error/reselection path, even if prose
survives. Native calls with model-generated invalid arguments remain business
content; schema conformance is not an admission test.

The 2026-10-19 user policy extends this owner to demonstrated orphan DSML and
analysis marker lines and bounded alternate invocation markup. Complete
invocations are harvested through current declarations. Incomplete outer labels
do not prevent harvest of fully delimited calls. Remove only known label spans;
preserve exact retained prose and native calls. A separate unharvestable attempted
invocation rejects the attempt even beside complete calls. Label-only results
enter existing provider_response_empty recovery after normalization. Exhaustion
ends only that request transport without error payload or empty success.
Harvested calls use the target protocol's tool-call termination. Chat ends with
finish_reason=tool_calls; Responses exposes native function/custom_tool_call
items and legal status, without inventing a nonstandard finish_reason field.
Any existing explicit finish-reason field must agree with the harvested call.

Observed response-only marker inventory includes fullwidth calls open/close,
bare fullwidth DSML, ASCII DSML tool_calls, end_of_analysis and end▁of▁analysis,
and malformed exec_command opener with delimited cmd and numeric parameters.
The post-load 4914 audit additionally binds exact standalone ` calls>` and
`｜｜DSML｜｜ calls>` remnants, and the bounded
`<tool_call>name<arg_key>key</arg_key><arg_value>value</arg_value></tool_call>`
grammar. Its name and parameter types use the same declaration registry and
exact attempt inverse. Complete invocations leave visible prose; an incomplete
recognized invocation rejects the complete attempt. Literal examples remain
business text. Tests use only safe fixture commands.
The demonstrated standalone bare `>` lines immediately followed by the exact
fullwidth closing label form one closing residue sequence. Remove that known
sequence; retain explicit blockquote lines such as `> </｜｜DSML｜｜ calls>`.
The exact line prefix ` calls>` directly attached to a complete `<tool_call>`
belongs to that invocation and leaves no visible residue after harvest.
The user's subsequent two screenshots match inferai Responses Direct requests
`073716826-1399765-13953` (complete write_stdin text envelope),
`074639936-1399903-14091` (missing-open fullwidth label), and
`074949254-1399935-14123` (closing residue). Their complete request IDs and
private archives are retained in the issue run. No screenshot command is run.
The latest screenshot matches retained request
openai-responses-router-gpt-5.5-20261019T054307010-1395997-10185, inferai Responses
Direct deepseek-v4.1-flash. It has reasoning/message and no native call. Tests use
sanitized safe command text and preserve the demonstrated shape; raw samples
remain private. Earlier opener-only request 053212806-1395643-9831 is inxk.

Thinking normalization reuses the existing thinking owner (issue d94731e).
Complete wrappers are harvested. With complete tools and half thinking/text
labels, remove labels only and preserve the body. If the reasoning start cannot
be located, keep the body as text. An isolated closing label is removed without
deleting text before or after it, per the explicit user clarification.

JSON and fully buffered SSE use the same owner. The existing attempt store calls
the registered complete-response hook before final business admission and sealing.
Both JSON kernels and both SSE exits propagate hook failure to the existing
reselection loop. SSE projects consistent
added/delta/done/terminal events and never emits converted DSML text first.
Opaque fields on replaced item, part and text events must retain their complete
values and association. When an association cannot be represented faithfully,
the original envelope remains text instead of losing event data.
Empty standard `logprobs` arrays on text events and content parts carry no
token data and permit conversion. Nonempty logprobs retain the original
association. The SSE round-trip fixtures include these empty arrays, matching
the observed inferai stream.

The 4914 audit also proves that event output indexes are not terminal output
indexes. An observed native function is wire slot 1 and terminal slot 2, while
the stable-ID message is wire slot 2 and terminal slot 1. Protection, carrier
replacement, survivor indexes, snapshots and raw rendering must share one
attempt-local identity association. Stable item IDs and unique call IDs supply
associations; content, type order and neighboring positions do not. Retain each
original native carrier ID and argument bytes. Ambiguous opaque associations
remain protected rather than guessed. A controlled fixture with the already
recognized fullwidth close isolates this causal regression from vocabulary.

These observations invalidate a complete-acceptance claim for 4914. The issue
remains open until the amended source and public-entry cases pass, followed by
actual runtime acceptance and the remaining delivery gates. Relay marker
leakage after candidate recovery is separately tracked as issue `4effed6` and
belongs to Relay Chat Process; it must not be handled by this Direct hook.

Regression IDs and commands:

- `responses_direct_dsml_json_tool_round_trip`
- `responses_direct_dsml_sse_tool_round_trip`
- `responses_direct_dsml_literal_text_preserved`
- `responses_direct_dsml_nested_namespace_json_tool_round_trip`
- `responses_direct_dsml_nested_namespace_sse_tool_round_trip`
- `responses_direct_dsml_discovered_function_json_tool_round_trip`
- `responses_direct_dsml_discovered_function_sse_tool_round_trip`
- `responses_direct_dsml_opaque_carrier_extensions_sse_preserved`
- `responses_direct_dsml_residue_json_tool_round_trip`
- `responses_direct_dsml_residue_sse_tool_round_trip`
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test multi_listener_server responses_direct_dsml_ -- --nocapture`
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --lib direct_dsml_ -- --nocapture`

The public-entry upstream validates both rounds. The client executes a safe
owned-file image read and returns its real dimensions with the matching call ID.
Raw sample commands are never executed. Exact original read_image generation is
not retained; three analogous inferai Responses Direct samples establish scope.

Residual-policy RED, before runtime owner edits: five focused owner tests gave
one literal-preservation PASS and four FAIL for orphan cleanup, mixed marker
lines, screenshot alternate harvest and SSE deletion/remapping. Both public
residue cases failed because the retained After text still included trailing
analysis/DSML markers. These are failure receipts, not current GREEN claims.

## Historical author evidence before combined-candidate acceptance

The first public-entry run failed before runtime edits: JSON had zero native
calls, and SSE contained the serialized DSML envelope in early text events.
After the registered-hook change, all three public tests pass. The test client
reads a valid owned PNG, decodes its IHDR dimensions, and returns the real result
with the matching call ID; the upstream validates the paired follow-up.

Nine focused owner tests pass. They cover text and argument preservation,
literal/incomplete/duplicate/unknown shapes, multiple calls and namespace
restoration, lossless large JSON numbers, and attempt-budget accounting after event expansion. Twelve
existing Direct passthrough/error-isolation tests also pass. Architecture CI
passes all 35 sub-gates. The V3 isolation gate and formatting checks pass.
The V3 red-fixture aggregate passes. No assertion or gate was weakened.

Candidate 0.90.4905 was built and installed through `npm run install:v3`.
Its formal restart attempt was rejected with:

```text
IdentityMismatch: managed instance identity mismatch:
managed lifecycle validation failed: business child authority:
candidate launch conflicts with current owner
```

Both configured listeners initially remained healthy on running version
0.90.4903. A later external generation change loaded 0.90.4905. Candidate
0.90.4906 was then installed and given one formal restart for that new state.
That attempt timed out during the control challenge. The latest read-only
status check still shows both listeners healthy on 0.90.4905. No latest-fix
claim is made. The lifecycle control owner must resolve the handshake through
its formal channel. No stop/start, process takeover, authority edit or blind
restart retry was attempted.

Bug 3ccb5fa remains open. Runtime acceptance and sample audit, independent code
review, commit/integration/remote CI, and resource closeout remain pending.
The issue-owned worktree is retained for that recovery. A final author check
found that materializing JSON numbers could round a large argument. A failing
owner test confirmed this; the decoder now validates JSON syntax with IgnoredAny
and retains the exact raw JSON value. Further red tests caught corruption of
opaque output_text, unrelated SSE numbers and transport fields. Ordered raw
JSON fields now preserve those values, including unknown frame shapes.
Lexical red tests caught quoted/code examples being interpreted as calls and
argument fences changing subsequent envelope scope. Atomic consumed spans and
matching quote/backtick/fence boundaries fix those observed failures.
The nine owner tests and three public-entry tests pass after these corrections.
The latest source requires a fresh candidate install when the lifecycle blocker
is resolved; the prior installed binary is not evidence for these corrections.

Canonical workspace test constituents completed: 138 non-lifecycle test-program
summaries passed; 47 lifecycle tests passed directly, and the remaining five
passed after providing the repository's genuine previous-release fixture.
Thirteen remaining CLI test binaries also passed. The root strict Clippy gate
still fails on three untouched route-classifier lints; the canonical V3 Clippy
command passed. No root strict-Clippy PASS is claimed.

The exact guard branch
in the running authority is not exposed by status; it is not inferred from
healthy listeners or the common error message.

Final source build passed as version 0.90.4906. The existing Direct regression
passed again, 12/12, after the final lexical correction. This build was not
reinstalled after the known control challenge timeout. The canonical bug comment
records the OPEN disposition and retained resources.

## Historical user-restart verification

User reported restart completion. Both listeners were healthy on 0.90.4907,
which differs from the issue's previous build. A real inferai SSE replay
returned a complete DSML envelope as assistant text and no native call. Raw
provider and client artifacts are retained in sample
`openai-responses-router-inferai.deepseek-v4.1-flash-20261018T225744771-1384018-39611`.
The declared tool was read, the route was Responses Direct and upstream status
was 200. This proves current running behavior still leaks; version alone does
not prove this patch is loaded. The tool round trip failed before execution.

Built and installed the issue source as 0.90.4908. Config validation passed.
One formal restart for the new user-restored state again timed out at control
challenge. Both listener health checks remain 0.90.4907, status running. No
blind retry or lifecycle bypass was attempted. Runtime acceptance and review
remain blocked. The installed command is now 0.90.4908; it is not the running
generation. Keep bug 3ccb5fa open and retain the worktree for recovery.
