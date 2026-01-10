# RouteCodex V2 – Working Agreement

This document replaces the old “architecture novel” with a concise set of rules that reflect how the system actually works today. Everything else lives in source.

## 1. Core Principles

1. **Single execution path** – All traffic flows `HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream AI`. No side channels, no bypasses.
2. **llmswitch-core owns tools & routing** – Host/server/provider code must never repair tool calls, rewrite arguments, or decide routes. Use the Hub Pipeline APIs only.
3. **Provider layer = transport** – V2 providers handle auth, HTTP, retries, and compatibility hooks. They do not inspect user payload semantics.
4. **Fail fast** – Any upstream error (HTTP, auth, compat) is bubbled via `providerErrorCenter` + `errorHandlingCenter`. No silent fallbacks.
5. **Config-driven** – Host consumes `bootstrapVirtualRouterConfig` output only. Do not reassemble “merged configs” or patch runtime data on the fly.

## 2. Module Responsibilities

| Layer | Source | What it does | What it must **not** do |
|-------|--------|--------------|--------------------------|
| HTTP server | `src/server/runtime/http-server/` | Express wiring, middleware, route handlers, delegating to Hub Pipeline, managing provider runtimes | Tool/route logic, manual SSE bridging, configuration munging |
| Hub Pipeline (llmswitch-core) | `sharedmodule/llmswitch-core/dist/...` | Tool canonicalization, routing, compatibility orchestration, SSE conversion | Direct HTTP calls, auth, provider-specific behavior |
| Provider V2 | `src/providers/` | Auth resolution, request shaping, error reporting, compatibility adapters | Tool extraction, routing, configuration merges |
| Compatibility (if needed) | `sharedmodule/llmswitch-core/src/conversion/compat/` | Minimal field remap/cleanup per upstream contract（通过 `compatibilityProfile` 触发） | Tool decoding, fallback routing, catch-all try/catch |

## 3. Build & Release Workflow

1. **Update shared modules first** – Modify `sharedmodule/llmswitch-core` (or other sharedmodule repos) in their source worktrees, run their `npm run build`, and ensure dist artifacts exist.
2. **Host build** – Run `npm run build:dev` 并确保验证通过；禁止在常规流程中使用 `ROUTECODEX_VERIFY_SKIP=1` 跳过验证。这会重新生成 `dist/` 和 `src/build-info.ts`。
3. **Global install/test** – `npm run install:global` to validate the CLI, followed by any targeted smoke tests (providers, responses SSE, etc.).
4. **Never commit build artifacts** – `dist/` is emitted during CI, sharedmodule dist files track the upstream repo, and tarballs stay out of git.
5. **Release vs. Dev 依赖** – Release 构建一律依赖 npm 上的 `@jsonstudio/llms`（通过 `npm install` 获取）；开发流程使用 `npm run llmswitch:link` 将 `sharedmodule/llmswitch-core` 符号链接到 `node_modules/@jsonstudio/llms`，两种路径互不覆盖。
6. **CLI 包隔离** – Release 版只能用 `@jsonstudio/rcc`，并通过 `node scripts/pack-mode.mjs --name @jsonstudio/rcc --bin rcc` 生成 tarball 后 `npm publish jsonstudio-rcc-*.tgz`；`routecodex` 仅限本地/调试 CLI，严禁发布到 npm。
7. **CLI 运行模式固定** – `routecodex` 始终对应 dev 模式（`npm run build:dev` + `npm run install:global`，使用本地 `sharedmodule/llmswitch-core` symlink）；`rcc` 始终对应 release 模式（`npm run install:release`，使用 npm 安装的 `@jsonstudio/llms`）。禁止用 release 构建启动 `routecodex`，两条 CLI 路径的构建与运行互不混用。

## 4. Error Reporting

- 错误流统一交由 `RouteErrorHub → ErrorHandlerRegistry → providerErrorCenter` 处理，详见 `docs/error-handling-v2.md`。
- Every provider failure must call `emitProviderError({ ..., dependencies })`，确保 Virtual Router 获取 `ProviderErrorEvent` 并更新健康状态。
- HTTP server / CLI / pipeline 在捕获异常时调用 `reportRouteError({ scope: 'http' | 'server' | ... })`，由 RouteErrorHub 负责日志裁剪与 HTTP 映射。

## 5. Configuration Rules

1. Read user configs through `src/config/routecodex-config-loader.ts` only.
2. Immediately call `bootstrapVirtualRouterConfig(virtualrouter)` and pass the resulting `virtualRouter` + `targetRuntime` into the Hub Pipeline and Provider bootstrap.
3. Runtime auth secrets are resolved in the host via env vars or `authfile-*` references; never store decrypted secrets back into configs.

## 6. Testing Checklist (per change)

- `sharedmodule/llmswitch-core`: `npm run build` (matrix) whenever shared code changes.
- Host repo: `npm run build:dev`, `npm run install:global`。
- Provider-specific tweaks: run the relevant script in `scripts/provider-*` or `scripts/responses-*` to ensure upstream compatibility.

Keep this file short. If a rule needs more nuance, add a doc in `docs/` and link it here instead of expanding this page.

## Skills
A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.
### Available skills
- skill-creator: Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Codex's capabilities with specialized knowledge, workflows, or tool integrations. (file: /Users/fanzhang/.codex/skills/.system/skill-creator/SKILL.md)
- skill-installer: Install Codex skills into $CODEX_HOME/skills from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo (including private repos). (file: /Users/fanzhang/.codex/skills/.system/skill-installer/SKILL.md)
### How to use skills
- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.
  2) If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request; don't bulk-load everything.
  3) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.
  4) If `assets/` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.
