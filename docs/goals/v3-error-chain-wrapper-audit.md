# V3 Error Chain Wrapper Audit
**Date**: 2026-07-30
**Author**: codex
**Status**: Audit complete — awaiting Jason review
## 1. Audit Goal
Jason 要求：V3 错误链 debug 显示应真实反映上游错误状态，不做自创包装。包装/映射必须有显式配置（non-configured 不能乱做）。例外：200 返回但内容是错误的（如 encrypted_content），必须显式映射。
## 2. V3 Error Chain Architecture (Current)
```
V3ProviderError (transport-level: HTTP status, body, transport, SSE)
  ↓ hooks.rs::external_link_for_provider_error()  ← maps V3ProviderError → V3ExternalErrorLink
  ↓ provider_failure_runtime_policy.rs::run_v3_relay_provider_failure_policy()
     error_type = client_response.pointer("/error/type")   ← from parsed upstream JSON
     message = client_response.pointer("/error/message")  ← from parsed upstream JSON
  ↓ provider_failure_runtime_policy.rs::build_v3_relay_provider_error_05_decision()
     code = error_type.unwrap_or("provider_failure")   ← ← OVERWRITES with fallback
     external_error.code = code                         ← ← ALSO overwritten
  ↓ v3-error lib::build_v3_error_06_client_projected_from_v3_error_05()
     body.error.code = source.code                      ← uses internal code (was overwritten)
     body.error.external_error = V3ExternalErrorLink   ← preserves upstream link
  ↓ server.rs::record_and_emit_v3_error_projection()
     console line: format! with message (double-encodes upstream JSON as string)
```
**Key types**:
- `V3ProviderHttpFailure::body: Vec<u8>` — raw upstream response bytes (preserved)
- `V3ExternalErrorLink` — preserves upstream `status`, `code`, `message`, `provider_id`
- `V3Error01SourceRaised::code` — internal V3 code (used for client-facing `error.code`)
- `V3Error01SourceRaised::external_error` — optional upstream truth link
## 3. Live Evidence: asxs 400 `invalid_encrypted_content`
Console log line:
```
type=server_error message=400: {'upstream_status': 400, 'upstream_request_id': '...',
  'error': {'error': {'message': 'The encrypted content for item rs_... could not be verified.
  Reason: Encrypted content could not be decrypted or parsed.',
  'type': 'invalid_request_error', 'param': None, 'code': 'invalid_encrypted_content'}}}
```
**Observations**:
1. `type=server_error` — V3 policy classification (upstream was `invalid_request_error`)
2. `message=` wraps upstream JSON body as a Python dict string — double-encoding
3. `external_error` sub-structure in client JSON exposes upstream truth (correct)
4. Top-level `error.code` in client JSON uses `invalid_request_error` (extracted from upstream body) — correct when `error_type` extraction succeeds
5. **BUT**: `error_type` falls back to `"provider_failure"` when no upstream `/error/type` matches; then both `code` and `external_error.code` become `"provider_failure"`, losing upstream `code`
## 4. Issue Catalog
### P0 — Core: Error Type Fallback Overwrites Upstream Code
**File**: `v3/crates/routecodex-v3-runtime/src/provider_failure_runtime_policy.rs:745`
```rust
let code = error_type.unwrap_or("provider_failure").to_string();
```
**Problem**: When `error_type` is `None` (upstream error body has no `/error/type` or doesn't parse), `code` becomes `"provider_failure"`. Then this overwrites `external_error.code`:
```rust
V3ExternalErrorLink {
    code: Some(code),  // ← "provider_failure" overwrites upstream code
```
**Should be**: If upstream had a meaningful code from the body (e.g. from `V3ProviderHttpFailure.body`), extract it and use it as the code. The `error_type` field in `V3ExternalErrorLink` should carry the upstream code even when the relay policy couldn't parse a structured error type.
**Fix**: In `build_v3_relay_provider_error_05_decision`, accept an additional `upstream_code: Option<String>` and use it for `external_error.code` when `error_type` is None.
**Severity**: P0 — upstream `error.code` lost when upstream body doesn't have `error.type`.
---
### P0 — Core: Console `message=` Double-Encodes Upstream JSON
**File**: `v3/crates/routecodex-v3-server/src/lib.rs` (provider switch/failure emit)
**Problem**: Console output formats error as:
```
message=400: {'upstream_status': 400, 'error': {'error': {'message': '...', 'type': 'invalid_request_error', 'code': 'invalid_encrypted_content'}}}
```
This is a Python dict literal string (`'key': 'value'`), not JSON. The upstream body is embedded as a string inside another string. The inner `'error': {'error': {...}}` is a double `error` wrapper.
**Root cause**: The console formatter calls `format!("{}", error)` on a string that already contains the upstream body, creating a double-string layer.
**Should be**: Console `message=` should contain either: (a) just the upstream `error.message` text, or (b) the full upstream error JSON serialized as proper JSON, not a Python dict string.
**Fix**: Extract `error.message` from upstream body for console `message=`. The `external_error.message` field already has the message — use it directly.
---
### P1 — SSE Error: All SSE Failures Collapse to One Code
**File**: `v3/crates/routecodex-v3-server/src/lib.rs:4750,4761,4845,4860,6793,10657`
```rust
raise_v3_sse_provider_failure("provider_response_sse_stream", error)
```
**Problem**: All SSE failure modes (mid-stream provider EOF, terminal missing, transport error, invalid event) use the same code `"provider_response_sse_stream"`. Upstream error details (e.g. `response.failed` with `HTTP_429`) are not extracted.
**Should be**: SSE error codes should differentiate: `sse_midstream_eof`, `sse_terminal_missing`, `sse_transport_error`, `sse_invalid_event`. When upstream SSE event contains an error (like `response.failed`), that upstream error type should be preserved.
**Fix**: Add SSE-specific error codes based on failure mode. Extract upstream error type from SSE event data when present.
---
### P1 — HTTP Status: `external_link_for_provider_error` Drops Upstream Error Code
**File**: `v3/crates/routecodex-v3-runtime/src/hooks.rs:371-377`
```rust
V3ProviderError::HttpStatus { response } => V3ExternalErrorLink {
    code: Some(format!("HTTP_{}", response.status)),
    // ↑ drops upstream error.code from response.body
```
**Problem**: For HTTP status >= 400, `code` is set to `HTTP_{status}` (e.g. `HTTP_400`). The upstream body may contain a richer `error.code` (e.g. `invalid_encrypted_content`). This upstream code is NOT preserved in `external_error.code`.
**Should be**: Parse the upstream body, extract `error.code` if present, and use it as `external_error.code`. Fall back to `HTTP_{status}` only if no upstream code found.
**Fix**: In `hooks.rs::external_link_for_provider_error` for `HttpStatus`, attempt to parse `response.body` as JSON and extract `error.code`.
---
### P1 — HTTP Status: `hooks.rs` Drops Upstream Error `type`
**File**: `v3/crates/routecodex-v3-runtime/src/hooks.rs:330`
```rust
V3ProviderError::HttpStatus { response } => format!("provider_http_{}", response.status)
```
**Problem**: `source_code_for_provider_error` returns `provider_http_400` instead of upstream `error.type` (e.g. `invalid_request_error`).
**Should be**: Return upstream `error.type` if parseable from body.
**Fix**: Same as P1 above — parse upstream body for `error.type`.
---
### P2 — Content-Type Errors: No Upstream Preservation
**File**: `v3/crates/routecodex-v3-runtime/src/shared.rs:100,162`
```rust
"provider_content_type_missing"     // line 100
"provider_content_type_unsupported" // line 162
```
**Problem**: Content-type mismatches use internal codes. The actual content-type value received from upstream is not included in the error.
**Should be**: Include the actual content-type in the error message; code can remain internal but message should reflect reality.
**Fix**: Update error message to include actual received content-type. Consider adding `external_error.message` with actual content-type.
---
### P2 — JSON Parse Errors: No Upstream Preservation
**File**: `v3/crates/routecodex-v3-runtime/src/shared.rs:144`
```rust
"provider_response_json_invalid"
```
**Problem**: JSON parse failures use internal code. The actual parse error details are lost.
**Should be**: The error message (`error.to_string()`) includes the parse error; this is passed to `message` in `external_error`. The issue is the code is still internal. If the provider returned a structured error in the body (that failed JSON parse), that context is lost.
**Fix**: Low priority — parse failure is a legitimate transport-level error. The current message does capture the parse error. Consider adding the raw body snippet to message for debugging.
---
### P2 — SSE Transport Errors: No Upstream Preservation
**File**: `v3/crates/routecodex-v3-runtime/src/shared.rs:710`
```rust
"provider_response_sse_invalid"
```
**Problem**: Same as JSON parse — uses internal code. For SSE, the upstream may have returned an SSE event with an error (like `response.failed`). This is not extracted.
**Fix**: When SSE stream contains `event: response.failed` with error data, extract upstream error type and code.
---
### P2 — `V3InternalErrorCode` Numeric Scheme
**File**: `v3/crates/routecodex-v3-error/src/lib.rs:36-67`
**Problem**: Internal runtime failures use numeric codes like `500-100`, `500-110`. These are meaningful for internal debugging but mix with provider error domain.
**Should be**: These are internal-only (not in `V3ExternalErrorLink`) so they don't affect client-facing errors. The concern is only for observability. Keep internal codes but ensure they don't leak to client-facing `error.code` without going through `external_error`.
**Status**: Acceptable — internal errors use `build_v3_error_01_source_raised_internal` which doesn't create `external_error` link, so they don't pollute client projection. The numeric scheme is for internal debugging only.
---
### P3 — Config Gate Not Used
**File**: `v3/crates/routecodex-v3-config/src/validate.rs:1494`
**Evidence**: `compile_provider_error_action_policies` and `compile_client_error_projection_policies` exist and compile `provider_error_action_policy` and `client_error_projection_policy` from authoring config. These allow per-provider, per-error-type policy mapping with `match.content_contains_any`, `match.sse_event_type`, `action.reason_code`, etc.
**Problem**: The relay failure path in `run_v3_relay_provider_failure_policy` does NOT consult these compiled policies. `error_type` is extracted from the upstream body but never matched against the configured `provider_error_action_policies`.
**Should be**: The policy engine should match upstream error against configured policies and use the policy's `reason_code` as the `error_type` for the error chain. This would enable Jason's requirement: "必须配置才能包装，不配置不乱搞".
**Fix**: Wire `client_error_projection_policy` into `run_v3_relay_provider_failure_policy` to match upstream error and override `error_type` with the configured `reason_code`.
---
### P3 — `direct_sse_provider_outcome.rs` SSE Error Code Extraction
**File**: `v3/crates/routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs:128`
**Evidence**: The code does extract upstream `error.code` from SSE event data:
```rust
.get("error")
.and_then(|error| error.get("code"))
```
But then wraps it with `build_v3_error_01_source_raised` (internal, no external_error link):
```rust
build_v3_error_01_source_raised(
    V3ErrorSourceKind::ProviderFailure,
    "V3ProviderResp14Raw",
    "provider_response_sse_event_invalid",
    format!("{event_type} requires non-empty response.error.code"),
)
```
**Problem**: When SSE event data has a `response.failed` error with upstream `code`, that upstream code is extracted but then immediately thrown away. The error is wrapped with a generic internal code.
**Should be**: Use `build_v3_error_01_source_raised_external` and preserve the upstream error code in `external_error`.
**Fix**: Change to `build_v3_error_01_source_raised_external` and pass the extracted upstream error code via `V3ExternalErrorLink`.
---
## 5. Severity Summary
| ID | Location | Issue | Severity |
|----|----------|-------|----------|
| P0-1 | `provider_failure_runtime_policy.rs:745` | `error_type` None fallback overwrites `external_error.code` with "provider_failure" | P0 |
| P0-2 | `server.rs` console emit | `message=` double-encodes upstream JSON as Python dict string | P0 |
| P1-1 | `hooks.rs:371-377` | `HttpStatus` drops upstream `error.code` from response body | P1 |
| P1-2 | `hooks.rs:330` | `source_code_for_provider_error` returns `provider_http_XXX` instead of upstream `error.type` | P1 |
| P1-3 | `server.rs:4750+` | All SSE failures use single code `provider_response_sse_stream` | P1 |
| P2-1 | `shared.rs:100,162` | Content-type errors lose actual upstream content-type value | P2 |
| P2-2 | `shared.rs:144,710` | JSON/SSE parse errors use internal codes without upstream context | P2 |
| P3-1 | `provider_failure_runtime_policy.rs` | Config-gated error policies not consulted in relay path | P3 |
| P3-2 | `direct_sse_provider_outcome.rs:128` | SSE upstream error.code extracted then thrown away | P3 |
## 6. What Is Correct (Do Not Change)
1. **`V3ExternalErrorLink` structure**: Correctly preserves upstream `status`, `code`, `message`, `provider_id`. No change needed.
2. **`V3Error01SourceRaised::external_error` presence**: All `provider_body_source`, `sse_transport_source`, and `build_v3_relay_provider_error_05_decision` use `build_v3_error_01_source_raised_external`, creating the link. Correct.
3. **`V3Error06` projection**: `build_v3_error_06_client_projected_from_v3_error_05` correctly serializes `external_error` into `body.error.external_error`. Correct.
4. **No success wrapping**: Provider errors always produce HTTP status >= 400. Verified by `debug_assert!` in `ErrorHandlingCenter::handle`. Correct.
5. **Error chain topology**: `Error01 → Error02 → Error03 → Error04 → Error05 → Error06` single chain. No bypass. Correct.
6. **`V3InternalErrorCode` numeric scheme**: Internal-only, not exposed to clients. Acceptable.
7. **`provider_http_failure` in responses_relay_runtime**: Correctly parses upstream body as JSON and preserves it in `client_response`. Correct.
## 7. Recommended Fix Order
1. **P0-1** (`provider_failure_runtime_policy.rs`): Pass `upstream_code` through and use it when `error_type` is None.
2. **P0-2** (`server.rs` console): Extract upstream message for console `message=`, use `external_error.message` directly.
3. **P1-1 + P1-2** (`hooks.rs`): In `external_link_for_provider_error` for `HttpStatus`, parse body and extract `error.code`/`error.type`.
4. **P1-3** (`server.rs` SSE codes): Add SSE-specific error codes based on failure mode.
5. **P3-1** (config gate): Wire `client_error_projection_policy` into relay failure policy.
6. **P2-1 + P2-2 + P3-2**: Low-priority cleanup.
## 8. Verification Plan
After fixes:
1. Live replay of asxs `invalid_encrypted_content` case — verify client JSON has correct `error.code` (not "provider_failure") and `external_error.code` matches upstream
2. Live replay of SSE stream failure cases — verify distinct error codes for each SSE failure mode
3. Build: `cd v3 && cargo build --all` must pass
4. Tests: `cargo test -p routecodex-v3-runtime -p routecodex-v3-error` must pass
5. Integration: Run existing `hub_relay_runtime_closeout.rs` tests

