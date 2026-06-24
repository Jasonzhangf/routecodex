# EcoDev Provider Implementation Plan

## Goal

Add EcoDev as a RouteCodex Provider V2 provider that exposes the two verified DevEco models:

- `GLM-5.1`
- `Qwen3_VL_235B_A22B_Instruct`

The implementation must support multiple login tokens, use token files as the provider credential source, and stay within the existing Provider/auth/profile/config architecture. Do not modify Hub Pipeline request/response semantics.

## Acceptance Criteria

- `~/.rcc/provider/ecodev/config.v2.toml` or bundled provider template can declare EcoDev with `type = "openai"` and `auth.type = "ecodev-oauth"`.
- Multiple EcoDev tokens can be configured through `[[provider.auth.entries]]`, each with its own `alias` and `tokenFile`.
- Runtime entries materialize as `<provider>.<alias>` and route targets as `<provider>.<alias>.<model>`.
- `ecodev-oauth` token files are read as bearer credential files via the existing token-file auth path.
- `/v1/models` exposes the two configured models.
- Chat completions for `GLM-5.1` and `Qwen3_VL_235B_A22B_Instruct` work through the normal RouteCodex server path.
- Provider request snapshots prove tokens only appear in headers, not in provider request bodies or metadata payload.
- No Hub Pipeline / Virtual Router provider-specific special case is introduced.

## Scope

In scope:

- Provider profile/family registration for `ecodev`.
- Provider-specific auth/token-file mode selection for `ecodev-oauth`.
- Provider-specific endpoint/header shaping needed by DevEco.
- OAuth/login command integration that writes token files under project-standard token storage.
- Provider config sample/template and docs.
- Focused unit/contract tests, build/typecheck, config validation, and live smoke verification.

Out of scope:

- Hub Pipeline request/response semantic changes.
- Virtual Router route policy changes.
- Generic routing fallback behavior changes.
- New provider protocol type such as `type = "ecodev"`.
- Payload trimming, request semantic rewriting, or client response patching to compensate for DevEco behavior.
- Automatic global scan of all EcoDev token files unless explicitly justified after the explicit `auth.entries` path is working.

## Architecture Rules

- Use the standard path: `HTTP server -> llmswitch-core Hub Pipeline -> Virtual Router -> Provider Runtime -> upstream`.
- EcoDev is an OpenAI-compatible Chat provider, so provider config must use `type = "openai"`.
- Brand/family identity belongs in `provider.id`, `compatibilityProfile`, `auth.type`, and family profile, not in protocol type.
- Provider differences belong in provider runtime/profile/auth surfaces only.
- Token/auth data must never enter provider body, client response body, Hub normal payload, or metadata payload.
- Errors must be explicit and enter the existing provider error chain; no fallback or swallowed auth errors.
- Model config key is the upstream wire model name. Aliases are only client-facing/routing aliases.

## Technical Design

### Provider Config Shape

Recommended runtime config:

```toml
version = "2.0.0"
providerId = "ecodev"

[provider]
id = "ecodev"
enabled = true
type = "openai"
baseURL = "https://cn.devecostudio.huawei.com/sse/codeGenie/maas"
compatibilityProfile = "chat:ecodev"

[provider.auth]
type = "ecodev-oauth"

[[provider.auth.entries]]
alias = "default"
type = "ecodev-oauth"
tokenFile = "~/.rcc/auth/ecodev-oauth-1-default.json"

[[provider.auth.entries]]
alias = "backup"
type = "ecodev-oauth"
tokenFile = "~/.rcc/auth/ecodev-oauth-2-backup.json"

[provider.models."GLM-5.1"]
aliases = ["glm-5.1"]
supportsStreaming = true

[provider.models."Qwen3_VL_235B_A22B_Instruct"]
aliases = ["qwen3-vl-235b-a22b-instruct", "qwen3-vl"]
supportsStreaming = true
capabilities = ["vision"]
```

Token file shape:

```json
{
  "access_token": "<DevEco accessToken>",
  "refresh_token": "",
  "jwt_token": "<DevEco jwt>",
  "token_type": "Bearer",
  "provider": "ecodev",
  "site_id": "1"
}
```

`refresh_token` may be empty if DevEco does not return one. Do not fabricate refresh support. If token expires and cannot be refreshed, fail fast and require explicit re-login.

### File Changes

Provider family/profile:

- Add `src/providers/profile/families/ecodev-profile.ts`.
- Update `src/providers/profile/provider-directory.ts` to include `ecodev` as a known family.
- Update `src/providers/profile/profile-registry.ts` to register `ecodevFamilyProfile`.
- Update provider profile tests.

Auth and OAuth/login:

- Add EcoDev OAuth/login strategy or acquirer under provider auth/core strategy surfaces.
- Wire `rcc oauth --force ecodev-oauth-1-default.json` or equivalent selector handling through existing OAuth command flow.
- Store token files under `~/.rcc/auth/ecodev-oauth-<seq>-<alias>.json`.
- Reuse `TokenFileAuthProvider` for runtime header generation.

Provider request shaping:

- In `ecodevFamilyProfile`, implement only provider-local behavior:
  - `resolveOAuthTokenFileMode()` returns `true` for `ecodev-oauth` token-file mode without OAuth client credentials.
  - `resolveEndpoint()` selects `v2/chat/completions` for stream and `v2/no-stream/chat/completions` for non-stream if current openai provider endpoint composition cannot express this via config.
  - `applyRequestHeaders()` adds DevEco-required headers such as `lang = en` and per-request `Chat-Id`.
- Do not rewrite Hub messages or tool governance.

Config/template/docs:

- Add `configsamples/provider-default/ecodev/config.v2.json` or TOML sample, following existing provider-default conventions.
- Add `ecodev` to provider-default manifest if template is bundled.
- Update provider docs only if needed.

Architecture maps:

- If new source anchors are added under provider/profile/auth surfaces, update `docs/architecture/function-map.yml` and `docs/architecture/verification-map.yml` according to existing owner-map rules.
- Do not claim architecture map closure unless gates pass.

## Evidence From Audit

- `AuthProviderFactory` selects `TokenFileAuthProvider` only when family profile enables token-file mode for OAuth without `clientId/tokenUrl/deviceCodeUrl`.
- `TokenFileAuthProvider` already reads `access_token`, `token`, or `api_key` and emits `Authorization: Bearer <credential>`.
- Native provider bootstrap already supports explicit `auth.entries` with aliases and `tokenFile`.
- Model alias canonicalization already preserves provider model key as upstream wire model.
- `/v1/models` can display aliases while provider runtime keeps canonical model IDs.
- Current automatic multi-token scan is only for Qwen and should not be expanded for first EcoDev implementation; explicit `auth.entries` satisfies the requirement with lower architecture risk.

## Risks And Mitigations

- Risk: `ecodev-oauth` falls into `OAuthAuthProvider` and fails due missing client credentials.
  Mitigation: profile `resolveOAuthTokenFileMode()` must force token-file mode; add red/green test.

- Risk: non-stream DevEco endpoint is slow or differs from stream endpoint.
  Mitigation: support endpoint selection in provider profile only; verify both stream and non-stream with bounded timeouts.

- Risk: refresh token is empty.
  Mitigation: fail fast on expired/missing token; do not implement fake refresh or fallback.

- Risk: model aliases leak to upstream.
  Mitigation: lock canonical model tests for `GLM-5.1` and `Qwen3_VL_235B_A22B_Instruct`.

- Risk: token leaks into body/metadata/snapshot normal payload.
  Mitigation: snapshot/live verification checks provider body and metadata payload absence; auth header redaction rules remain in existing snapshot writer.

## Test Plan

Focused tests:

- Provider profile registry resolves `ecodev`.
- `ecodev-oauth` with explicit tokenFile and no OAuth client credentials uses `TokenFileAuthProvider`.
- Token file with `access_token` produces `Authorization: Bearer ...`.
- Missing/empty token file fails explicitly.
- `auth.entries` with two EcoDev token files materializes two aliases.
- Empty `auth.entries` records do not materialize phantom aliases.
- Alias route such as `ecodev.glm-5.1` resolves to canonical `GLM-5.1`.
- Stream request resolves to DevEco stream endpoint.
- Non-stream request resolves to DevEco no-stream endpoint.
- DevEco login flow rejects missing `tempToken`, mismatched `code`, unsupported `siteId`, and invalid JWT.

Suggested commands:

```bash
node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/providers/profile/profile-registry.unit.test.ts --runInBand
node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/sharedmodule/virtual-router-bootstrap-provider-auth-alias.spec.ts --runInBand
node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/providers/auth/oauth-command.behavior.spec.ts --runInBand
npx tsc --noEmit --pretty false
npm run verify:function-map-compile-gate
npm run build:base
```

Live verification:

```bash
rcc oauth --force ecodev-oauth-1-default.json
routecodex config validate
routecodex restart --port <test-port>
curl http://127.0.0.1:<test-port>/v1/models -H 'Authorization: Bearer <local-key>'
curl http://127.0.0.1:<test-port>/v1/chat/completions -H 'Authorization: Bearer <local-key>' -H 'Content-Type: application/json' -d '{"model":"GLM-5.1","messages":[{"role":"user","content":"只回复 OK"}],"stream":true,"max_tokens":16}'
curl http://127.0.0.1:<test-port>/v1/chat/completions -H 'Authorization: Bearer <local-key>' -H 'Content-Type: application/json' -d '{"model":"Qwen3_VL_235B_A22B_Instruct","messages":[{"role":"user","content":"只回复 OK"}],"stream":false,"max_tokens":16}'
```

Snapshot checks:

- Provider request URL uses DevEco `/sse/codeGenie/maas/...` endpoint.
- Provider body `model` is `GLM-5.1` or `Qwen3_VL_235B_A22B_Instruct`.
- Provider body does not contain token, jwt, tempToken, credential, or internal metadata.
- Header contains Authorization in runtime request, but snapshots must redact secrets according to existing snapshot policy.

## Implementation Steps

1. Add red tests for profile token-file mode, auth entries expansion, canonical model alias, and endpoint selection.
2. Add `ecodevFamilyProfile` with token-file mode and provider-local endpoint/header behavior.
3. Register `ecodev` provider family.
4. Add EcoDev OAuth/login acquirer that writes token files under `~/.rcc/auth`.
5. Add config sample/template and docs.
6. Update function/verification map only for changed provider/auth/profile source anchors.
7. Run focused tests and typecheck.
8. Run architecture gates required by changed maps.
9. Run live login and two model calls.
10. Record verification evidence and remaining risks.

## Definition Of Done

- EcoDev provider can be configured with multiple token files via `auth.entries`.
- Login command creates usable EcoDev token files.
- Both models appear in `/v1/models`.
- `GLM-5.1` live request succeeds.
- `Qwen3_VL_235B_A22B_Instruct` live request succeeds.
- All targeted tests, typecheck, config validation, and required architecture gates pass.
- No Hub Pipeline or Virtual Router provider-specific branch is added.
- Final report includes changed files, verification commands/results, live evidence, and remaining risks.
