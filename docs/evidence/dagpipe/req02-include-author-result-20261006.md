# REQ02 registered include boundary: author acceptance r143

Status: author validation complete for this boundary repair. Final independent
architecture review, clean candidate commit binding, CI, merge, remote receipt,
and post-merge source/runtime verification are pending. REQ02 is not delivered.

## Exact input and owner

Base commit a6e33d85b8b7e0efb84f4dd403e8235d6303ad49 includes the existing
REQ02 caller replacement and provider-management prerequisite. Latest fetched
origin/main was 459004b113d31f79d818992509c1a1fb17639b66.
The tested staged tree before this evidence-only document was
20c74c25db476ab5b99bb09fc13525ffd8ceeceb. Full patch SHA256:
242f4897b8122e03cfd8f85c3cd299bc3ab2b9037c8e2017455d832c6ecd53cd.
This is an uncommitted source candidate, not a clean repaired commit.

Only project_canonical_fields.rs and field_operator_profiles.rs change runtime
behavior. The existing shared canonical-to-standard working-view owner now
consumes the registered ResponsesIncludeTransform chat_to_provider binding.
Source/destination paths come from the compiled profile. The current canonical
value is materialized into a working clone; only its consumed contribution and
empty containers are removed. Canonical/original pair and inverse association
remain unchanged. Existing explicit standard Outbound filtering owns unsupported
output selectors. REQ06's separately assigned operator was not edited.

The admitted design was independently reviewed in r133b (oauth/gpt-6.1-sol,
completed/passed, exit 0); it is docs/design/v3-req02-responses-include-projection.md.

## Author tests and causal experiment

RUN is /Volumes/Intel/playground/routecodex/.worker-runs/dagpipe-parallel-foundation-20261005.
Unless named otherwise, logs and exit files are under
RUN/req02-include-integration-r137.

| Public behavior | Evidence | Result |
| --- | --- | --- |
| Four target standard include projections | fixed-after-reverse-r141.log/.exit | 3 cases PASS, exit 0 |
| Current mutation/removal, canonical immutability, Direct inverse, unrelated opaque siblings, malformed selector passage | current-inverse-final-host.log/.exit | 5 PASS, exit 0 |
| Real Server HTTP JSON/SSE exec/patch/MCP identity, complete arguments/results, follow-up and disconnect isolation | http-tools-host.log/.exit | 7 PASS, exit 0 |
| Real Server WebSocket Relay and typed Direct handoff | ws-host-r143.log/.exit | 2 PASS, exit 0 |

Removing only the runtime source repair reproduced the original four-target
boundary failure: source-reverse-red.exit 101. Restoring that exact source patch
completed with source-reverse-restore.exit 0. The unchanged public fixture then
passed in fixed-after-reverse-r141. No provider routing/config/network condition
was changed for this experiment.

Worker development tests: operation_runner 150 PASS and field_operator 25 PASS
in received-req02-include-owner-r135/records. These supplement public consumers.
Architecture static gate architecture-host-r139 exited 0, 43/43 sub-gates green.
The composed original mutation suites retain all cases: Anthropic 12, H1 11,
Provider action 60, Relay 5, each exit 0 in *-fixtures-composed-r141.log/.exit.
Static gates are not runtime or independent review evidence.

## Installed isolated runtime

Official copy-cli-bin builder: build-r141.log/.exit, exit 0, version 0.90.4839.
CLI SHA256 bdfb2dfc97d0ed27c7beb2a70a63fd0102a9b3b159c0a26009b5eca82222dee2;
hooks SHA256 fe6b9947dfe46d4a5c372e26ea66898abe3b306955a93fc05bce9e19bf5c6186.
Stable candidate binaries were atomically installed and byte-compared with the
signed build artifacts. installed-r142.sha256 records them. The runtime HOME
alias resolves to /Volumes/extension/.rcc.

Initial restart command's unsupported --port option failed at CLI parsing
before any lifecycle operation; restart-r142.log/.exit retains that exit 2.
The installed V3 help and original effective command were then used:
rccv3 restart -c RUN/gcm-acceptance-prep/isolated-candidate-config/config.toml
--snapall --debug, with ROUTECODEX_V3_ADMIN_BIND=127.0.0.1:45560.
restart-r142-corrected.log/.exit records control acceptance, exec replacement,
and running completion, exit 0. Instance v3-64cbe5e69c7c944e9b95 retains PID
49587 via exec. Listener 45559 health reports 0.90.4839. Loaded-image sampling
is retained in loaded-image-r142.sample/.log. These observations together bind
the loaded artifact; health alone does not prove behavior. Production 4444
was not installed, restarted, stopped, or killed.

## Actual GCM tools and bound histories

Fresh gcm consumers ran concurrently against http://127.0.0.1:45559/v1 from
separate source copies of the exact frozen repair. Parent HEAD a6e is the base
anchor in the harness; the source delta/tree above is part of its source binding.
The two worktrees were not clean repaired commits. Final commit/source and
artifact equivalence must be checked before delivery.

| Model | Thread | Evidence | Result |
| --- | --- | --- | --- |
| gpt-5.5 | 01a11380-85fb-7750-aa02-0fd510c2a8be | RUN/req02-gcm55-r143 | harness PASS, child exit 0, 7 bound requests |
| gpt-5.6 | 01a11380-86c6-7eb2-adf8-a9651f8b9a08 | RUN/req02-gcm56-r143 | harness PASS, child exit 0, 6 bound requests |

Both summaries prove actual command execution, native file_change Add/Update
receipts, exact marker content/bytes/hash, real MCP environment_read with exact
arguments and structured observations, result return, subsequent model
consumption, complete bound tool history, and no unrelated worktree edits.
gpt-5.5 declares native custom apply_patch. gpt-5.6 has no native apply_patch
declaration in this request and uses exec_command with an exact apply_patch
heredoc; native file_change receipts and complete patch text are verified.
The consumer derives that acceptance from actual declarations, not model-name
guessing. No runtime or test acceptance rule was changed for this run.

Raw request/provider-request/provider-response/response files are bound by
the sample-binding reports. raw-sample-audit-r143.json records the post-restart
audit. HTTP 200 or requires_action alone was not used as acceptance.

## Integration boundary

The CI fixture/verifier maintenance repairs stale owner anchors and copied
include fragments, with original forbidden mutation guarantees retained.
The already reviewed Gemini fixture/evidence delta from PR367 is included in
this source candidate. PR367's later Chat fixture-only correction is separate;
latest-main composition must account for it before final integration.

No final architecture PASS, new REQ02 commit, merge, push, or node delivery is
claimed by this author record. Resource cleanup remains pending until acceptance.
