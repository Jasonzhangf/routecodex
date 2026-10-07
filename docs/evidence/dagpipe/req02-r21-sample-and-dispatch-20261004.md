# REQ02 r21 sample audit and bounded parallel work

## Input and verified layer

- Active integration tree: `req02-main338-combined-r20-20261004`.
- HEAD/base: `f1204ab19f10d84da8558c846990258dd20575d8` plus uncommitted candidate; HEAD does not identify the complete candidate.
- Fetch at 2026-10-05T01:40Z confirmed unchanged `origin/main`.
- REQ02 remains INCOMPLETE. Implementation architecture review, candidate install/restart, two-model real tool consumer, integration and resource closeout remain open.

## Saved sample

Runtime process HOME-derived store is `$HOME/.rcc`, linked to `/Volumes/extension/.rcc`. Inspected sample:

`codex-samples/openai-responses/ports/55341/openai-responses-router-gateway.glm-5.3-20261004T181845421-1-1/`.

`request.json` contains model `gateway.glm-5.3`, stream/input/tools and a native `web_search` declaration alongside exec/write_stdin/MCP functions. `error.json` records status502 and the six-node Error chain. `provider-terminal.json` records `kind: no_response`. No provider-request artifact was present in the prior directory audit. File absence does not establish any stage success.

These sample facts complement the preserved real HTTP blackbox: the fixture panics because `web_search_20250305` is missing from the provider-bound tools. The later502 alone does not identify a network root cause. The existing single-variable forward/reverse experiment binds the first divergence to the Anthropic branch borrowing Responses capability filtering. Product repair must use the actual Anthropic emission owner, not a fixed capability override.

## Direct completed diagnosis

The read-only GCM result and notes are frozen in `req02-direct-request-r12-20261004/.execution/direct-emission-r20-{result,notes}.md`; original process receipt is exit0. The current Direct mapping is produced before Provider wire namespace flattening. Actual tools can therefore differ from that mapping. The existing `flatten_namespace_tool_for_provider_with_sources` returns child/destination indices during emission. Its owner must be the standard Outbound or registered Direct hook, with Provider wire remaining transport-only for this concern.

Successful attempt publication must follow the existing shared decoder/compat/terminal admission, then create the mandatory same-handle view and run inverse once. Neither HTTP200 nor chunk EOF is sufficient for publication.

## New dispatch and ownership

Fresh GCM design binding worker: `req02-direct-bindings-main338-r21-20261004`, branch `codex/req02-direct-bindings-main338-r21-20261004`, same baseSHA. Parent frozen tracked patch and source-only untracked archive imported without conflicts; `import.exit=0`, diff check passed. Task contract is `.execution/worker-task.md`. Session4378 and isolated `/tmp/codex-worker-home/req02-direct-bindings-r21-20261004` belong to this goal. Logs/exit live in the active parent `.execution/direct-bindings-r21.*`.

Worker may change only the four affected maps, existing request/response graph bindings when needed, bounded design addendum and its notes/result. Product code is forbidden before precise bindings and independent design admission. Other four active GCM writers/diagnosis retain their scopes; their unfinished drafts are not imported.

The parent owns eventual archive and normal removal of this tree/home after acceptance or cancellation. Active worktrees and original failure evidence remain preserved. Shared dirty root and port4444 are unchanged.
