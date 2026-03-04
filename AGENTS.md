# RouteCodex V2 – Working Agreement

This document replaces the old “architecture novel” with a concise set of rules that reflect how the system actually works today. Everything else lives in source.

## 1. Core Principles

1. **Single execution path** – All traffic flows `HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream AI`. No side channels, no bypasses.
2. **llmswitch-core owns tools & routing** – Host/server/provider code must never repair tool calls, rewrite arguments, or decide routes. Use the Hub Pipeline APIs only.
3. **Provider layer = transport** – V2 providers handle auth, HTTP, retries, and compatibility hooks. They do not inspect user payload semantics.
4. **Fail fast** – Any upstream error (HTTP, auth, compat) is bubbled via `providerErrorCenter` + `errorHandlingCenter`. No silent fallbacks.
5. **No fallback logic** – If required inputs are missing (e.g., tmux session for client injection), do not invent fallbacks. Fail fast and surface the error; fallback logic is forbidden.
6. **Config-driven** – Host consumes `bootstrapVirtualRouterConfig` output only. Do not reassemble “merged configs” or patch runtime data on the fly.
7. **No backtracking** – Never revert changes or apply patches to fix bugs. Always identify and fix the root cause.

## 1.1 Agent Conduct & Accountability

1. **Verify before reporting** – Every claim, completion report, or status update must be validated against actual files, command outputs, or test results. Never assume or infer completion without concrete evidence.
2. **Honest disclosure of incomplete work** – If a task cannot be completed, state this clearly with reasons. Unfinished work reported honestly has no severe consequences—concealment or misrepresentation is the real problem.
3. **Deception is professional misconduct** – Fabricating results, hiding errors, claiming work that wasn't done, or misrepresenting task status constitutes serious professional misconduct and violates the trust foundation of this working agreement.
4. **No deletions without approval** – Never delete existing repo files without explicit user approval. If removal seems necessary, propose the change and wait for confirmation.
5. **Untracked-first review & dangerous-action gate** – When new/untracked files are detected, review them first as potential valid fixes. Do not delete/clean/checkout/reset these files by default. If they truly violate policy and require removal or rollback, ask the user before any destructive action.
6. **Process-kill commands are prohibited** – Agent must not execute any process termination command, including `kill`, `pkill`, `killall`, `taskkill`, `launchctl kill`, or port-based mass termination patterns (e.g. `lsof ... | xargs kill`). Process stop/restart must use explicit project CLI control flow only, and never by direct signal commands.

## 1.2 三层架构铁律（Block / App / UI）

1. **Block 层 = 基础能力层（全局唯一真源）** – Block 只提供可复用基础能力，不承载业务编排或业务决策；同一能力只能有一个权威实现，禁止多处复制逻辑。
2. **App 层 = 编排层** – App 只允许编排/组合 Blocks，不写业务细节实现，不在编排层“补一版逻辑”。
3. **UI 层 = 呈现层** – UI 只负责展示状态与触发交互，不承载业务规则；UI 必须与业务逻辑解耦。

## 1.3 Memsearch 使用原则

1. 当任务完成或阶段性完成、有重要发现、或需要记录失败尝试时，使用 memsearch skill 进行记录。
2. 当需要压缩记忆时，使用 memsearch skill 进行记录。
3. 当有 debug 任务需要分析或有新任务要实现时，先使用 memsearch skill 做记忆搜索再执行。
4. 对用户反复要求的任务、习惯与命令，提炼规律并记录到 memsearch。

---

## 2. Module Responsibilities

| Layer | Source | What it does | What it must **not** do |
|-------|--------|--------------|--------------------------|
| HTTP server | `src/server/runtime/http-server/` | Express wiring, middleware, route handlers, delegating to Hub Pipeline, managing provider runtimes | Tool/route logic, manual SSE bridging, configuration munging |
| Hub Pipeline (llmswitch-core) | `sharedmodule/llmswitch-core/dist/...` | Tool canonicalization, routing, compatibility orchestration, SSE conversion | Direct HTTP calls, auth, provider-specific behavior |
| Provider V2 | `src/providers/` | Auth resolution, request shaping, error reporting, compatibility adapters | Tool extraction, routing, configuration merges |
| Compatibility (if needed) | `sharedmodule/llmswitch-core/src/conversion/compat/` | Minimal field remap/cleanup per upstream contract（通过 `compatibilityProfile` 触发） | Tool decoding, fallback routing, catch-all try/catch |

## 3. Build & Release Workflow

1. **Update shared modules first** – Modify `sharedmodule/llmswitch-core` (or other sharedmodule repos) in their source worktrees, run their `npm run build`, and ensure dist artifacts exist.
2. **Tag both repos for npm releases** – Every npm publish requires matching git tags on BOTH repos: `routecodex` and `sharedmodule/llmswitch-core`. If tags are missing, do **not** build/publish the npm package.
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
- Replay confirmation (mandatory): at least one same-shape replay for the failing provider + one control replay for an unaffected provider before claiming fix complete.

### 6.1 Compatibility Debug SOP (single implementation)

1. First check existing bd records before coding: `bd --no-db ready` + `bd --no-db search "<provider/error keywords>"`; continue on existing issue when matched.
2. Create/update a `bd --no-db` issue (with clear acceptance criteria and failing sample).
3. Reproduce with one minimal sample and record `requestId`, `providerKey`, `providerProtocol`, route, and model.
4. Triage layer before coding: routing/config issue vs compat shape issue vs provider transport issue.
5. Tool/shape/`reasoning_content`/tool-id fixes must live in llmswitch-core compat (profile/action/Hub compat stage), not in Virtual Router or provider transport.
6. Keep a single source of truth for fallback behavior (only one resolver location); do not duplicate heuristics across layers.
7. Add a targeted regression script plus matrix hook when behavior changes.
8. Close only with replay evidence: compat profile hit + key field before/after + unaffected control replay.

### 6.2 LSP 跨仓管理（RouteCodex + llmswitch-core）

> `sharedmodule/llmswitch-core` 是独立仓库（git 根在 `../sharedmodule`），必须按“双仓”管理。

1. **双 Workspace 启动**
   - 必须分别启动 LSP：
     - `lsp server start /Users/fanzhang/Documents/github/routecodex`
     - `lsp server start /Users/fanzhang/Documents/github/sharedmodule/llmswitch-core`
   - 禁止仅启动 host 仓库后就声称完成跨仓影响分析。

2. **桥接边界是单一入口**
   - Host 侧仅以 `src/modules/llmswitch/bridge.ts` 为 llmswitch-core 语义边界。
   - 分析顺序固定：`outline -> doc -> definition -> reference`。
   - 禁止在 host 其他模块直接把 llmswitch-core 作为“主分析入口”并据此推断影响面。

3. **跨仓追踪最小清单**
   - 在 RouteCodex 上先定位 bridge 导出符号与调用点（`lsp reference`）。
   - 再在 llmswitch-core 源码仓定位对应实现（`lsp definition/outline`）。
   - 每次涉及 bridge 变更，必须在 BD 备注里记录：`bridge symbol -> core file -> host callsites`。

4. **提交与验证顺序**
   - llmswitch-core 变更先在 sharedmodule 仓提交并 `npm run build`。
   - RouteCodex 再执行 `npm run build:dev` 与 `npm run install:global` 验证接入。
   - 不允许把 sharedmodule 未提交状态当作 RouteCodex 已完成结果。

5. **会话收尾**
   - 结束前执行 `lsp server list` 并停止相关 server（`lsp server stop <path>`）。
   - 避免后台 server 残留导致后续分析串仓或结果污染。

Keep this file short. If a rule needs more nuance, add a doc in `docs/` and link it here instead of expanding this page.

## Task Management

Use the `bd-task-flow` skill for the BD task flow (`bd --no-db`, `.beads/issues.jsonl`, git-portable sync, claim/close rules). The skill is the single source of truth for task tracking workflow.
