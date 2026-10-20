# 809a54f reasoning-block preservation repair

Status: local candidate only. This result is not delivery. Do not infer an
install, restart, replay, merge, or push from this file.

Branch: `codex/p0-anthropic-reasoning-r2-20261020`

Base: `44d1b101b`

## Finding and repair

The independent milestone Review found that a canonical assistant message with
mixed reasoning blocks retained only the block carrying an Anthropic provider
extension. When a mixed canonical message contained one extension-free block
and one extended block, the extension-free block disappeared from the next
provider request.

The unique owner is the Anthropic reasoning carrier and projection:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec/reasoning_projection.rs`

The repair creates an ordered `anthropic_reasoning_blocks` record for every
reasoning item that joins the canonical message. Each record carries:

- native block type (`thinking` or `redacted_thinking`)
- plaintext `reasoning_content`
- optional `encrypted_content`
- optional `anthropic_reasoning` provider extension

The projection accepts records without a provider extension and restores the
native block type and payload before the provider wire. It does not invent a
rejection, drop business payload, or convert a provider response into a local
client error.

The stale `note.md` entry now describes per-item ordered records and append-only
block association. It no longer claims recursive carrier merging or that
redacted reasoning is limited to codec-level coverage.

## Red-first evidence

Red evidence was collected before the production patch. The raw pre-fix runner
logs were not retained; the recorded summary is at
`.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/00-red-first-summary.md`.

Canonical command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib responses_mixed_reasoning_blocks_keep_complete_ordered_records_in_both_orders -- --nocapture
```

Exit code: `101`. The extension-free `thinking` record was absent; only the
extension-bearing `redacted_thinking` record remained.

Public `/v1/responses` command:

```text
CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test multi_listener_server responses_client_anthropic_mixed_reasoning_blocks_keep_both_orders_and_paired_tool_result -- --exact --nocapture --test-threads=1
```

Exit code: `101`. The captured second provider wire contained
`[redacted_thinking(redacted-encrypted), text(""), tool_use(...)]` and omitted
the extension-free `thinking("plain reasoning", signature="plain-signature")`
block.

## Green evidence

All paths below are relative to this worktree.

| Check | Exact command | Exit | Evidence |
| --- | --- | ---: | --- |
| Canonical focused regression | `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib responses_mixed_reasoning_blocks_keep_complete_ordered_records_in_both_orders -- --nocapture` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/10-focused-canonical-green.log` |
| Public `/v1/responses` regression | `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test multi_listener_server responses_client_anthropic_mixed_reasoning_blocks_keep_both_orders_and_paired_tool_result -- --exact --nocapture --test-threads=1` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/11-focused-public-green.log` |
| Anthropic characterization tests | `CARGO_NET_OFFLINE=true npm --prefix v3 run test:v3-anthropic-codec-characterization` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/01-anthropic-codec-characterization.log` |
| Anthropic characterization verifier | `npm run verify:v3-anthropic-codec-characterization` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/12-verify-anthropic-codec-characterization.log` |
| Anthropic provider-wire integration | `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --test responses_relay_anthropic_provider_wire_integration -- --nocapture` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/02-anthropic-provider-wire-integration.log` |
| Public Anthropic server tests | `CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test multi_listener_server responses_client_anthropic_ -- --nocapture --test-threads=1` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/03-public-anthropic-server.log` |
| Protocol field-parity verifier | `npm --prefix v3 run verify:v3-protocol-conversion-field-parity` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/04-verify-protocol-conversion-field-parity.log` |
| Protocol field-parity red fixtures | `CARGO_NET_OFFLINE=true npm --prefix v3 run test:v3-protocol-conversion-field-parity-red-fixtures` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/05-protocol-conversion-field-parity-red-fixtures.log` |
| Full protocol field-parity suite | `CARGO_NET_OFFLINE=true npm --prefix v3 run test:v3-protocol-conversion-field-parity` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/09-test-protocol-conversion-field-parity.log` |
| Resource map | `npm --prefix v3 run verify:v3-resource-map` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/07-verify-v3-resource-map.log` |
| Module boundaries | `npm --prefix v3 run verify:v3-module-boundaries` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/08-verify-v3-module-boundaries.log` |
| V3 architecture CI | `npm --prefix v3 run verify:v3-architecture-ci` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/06-verify-v3-architecture-ci.log` |
| Cargo formatting | `npm --prefix v3 run verify:v3-cargo-fmt` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/13-verify-cargo-fmt.log` |
| Diff whitespace check | `git diff --check` | 0 | `.agent-collab/runs/20261020T140000Z-Macstudio.local-809a54f-reasoning-r2/evidence/14-git-diff-check.log` |

The characterization suite reported `94 passed`; provider-wire integration
reported `19 passed`; public Anthropic server tests reported `5 passed`; the
full field-parity suite passed all of its component test groups; architecture
CI reported `35/35 sub-gates green`.

The public regression covers both `plain-first` and `extended-first` input
orders. It asserts the complete ordered reasoning sequence and the paired
`tool_use` with name/arguments plus the following `tool_result` with output
`42` on the captured second provider wire.

## Scope and boundaries

Changed paths:

- `v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec/reasoning_projection.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs`
- `v3/crates/routecodex-v3-runtime/src/hub_v1/responses_openai_codec_extra_tests.rs`
- `v3/crates/routecodex-v3-server/tests/multi_listener_server.rs`
- `docs/architecture/v3-verification-map.yml`
- `note.md`

Not performed: install, restart, live replay, merge, or push. Shared main and
other worktrees were not touched. The worktree remains the candidate handoff
until the local commit is inspected.

Working-directory note: the root package owns
`verify:v3-anthropic-codec-characterization`. Running that script through
`npm --prefix v3` from the repository root resolves `v3/v3/...` and exits 1;
the successful command above uses the root package entry point.
