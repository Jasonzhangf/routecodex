# File Line-Limit Gate (Host)

Host (`routecodex`) enforces a hard line limit for changed code files.

## Rule

- Limit: `< 500` lines per file.
- Scope: changed files in current diff range.
- Trigger: CI `tests` workflow (`verify:file-line-limit`).

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
