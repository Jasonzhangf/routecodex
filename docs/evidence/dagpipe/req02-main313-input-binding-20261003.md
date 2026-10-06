# REQ02 main313 combination provenance

## Inputs

- New upstream/worktree HEAD: `50ba5e540869f4021d40e884dcf629b9e59ffc95` (PR #313).
- Original task-owned dirty candidate: `/Volumes/Intel/playground/routecodex/dagpipe-req02-cutover-20261002`, HEAD `a9952cc748f417caa675025f20ae1e51323d0c79`.
- Snapshot base for the original task delta: `2fde74987ed8079c36961bd7bb0c8c07348cb4b9`.
- Tracked patch SHA-256: `11e8d5577bae941873c0befbef6d1cc7df94fe358f3ae3776697d65fb84284dd`.
- Untracked source/tests/docs archive SHA-256: `b15bd93828ad0fd398551c795f5c4d6a6f60b401b793415203e433681371dce6`.
- Both snapshots remain under the original tree's `.execution/main313-combination/`; no original dirty file was reverted or deleted.

The new tree is based on the new upstream HEAD and imports the task delta via
Git three-way application. Import exited 0; no unmerged entries remained.
`.execution/parent-threeway-import.log` records every tracked file application.
The untracked archive was then extracted, preserving source/test/document bytes.
This is a dirty author candidate: its HEAD alone does not identify the full source
and must not be presented as a frozen candidate SHA or installed runtime proof.

## Upstream preservation check

After import, `git diff --name-only HEAD --` was empty for the following upstream
terminal owners and real-entry regressions:

- `v3/crates/routecodex-v3-server/src/endpoint_handlers.rs`
- `v3/crates/routecodex-v3-server/src/frame_builders.rs`
- `v3/crates/routecodex-v3-server/src/live_snapshot.rs`
- `v3/crates/routecodex-v3-server/src/websocket.rs`
- `v3/crates/routecodex-v3-cli/tests/h2_chat_direct_isolation.rs`
- `v3/crates/routecodex-v3-server/tests/multi_listener_server.rs`

The overlapping Server unit fixture file retains upstream terminal assertions;
the task delta only adds the necessary `request_finalizer: None` fixture fields.
The overlapping runtime failure owner retains upstream evidence-only status
comment and adds the same carrier fields. The combined design retains upstream
`client_transport_break` disposition plus the existing REQ02 resource amendment.
Textual preservation is not behavioral acceptance; new author terminal tests are
recorded separately.

## Evidence reuse and remaining dependency

The normalization library and request-context store compare byte-identical to
the original candidate. Current SHA-256 values:

- `field_operator_library.rs`: `499de581bb5dfbaa8d2bf6bca46b4b012f485f6ed60f880c9585d70f9d0d2fa6`.
- `request_context_store.rs`: `b1fce25bd34f8a047df6cbe00520837bcd6e1bb51672dffbb99523a383bae7ba`.

Earlier `.execution/...` references in copied notes/evidence resolve to the
**original task tree** unless a record explicitly supplies a new-tree path.
They remain retained there; import did not copy its 70 MiB raw execution ledger.
Old provider HTTP status passthrough acceptance is invalidated by PR #313.
Unchanged normalization evidence may be reused only for its proven boundary;
it does not prove the unconnected REQ02 caller, new terminal behavior or live tools.

External REQ06 was inspected read-only at HEAD `405e0c70a98e525562362c7d5637d9b1c78a7443`
with 12 tracked dirty files. Its required `project_canonical_request(...) -> ProjectedRequest`
boundary is still absent, and its current Direct branch reads a full business
request from `direct_native_request` control storage. No source from that external
candidate was imported. The provider-action manual lock refresh remains pending
the already-requested explicit authorization; no audit lock was changed.

No install, 4444 restart, implementation review, commit, merge or push is claimed.
