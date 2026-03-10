# Conversion Pipeline (v2)

This directory hosts the second-generation protocol conversion pipeline that the
hub runtime will gradually adopt. The unified design is documented in
`../../docs/conversion/UNIFIED_CONVERSION_PIPELINE.md` and follows this flow:

```
protocol input → pre-validation → parser → canonical + meta
  → cleanup/augmentation → Chat Process → outbound augmentation
  → field mapping/whitelist → post-validation → protocol output
```

Key folders:

- `hooks/` – strongly typed hook contracts shared by all protocols.
- `meta/` – utilities for storing protocol-specific metadata that must bypass the Chat Process.
- `schema/` – canonical chat schema exports used by codecs.
- `codecs/v2/` – new protocol implementations that opt into the pipeline.
- `tests/` – regression suites ensuring v2 codecs match their legacy counterparts.

Only create codecs inside `codecs/v2/` after the shared hooks/helpers exist; this keeps
the rollout incremental and testable.***
