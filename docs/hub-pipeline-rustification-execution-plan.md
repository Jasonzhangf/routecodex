# Hub Pipeline Rustification Execution Plan

## Objective

Complete the rustification closeout of Hub Pipeline so that `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/` becomes the only semantic source of truth for Hub request/response processing, tool governance, and servertool followup orchestration.

## Hard Constraints

- The only allowed runtime path is `HTTP server -> llmswitch-core Hub Pipeline -> Provider V2 -> upstream`.
- Hub Pipeline, chat process, `req_process`, `resp_process`, and servertool followup orchestration must be Rust-only in semantics.
- `sharedmodule/llmswitch-core/src/**` may keep only thin TypeScript call shells; no new llmswitch-core TypeScript feature semantics may be added.
- No fallback, downgrade, compensation path, silent repair, or dual-authority behavior is allowed.
- Completion cannot be claimed without file-level evidence, test evidence, and residue-audit evidence.
- Replaced or incorrect TypeScript semantics must be physically removed after the Rust source of truth is validated.

## Definition of Done

The work is complete only when all of the following are true:

1. All Hub request and response semantic decisions are made in Rust.
2. All servertool followup orchestration semantics are made in Rust.
3. Provider request/response mapping semantics are made in Rust; TypeScript only forwards data and surfaces errors.
4. Tool surface, tool history, and carrier normalization semantics are made in Rust.
5. No duplicate TypeScript semantic implementation remains in the repository for the same behavior.
6. Golden, parity, roundtrip, and targeted regression tests pass with Rust as the only semantic authority.
7. An audit gate exists to prevent new TypeScript Hub semantics from re-entering the codebase.

## Scope

### In Scope

- `sharedmodule/llmswitch-core/src/conversion/hub/**`
- `sharedmodule/llmswitch-core/src/conversion/pipeline/stages/req_process/**`
- `sharedmodule/llmswitch-core/src/conversion/pipeline/stages/resp_process/**`
- `sharedmodule/llmswitch-core/src/conversion/tool-governance/**`
- `sharedmodule/llmswitch-core/src/conversion/tool-surface/**`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/**`
- Associated tests, goldens, and residue-audit scripts that prove Rust-only authority

### Explicitly Out of Scope

- Unrelated provider features
- Cosmetic refactors with no effect on semantic authority
- Temporary compatibility branches intended to preserve old TypeScript semantics long-term

## Execution Principles

1. Migrate authority before deleting residue.
2. Keep exactly one semantic source of truth at every stage.
3. Treat TypeScript as a transport shell, not a rule engine.
4. Fail fast on unsupported or inconsistent states.
5. Prefer physical deletion over disconnected dead code.
6. Every phase must end with evidence, not narrative confidence.

## Phase 0: Residue Map and Authority Freeze

### Goal

Produce a file-level residue map that identifies all remaining TypeScript semantic authority and assigns each residue to its Rust destination.

### Required Outputs

- A table of files under the Hub/Pipeline surface classified as:
  - `native-only`
  - `native-primary with TS residue`
  - `TS-authoritative residue`
- For each residue item:
  - current semantic responsibility
  - target Rust module/crate location
  - final TypeScript fate: keep thin shell, shrink, or delete
  - required verification evidence

### Review Focus

High-priority review targets must include at least:

- `sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/anthropic-mapper-from-chat.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/operation-table/semantic-mappers/gemini-mapper-from-chat.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/response/provider-response.ts`
- `sharedmodule/llmswitch-core/src/conversion/pipeline/stages/resp_process/**`
- `sharedmodule/llmswitch-core/src/conversion/tool-surface/**`

### Exit Criteria

- No in-scope TypeScript semantic file is left unclassified.
- Every residue has one Rust landing zone.
- The migration order is frozen from evidence rather than intuition.

## Phase 1: Resp Process and Servertool Orchestration Closeout

### Goal

Move all remaining response pipeline semantics into Rust and reduce TypeScript response orchestration to thin invocation shells.

### Required Work

- Migrate the semantic responsibility of:
  - `resp_process_stage1_tool_governance`
  - `resp_process_stage2_finalize`
  - `resp_process_stage3_servertool_orchestration`
- Collapse `provider-response.ts` so it no longer owns business-rule decisions.
- Ensure all servertool followup, continuation, and required-action decisions originate from Rust.

### Forbidden End State

- TypeScript branching that repairs, sanitizes, or semantically reinterprets Rust outputs.
- TypeScript shadow orchestration that duplicates Rust decision-making.

### Exit Criteria

- Response-stage business rules are no longer authored in TypeScript.
- `provider-response.ts` is a thin shell with fail-fast error propagation.
- Response behavior differences can be traced to Rust code only.

## Phase 2: Provider Mapper Rustification Closeout

### Goal

Move remaining provider-specific request and response mapping semantics into Rust.

### Required Work

Prioritize at minimum:

- `anthropic-mapper-from-chat.ts`
- `gemini-mapper-from-chat.ts`
- `anthropic-mapper-to-chat.ts`
- `gemini-mapper-to-chat.ts`
- supporting helper/config files that still encode semantic rules

### Semantic Categories That Must Leave TypeScript

- payload construction rules
- parameter extraction and normalization
- tool output synthesis
- provider-specific sanitize rules
- missing-field semantic validation
- reasoning/system/tool metadata semantic handling

### Exit Criteria

- Mapper files are reduced to input shaping, native invocation, output typing, and explicit error propagation.
- Provider-specific semantic rules no longer exist as authoritative TypeScript logic.

## Phase 3: Tool Surface and History Carrier Rustification Closeout

### Goal

Move carrier normalization and tool-history semantic comparison into Rust.

### Required Work

- Rust-own the semantic decision of `messages` vs `input` carrier handling.
- Rust-own tool history canonicalization and diff authority.
- Remove TypeScript-owned payload rewrite rules that affect Hub semantics.

### Exit Criteria

- TypeScript no longer decides carrier semantics or history truth.
- Rust is the only authority for tool-surface normalization and diff behavior.

## Phase 4: Physical Deletion of TS Semantic Residue

### Goal

Remove obsolete or duplicated TypeScript semantic implementations once Rust authority is proven.

### Required Work

- Delete helper functions that duplicate Rust semantic logic.
- Delete dead branches kept only for compatibility with former TypeScript authority.
- Delete superseded mapper branches and unused semantic utilities.
- Keep only minimal shells required to call Rust and adapt types.

### Exit Criteria

- No disconnected semantic dead code remains for migrated Hub behavior.
- Grep/audit results no longer show duplicate semantic implementations in TypeScript for closed items.

## Phase 5: Verification and CI Gate Closeout

### Goal

Prove that rustification is complete and prevent semantic backslide.

### Required Verification

- Protocol matrix coverage for at least:
  - OpenAI chat
  - OpenAI responses
  - Anthropic messages
  - Gemini chat
- Request/response roundtrip integrity tests
- Servertool followup and continuation tests
- Golden/parity tests proving Rust output matches expected semantics
- A residue audit script or CI gate that flags new TypeScript Hub semantics

### Evidence Requirements

Every closeout report must include:

- changed files
- deleted files/functions
- verification commands
- test outputs or failure evidence
- remaining residue, if any
- explicit statement of whether Rust is now the sole authority

### Exit Criteria

- Required tests pass.
- The residue audit gate is active.
- There is evidence that TypeScript semantic authority has been reduced to zero within the defined scope.

## Recommended Work Breakdown

### Week 1

- Finish residue map
- Freeze Rust target ownership for every residue item
- Add or draft the residue-audit script skeleton

### Week 2

- Close out `resp_process` and servertool orchestration in Rust
- Shrink `provider-response.ts`

### Week 3

- Close out Anthropic and Gemini request mappers in Rust

### Week 4

- Close out response mappers, tool surface, and history carrier semantics
- Delete superseded TypeScript semantic residue

### Week 5

- Complete protocol matrix, roundtrip, golden/parity, and audit-gate verification
- Produce closeout report

## Delivery Checklist

Before declaring completion, confirm all items below with evidence:

- [ ] Residue map exists and covers the full in-scope surface
- [ ] Rust destination is defined for every residue item
- [ ] `resp_process` semantics are Rust-only
- [ ] servertool orchestration semantics are Rust-only
- [ ] provider mapper semantics are Rust-only
- [ ] tool surface/history semantics are Rust-only
- [ ] replaced TypeScript semantic code has been physically deleted
- [ ] protocol matrix tests pass
- [ ] roundtrip and followup tests pass
- [ ] parity/golden tests pass
- [ ] CI residue gate is active
- [ ] closeout report proves Rust is the only semantic authority

## Suggested /goal Prompts

### Full Program

```text
/goal Execute docs/hub-pipeline-rustification-execution-plan.md to complete Hub Pipeline rustification closeout. Enforce Rust as the only semantic source of truth for Hub Pipeline, chat process, req_process, resp_process, and servertool followup orchestration. Do not add or preserve llmswitch-core TypeScript business semantics. Prohibit fallback, downgrade, or dual-authority behavior. Work phase by phase, and after each phase report changed files, deleted TypeScript residue, verification evidence, and remaining gaps.
```

### Residue Map Only

```text
/goal Using docs/hub-pipeline-rustification-execution-plan.md, produce the Hub Pipeline rustification residue map first. Classify each in-scope file as native-only, native-primary with TS residue, or TS-authoritative residue; assign each residue to one Rust landing zone; and state the final TypeScript fate, verification evidence, and risk for each item.
```

### Response Pipeline Only

```text
/goal Using docs/hub-pipeline-rustification-execution-plan.md, complete Phase 1 only: move resp_process and servertool orchestration semantics fully into Rust, reduce provider-response.ts to a thin shell, prohibit fallback, and finish with file-level evidence and tests.
```

### Verification Closeout Only

```text
/goal Using docs/hub-pipeline-rustification-execution-plan.md, perform verification closeout only: protocol matrix, roundtrip, servertool followup, golden/parity, and residue-audit gate. Conclude whether Rust is now the sole semantic authority within the defined scope, with explicit evidence.
```

## Final Rule

If any required semantic rule still lives in TypeScript within the defined scope, rustification is not complete.
