# File Line-Limit Gate (Host)

Host (`routecodex`) enforces a line-growth limit for changed code files.

## Rule

- Limit: `< 500` lines per file.
- New files at or above the limit are blocking.
- Existing files at or above the limit remain blocking only when they grow beyond
  their selected base revision; historical over-limit files with no growth emit a
  warning and do not block commit or CI.
- Scope: changed files in current diff range.
- Trigger: CI `tests` workflow (`verify:file-line-limit`).

The base revision is the explicit `--base` value, then
`ROUTECODEX_LINE_LIMIT_BASE`, then the pull request base, then `HEAD~1`.
If the base file cannot be read, the check remains blocking.

## Policy File

- `config/file-line-limit-policy.json`
- Keys:
  - `limit`: max lines
  - `extensions`: checked code suffixes
  - `excludeDirs`: skipped directory prefixes
  - `allowList`: temporary exemptions (exact paths)

## Exemption Process

1. Only use `allowList` for short-lived exceptions.
2. Add a linked `bd --no-db` issue for removal/splitting.
3. Remove exemption in the follow-up PR after refactor lands.

## Local Run

```bash
npm run verify:file-line-limit
```
