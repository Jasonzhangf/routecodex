# RouteCodex V2 – Working Agreement

This document replaces the old “architecture novel” with a concise set of rules that reflect how the system actually works today. Everything else lives in source.

## 1. Core Principles

1. **Single execution path** – All traffic flows `HTTP server → llmswitch-core Hub Pipeline → Provider V2 → upstream AI`. No side channels, no bypasses.
2. **llmswitch-core owns tools & routing** – Host/server/provider code must never repair tool calls, rewrite arguments, or decide routes. Use the Hub Pipeline APIs only.
3. **Provider layer = transport** – V2 providers handle auth, HTTP, retries, and compatibility hooks. They do not inspect user payload semantics.
4. **Fail fast** – Any upstream error (HTTP, auth, compat) is bubbled via `providerErrorCenter` + `errorHandlingCenter`. No silent fallbacks.
5. **Config-driven** – Host consumes `bootstrapVirtualRouterConfig` output only. Do not reassemble “merged configs” or patch runtime data on the fly.
6. **No backtracking** – Never revert changes or apply patches to fix bugs. Always identify and fix the root cause.

## 1.1 Agent Conduct & Accountability

1. **Verify before reporting** – Every claim, completion report, or status update must be validated against actual files, command outputs, or test results. Never assume or infer completion without concrete evidence.
2. **Honest disclosure of incomplete work** – If a task cannot be completed, state this clearly with reasons. Unfinished work reported honestly has no severe consequences—concealment or misrepresentation is the real problem.
3. **Deception is professional misconduct** – Fabricating results, hiding errors, claiming work that wasn't done, or misrepresenting task status constitutes serious professional misconduct and violates the trust foundation of this working agreement.
4. **No deletions without approval** – Never delete existing repo files without explicit user approval. If removal seems necessary, propose the change and wait for confirmation.
5. **Untracked-first review & dangerous-action gate** – When new/untracked files are detected, review them first as potential valid fixes. Do not delete/clean/checkout/reset these files by default. If they truly violate policy and require removal or rollback, ask the user before any destructive action.
6. **Process-kill commands are prohibited** – Agent must not execute any process termination command, including `kill`, `pkill`, `killall`, `taskkill`, `launchctl kill`, or port-based mass termination patterns (e.g. `lsof ... | xargs kill`). Process stop/restart must use explicit project CLI control flow only, and never by direct signal commands.

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

## 7. Task Tracking（Beads / `bd`）

本仓库的**具体任务/计划/依赖**不再写在 `AGENTS.md`（避免过时）；统一用 Beads（`bd` CLI）管理，并以 **`bd --no-db` + `.beads/issues.jsonl`** 作为可版本化的单一任务来源。

### 7.1 Setup（推荐）

- 初始化：`bd init --no-db`
- 日常使用：所有命令都带 `--no-db`（避免误用 sqlite db）
- 检查位置：`bd --no-db where`

### 7.2 日常工作流（最小命令集）

- 找可做：`bd --no-db ready`（无 blocker 的 open/in_progress）
- 看详情：`bd --no-db show <id>`
- 新建任务：`bd --no-db create "Title" -p 0 --parent <epic>`
- 更新状态：`bd --no-db update <id> --status in_progress|blocked|closed`
- 依赖（避免循环）：`bd --no-db dep add <blocked> <blocker>`
  - 注意：parent-child 关系不要再额外用 `dep add` 连接（会形成 cycle）
- Epic 进度：`bd --no-db epic status` / `bd --no-db epic close-eligible`

### 7.3 约定

- 新增需求：必须先创建/更新 `bd` issue（含验收标准），再开始实现；不要把 TODO 写回 `AGENTS.md`。
- Issue 模板要求：`task/bug` 必须包含 `Acceptance Criteria`，`epic` 必须包含 `Success Criteria`；新增 issue 以 `bd --no-db lint` 无告警为目标。
- `.beads/issues.jsonl` 是唯一需要版本化的 beads 文件；其它 `.beads/*` 视为本地运行态，不纳入协作。
- `task.md` 仅作为历史说明文件；任务/进展/记忆一律以 `bd --no-db` 为准。

### 7.4 多人并行协作约束（推荐规则）

> 目标：多人同时推进多个任务时，保证“谁在做什么”可见、可合并、可回溯，并尽量减少 `.beads/issues.jsonl` 冲突。

- 任务粒度：一个可独立合并的改动 = 一个 `bd` issue（必要时拆分子任务 `epic.1.1`）
- 领取/占用：开工前必须“claim”任务，避免多人同时改同一件事：
  - 推荐：`bd --no-db update <id> --claim`（原子操作：设置 assignee + `in_progress`；若已被占用会失败）
  - 兼容：`bd --no-db update <id> --status in_progress --assignee <name>`
- 分支命名：建议 `/<issueId>-short-title`，PR 标题/描述必须包含 `<issueId>` 便于追踪
- 同步节奏：每个 PR 必须包含对应 issue 的状态更新（至少 `in_progress`/`closed`）并提交 `.beads/issues.jsonl`
- 串行合入（高冲突区域）：需要严格串行的工作流（例如 policy/quota/persistence）用 `bd merge-slot` 做“排队合入”，避免互相覆盖
- 冲突规避：不要手写编辑 `.beads/issues.jsonl`；只用 `bd --no-db update/create` 写入
- 冲突处理：若 `.beads/issues.jsonl` 出现 git 冲突，优先用 `bd resolve-conflicts` 修复后再继续
- 依赖表达：跨人/跨任务阻塞用 `bd --no-db dep add <blocked> <blocker>`；不要把 parent-child 再用 dep 连接
- 关闭任务：必须在 notes 里附带“可复现的证据”（测试/命令输出/文件路径），再 `bd --no-db close <id> --reason "<what>" --suggest-next`

### 7.5 常用搜索（bd search / bd list）

下面是 `bd` 的“详细搜索用法”整理，覆盖 `bd search`（全文检索）和 `bd list`（字段过滤），按实际使用场景编排。

#### 1) bd search：全文检索（标题/描述/ID）

基础用法

```bash
bd --no-db search "关键词"
bd --no-db search "authentication bug"
bd --no-db search "bd-a3f8"           # 支持部分 ID
bd --no-db search --query "performance"
```

常用过滤

```bash
bd --no-db search "bug" --status open
bd --no-db search "database" --label backend --limit 10
bd --no-db search "refactor" --assignee alice
bd --no-db search "security" --priority-min 0 --priority-max 2
```

时间范围

```bash
bd --no-db search "bug" --created-after 2025-01-01
bd --no-db search "refactor" --updated-after 2025-01-01
bd --no-db search "cleanup" --closed-before 2025-12-31
```

排序与展示

```bash
bd --no-db search "bug" --sort priority
bd --no-db search "task" --sort created --reverse
bd --no-db search "design" --long       # 多行显示细节
```

支持的 `--sort` 字段

- `priority`, `created`, `updated`, `closed`, `status`, `id`, `title`, `type`, `assignee`

---

#### 2) bd list：字段级精确过滤（适合缩小范围）

按状态/优先级/类型

```bash
bd --no-db list --status open --priority 1
bd --no-db list --type bug
```

按标签

```bash
bd --no-db list --label bug,critical           # AND：必须同时拥有
bd --no-db list --label-any frontend,backend   # OR：任意一个即可
```

按字段包含（子串匹配）

```bash
bd --no-db list --title-contains "auth"
bd --no-db list --desc-contains "implement"
bd --no-db list --notes-contains "TODO"
```

按日期范围

```bash
bd --no-db list --created-after 2024-01-01
bd --no-db list --updated-before 2024-12-31
bd --no-db list --closed-after 2024-01-01
```

空字段筛选

```bash
bd --no-db list --empty-description
bd --no-db list --no-assignee
bd --no-db list --no-labels
```

优先级范围

```bash
bd --no-db list --priority-min 0 --priority-max 1
bd --no-db list --priority-min 2
```

组合过滤

```bash
bd --no-db list --status open --priority 1 --label-any urgent,critical --no-assignee
```

### 7.6 Git Portable 同步流程（推荐）

最合理的“基于 git 的 bd 同步”做法，本质目标是：让团队只通过 git 同步 `.beads/issues.jsonl`，而不是同步本地数据库文件，并且把“忘了导出/导入”的风险降到最低。

- 统一模式：`bd sync mode set git-portable`
- 一次性初始化：`bd init`（若 main 受保护：用 `bd init --branch beads-sync` 建一个元数据分支）
- 把同步做成“自动护栏”（强烈推荐）：`bd hooks install`（会装 pre-commit / post-merge / pre-push / post-checkout 等，保证提交前 flush、拉取/切分支后 import、推送前不允许 stale）
- 日常流程（最省心）：`git pull --rebase` → 正常 `bd create/update/close` → 正常 `git commit/push`（hooks 自动处理大部分同步）
- 关键时刻强制落盘：结束会话/交接前跑一次 `bd sync`（把 debounce 窗口里的改动立刻刷到 JSONL）
- 约定：git 只追踪 `.beads/issues.jsonl`/`.gitattributes`/`.beads/.gitignore`，不要提交 `.beads/beads.db` 之类本地文件
- 如果用 git worktree：别开 daemon（`export BEADS_NO_DAEMON=1` 或每次加 `--no-daemon`），主要依赖 hooks + 需要时手动 `bd sync`


