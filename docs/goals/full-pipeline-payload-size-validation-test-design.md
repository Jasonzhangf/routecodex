# Full-Pipeline Payload Size Validation Test Design

## Lifecycle

1. A request or response format node owns a borrowed `serde_json::Value`.
2. The node asks the shared JSON utility for the exact serialized UTF-8 byte count.
3. The utility streams serialization into a counting `Write` implementation and does not retain serialized bytes.
4. The format node compares the returned count with its existing 50 MiB limit.
5. The original payload remains owned by the format node and continues through the existing adjacent pipeline edge unchanged.

## White-Box Positive Cases

- The shared counter returns exactly the same byte count as `serde_json::to_vec` for nested objects, arrays, escaped strings, and non-ASCII text.
- Request inbound, request outbound, and response inbound validators all call the same shared helper.
- Payloads below or equal to the existing limit retain the current success behavior.
- Existing format parse/build outputs remain byte-semantic equivalent after validation.

## White-Box Negative Cases

- The three validators must not call `serde_json::to_string` merely to inspect `.len()`.
- The shared helper must not allocate a `String` or `Vec<u8>` as its serialization sink.
- Payloads above the existing limit retain the current error text shape and report the exact serialized byte count.
- A counting overflow or serialization failure remains an explicit serialization error; it must not become a zero-byte payload or bypass validation.

## Module Black-Box

- Focused request inbound, request outbound, and response inbound format tests remain green.
- A source gate fails if any of the three format owners reintroduces local full-string size validation.
- The shared helper equality test covers Unicode and JSON escaping so character count cannot replace UTF-8 byte count.

## Project Black-Box

- Request and response Hub Pipeline regressions remain green for JSON and SSE materialization paths.
- Native hotpath and base builds remain green.
- No provider/client payload field, provider configuration, MetadataCenter carrier, or JS/Rust bridge contract changes.

## Known Gap

The source and native gates prove removal of the extra full JSON `String` allocation inside size validation. They do not prove process RSS reduction. RSS claims still require the goal-prescribed installed-runtime concurrent large-payload replay.
