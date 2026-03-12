# RouteCodex V2 – Working Agreement

This document replaces the old "architecture novel" with a concise set of rules that reflect how the system actually works today. Everything else lives in source.

## 1. Core Principles

1. **Single execution path** – All traffic flows `HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream AI`. No side channels, no bypasses.
2. **llmswitch-core owns tools & routing** – llmswitch-core 位于本仓库 `sharedmodule/llmswitch-core/`，Host/server/provider 代码不得修复工具调用、重写参数或决定路由，只使用 Hub Pipeline APIs。
3. **Provider layer = transport** – V2 providers handle auth, HTTP, retries, and compatibility hooks. They do not inspect user payload semantics.
4. **Fail fast** – Any upstream error (HTTP, auth, compat) is bubbled via `providerErrorCenter` + `errorHandlingCenter`. No silent fallbacks.
5. **No fallback logic** – If required inputs are missing (e.g., tmux session for client inject), do not invent fallbacks. Fail fast and surface the error; fallback logic is forbidden.
6. **Config-driven** – Host consumes `bootstrapVirtualRouterConfig` output only. Do not reassemble "merged configs" or patch runtime data on the fly.
7. **No backtracking** – Never revert changes or apply patches to fix bugs. Always identify and fix the root cause.

## 1.1 Agent Conduct & Accountability

1. **Verify before reporting** – Every claim, completion report, or status update must be validated against actual files, command outputs, or test results. Never assume or infer completion without concrete evidence.
2. **Honest disclosure of incomplete work** – If a task cannot be completed, state this clearly with reasons. Unfinished work reported honestly has no severe consequences—concealment or misrepresentation is the real problem.
3. **Deception is professional misconduct** – Fabricating results, hiding errors, claiming work that wasn't done, or misrepresenting task status constitutes serious professional misconduct and violates the trust foundation of this working agreement.
4. **No deletions without approval** – Never delete existing repo files without explicit user approval. If removal seems necessary, propose the change and wait for confirmation.
5. **Untracked-first review & dangerous-action gate** – When new/untracked files are detected, review them first as potential valid fixes. Do not delete/clean/checkout/reset these files by default. If they truly violate policy and require removal or rollback, ask the user before any destructive action.
6. **Uncertain changes require confirmation** – When an unexpected or uncertain change is detected, do not modify it; ask the user how to proceed.
7. **Process-kill commands are prohibited** – Agent must not execute any process termination command, including `kill`, `pkill`, `killall`, `taskkill`, `launchctl kill`, or port-based mass termination patterns (e.g. `lsof ... | xargs kill`). Process stop/restart must use explicit project CLI control flow only, and never by direct signal commands.

## 1.2 三层架构铁律（Block / App / UI）

1. **Block 层 = 基础能力层（全局唯一真源）** – Block 只提供可复用基础能力，不承载业务编排或业务决策；同一能力只能有一个权威实现，禁止多处复制逻辑。
2. **App 层 = 编排层** – App 只允许编排/组合 Blocks，不写业务细节实现，不在编排层"补一版逻辑"。
3. **UI 层 = 呈现层** – UI 只负责展示状态与触发交互，不承载业务规则；UI 必须与业务逻辑解耦。

## 1.3 Memsearch 使用原则

1. 当任务完成或阶段性完成、有重要发现、或需要记录失败尝试时，使用 memsearch flow skill 进行记录。
2. 当需要压缩记忆时，使用 memsearch flow skill 进行记录。
3. 当有 debug 任务需要分析或有新任务要实现时，先使用 memsearch flow skill 做记忆搜索再执行。
4. 对用户反复要求的任务、习惯与命令，提炼规律并记录到 memsearch。
5. 当用户提出"请记住 / 记住 / 保存记忆 / 记忆一下"等请求时，必须调用 memsearch flow skill 写入记忆。
6. 当用户提出"查询记忆 / 查找记忆 / 搜索记忆 / 回忆"等请求时，先调用 memsearch flow skill 检索记忆，再进行代码搜索或实现操作。
7. 对于项目约束、项目习惯、全项目通用信息、项目架构等长期共享记忆，统一记录在仓库根目录 `MEMORY.md`；对于每一条独立任务的过程性记忆，记录在 `./memory/` 目录。

## 1.4 Rust 化原则

1. Rust 化过程中必须函数化、模块化与自包含；拆分时遵循"先拆新文件、验证后再删旧逻辑"，避免巨型文件。
2. 每次写入 memsearch 记忆时必须添加 `Tags:` 行，并包含清晰可检索的关键词标签。

---

## 2. Module Responsibilities

| Layer | Source | What it does | What it must **not** do |
|-------|--------|--------------|--------------------------|
| HTTP server | `src/server/runtime/http-server/` | Express wiring, middleware, route handlers, delegating to Hub Pipeline, managing provider runtimes | Tool/route logic, manual SSE bridging, configuration munging |
| Hub Pipeline (llmswitch-core) | `sharedmodule/llmswitch-core/src/` | Tool canonicalization, routing, compatibility orchestration, SSE conversion | Direct HTTP calls, auth, provider-specific behavior |
| Provider V2 | `src/providers/` | Auth resolution, request shaping, error reporting, compatibility adapters | Tool extraction, routing, configuration merges |
| Compatibility (if needed) | `sharedmodule/llmswitch-core/src/conversion/compat/` | Minimal field remap/cleanup per upstream contract | Tool decoding, fallback routing, catch-all try/catch |

## 3. Build & Release Workflow

1. **单仓库结构** – llmswitch-core 已并仓到本仓库 `sharedmodule/llmswitch-core/`，不再是独立仓库。
2. **构建顺序** – 先在 `sharedmodule/llmswitch-core/` 执行 `npm run build`，再在仓库根目录执行 `npm run build:dev`。
3. **Host build** – Run `npm run build:dev` 并确保验证通过；禁止在常规流程中使用 `ROUTECODEX_VERIFY_SKIP=1` 跳过验证。
4. **Global install/test** – `npm run install:global` to validate the CLI, followed by any targeted smoke tests.
5. **Never commit build artifacts** – `dist/` is emitted during CI, tarballs stay out of git.
6. **CLI 包隔离** – Release 版使用 `@jsonstudio/rcc`；`routecodex` 仅限本地/调试 CLI。

## 4. Error Reporting

- 错误流统一交由 `RouteErrorHub → ErrorHandlerRegistry → providerErrorCenter` 处理，详见 `docs/error-handling-v2.md`。
- Every provider failure must call `emitProviderError({ ..., dependencies })`，确保 Virtual Router 获取 `ProviderErrorEvent` 并更新健康状态。
- HTTP server / CLI / pipeline 在捕获异常时调用 `reportRouteError({ scope: 'http' | 'server' | ... })`，由 RouteErrorHub 负责日志裁剪与 HTTP 映射。

## 5. Configuration Rules

1. Read user configs through `src/config/routecodex-config-loader.ts` only.
2. Immediately call `bootstrapVirtualRouterConfig(virtualrouter)` and pass the resulting `virtualRouter` + `targetRuntime` into the Hub Pipeline and Provider bootstrap.
3. Runtime auth secrets are resolved in the host via env vars or `authfile-*` references; never store decrypted secrets back into configs.

## 6. Testing Checklist (per change)

- llmswitch-core: 在 `sharedmodule/llmswitch-core/` 执行 `npm run build`。
- Host repo: `npm run build:dev`, `npm run install:global`。
- Provider-specific tweaks: run the relevant script in `scripts/provider-*` or `scripts/responses-*` to ensure upstream compatibility.
- Replay confirmation (mandatory): at least one same-shape replay for the failing provider + one control replay for an unaffected provider before claiming fix complete.

### 6.1 LSP 单仓库管理

由于 llmswitch-core 已并仓，只需启动一个 LSP server：
- `lsp server start /Users/fanzhang/Documents/github/routecodex`

Host 侧仅以 `src/modules/llmswitch/bridge.ts` 为 llmswitch-core 语义边界。

Keep this file short. If a rule needs more nuance, add a doc in `docs/` and link it here instead of expanding this page.

## Task Management

Use the `bd-task-flow` skill for the BD task flow (`bd --no-db`, `.beads/issues.jsonl`, git-portable sync, claim/close rules). The skill is the single source of truth for task tracking workflow.

### BD Notes Hygiene

1. `bd` issue `notes` 只写结论、验收结果和证据路径，不要粘贴原始构建日志、测试日志、matrix 输出或大段命令回显。
2. 详细输出必须写到仓库产物、测试结果文件、`MEMORY.md`/`memory/` 或独立日志文件，再在 `notes` 里引用路径。
3. 提交 `bd update --notes` 前，避免生成超长单行 JSON 记录，防止 `.beads/issues.jsonl` 因 scanner token too long 再次损坏可读性。
4. 每次执行任何 `bd --no-db *` 命令前，先运行 `node scripts/cleanup-beads-oversized-notes.mjs --apply`，把历史超长 notes 压缩后再继续。
