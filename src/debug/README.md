# Debug Toolkit

## Purpose
Debug toolkit provides snapshot, dry-run, and replay capabilities for offline testing and inspection. Does not modify Hub Pipeline behavior.

## Components
```
src/debug/
├── index.ts                 # createDebugToolkit() entry
├── types.ts                 # snapshot/session types
├── snapshot-store.ts        # JSONL snapshot storage
├── session-manager.ts       # debug session lifecycle
├── harness-registry.ts      # harness registration
├── harnesses/
│   └── provider-harness.ts  # provider-layer dry-run
├── dry-runner.ts            # dry-run controller
└── replay-runner.ts         # snapshot replay
```

## Core Concepts
- **DebugSession**: Single debug session
- **NodeSnapshot**: Node-level snapshot (request/response payload)
- **ExecutionHarness**: Provider/compat node runner

## Usage
```bash
npm run snapshot:inspect -- --rid <RID>
```
Fast snapshots are stored in `~/.routecodex/codex-samples/`.

## Policy Violations Folder

When Unified Hub Framework policy snapshots (`hub_policy.*`) detect violations, they are additionally copied to:

- `~/.routecodex/codex-samples/__policy_violations__/`
- `~/.routecodex/errorsamples/policy/`

This keeps normal snapshot traffic intact while making these cases easy to monitor:

- observe-mode violations (`violations[]` / `summary.totalViolations > 0`)
- enforce-mode outbound rewrites (`removedTopLevelKeys[]` / `flattenedWrappers[]`)

Quick report:
```bash
npm run policy:report
```

## Do / Don't
**Do**
- Use for inspection, replay, and offline testing
- Record snapshots for troubleshooting
- Keep separate from production path

**Don't**
- Modify Hub Pipeline behavior
- Intercept or alter real requests
- Store sensitive data in repos
