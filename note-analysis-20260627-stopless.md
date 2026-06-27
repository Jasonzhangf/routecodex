# 2026-06-27 stopless blackbox closeout notes

- Focused blackbox failure after native rebuild was a single real owner gap:
  - `stop_message_auto_handler.rs` budget terminal path returned `input.base` directly and bypassed visible text sanitization.
- Terminal `allow-stop` sample in blackbox was not a valid allow-stop contract sample at first; missing required schema fields caused Rust to choose `stop_schema_terminal_missing_fields`.
- After modernizing fixtures to use `MetadataCenter.runtime_control.stopless`, and rebuilding native, the focused stopless blackbox passed.
- Key verified commands:
  - `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts --runInBand --no-cache`
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js tests/servertool/stopless-cli-continuation.spec.ts --runInBand --no-cache`
  - `bash -lc 'cd sharedmodule/llmswitch-core/rust-core && cargo test -p servertool-core stopless --lib -- --nocapture'`
- Result: both stopless blackbox and stopless continuation focused tests passed.
