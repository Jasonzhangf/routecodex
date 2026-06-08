# note.md Topic Consolidation and MEMORY Promotion Plan

## Goal

Organize `note.md` by recurring themes, verify each candidate fact against the current repository state, and append only verified, durable conclusions to `MEMORY.md`.

## Acceptance Criteria

- Recurring `note.md` themes are grouped into a concise topic index with duplicate or superseded entries identified.
- Every `MEMORY.md` addition is backed by current code, docs, tests, git history, or command evidence.
- Stale, unverified, contradicted, or one-off process notes are not promoted to `MEMORY.md`.
- Existing `MEMORY.md` content is not overwritten; new facts are appended under suitable dated sections.
- `note.md` is cleaned only where safe: mark promoted/superseded clusters or add a consolidation index. Do not delete evidence-heavy history unless the deletion is explicitly justified and verified.
- Worktree changes made by others are preserved.

## Scope

In scope:

- `note.md`
- `MEMORY.md`
- `CACHE.md` as context only
- `.agents/skills/rcc-dev-skills/SKILL.md` only if a genuinely reusable workflow lesson emerges
- Current code/docs/tests needed to verify facts

Out of scope:

- Runtime behavior changes
- Architecture rewrites
- New product behavior
- Broad note deletion
- Reformatting all historical memory content
- Pushing commits unless separately requested

## Required Inputs

- Project entry rules: `AGENTS.md`
- User profile: `~/.codex/USER.md`
- Memory routing: `docs/agent-routing/40-task-memory-routing.md`
- Memory skill: `conversation-memory`
- Current state context: `CACHE.md`
- Existing memory truth: `MEMORY.md`
- Raw exploration source: `note.md`

## Execution Principles

- Fact first: a `note.md` line is only a candidate, not truth.
- No fallback: if a fact cannot be verified, record it as unpromoted or stale; do not soften it into a vague memory item.
- Preserve ownership: `MEMORY.md` stores durable project facts; `SKILL.md` stores reusable methods; `note.md` stores raw exploration.
- Append-only memory: do not rewrite historical `MEMORY.md` truth. If a current fact supersedes an older fact, append a new dated correction.
- Minimal edits: only edit `note.md` and `MEMORY.md` for this task unless skill promotion is clearly warranted.
- Dirty worktree safe: inspect `git status --short` first and avoid overwriting unrelated existing changes.

## Technical Plan

### 1. Build a Topic Inventory

Use heading and keyword scans to create a compact inventory:

```bash
rg -n '^#{1,4} ' note.md
rg -n 'Hub Pipeline|Virtual Router|servertool|stopless|direct|Responses|ErrorPolicy|metadata|apply_patch|Windsurf|MiniMax|config.toml|generated|source-map|fallback|hardcode' note.md
```

Group entries by durable themes, for example:

- Hub Pipeline Rust closeout and TS residue deletion
- Virtual Router routing, health, quota, and Rust ownership
- Servertool / stopless / followup lifecycle
- Direct passthrough and Responses continuation
- ErrorPolicyCenter / provider failure classification
- Metadata isolation and pipeline topology
- Provider-specific contracts: Windsurf, MiniMax, DeepSeek, Qwen
- apply_patch and servertool projection behavior
- Generated artifacts, source-map residue, repo root governance
- Build/install/runtime verification baselines

### 2. Deduplicate and Classify

For each topic cluster, classify entries as:

- `verified_current`: still true in current code/docs/tests
- `superseded`: older truth replaced by a later verified state
- `contradicted`: current code disproves it
- `one_off`: useful historical event but not durable memory
- `skill_candidate`: reusable workflow or anti-pattern, not project fact

Record the classification in a temporary working table in `note.md` or a short local scratch under `tmp/`, then promote only final evidence-backed facts.

### 3. Verify Against Current Source

For every `verified_current` candidate, collect at least one hard evidence type:

- Code path with line reference via `rg`, `sed`, or `nl`
- Existing test path proving the invariant
- Commit or git diff evidence for recently changed truth
- Current docs path if docs are the contract source
- Build/test command output for verification gates

Examples of required verification patterns:

- For Hub Pipeline ownership: inspect `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`, TS shell files, and residue gates.
- For servertool/stopless: inspect Rust `servertool-core`, `chat_servertool_orchestration`, TS thin shells, and `verify:servertool-rust-only`.
- For ErrorPolicyCenter: inspect `src/providers/core/runtime/provider-failure-policy-impl.ts`, provider error catalog, Rust health tests, and direct passthrough tests.
- For metadata isolation: inspect topology docs, request/response carrier gates, and provider outbound guards.
- For generated artifacts: inspect `.gitignore`, residue audit tests, source-side artifact scans, and current `git status`.

### 4. Write MEMORY.md Entries

Append concise entries using this shape:

```markdown
## YYYY-MM-DD <topic>

- Verified fact sentence with current owner/path and behavior.
  Evidence: <file/test/command>.
  Tags: <short-tags>
```

Rules:

- Prefer 1-3 bullets per theme.
- Do not paste raw logs or long timelines.
- Include evidence paths, not broad claims.
- If older `MEMORY.md` content is now stale, append a dated correction instead of editing old text.

### 5. Update note.md

After promotion, add a compact consolidation marker near the top or at the relevant theme section:

```markdown
## YYYY-MM-DD note.md consolidation index

- <theme>: promoted to MEMORY.md section `<section title>`; stale entries marked unpromoted where applicable.
- <theme>: no promotion; current code contradicted earlier assumption.
```

Only remove duplicate note chunks if they are pure repeated summaries and the retained entry plus `MEMORY.md` section preserves the evidence. Do not delete raw investigation data needed for future audits without explicit justification.

### 6. Skill Promotion Check

Update `.agents/skills/rcc-dev-skills/SKILL.md` only if the consolidation reveals a reusable method that is:

- repeated across at least two independent incidents,
- action-oriented,
- currently valid,
- not already captured in the skill.

Use the local route template: trigger signal, key judgment, reusable minimal actions, anti-pattern/boundary, verification metric.

## Verification Plan

Required:

```bash
git diff --check
rg -n 'TBD|TODO|待验证|可能|疑似' MEMORY.md
```

The second command may find existing historical content. New `MEMORY.md` entries must not add unverified language.

Recommended:

```bash
git diff -- note.md MEMORY.md .agents/skills/rcc-dev-skills/SKILL.md
```

Topic-specific verification commands depend on promoted facts. Run the smallest relevant gates for each promoted cluster, for example:

- `npm run verify:servertool-rust-only`
- `pnpm run verify:hardcode`
- focused Jest/Rust tests named in existing `MEMORY.md`, `CACHE.md`, or goal docs
- `npx tsc --noEmit --pretty false` when code-facing claims depend on current TS shape

Do not claim full project closure unless the full mapped gates pass.

## Risks and Guards

- Risk: promoting stale note entries from old architecture.
  Guard: verify every candidate against current code before writing memory.
- Risk: duplicating existing `MEMORY.md` facts.
  Guard: search `MEMORY.md` by topic before appending; add only new current-state clarification.
- Risk: losing raw debugging evidence.
  Guard: prefer consolidation markers over deletion.
- Risk: mixing method lessons with project facts.
  Guard: project facts go to `MEMORY.md`; reusable workflow goes to local skill.
- Risk: unrelated dirty changes.
  Guard: inspect `git status --short`; do not revert or overwrite unrelated files.

## Implementation Steps

1. Read `AGENTS.md`, `~/.codex/USER.md`, `CACHE.md`, memory routing, and memory skill.
2. Inspect `git status --short`.
3. Build `note.md` topic inventory from headings and keyword scans.
4. Search `MEMORY.md` for existing entries per topic.
5. For each candidate theme, verify current code/docs/tests.
6. Draft a promotion table: theme, candidate fact, current evidence, destination, decision.
7. Append verified facts to `MEMORY.md`.
8. Add a compact consolidation index to `note.md`; avoid broad deletion.
9. Update local skill only if the promotion check passes.
10. Run verification commands and report changed files, evidence, residual gaps, and next step.

## Done Definition

- `note.md` has a clear consolidation index or safe theme markers.
- `MEMORY.md` has only verified, non-duplicative, dated project facts.
- Any stale/superseded note themes are not promoted as truth.
- Optional skill update is either completed with evidence or explicitly skipped because no new reusable lesson was found.
- Verification commands and evidence paths are reported.
