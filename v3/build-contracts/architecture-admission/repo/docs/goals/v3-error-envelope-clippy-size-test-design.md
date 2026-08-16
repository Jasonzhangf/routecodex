# V3 Error Envelope Clippy Size Test Design

## Goal

Keep `V3Error01SourceRaised` cheap enough to return by value across the typed Error01 boundary while
preserving the existing internal/external identity and client JSON contract.

## Red/green cases

- Red: the Error01 value exceeds 128 bytes and `clippy::result_large_err` fails every adjacent
  `Result<_, V3Error01SourceRaised>` edge.
- Green: the large optional internal and external identity links are indirect, Error01 stays at or
  below 128 bytes, and the
  external provider projection still contains the same `kind`, `status`, `code`, `provider_id`,
  upstream request id, and message fields.
- Negative: internal errors still project no external link; provider/client status mapping and the
  Error01-06 decision chain do not change.

## Verification

- `cargo +stable test --manifest-path v3/Cargo.toml -p routecodex-v3-error --test error_chain_contract -- --nocapture`
- `npm run verify:v3-clippy`
- `npm run test:v3-workspace`
