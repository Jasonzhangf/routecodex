# Task: Gemini CLI Provider Refactor

## Goal

Unify `gemini-cli` with the standard `gemini` protocol family: both use providerType `gemini` (protocol = `gemini-chat`), `gemini-cli` is only a protocol/auth variant (Cloud Code Assist) with special OAuth + project handling. Config/auth shapes follow the same pattern as `qwen`/`iflow`.

## Constraints

- Follow AGENTS.md core principles (single execution path, config-driven, provider layer = transport).
- Provider layer must not do routing or tool logic; only auth + HTTP + minimal wire shaping.
- Keep configuration purely config-driven via `service-profiles` and config-core; provider must not special-case config values beyond reading `ServiceProfile`.
- Gemini CLI should align with how `qwen` / `iflow` variants are integrated.

## Plan

1. Analyze current Gemini providers
   - [ ] Inspect `gemini-http-provider` implementation (if present) and base `HttpTransportProvider` behavior for Gemini.
   - [ ] Compare with `gemini-cli-http-provider` to identify divergence (config, auth, compat, protocol client usage).

2. Define target design for `gemini-cli`
   - [ ] Confirm that `gemini-cli` uses protocol type `gemini` (same protocol as Gemini chat) with only auth/transport-specific tweaks.
   - [ ] Decide where to plug in OAuth-specific behavior (e.g., token file / OAuth client) similar to `qwen` / `iflow` patterns.
   - [ ] Decide whether any compat shim is needed and, if so, where to implement it without violating core rules.

3. Refactor `gemini-cli-http-provider`
   - [ ] Change `GeminiCLIHttpProvider` to set `providerType: 'gemini'` (same as standard Gemini provider).
   - [ ] Keep using `GeminiCLIProtocolClient` so endpoint and headers stay Cloud Code Assist–specific.
   - [ ] Remove hardcoded service profile values; always delegate to `HttpTransportProvider.getServiceProfile()` and let `service-profiles` + config-core drive baseURL/endpoint/auth.
   - [ ] Ensure provider-specific logic is limited to: resolving `project` from OAuth token, shaping payload (messages → contents, generationConfig mapping), and leaving routing/tool logic to llmswitch-core.

4. Align auth behavior with Qwen/iflow patterns
   - [ ] Ensure `BASE_SERVICE_PROFILES.gemini` allows both `apikey` and `oauth` (so `gemini-cli-oauth` is accepted once normalized) or introduce a `gemini`-family profile override that accepts both.
   - [ ] Adjust `createAuthProvider` so `providerIdForAuth` for Gemini CLI maps to the same `gemini` profile but still allows tokenFile-based OAuth (similar to `qwen`/`iflow`).
   - [ ] Confirm that missing/expired tokenFile for Gemini CLI triggers the same OAuth acquisition flow as Qwen/iFlow (open browser, save tokenFile under `~/.routecodex/auth/`).

5. Wire up config and protocol mapping
   - [ ] Confirm `service-profiles.ts` uses a single `gemini` profile; if a dedicated `gemini-cli` entry remains, ensure it is treated as an alias and does not split auth semantics.
   - [ ] Verify `provider-profile-loader` and `provider-utils` treat `providerType: gemini` with `type: gemini-http-provider | gemini-cli-http-provider` as two modules under the same protocol `gemini-chat`.

6. Tests and verification
   - [ ] Add minimal provider-layer unit tests for `GeminiHttpProvider` and `GeminiCLIHttpProvider` that construct providers with `providerType: 'gemini'` + `auth.type: 'gemini-oauth'`/`'gemini-cli-oauth'` and assert ServiceProfile + auth validation passes.
   - [ ] Run `ROUTECODEX_VERIFY_SKIP=1 npm run build:dev`.
   - [ ] Extend `scripts/verify-e2e-toolcall.mjs` to include a Gemini CLI startup health check on `~/.routecodex/provider/gemini-cli/config.v1.json` so misconfigurations are caught during build.

## Execution Log

- 2025-12-16: Created task.md and documented plan for Gemini CLI provider refactor.
