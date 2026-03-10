# Pipeline Regression Tests

This folder will host comparison suites that run the v2 pipeline codecs against
the legacy implementations. Each test should:

- Load identical golden samples for both codecs.
- Execute the request + response conversions.
- Diff the canonical payloads (allowing protocol-specific tolerances).
- Emit a summary JSON artifact so `scripts/tests/run-matrix-ci.mjs` can fail fast.

Add tests as soon as the first v2 codec (Anthropic) is available.***
