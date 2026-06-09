# Pipeline Utils

This directory is a Host logging/debug compatibility surface only.

## Live Files

- `colored-logger.ts`: console color formatting used by the HTTP server wrapper and tests.
- `debug-logger.ts`: structured debug logging facade used by server bootstrap and debug harnesses.

## Boundary

- Do not add Hub Pipeline transformation, preflight validation, sanitizer, or tool-result parsing semantics here.
- Hub Pipeline request/response semantics belong to `sharedmodule/llmswitch-core` Rust/native contracts.
- Provider wire compatibility belongs in provider runtime owners, not in `src/modules/pipeline/utils`.
