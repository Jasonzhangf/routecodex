# V3 Provider Error Unified Interface Contract Plan

Status: implementation prompt source
Owner scope: `v3.debug_error_foundation.mainline` + provider response semantic error policy
Created: 2026-07-24

## 1. Goal And Acceptance

Build a single V3 provider error interface contract that fixes three things:

1. Error entries are explicit and typed.
2. Provider-specific error rules are config-compiled into deterministic manifest policy.
3. All provider errors normalize into one Error01-06 path before action planning, health mutation, retry/reselect, cooldown, and Error06 client projection.

Acceptance requires:

- HTTP non-2xx, structured provider error envelopes, HTTP 200 provider business diagnostics, and hook/codec semantic failures all produce a `ProviderErrorSignal` and enter one normalization function.
- Provider-specific status/finish/body/SSE feature matching is configured, validated, and compiled into manifest; runtime does not hardcode provider IDs or diagnostic phrases.
- Policy action output maps only to three generic classes:
  - `recoverable_no_penalty`
  - `disable_until_restart`
  - `periodic_recovery`
- Error06 client projection redaction is display-only and cannot influence retry/backoff/health decisions.
- The live sample `openai-responses-router-gpt-5.5-20260724T120002045-611803-2288` no longer projects as `200 requires_action` with `provider_failure_events=[]` and `stopless_activation=true`.

## 2. Unified Interface Contract

### 2.1 Entry Surfaces

There are three entry surfaces. Each entry extracts evidence only; none may decide retry/cooldown/client projection on its own.

#### Entry A — Direct Error Code Entry

Inputs:

- HTTP status / upstream status.
- Provider structured error fields, e.g. `{error:{code,type,message}}`.
- Provider SDK/transport error code.

Output:

- `ProviderErrorSignal { source_entry: direct_code, ... }`.

Used for:

- 401/403 auth errors.
- 429/rate limit.
- 5xx/timeout/transport status.
- Explicit provider `error.code` / `error.type`.

#### Entry B — Provider Response Semantic Entry

Inputs:

- HTTP 200 JSON/SSE provider responses whose semantic payload is not valid model output.
- Provider finish marker / finish_reason / terminal event status.
- Usage counters.
- Output token presence.
- Choices/content/tool fields.
- Body/SSE text features.

Output:

- `ProviderErrorSignal { source_entry: response_semantic, ... }`.

Used for:

- HTTP 200 SSE diagnostic text + zero usage.
- HTTP 200 JSON provider error envelope.
- Empty choices + no valid output tokens + diagnostic body.

Required order:

- Runs before Resp03 stopless/servertool governance.
- If it emits ProviderFailure, Resp03 must never see this payload as normal assistant output.

#### Entry C — Hook / Codec Error Entry

Inputs:

- Provider response compat failures.
- Provider event codec failures.
- Tool/schema validation errors detected while parsing provider-bound or provider-returned protocol.
- Malformed SSE event payload after transport framing has succeeded.

Output:

- `ProviderErrorSignal { source_entry: hook_codec, ... }`.

Used for:

- Malformed provider body/event.
- Provider codec cannot build legal Hub response.
- Tool/schema response cannot be represented as valid protocol output.

### 2.2 Unified Normalization Port

All entries must call one normalization port:

```rust
normalize_provider_error_signal(
    signal: ProviderErrorSignal,
    policy_manifest: ProviderErrorPolicyManifest,
) -> NormalizedProviderError
```

Input shape:

```rust
ProviderErrorSignal {
  provider_id: Option<String>,
  provider_type: Option<String>,
  model_id: Option<String>,
  auth_alias: Option<String>,
  routing_group: Option<String>,
  http_status: Option<u16>,
  provider_code: Option<String>,
  provider_type_code: Option<String>,
  finish_reason: Option<String>,
  terminal_status: Option<String>,
  usage_total_tokens: Option<u64>,
  input_tokens: Option<u64>,
  output_tokens: Option<u64>,
  choices_count: Option<usize>,
  has_valid_model_output: bool,
  structured_error_path: Vec<String>,
  text_features: Vec<String>,
  source_entry: ProviderErrorSignalEntry,
}
```

Output shape:

```rust
NormalizedProviderError {
  source: V3Error01SourceRaised,
  policy_match: Option<ProviderErrorPolicyMatch>,
  action_class: ProviderErrorActionClass,
  action_plan: V3ErrorActionPlan,
  client_projection_policy: Option<ClientErrorProjectionPolicyMatch>,
  observability: ProviderFailureEvent,
}
```

## 3. Policy Rules

### 3.1 Provider Error Action Policy

Config authoring example:

```yaml
provider_error_action_policy:
  - policy_id: glmrelay_openai_200_diagnostic_zero_usage
    scope:
      provider_id: glmrelay_openai
      provider_type: openai_chat
    match:
      http_status: 200
      sse:
        finish_reason: stop
        usage_total_tokens: 0
        content_contains_any:
          - "mac超负荷运载，应该是挂了"
    action:
      kind: periodic_recovery
      reason_code: provider_diagnostic_zero_usage
      cooldown_ms: 300000
      retry_mode: reselect_before_client_projection
```

Compiler rules:

- Validate schema, scope, matcher fields, action kind, bounded regex, bounded phrase length, cooldown/backoff bounds, and reason code.
- Emit deterministic manifest policy.
- Reject unknown action kinds.
- Reject missing scope for provider-specific body/text matchers.
- Reject unbounded regex or matchers that can inspect secrets/debug fields.
- Manifest must not contain provider secret values.

Runtime rules:

- Runtime consumes only manifest policy.
- No provider ID, model ID, provider-specific phrase, or special status+text branch may be hardcoded in Rust runtime outside tests/fixtures.
- Provider-specific policies map only to generic actions.

### 3.2 Generic Action Classes

#### recoverable_no_penalty

Meaning:

- The error is transient/auto-recoverable and must not cool down or remove the provider.

Action:

- May retry/reselect for current attempt when policy says so.
- Does not mutate long-lived provider health.
- Next request may use the provider normally.

#### disable_until_restart

Meaning:

- The current process should not route to this target again until restart.

Action:

- Remove target/provider/model/auth scope from the process-local availability pool.
- Recovery only by restart.
- Must emit an observable provider failure event.

#### periodic_recovery

Meaning:

- Provider can recover after a configured backoff/cooldown period.

Action:

- Apply cooldown/backoff until time expires.
- Re-enter pool automatically after period.
- Parameters must be bounded and configured.

### 3.3 Client Error Projection Policy

Config authoring example:

```yaml
client_error_projection_policy:
  - policy_id: common_provider_busy_code_only
    match:
      reason_code: provider_diagnostic_zero_usage
    projection:
      public_code: E_PROVIDER_TEMPORARILY_UNAVAILABLE
      message_mode: code_only
```

Rules:

- Runs only at Error06 client projection.
- May redact/clean user-visible message.
- Must not affect Error02 classification, Error03 action planning, provider health mutation, retry, reselect, or cooldown.
- Side-channel/debug observability must retain policy id, reason code, and action class.

## 4. Error Flow

```text
Entry A: direct status/code
Entry B: provider response semantic validation before Resp03
Entry C: hook/codec semantic failure
        |
        v
ProviderErrorSignal
        |
        v
normalize_provider_error_signal + manifest policy match
        |
        v
V3Error01SourceRaised + ProviderErrorPolicyMatch
        |
        v
V3Error02Classified
        |
        v
V3Error03TargetLocalAction
        |
        +--> V3ProviderHealthStateMutated / availability projection when action requires it
        |
        v
V3Error04TargetExhaustionDecision
        |
        v
V3Error05ExecutionDecision
        |
        v
V3Error06ClientProjected + client_error_projection_policy
```

## 5. Gap Audit

Current gaps observed on 2026-07-24:

1. `V3ErrorHandlingCenter` dirty work exists in runtime/server/tests but `routecodex-v3-error/src/lib.rs` does not define/export `V3ErrorHandlingCenter` or `V3ErrorHandlingCenterInput`; `cargo test -p routecodex-v3-error --test error_chain_contract` fails unresolved imports.
2. Locked `v3.debug_error_foundation.mainline` still maps Error01-06 edges to adjacent builder calls from runtime functions. A facade is allowed only if maps/locks honestly represent caller/callee changes or the facade internally preserves adjacent builder semantics.
3. Error entry surfaces are not yet abstracted as `ProviderErrorSignal`; direct status, provider response semantic failures, and hook/codec failures are scattered.
4. HTTP 200 provider business diagnostic response is not classified before Resp03. Sample `20260724T120002045-611803-2288` becomes `200 requires_action`, `provider_failure_events=[]`, `stopless_activation=true`.
5. No compiled config/manifest schema exists for provider-specific status/finish/text/zero-usage matchers mapped to generic action classes.
6. Client redaction policy and provider action policy are not separated in a typed contract.
7. Red gates do not yet reject provider ID / diagnostic phrase hardcoding in Rust runtime.
8. Existing historical docs warn that `ErrorHandlingCenter` must not become a second provider policy center; naming/ownership must be clarified.

## 6. Implementation Plan

1. Add contract types in the correct Rust owner:
   - `ProviderErrorSignal`
   - `ProviderErrorSignalEntry`
   - `ProviderErrorPolicyManifest`
   - `ProviderErrorPolicyMatch`
   - `ProviderErrorActionClass`
   - `ClientErrorProjectionPolicyMatch`
2. Add config authoring + manifest compile/validation for provider error action policy and client projection policy.
3. Add provider response semantic entry before Resp03 in relay/provider response path.
4. Route direct-code and hook/codec errors into `ProviderErrorSignal` too.
5. Implement `normalize_provider_error_signal` as the only provider error normalization port.
6. Decide whether to keep `V3ErrorHandlingCenter` name:
   - If kept, make it Error01-06 facade only, not provider policy center.
   - If renamed, prefer `V3ErrorChainFacade` or `V3ProviderErrorNormalizer` for clearer ownership.
7. Update `v3.debug_error_foundation.mainline` lock only with Jason manual authorization if caller/callee edges change.
8. Add observability:
   - `provider_failure_events[]` includes entry type, policy id, reason code, action class, and target scope.
   - Error06 redaction hides client detail but side-channel remains complete.
9. Replay sample and live validate after source gates.

## 7. Required Tests

Minimum red/green suite:

- Unit: direct status/code entry normalizes to `ProviderErrorSignal`.
- Unit: HTTP 200 SSE diagnostic + zero usage + configured phrase matches policy and emits ProviderFailure before Resp03.
- Unit: valid HTTP 200 SSE with normal model output does not become ProviderFailure.
- Unit: hook/codec failure normalizes through same port.
- Unit: `recoverable_no_penalty` does not mutate cooldown/availability.
- Unit: `disable_until_restart` removes target until restart-only reset.
- Unit: `periodic_recovery` cools down and re-enters after duration.
- Unit: Error06 redaction does not alter Error03 action.
- Config red: unknown action kind rejected.
- Config red: missing scope rejected for provider-specific text matcher.
- Config red: unbounded regex/secret-bearing matcher rejected.
- Source red: hardcoded provider id or diagnostic phrase outside config/test fixtures rejected.
- Integration: sample `20260724T120002045-611803-2288` no longer produces normal `requires_action`/stopless path.
- Live: after global install + `routecodex restart --port 5555`, equivalent provider diagnostic produces provider failure event and configured action, not stopless.

## 8. Completion Definition

Complete only when:

- Contract docs/maps/gates are updated and synced.
- Source implementation compiles.
- Red fixtures fail before and pass after.
- Targeted Rust tests pass.
- Architecture gates pass.
- Sample replay proves `200 diagnostic zero usage` enters provider failure chain before Resp03.
- Global install + managed 5555 restart + live replay pass.
- Work is committed without staging unrelated dirty files.
