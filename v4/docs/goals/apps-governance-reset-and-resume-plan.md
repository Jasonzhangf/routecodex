# AppSDK governance reset and resume

## Scope

`v4/` is the project root. The reset is performed only in a clean owner
worktree from `origin/main`; business source, `protected/`, other worktrees,
and Collab v1 state remain outside the reset boundary.

## Ordered gates

1. Inspect and snapshot AppSDK and Collab state.
2. Run the official `appsdk reset-governance <root> --discard-legacy` once;
   record any SDK failure and do not invent lifecycle records.
3. Re-run the same command to check idempotence.
4. Run `appsdk prepare`, confirm the project scope, then `appsdk init`.
5. Pin the installed SDK with `appsdk pin-lock`, bind the confirmed goal and
   project module/maps, then run `appsdk verify` and `appsdk compile`.

## Safety

Only `.appsdk/`, `.appsdk-control/`, `generated/`, and `active/` are reset.
No source, Protected artifact, historical Collab evidence, claim, daemon, or
unrelated process is taken over. Failed official operations remain evidence;
records are never hand-forged.
