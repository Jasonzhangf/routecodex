# RouteCodex V2 – Working Agreement

This document replaces the old “architecture novel” with a concise set of rules that reflect how the system actually works today. Everything else lives in source.

## 1. Core Principles

1. **Single execution path** – All traffic flows `HTTP server → llmswitch-core Super Pipeline → Provider V2 → upstream AI`. No side channels, no bypasses.
2. **llmswitch-core owns tools & routing** – Host/server/provider code must never repair tool calls, rewrite arguments, or decide routes. Use the Super Pipeline APIs only.
3. **Provider layer = transport** – V2 providers handle auth, HTTP, retries, and compatibility hooks. They do not inspect user payload semantics.
4. **Fail fast** – Any upstream error (HTTP, auth, compat) is bubbled via `providerErrorCenter` + `errorHandlingCenter`. No silent fallbacks.
5. **Config-driven** – Host consumes `bootstrapVirtualRouterConfig` output only. Do not reassemble “merged configs” or patch runtime data on the fly.

## 2. Module Responsibilities

| Layer | Source | What it does | What it must **not** do |
|-------|--------|--------------|--------------------------|
| HTTP server | `src/server/runtime/http-server/` | Express wiring, middleware, route handlers, delegating to Super Pipeline, managing provider runtimes | Tool/route logic, manual SSE bridging, configuration munging |
| Super Pipeline (llmswitch-core) | `sharedmodule/llmswitch-core/dist/v2/...` | Tool canonicalization, routing, compatibility orchestration, SSE conversion | Direct HTTP calls, auth, provider-specific behavior |
| Provider V2 | `src/modules/pipeline/modules/provider/v2/` | Auth resolution, request shaping, error reporting, compatibility adapters | Tool extraction, routing, configuration merges |
| Compatibility (if needed) | `src/modules/pipeline/modules/provider/v2/compatibility/` | Minimal field remap/cleanup per upstream contract | Tool decoding, fallback routing, catch-all try/catch |

## 3. Build & Release Workflow

1. **Update shared modules first** – Modify `sharedmodule/llmswitch-core` (or other sharedmodule repos) in their source worktrees, run their `npm run build`, and ensure dist artifacts exist.
2. **Host build** – Run `npm run build:dev` (use `ROUTECODEX_VERIFY_SKIP=1` only if the verification provider config is known broken). This regenerates `dist/` and `src/build-info.ts`.
3. **Global install/test** – `npm run install:global` to validate the CLI, followed by any targeted smoke tests (providers, responses SSE, etc.).
4. **Never commit build artifacts** – `dist/` is emitted during CI, sharedmodule dist files track the upstream repo, and tarballs stay out of git.

## 4. Error Reporting

- Every provider failure must call `emitProviderError({ ..., dependencies })`. This pushes events into llmswitch-core for breaker logic and also invokes the local `ErrorHandlingCenter`.
- When the HTTP server catches unexpected throws, wrap them via `errorHandling.handleError({ source: 'routecodex-server-v2.<stage>', ... })` so log streams stay structured.

## 5. Configuration Rules

1. Read user configs through `src/config/routecodex-config-loader.ts` only.
2. Immediately call `bootstrapVirtualRouterConfig(virtualrouter)` and pass the resulting `virtualRouter` + `targetRuntime` into the Super Pipeline and Provider bootstrap.
3. Runtime auth secrets are resolved in the host via env vars or `authfile-*` references; never store decrypted secrets back into configs.

## 6. Testing Checklist (per change)

- `sharedmodule/llmswitch-core`: `npm run build` (matrix) whenever shared code changes.
- Host repo: `ROUTECODEX_VERIFY_SKIP=1 npm run build:dev`, `npm run install:global`.
- Provider-specific tweaks: run the relevant script in `scripts/provider-*` or `scripts/responses-*` to ensure upstream compatibility.

Keep this file short. If a rule needs more nuance, add a doc in `docs/` and link it here instead of expanding this page.
