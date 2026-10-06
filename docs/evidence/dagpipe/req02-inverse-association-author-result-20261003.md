# REQ02 inverse association dependency: author result

Recorded: 2026-10-04T02:56:51Z.

Status: dependency implementation/development verification PASS; **REQ02 cutover and delivery INCOMPLETE**. This is an author receipt, not independent architecture review or installed-runtime acceptance.

## Bound input

- Worktree: `/Volumes/Intel/playground/routecodex/dagpipe-req02-authorized-20261003`.
- Branch: `codex/dagpipe-req02-authorized-20261003`.
- Baseline HEAD: `de953d36ea731c5afd8ad6e8464e9fa2abac6b02`, with uncommitted candidate changes.
- Exact nine source/test inputs: `.execution/req02-inverse-inputs-r2.sha256`.
- Input manifest SHA256: `2b32a2e90da0536b5bfa3b4bde388c10abe62a51670909a0c817fbf824e01126`.
- Post-run source check: `.execution/req02-inverse-inputs-r2-final-check.log`, actual exit 0.
- Tests use owned `.execution/message-test-home`, retaining the actual Cargo/Rustup homes. No installed-runtime configuration change.

## Implemented behavior

1. Tool normalization records each source declaration's actual canonical destination when it emits that declaration. Namespace children stay nested. Gemini's flattened declarations carry their own destinations. Preserved opaque scalar declaration items also carry data associations without being invented as callable tools.
2. History normalization records each source contribution's actual canonical message destination. The existing configured fold and inserted system prefix remap these associations. Equivalent histories retain aliases; distinct histories retain the profile's `messages -> input` order. No payload or fold policy change.
3. Concrete inverse path operations read/write declared paths and borrow opaque data by its typed record reference. Container construction preserves siblings, null/absence, full command strings and patch text. This primitive does not parse tool business arguments.
4. The Direct tool inverse operation reads current canonical declarations plus opaque sibling values. Anthropic/Gemini inverses use the declared transform ID; model names do not select behavior. Returned declaration associations describe the actual native declarations after projection. This is a library dependency, not the complete request helper or a production caller.
5. File-size recovery physically moved the existing tool identity reader into `field_operator_helpers.rs`, removing its old implementation. The library is 1483 lines; policy was not changed.

## Red and green evidence

| Boundary | Red evidence | Final result |
| --- | --- | --- |
| Tool source associations, public SDK | helper tree `.execution/declaration-red-r2.log`: 0 PASS / 4 FAIL / exit 101, missing declaration provenance | Included in final public run below |
| History source associations, public SDK | `.execution/message-parent-red.log`: 0 PASS / 3 FAIL / exit 101, missing actual source association | Included in final public run below |
| Concrete path creation | consumer tree `.execution/paths-parent-red.log`: 8 PASS / 3 FAIL / exit 101, failed nested container creation | Final operation-runner run includes all 11 tests |
| Opaque declaration inverse | `.execution/direct-tools-parent-red.log`: 4 PASS / 1 FAIL / exit 101, opaque Anthropic item replaced by null | Final operation-runner run includes all 5 tests |
| File-size gate | `.execution/req02-inverse-architecture-ci.log`: exit 1, 1503 > 1500; normal gate and its green fixture failed | Full final architecture run: 40/40 PASS / exit 0 |

Final exact input results:

- `.execution/req02-combined-operation-runner-r2.log`: **67 PASS / 0 FAIL / exit 0**.
- `.execution/req02-inverse-public-r2.log`: **37 PASS / 0 FAIL / exit 0**, across ten public normalization/association/history/namespace/tool suites. The earlier commentary total of 39 was an arithmetic error; the actual logs establish 37.
- `.execution/req02-inverse-architecture-ci-r2.log`: **40/40 sub-gates PASS / exit 0**.
- `git diff --check`: PASS.

Log SHA256:

```text
9c30bf76bbaac5a13581e34f036a1cf15163343aae8a62a416a69344e3be0894  req02-combined-operation-runner-r2.log
d84ce305d568d9b660acfeb9626ee00abea5b77102dcfc915b3d311d135443a2  req02-inverse-public-r2.log
381fe62b50f9fba2d6e9230923f9955d62171445765979d0198779040a391ccd  req02-inverse-architecture-ci-r2.log
```

## Corrections and limits

Four fresh GCM authors were used with exclusive scopes. The declaration draft incorrectly flattened namespace children in its expectations; the path draft confused root aliases with payload containers and initially used a reserved zsh variable; the other two authors returned no implementation. Their processes were stopped by verified exact PID, source/raw failures retained, and bounded fixes completed by the parent. These workers did not provide independent review PASS. Incorrect test fixtures were corrected against the declared contract; original logs/drafts were preserved.

All stopped child PIDs were absent at cleanup. Their six owned `CODEX_HOME` directories, including the earlier helper/consumer a2 homes, were removed and absence checked. The three current worktrees, uncommitted source, raw logs and required test resources remain because this node is unfinished. No unrelated worktree or process was removed.

Remaining required work:

- Complete `project_canonical_request`: current-canonical Direct history/field view and standard Outbound's actual emitted-attempt declaration association.
- Replace the actual REQ02 caller and consume successful-attempt response metadata, after the isolated complete helper/consumer tests pass.
- Actual GCM `gpt-5.5` and `gpt-5.6` exec/apply_patch/MCP execution, result return and follow-up through the candidate server. Fixture model strings and the tests above do not prove those flows.
- Applicable candidate build/install, **4444 restart**, live replay/sample audit, independent architecture review, commit/merge/push/remote receipt and complete resource cleanup.

REQ03 has not started. Production 4444 was not installed, restarted, stopped or killed by this run. The externally owned REQ06 tree was only read; no public helper was present in that observed tree.
