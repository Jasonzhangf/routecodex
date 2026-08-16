# V3 Provider Error Unified Interface Contract Plan

Status: implementation prompt source
Owner scope: `v3.debug_error_foundation.mainline` + provider response semantic error policy
Created: 2026-07-24
Updated: 2026-07-24 — lock entry/rule/exit interface skeleton before runtime repair

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

### 2.0 Fixed Skeleton

The V3 provider error surface has exactly three public entry surfaces, one internal
normalization/rule port, and five effect exits. Entry surfaces extract evidence;
the rule port decides generic action class from compiled manifest policy; exits
apply that decision without inventing a second policy.

```text
Entry A: direct status/code/provider envelope
Entry B: provider response semantic inspection before Resp03
Entry C: hook / compat / codec / schema error
        |
        v
ProviderErrorSignal
        |
        v
ProviderErrorRulePort::normalize_provider_error_signal(signal, manifest_policy)
        |
        v
ProviderErrorExitBundle
        |-- Error chain exit: V3Error01 -> 02 -> 03 -> 04 -> 05 -> 06
        |-- Route execution exit: retry same / reselect / project terminal
        |-- Health exit: no mutation / disable until restart / periodic cooldown
        |-- Client projection exit: redacted display only
        |-- Observability exit: full side-channel evidence, never normal payload
```

Hard locks:

- Entry A/B/C may not mutate health, decide retry, redact client output, or call
  stopless/servertool. They only build `ProviderErrorSignal`.
- All provider errors must pass through `normalize_provider_error_signal` before
  Error03 action planning or provider health mutation.
- Provider-specific matching lives only in config-compiled manifest policy.
  Runtime code must not hardcode provider IDs, model IDs, diagnostic phrases, or
  provider-specific status+text branches outside tests/fixtures.
- Error06 redaction is display only. It cannot affect retry/reselect, cooldown,
  provider availability, or health state.
- Provider error exits are side-channel/control resources; they must not be
  projected as a normal provider/client success payload.

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

### 2.3 Rule Interface

Rules are split into two independent manifests compiled by V3 config:

```rust
ProviderErrorPolicyManifest {
  action_policies: Vec<ProviderErrorActionPolicy>,
  client_projection_policies: Vec<ClientErrorProjectionPolicy>,
}

ProviderErrorActionPolicy {
  policy_id: String,
  scope: ProviderErrorPolicyScope,
  matcher: ProviderErrorMatcher,
  action: ProviderErrorActionSpec,
}

ProviderErrorActionSpec {
  class: ProviderErrorActionClass,
  reason_code: String,
  retry_mode: ProviderErrorRetryMode,
  cooldown_ms: Option<u64>,
  disable_scope: ProviderErrorActionScope,
}
```

Rule responsibilities:

- Match a `ProviderErrorSignal` to at most one highest-priority provider action
  policy. Ties are config compile errors.
- Convert provider-specific facts into one generic `ProviderErrorActionClass`:
  `recoverable_no_penalty`, `disable_until_restart`, or `periodic_recovery`.
- Build `V3Error01SourceRaised` and `V3Error03TargetLocalAction` inputs with a
  stable reason code, action scope, retry mode, and health effect.
- Select client projection redaction only by normalized reason/action facts, not
  by raw provider phrase or provider secret-bearing fields.

Forbidden in the rule interface:

- Fallback to success when no policy matches.
- Provider-specific runtime `if provider_id == ...` or `content.contains(...)`.
- Matching against provider secrets, raw auth headers, debug artifacts, or client
  request payloads unrelated to provider error evidence.
- Letting Error06 display policy change Error02/03/04/05 decisions.

### 2.4 Exit Interface

The normalization port returns a single `ProviderErrorExitBundle` consumed by
runtime execution. Runtime applies exits in this order:

1. `error_chain_exit`: constructs adjacent `V3Error01SourceRaised` through
   `V3Error06ClientProjected`. The chain stays the canonical client error path.
2. `route_execution_exit`: returns one of `RetrySame`, `Reselect`, or
   `ProjectTerminal`. This is an execution decision, not a health mutation.
3. `health_exit`: applies exactly one generic health effect:
   - `NoMutation` for `recoverable_no_penalty`.
   - `DisableUntilRestart(scope)` for `disable_until_restart`.
   - `CooldownUntil(scope, until_ms)` for `periodic_recovery`.
4. `client_projection_exit`: applies code-only/redacted display rules at
   `V3Error06ClientProjected` only.
5. `observability_exit`: writes `provider_failure_events[]` with entry type,
   policy id, reason code, action class, health effect, retry/reselect decision,
   and target scope.

Exit rules:

- `recoverable_no_penalty` must not write cooldown/disable state; next request can
  use the target normally.
- `disable_until_restart` must survive until process restart and must not
  auto-expire in the same process.
- `periodic_recovery` must auto-expire after configured bounded duration.
- A 200 provider diagnostic error must leave the success response path before
  Resp03; stopless/servertool must never see it as a normal `finish_reason=stop`.
- Client-visible body may be redacted, but debug side-channel must retain policy
  and normalized action evidence.

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

1. Dirty source now has `V3ErrorHandlingCenter`, but it is only an Error01-06
   facade with `source/action_scope/candidates_remaining/source_status`. It does
   not accept `ProviderErrorSignal`, manifest policy, action class, or client
   projection policy, so it is not the unified provider error interface yet.
2. Locked `v3.debug_error_foundation.mainline` still maps Error01-06 edges to
   adjacent builder calls. If a facade remains, maps must still expose adjacent
   Error01-06 semantics and must not hide a second policy center behind it.
3. Entry A/B/C are scattered. Direct status/code failures, provider response
   semantic failures, and hook/codec failures do not share a `ProviderErrorSignal`
   builder or a single normalization port.
4. The installed 5555 sample
   `~/.rcc/codex-samples/openai-responses/ports/5555/openai-responses-router-gpt-5.5-20260724T120002045-611803-2288/`
   proves the current live gap: upstream returned HTTP 200 SSE diagnostic text
   `mac超负荷运载，应该是挂了` with zero usage, but `response.json` projected
   normal success semantics: `status=200`, `response_status=requires_action`,
   `provider_failure_events=[]`, `stopless_activation=true`.
5. Current source contains an ad-hoc semantic detector
   `openai_chat_provider_diagnostic_message` in
   `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs`. It
   hardcodes `mac超负荷运载` / `挂了` and returns a provider response codec error.
   This is evidence of the right detection point, but wrong ownership: the phrase
   must move to provider config compiled manifest policy, and the result must be
   `ProviderErrorSignal -> normalize_provider_error_signal`, not a local codec
   branch.
6. `run_v3_relay_provider_failure_policy` and direct failure handling still use
   fixed retry/backoff constants and record every failure into provider health.
   They do not consume generic action classes, so they cannot express
   `recoverable_no_penalty`, `disable_until_restart`, or configurable
   `periodic_recovery` correctly.
7. `V3ProviderHealthStore` supports cooldown-like state and configured disabled
   providers, but it has no explicit action-class interface for
   `NoMutation` / `DisableUntilRestart` / `CooldownUntil`, and no manifest-driven
   scope mapping for provider-specific error policies.
8. V3 config manifest has no `provider_error_action_policy` or
   `client_error_projection_policy` authoring/validation/compiled manifest type.
   Current dirty config work only derives Hub V1 defaults; it does not close this
   provider error policy gap.
9. Client projection is still built from source message at Error06. There is no
   display-only redaction policy that can show only a public error code while
   retaining full side-channel observability.
10. Observability lacks normalized entry type, policy id, action class, and
    health effect in `provider_failure_events[]`, so postmortem cannot prove
    which entry/rule/exit path fired.
11. Architecture maps/resources do not yet declare provider error signal, policy
    manifest, rule match, and exit bundle as explicit resources/edges. Existing
    resources cover `v3.error.*` and `v3.provider.health_state`, but not the
    unified provider-error interface layer before Error01.
12. Red gates do not reject provider ID / diagnostic phrase hardcoding in V3
    runtime outside tests/fixtures.

## 6. Implementation Plan

1. Add contract types in the correct Rust owner:
   - `ProviderErrorSignal`
   - `ProviderErrorSignalEntry`
   - `ProviderErrorPolicyManifest`
   - `ProviderErrorPolicyMatch`
   - `ProviderErrorActionClass`
   - `ClientErrorProjectionPolicyMatch`
   - `ProviderErrorExitBundle`
   - `ProviderHealthEffect`
   - `ProviderRouteExecutionExit`
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
9. Remove ad-hoc provider diagnostic phrase matching from runtime after manifest policy is wired.
10. Replay sample and live validate after source gates.

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
- Source red: provider response semantic entry cannot call stopless/servertool or
  project normal success after it emits `ProviderErrorSignal`.
- Source red: Error06 client redaction policy cannot be read by Error02/03/04/05
  or provider health.
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

## 9. Goal Prompt

```text
/goal
目标：实现 V3 provider error 统一入口/规则/出口界面合同，让 direct error、provider response semantic error、hook/codec error 全部先归一为 ProviderErrorSignal，再由配置编译的 manifest policy 映射到三类 generic action，并从统一出口进入 Error01-06、route execution、provider health、client projection、observability。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v3-provider-error-unified-interface-contract-plan.md

执行规范：
- 先查 V3 architecture skill、function map、mainline call map、resource map、verification map 和 locked SOP，再改唯一 owner；缺 map/source anchor 先补合同，不直接 grep 改实现。
- 严禁 fallback、错误包成功、Error06 影响 retry/health、runtime provider 特例、硬编码 provider id/model/诊断短语；provider-specific matcher 只能来自 config 编译 manifest。
- Entry A/B/C 只产 ProviderErrorSignal；统一 normalizer 才能生成 action/exit；200 SSE 诊断零 usage 必须在 Resp03 stopless/servertool 前离开正常成功路径。
- 只保留三类 action：recoverable_no_penalty、disable_until_restart、periodic_recovery；client redaction 只在 Error06 显示层生效。

验证：
- 先做 red：旧 5555 样本 `20260724T120002045-611803-2288` 当前会被投成 200 requires_action/stopless；硬编码短语和 Error06 反向影响 policy 的 red fixtures 必须先红。
- 跑 config/action-policy/error-chain/response-semantic/provider-health/observability 定向 Rust tests，正反测试都要覆盖。
- 跑 V3 architecture/map/wiki/gate、cargo fmt、git diff --check。
- 全局安装，使用 `routecodex restart --port 5555`，验证 `/health`，重放旧样本或同入口 live 样本，证明 provider_failure_events 有 policy/action 证据且不再进入 stopless/requires_action。

完成标准：
- V3 provider error 只有一个归一化入口和一组统一出口，错误 action 与显示 redaction 完全隔离。
- 配置可声明 provider-specific 200/finish/text/zero-usage 等 matcher 并映射到三类 generic action。
- 旧 200 SSE 诊断样本不再作为正常模型输出，live 验证和提交完成，且不包含无关 dirty 文件。
```
