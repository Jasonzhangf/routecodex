# REQ02 inverse dependencies on current main

Status: dependency author verification passed; REQ02 cutover/delivery **INCOMPLETE**.

## Candidate

- Active candidate worktree: `/Volumes/Intel/playground/routecodex/req02-main322-20261004`.
- Branch: `codex/req02-main322-20261004`.
- Baseline HEAD: `73083890f6bb86635a50526f263b98349b338efd` with uncommitted candidate changes. HEAD alone is not the candidate content.
- Complete source/map/test manifest: `.execution/main322-candidate-inputs.sha256` (SHA256 `047e14ee46e96b48816f4bb536265517321d05bf5e2d5c436b526a6bcf833334`).
- Focused inverse inputs: `.execution/main322-inverse-inputs.sha256`. Its ten entries were checked successfully after the runs. The complete manifest additionally includes the updated mixed-history test and graph/profile inputs.
- Import artifacts from the preserved prior candidate: `.execution/main322-import.patch` and `.execution/main322-untracked.tar` in the prior authorized tree. Hashes respectively `2dd51893aa5360353cdcb196a99e901ed9f7dfe41b2d13fe080f5694aa28e0d4` and `0eedad5d998ade37deb1d3e8b6494bd91896c7685bf43daf12cf920736df67a2`.

## Implementation

1. New private `project_canonical_fields` reverses mapped non-history/non-tool fields from the **current** canonical data. It preserves explicit null, honors mapped removals, reads unmapped sibling references and reverses registered boolean/tool-choice mappings. It is a dependency, not the complete request projector or a production caller.
2. The unique inbound producers now record previously missing associations: Anthropic parallel-tool boolean, Gemini safety extension, unknown Gemini generation fields and literal unknown top-level keys. Current opaque extension values are consumed through their actual paths; removing a current field does not resurrect its original value.
3. The shared concrete path primitive supports JSON-quoted literal keys. Literal dots/brackets/escaped quotes in a business key are preserved. Neither commands nor tool arguments are parsed.
4. The unique system-instruction producer returns its actual emitted index. `finish` finalizes registered instruction source aliases at that index after existing history remap. No protocol-name selection or downstream search for a first system message was introduced.
5. Moved the existing known-container method from the main library into its existing records module, removing the old definition. The formatted main library is 1492 lines; no file-size policy waiver.

## Main combination

Three-way import initially exited 1 with two conflicts; raw evidence is `.execution/main322-threeway.log` and `.exit`. Integration was stopped and the conflicts inspected.

- Retained current main's removal of the old ModelNotFound client-error projection in `responses_relay_dry_run.rs`. The old branch was not restored.
- Kept current main's server-boundary authorization records and the user's separate REQ02 resident-caller authorization in the audit-lock ledger.

Conflict resolutions are candidate changes. There are no unmerged index entries and `git diff --check` passes. No main merge/push or runtime installation was performed.

## Red and green

- Prior authorized tree `.execution/direct-fields-red-r2.log`: 4 PASS / 4 FAIL / exit 101. Missing current-value associations and field-removal restoration were reproduced.
- `.execution/direct-fields-paths-red-r3.log` there: 22 PASS / 4 FAIL / exit 101, including literal-key and actual dotted extension-path failures.
- `.execution/direct-fields-paths-green.log` there: 26 PASS / 0 FAIL / exit 0 for private field/path/tool dependencies.
- Instruction author's tree `.execution/req02-instruction-source-red.log`: 0 PASS / 4 FAIL / exit 101 on provenance destinations after graph dependency refresh; canonical payload assertions already passed. `.execution/req02-instruction-source-green.log`: 4 PASS / exit 0.
- Combined candidate `.execution/main322-operation-final.log`: **77 PASS / 0 FAIL / exit 0**. Log SHA256 `1d39cda5f7a64eebe2dfeb286fdc2a2df1223944477db46f2654afbb5df76987`.
- First combined final public run exited 101 because the older mixed-history test expected a symbolic role-selector destination. Its raw failure remains `.execution/main322-public-final.log`. Corrected that test to assert the exact content destination and both concrete shifted history associations; payload behavior unchanged.
- `.execution/main322-public-final-r2.log`: **45 PASS / 0 FAIL / exit 0**, across twelve public SDK suites using `--no-fail-fast`. Log SHA256 `5fd2d0835ff78a2fe9929af92c39e2649c0eaa31483ce304ce59d4c42ff76826`.
- `.execution/main322-operation-gate.log`: operation-runner topology/config gate PASS / exit 0.
- Full architecture gate completed: `.execution/main322-architecture.log` reports **40/40 sub-gates green**, `.execution/main322-architecture.exit` is **0**. The complete candidate input manifest was checked after the gate, with every entry OK. This is automated architecture-gate evidence; independent implementation review and runtime acceptance remain incomplete.

Public SDK tests prove normalization and published association behavior. They do not prove the complete request inverse helper, actual new runtime caller, GCM execution or live provider behavior.

## Workers and resources

Fresh GCM implementation workers ran with exclusive scopes. The broad history draft introduced protocol-name preference, first-system-message inference and new refusal paths; it was rejected and preserved under the history tree's `.execution/rejected-project_canonical_history.rs`. It is not present in this candidate. One public author returned no edits; a fresh narrowed task completed the declaration-shape mutation and exact Gemini assertion edits. That consumer draft still cannot compile without the complete public projection helper.

The instruction worker completed its bounded red/green task. Parent integrated only its minimal producer/finish changes, using exact registered operator IDs. The parent's separate boolean-profile fix was preserved.

All these child processes completed or were stopped by the verified owned PID. Four owned CODEX_HOME directories were removed and absence verified. The new public worker's draft, raw logs and result were moved into this candidate's `.execution/public-consumer-author/`; its clean worktree was removed without force, and both filesystem and Git worktree registry absence were verified. The active combined candidate, prior dirty candidate and instruction evidence tree remain in use. No unrelated resource was removed.

## Remaining

Complete the full current-canonical Direct history/field view and the standard Outbound owner's actual attempt-declaration association. Then compile/run the real public projection consumer, replace the actual REQ02 caller and successful-attempt response consumer, and perform candidate-bound gpt-5.5/gpt-5.6 exec/apply_patch/MCP execution plus follow-up. Applicable build/install/restart/live replay, independent architecture review, commit/merge/push/remote receipt and final cleanup are still required. REQ03 has not started. 4444 was not installed, restarted, stopped or killed.
