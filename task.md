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

---

# Task: HTTP Provider Refactor & Error Handling Cleanup

## Goal

Simplify `HttpTransportProvider` by splitting HTTP request phases into focused helpers, remove the unused Hook system stub, and push provider error classification into the global Error Handling Center / Virtual Router health manager. Providers should only perform transport duties (auth + HTTP + minimal shaping) and emit structured errors upstream.

## Constraints

- Obey AGENTS.md: provider layer = transport; no routing/tool logic.
- SSE handling must continue to rely on `@jsonstudio/llms` modules.
- Changes must be incremental; after each major step, run `npm run build` (release) followed by `npm run llmswitch:link`.

## Plan

1. **Document current provider responsibilities**
   - [ ] Capture the existing call graph inside `HttpTransportProvider.sendRequestInternal` (hooks, OAuth retry, SSE branch, error handling).
   - [ ] Identify which pieces map cleanly to helper methods (e.g., request snapshotting, OAuth replay, SSE wrapping, error normalization).

2. **Split HTTP execution pipeline**
   - [ ] Introduce helpers for request preparation (`buildFinalHeaders`, `buildFinalBody`), HTTP execution (`executeHttpRequest`), SSE wrapping, and snapshotting.
   - [ ] Ensure the core `sendRequestInternal` becomes a thin orchestrator that calls helpers in order.
   - [ ] Consolidate retry/backoff logic (3 attempts for 5xx) into a dedicated helper shared by SSE/JSON paths.

3. **Remove legacy Hook integration**
   - [ ] Delete `getHookManager` usage and the noop stub; replace with explicit helper invocations so the flow is deterministic.
   - [ ] If a future Hook system is needed, re‑introduce via a feature flag (`ROUTECODEX_ENABLE_PROVIDER_HOOKS`); default build must not mutate payloads.

4. **Centralize error reporting**
   - [ ] Move the recoverable/fatal classification out of `BaseProvider.handleRequestError` into a shared error handler (near `provider-error-reporter` / Virtual Router).
   - [ ] BaseProvider should capture context (status, code, stage) and emit it; Virtual Router decides health penalties/cooldowns.
   - [ ] Update Virtual Router error mapper to honor the new error payload (status, retryable, reason).

5. **Tests & Verification**
   - [ ] After each refactor milestone, run `npm run build` (release) and re-link `@jsonstudio/llms`.
   - [ ] Run targeted smoke tests (`npm run verify:e2e-toolcall`, sample `/v1/responses` requests) to ensure models propagate correctly and retries happen.

---

# Task: Virtual Router Context Capacity Management

## Goal

Ensure virtual router respects each provider/model's real context limit. When a request approaches/exceeds that limit, routing automatically prefers larger-context providers or fallback routes, preventing overflow errors while honoring the “config is the single source of truth” rule.

## Constraints

- Streaming flags remain config-driven; virtual router is the sole component allowed to mutate request `stream`.
- Provider layer must stay transport-only; context capacity logic lives entirely inside llmswitch-core virtual router.
- Default context limit is 200 000 tokens (tiktoken-based). Models with different limits must declare `maxContextTokens` in config.

## Plan

1. Capture requirements & defaults
   - [ ] Document the default 200k-token behavior and how modules/config overrides apply.
   - [ ] Define new configuration surface (`virtualrouter.providers.*.models.*.maxContextTokens`, `virtualrouter.contextRouting.*`).

2. Bootstrap/runtime wiring
   - [ ] Extend `bootstrapVirtualRouterConfig` to read `maxContextTokens` (fallback to 200k) and inject into `ProviderProfile`/`ProviderRuntimeProfile`.
   - [ ] Propagate `maxContextTokens` through `ProviderRegistry` and `TargetMetadata`.

3. ContextAdvisor implementation
   - [ ] Add a reusable advisor that classifies providers into safe/risky/overflow groups based on `estimatedTokens` ratio vs. `maxContextTokens`.
   - [ ] Make thresholds configurable (`warnRatio`, optional `hardLimit`, `fallbackRoute`).

4. Integrate into `VirtualRouterEngine.selectProvider`
   - [ ] Filter each route's pool via ContextAdvisor before invoking load balancer.
   - [ ] When a pool exhausts safe options, fall back to risky providers; if still empty, switch to fallback route (e.g., `longcontext`) if available.
   - [ ] Enrich diagnostics/logging with usage ratio context.

5. Tests & docs
   - [ ] Add unit tests covering safe/risky/fallback scenarios and ensuring backwards compatibility when configs omit `maxContextTokens`.
   - [ ] Update relevant docs (virtual router config guide, release notes) to describe the new knobs and defaults.

## Execution Log

- 2025-12-24: Drafted plan and constraints for virtual router context management.
