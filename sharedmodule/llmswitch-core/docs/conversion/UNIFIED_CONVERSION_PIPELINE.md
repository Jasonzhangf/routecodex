# Unified Conversion Pipeline Proposal

## Goals

1. Decouple protocol-specific quirks from the core Chat Process.
2. Guarantee maximal information retention across protocols via `canonical payload + meta`.
3. Provide standardized hooks for validation, cleanup, augmentation, and field mapping.
4. Enable parallel rollout alongside existing codecs (v1) with matrix tests before switching.

## High-level Flow

```
Inbound:
  (protocol input: JSON/SSE)
    → Protocol Pre-Validation Hook
    → Protocol Parser → canonical Chat payload + meta
    → Protocol Cleanup/Augmentation Hook
    → Chat Process (canonical only; meta carried separately, unmodified)

Outbound:
  canonical response + meta (from inbound)
    → Protocol Augmentation Hook (consume meta, rebuild protocol-specific fields)
    → Field Mapping / Whitelisting
    → Protocol Post-Validation Hook
    → Output encoding (JSON/SSE)
```

### Meta Handling
- Inbound parser extracts all non-canonical information into `meta`.
- Chat Process does not inspect `meta`; it only manipulates canonical data.
- Outbound augmentation consumes `meta` to reconstruct protocol-specific semantics before final encoding.

### Hooks
Each protocol registers hooks:
- **Pre-Validation**: enforce protocol constraints (e.g., Responses tool id length).
- **Parser / Serializer**: convert between wire format and canonical schema.
- **Cleanup / Augmentation**: remove or add fields that canonical schema cannot represent directly.
- **Post-Validation**: ensure output satisfies upstream requirements.

## Module Structure

```
src/conversion/pipeline/
  ├─ codecs/v2/               # new codec implementations
  ├─ hooks/                   # protocol hook definitions
  ├─ schema/                  # canonical schema helpers
  ├─ meta/                    # meta serialization helpers
  └─ tests/                   # v2 vs v1 matrix comparisons
```

## Rollout Plan

1. Implement the shared pipeline infrastructure (hooks, meta container, field mapping).
2. Port Anthropic codec to v2 pipeline; keep v1 codec in place (profile-based switch).
3. Extend matrix tests to compare v1 vs v2 for Anthropic (requests/responses/SSE).
4. After parity achieved, enable v2 profile; keep v1 as fallback.
5. Repeat for other protocols (Responses, Gemini, etc.).
