# Host Refactor 164.3 Responsibility Migration

This document records the responsibility split for `routecodex-164.3`:
- `src/server/runtime/http-server/request-executor.ts`
- `src/providers/core/runtime/http-transport-provider.ts`

## Current Line-Count Snapshot

| File | Lines |
|---|---:|
| `src/server/runtime/http-server/request-executor.ts` | 497 |
| `src/providers/core/runtime/http-transport-provider.ts` | 485 |
| `src/providers/core/runtime/http-request-executor.ts` | 474 |
| `src/providers/core/runtime/gemini-cli-http-provider.ts` | 479 |

## Request Executor Split Map

| Old responsibility (in `request-executor.ts`) | New module |
|---|---|
| Retry decisions, max attempts, backoff | `src/server/runtime/http-server/executor/retry-engine.ts` |
| Antigravity retry signal, status/error extraction, clock binding | `src/server/runtime/http-server/executor/request-retry-helpers.ts` |
| Provider response normalization, status/model extraction, request semantics extraction | `src/server/runtime/http-server/executor/provider-response-utils.ts` |
| Runtime resolution + provider error emission path | `src/server/runtime/http-server/executor/provider-runtime-resolver.ts` |
| Provider request identity (`requestId`/`providerLabel`/model/protocol) | `src/server/runtime/http-server/executor/provider-request-context.ts` |
| Provider response conversion bridge | `src/server/runtime/http-server/executor/provider-response-converter.ts` |
| Usage logging output | `src/server/runtime/http-server/executor/usage-logger.ts` |
| Inbound snapshot + pool-exhausted classifier | `src/server/runtime/http-server/executor/request-executor-core-utils.ts` |

## Provider Runtime / Transport Split Map

| Old responsibility (`http-transport-provider.ts` / related runtime hot files) | New module |
|---|---|
| Auth provider + HTTP client bootstrap wiring | `src/providers/core/runtime/provider-bootstrap-utils.ts` |
| Runtime profile/runtimeKey/codex mode context shaping | `src/providers/core/runtime/provider-runtime-utils.ts` |
| HTTP executor retry + OAuth replay helpers | `src/providers/core/runtime/provider-http-executor-utils.ts` |
| Service-profile resolution | `src/providers/core/runtime/service-profile-resolver.ts` |
| Endpoint/baseURL resolution | `src/providers/core/runtime/runtime-endpoint-resolver.ts` |
| Provider request preprocess + metadata normalization | `src/providers/core/runtime/provider-request-preprocessor.ts` |
| Request header orchestration | `src/providers/core/runtime/provider-request-header-orchestrator.ts` |
| Family/profile specific shaping helpers | `src/providers/core/runtime/provider-family-profile-utils.ts` |
| Request shaping helpers | `src/providers/core/runtime/provider-request-shaping-utils.ts` |
| Response postprocessing hooks | `src/providers/core/runtime/provider-response-postprocessor.ts` |
| Gemini CLI response normalization | `src/providers/core/runtime/gemini-cli-response-postprocessor.ts` |
| Gemini SSE normalization | `src/providers/core/runtime/gemini-sse-normalizer.ts` |
| IFlow business-error classifier helpers | `src/providers/core/runtime/provider-iflow-business-error-utils.ts` |
| Session/Codex header injection helpers | `src/providers/core/runtime/transport/session-header-utils.ts` |
| OAuth header preflight helpers | `src/providers/core/runtime/transport/oauth-header-preflight.ts` |
| Request header builder | `src/providers/core/runtime/transport/request-header-builder.ts` |
| Auth mode utility | `src/providers/core/runtime/transport/auth-mode-utils.ts` |

## Regression Verification Commands

```bash
npm run jest:run -- --runTestsByPath \
  tests/server/runtime/request-executor.single-attempt.spec.ts \
  tests/providers/core/runtime/gemini-cli-http-provider.unit.test.ts \
  tests/providers/core/runtime/deepseek-http-provider.unit.test.ts
```

```bash
npm run build:dev
```
