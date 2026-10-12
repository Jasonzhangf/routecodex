# Magpie live HTTP matrix: P1 evidence

This delivery adds test infrastructure only. It does not change runtime Rust,
the fixed skeleton, production configuration, credentials or installed services.
Magpie reference: `yetone/magpie`, MIT, commit
`bfaedf18301d02a423bd5422d22e41432d231ab8`.

The corpus has 48 cases: all 16 protocol pairs and 32 base JSON/SSE variants,
plus tool/history, media, reasoning, usage, field and failure boundaries.

## Versioned evidence

| Evidence | Runtime | Result and interpretation |
| --- | --- | --- |
| [Initial matrix (gzip JSON)](installed-baseline-20261012/baseline-report.json.gz) | Installed 0.90.4886 | 48 executed, 12 strict passes, 36 strict mismatches, zero infrastructure failures or not-run cases. All 48 owned instances cleaned up. |
| [Configuration delta](delta-replay-20261012/README.md) | Installed 0.90.4887 | Explicit same-tier recovery uses two different declared identities and passes. Ordinary Chat passes. Echo executes once and its actual ID/output reaches the second real request; remaining projection mismatches are retained. |
| [Exhaustion correction](g4-fault-integrate-20261012/result.md) | Installed 0.90.4887 | One real POST with wire model `unavailable-model`, scripted 429, empty client close; passes after separating parser diagnostics from actual payload observations. |
| [Oracle corrections](oracle-corrections-20261012/receipt.json) | Installed 0.90.4887 | Seven affected replays: six pass, one retained failure. Independent counterexamples still reject lost text, metadata, roles, signatures, media, arguments and IDs. |
| [Native echo control](native-echo-control-20261012/control-receipt.json) | Installed 0.90.4887 | Actual declared echo executes once; actual call ID and computed output appear in the second provider POST; client completes. Owned process, both listeners, mock and state cleaned up. |
| [History oracle correction](review-corrections-20261012/media-history/README.md) | Installed 0.90.4887 | Complete role/order and tool-result pairing assertions accept the preserved six-message history. The affected real HTTP replay passes; lost/reordered assistant history and incorrect tool IDs fail the independent controls. |

The initial raw report is immutable and archived losslessly as deterministic
gzip (`gzip -n -9`). Decompress with `gzip -dc
docs/reports/magpie-live-matrix/installed-baseline-20261012/baseline-report.json.gz`.
The decompressed JSON SHA-256 is
`bd874c09cc3146f59206c34845fefbe6d78f793373d59257dd8ac5601bfe1e91`.
Its 187 assertion mismatches are not 187
defects, and its 36 failed cases are not 36 confirmed operator bugs. Some
differences were legitimate representations or harness defects. Later results
use revised fixtures/helpers and a newer installed binary; they do not replace
the initial counts or establish a single new aggregate matrix count.

The runner source began at `88715b2fe` and the final candidate combines
`f7fc9e17b`. These Git revisions describe source, not installed-binary provenance.
Each replay records its own binary version/hash, configuration, provider captures,
client bytes and cleanup. Absolute paths in raw receipts identify the original
run locations; adjacent archived files preserve the evidence.

## Remaining P2 observations

Gemini ingress/target projection, Anthropic-to-Chat unmapped fields, some response
and SSE projections, and full namespace/history semantics remain candidates for
P2 investigation. The namespace case mixes an empty client response with a
request/mock stream-format difference; no root cause is claimed. Image bytes
alone do not prove preserved role, order or tool-result meaning. A flat Responses
`output_text` output item is not accepted as a valid message to make tests pass.

Runtime operators are intentionally not repaired in P1. The overall plan defines
the next operator/configuration phase without changing architecture ownership.

## Reproduce

From the repository root, run `npm run test:protocol-live-mock-support` for all
discovered helper test files. Run `npm run run:v3-protocol-live-mock-matrix -- --binary
/absolute/path/to/rccv3 --evidence /absolute/owned/output --report-path
/absolute/owned/output/baseline.md` for the explicit live matrix. `--case <id>`
selects an affected replay. Live product mismatches return nonzero and remain
visible; they do not weaken the author tests or CI gate.

The native control script accepts `--repo` and `--binary` arguments. It uses
owned loopback endpoints and fake credentials. It never uses an existing Admin
listener or invokes a real provider account.
