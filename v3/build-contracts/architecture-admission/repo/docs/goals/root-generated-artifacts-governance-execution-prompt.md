# Root Generated Artifacts Governance Execution Prompt

## Purpose

This document is the execution prompt and process design for cleaning and governing RouteCodex repository-root generated artifacts.

Authoritative implementation plan:

- `docs/goals/root-generated-artifacts-governance-plan.md`

Use this document when starting a new `/goal` run for root layout cleanup, source write-path normalization, and root-clutter prevention gates.

## Ready-to-Use Prompt

```text
/goal
目标：按 docs/goals/root-generated-artifacts-governance-plan.md 完成 RouteCodex 根目录生成物治理，先从源码写入路径规范化入手，再清理或迁移历史根目录散件，并用 gate 防止复发。

实现文档：
- docs/goals/root-generated-artifacts-governance-plan.md
- docs/goals/root-generated-artifacts-governance-execution-prompt.md

执行规范：
- 先审计再修改；每个删除/迁移动作必须有 git 跟踪状态、git check-ignore、源码引用、生成来源证据。
- 禁止 fallback/兜底/静默吞错；路径治理必须回到唯一写入真源修复。
- 禁止按 ignored 状态直接删除源码；webui/ 这类 local exclude hazard 必须保留并修正规则。
- 只做根目录生成物治理相关改动，不碰 provider/runtime/pipeline 语义。
- 不使用 broad kill，不回滚用户或其他任务的未提交改动。

验证：
- root audit/status：find 根目录 + git status --ignored 证据。
- gate：node scripts/ci/repo-sanity.mjs；若失败，区分本目标问题和既有 Rustification baseline 问题。
- 文档/格式：git diff --check。
- 涉及 TS/脚本源码时跑 npx tsc --noEmit --pretty false。
- 涉及 build/install/package 路径时跑 npm run build:min、npm run install:global、routecodex --version、rcc --version。

完成标准：
- 根目录无未解释 generated/local 散件。
- 所有 repo-local 写入路径归入 approved root。
- legacy exceptions 有明确删除/迁移结果或阻塞证据。
- repo-sanity root-layout 部分不再因根目录散件失败。
- 治理经验写入 note.md/MEMORY.md/本地 skill。
```

## Execution Process

### Phase 0: Load Context

Read these files before touching code:

1. `AGENTS.md`
2. `CACHE.md`
3. `MEMORY.md`
4. `.agents/skills/rcc-dev-skills/SKILL.md`
5. `docs/goals/root-generated-artifacts-governance-plan.md`
6. this document

Required stance:

- Treat root clutter as an architecture/governance problem, not only a cleanup task.
- Do not delete evidence truth or runtime state without a specific retention policy.
- Do not stage, revert, or overwrite unrelated dirty work.

### Phase 1: Current-State Audit

Run root inventory commands:

```bash
find . -maxdepth 1 -mindepth 1 -exec basename {} \; | sort
find . -maxdepth 1 -mindepth 1 -exec du -sh {} \; 2>/dev/null | sort -h
git status --short --ignored --untracked-files=all -- . | sed -n '1,220p'
```

Classify each suspicious root item:

- tracked source or tracked historical residue;
- ignored generated output;
- ignored local tool state;
- runtime evidence;
- package/build dependency cache;
- local exclude hazard.

Evidence requirements:

- Use `git ls-files <path>` to prove tracked status.
- Use `git check-ignore -v <path>` to prove ignored status.
- Use `rg -n "<path-or-name>"` to find source/script/doc references.
- Use `file`, `ls -la`, and `du -sh` for binary/cache/size classification.

Stop condition:

- No deletion until each candidate is classified.

### Phase 2: Source Write-Path Audit

Search for root write sources:

```bash
rg -n "(writeFile|writeFileSync|mkdir|mkdirSync|cpSync|copyFile|createWriteStream|appendFile|rmSync|outDir|pack-destination|test-results|tmp/|logs/|reports|\\.install-pack|\\.tgz|bin/|lib/)" scripts src sharedmodule webui package.json --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/target/**'
```

For each hit, record:

- owner script/module;
- current output path;
- approved target root;
- whether behavior is build/test/package/runtime/tool-state;
- verification command that proves the path moved safely.

Decision rule:

- If the source writes root clutter, fix the writer first.
- If the file is only historical residue and no writer remains, delete it after evidence.

### Phase 3: Implement Path Governance

Preferred implementation order:

1. Add a shared script helper, for example `scripts/lib/repo-output-paths.mjs`.
2. Move pack/install artifacts away from root `*.tgz` and `.install-pack/`.
3. Move report/debug defaults to `docs/reports/`, `test-results/`, `logs/`, or `~/.rcc`.
4. Ensure local CLI shims never create repo-root `bin/` or `lib/`.
5. Keep TypeScript/Rust/web build outputs in owned `dist/` or `target/` roots only.

Non-goals:

- Do not rewrite provider/runtime semantics.
- Do not change Hub Pipeline or Virtual Router behavior.
- Do not solve Rustification audit debt unless it directly blocks root-layout governance.

### Phase 4: Migrate Historical Root Exceptions

Handle one exception per slice:

- `package/`: prove active packaging role; either move under `scripts/packaging/` with owner docs or delete with package/install references updated.
- `rcc`: prove whether tracked root symlink is still required by packaging; replace with generated artifact only if packaging remains valid.
- `models/`: write cache policy before deletion or migration.
- tool state (`clock.md`, `.drudge/`, `.codex-work/`, `.reasonix/`, Hypatia/MemPalace files): move to approved local-state root or external tool home only after confirming tool behavior.

Already completed and must stay deleted:

- `nested/deep/ap003.txt`; self-test now uses `tmp/nested/deep/ap003.txt`.

### Phase 5: Tighten Gates

Update `scripts/ci/repo-sanity.mjs` only after source paths and legacy exceptions are handled.

Target gate behavior:

- root allowlist is split by source roots, generated roots, local state roots, and temporary legacy roots;
- new root files outside policy fail fast;
- root `*.tgz`, root `*.log`, root ad-hoc JSON, root `bin/`, root `lib/`, and source-side TS emit are blocked;
- known local exclude hazards such as `webui/` are not treated as disposable.

If `repo-sanity` fails from unrelated Rustification baseline debt, report that separately and still show whether the root-layout portion is clean.

### Phase 6: Cleanup

High-confidence cleanup candidates:

```bash
git check-ignore -v tmp test-results sharedmodule/test-results sharedmodule/llmswitch-core/test-results .install-pack '*.tgz' '.DS_Store' 2>/dev/null
```

Delete only confirmed disposable generated artifacts.

Never bulk-delete:

- `~/.rcc/diag`;
- `~/.rcc/codex-samples`;
- `models/`;
- `samples/`;
- `vendor/`;
- tracked historical roots without a source migration;
- local tool indexes without an explicit migration target.

### Phase 7: Verification

Minimum verification:

```bash
find . -maxdepth 1 -mindepth 1 -exec basename {} \; | sort
git status --short --ignored --untracked-files=all -- . | sed -n '1,220p'
git diff --check
node scripts/ci/repo-sanity.mjs
```

If source code changed:

```bash
npx tsc --noEmit --pretty false
```

If packaging/build/install changed:

```bash
npm run build:min
npm run install:global
routecodex --version
rcc --version
```

If `repo-sanity` remains red from unrelated Rustification baseline debt, include the exact failing file list and state that the root-layout issue is separately resolved or still pending.

### Phase 8: Memory and Report

Update:

- `note.md` with audit evidence and decisions;
- `MEMORY.md` only for verified durable conclusions;
- `.agents/skills/rcc-dev-skills/SKILL.md` when a reusable cleanup boundary or anti-pattern is discovered.

Final report shape:

- changed files/directories;
- deleted/migrated root items;
- verification commands and outcomes;
- remaining root exceptions and why they remain;
- next slice recommendation.

## Prompt Variants

### Audit-Only Variant

```text
/goal
目标：只审计 RouteCodex 根目录生成物与源码写入点，不修改代码、不删除文件，输出可执行整改清单。

实现文档：
- docs/goals/root-generated-artifacts-governance-plan.md
- docs/goals/root-generated-artifacts-governance-execution-prompt.md

执行规范：
- 只读审计；用 git ls-files、git check-ignore、rg、du/file 形成证据链。
- 分类 tracked source、ignored generated、local tool state、runtime evidence、cache、local exclude hazard。
- 不做删除、迁移、格式化、回滚。

验证：
- 提供根目录 inventory、写入点列表、风险分类、建议 phase。

完成标准：
- 每个可疑根目录项都有 owner/class/建议动作。
- 每个写根目录的源码或脚本都有迁移目标。
```

### Implementation Variant

```text
/goal
目标：执行 root generated artifacts governance Phase 1，修复源码/脚本默认写根目录的问题，并补 root-layout gate。

实现文档：
- docs/goals/root-generated-artifacts-governance-plan.md
- docs/goals/root-generated-artifacts-governance-execution-prompt.md

执行规范：
- 先跑 audit，确认本 slice 只处理 Phase 1。
- 每个写路径变更必须有测试/命令证明输出落在 approved root。
- 不处理 provider/runtime/pipeline 语义，不清理 ambiguous tool cache。

验证：
- git diff --check
- node scripts/ci/repo-sanity.mjs
- npx tsc --noEmit --pretty false
- 涉及 build/install 时追加 build:min/install/version smoke。

完成标准：
- 本 slice 涉及的脚本不再产生 root clutter。
- 新增/更新 gate 可阻止同类 root 写入复发。
- note/MEMORY/skill 已记录可复用结论。
```
