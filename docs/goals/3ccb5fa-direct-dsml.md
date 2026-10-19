# 3ccb5fa: Direct DSML response hook

The existing response graph is SESE and remains unchanged. The observed path is
Responses Direct, with DSML already in inferai's raw output_text. The registered
Direct response hook owns conversion; Relay Chat Process is outside this fix.

The hook reads current request tool declarations and complete response output.
It converts complete, representable DSML envelopes into native calls, preserving
text before and after each envelope, string whitespace, JSON parameter types,
native items, extensions, call identities and matching follow-up results.
Quoted, fenced, incomplete, unknown or duplicate fields remain text. No provider
failure, retry, health mutation or semantic parameter validation is added.

JSON and fully buffered SSE use the same owner. The existing attempt store calls
the registered complete-response hook before sealing. SSE projects consistent
added/delta/done/terminal events and never emits converted DSML text first.

Regression IDs and commands:

- `responses_direct_dsml_json_tool_round_trip`
- `responses_direct_dsml_sse_tool_round_trip`
- `responses_direct_dsml_literal_text_preserved`
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test multi_listener_server responses_direct_dsml_ -- --nocapture`
- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --lib direct_dsml_ -- --nocapture`

The public-entry upstream validates both rounds. The client executes a safe
owned-file image read and returns its real dimensions with the matching call ID.
Raw sample commands are never executed. Exact original read_image generation is
not retained; three analogous inferai Responses Direct samples establish scope.

## Author evidence and current delivery boundary

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

## User-restart verification

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
