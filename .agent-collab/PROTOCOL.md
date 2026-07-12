# RouteCodex Agent Collaboration Protocol

## Purpose

`.agent-collab/` is the project-local truth surface for black-box multi-worker coordination in RouteCodex. Workers do not share memory, tool state, process state, or a reliable control plane. Coordination is only based on files in this directory.

This protocol is governance-only. It must not change provider, Hub Pipeline, Virtual Router, restart/install, live server, request, response, metadata, or error runtime behavior.

## Tracked And Ignored Files

Tracked authoring contract:

- `PROTOCOL.md`
- `schema/*.schema.json`
- `examples/*`

Ignored runtime state:

- `runs/<run_id>/actor.json`
- `runs/<run_id>/heartbeat.json`
- `runs/<run_id>/events.jsonl`
- `runs/<run_id>/evidence.jsonl`
- `claims/<semantic_id>/owner.json`
- `handoff/`
- `merge-queue/`
- `KILL_SWITCH`

## Run Identity

Every execution round must create a `run_id` before writing code, changing config, running long gates, committing, or preparing merge handoff.

Recommended `run_id` format:

```text
<UTC timestamp>-<host>-<pid>-<random>
```

`worker_id` is optional and must not be required for correctness. The factual identity is `run_id`.

## Start-Of-Run View

Before code/config edits, long gates, commits, or merge handoff, refresh the collaboration view:

- Read active `runs/*/heartbeat.json`.
- Read `claims/*/owner.json`.
- Read recent `runs/*/events.jsonl`.
- Check `handoff/`, `merge-queue/`, and `KILL_SWITCH`.

If `.agent-collab/` is missing, low-risk single-worker work may continue, but the worker must not claim multi-worker collaboration is controlled.

## Semantic Claims

Claims bind semantic ownership, not raw file paths. RouteCodex claim IDs should prefer:

- `feature_id:<id>`
- `resource_id:<id>`
- `mainline_node_id:<id>`
- `gate_id:<id>`

Acquire a claim with atomic directory creation:

```sh
mkdir .agent-collab/claims/<semantic_id>
```

The run that successfully creates the directory writes `owner.json`. If the directory already exists, read `owner.json` and avoid the claim, wait, choose a non-conflicting task, or write a handoff request. Do not edit another run's semantic owner path.

File paths may appear in `allowed_paths`, but paths are not ownership identity.

## Run Files

Each worker writes only under its own `runs/<run_id>/` directory except for claim directories it owns.

Required per-run files:

- `actor.json`: run identity and worktree facts.
- `heartbeat.json`: current status and update time.
- `events.jsonl`: append-only progress events.
- `evidence.jsonl`: append-only verification evidence.

Shared JSON state must not be edited by multiple black-box workers. Shared progress uses append-only files or owner-only claim files.

## Heartbeat And Stale Claims

Heartbeat timeout only means `stale`. A stale heartbeat is not automatic takeover permission.

Stale heartbeat does not authorize high-risk takeover of production writes, deletes, migrations, releases, auth, secrets, payment-related work, global install mutation, or live runtime mutation. High-risk takeover needs explicit Jason approval or a separate checked handoff decision.

## Evidence And Completion

A completion claim is invalid without `evidence.jsonl`.

Each evidence record must include `run_id`, `claim`, `command_or_check`, `result`, and `timestamp`. Evidence must identify the check that was actually run and whether it passed, failed, or was blocked.

## Handoff And Merge Queue

Cross-worker integration defaults to `handoff/` or `merge-queue/`.

Implementers should write a handoff or merge-queue item with claim ID, changed scope, required gates, and evidence references. A checker should verify scope, unrelated dirty work, required gates, and evidence before merge when feasible.

## Forbidden Patterns

- Do not claim by raw file path only.
- Do not use stale heartbeat as automatic takeover permission.
- Do not use broad process-kill commands.
- Do not use destructive git cleanup such as broad checkout or reset.
- Do not overwrite unrelated dirty worktree changes.
- Do not claim completion without `evidence.jsonl`.
- Do not treat fallback, skipped gates, or silent success as valid evidence.
- Do not put secrets, live credentials, provider payloads, client payloads, request/response metadata, or runtime state in tracked protocol/schema/example files.
