# Conversation Cache

## 2026-06-04 ErrorPolicyCenter closeout
- Commits made for this goal: `aac979bdc`, `adbcfb51e`, `d024720e2`, `1699aef04`, `2cd60c171`, `d3a48f1a5`, `dabcf2167`, `441393f96`, `1cdb0fa54`, `afc8caa3e`, `6ca43d489`, `b10bc4a12`.
- Error strategy SSOT is `src/providers/core/runtime/provider-failure-policy-impl.ts`; `ErrorHandlingCenter` is projection-only.
- Categories locked: `recoverable | unrecoverable | special_400 | periodic_recovery`.
- Final focused gates passed: 6 Jest suites / 62 tests and `npx tsc --noEmit --pretty false`.
- Static scan: no `classification ===/!==` remains in executor/direct paths; comparisons are confined to provider policy helpers.
- Unrelated dirty file remains: `sharedmodule/llmswitch-core/rust-core/crates/stop-message-core/src/lib.rs`.
