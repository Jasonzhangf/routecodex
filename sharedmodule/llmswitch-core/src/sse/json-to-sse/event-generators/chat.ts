// feature_id: sse.chat_stream_projection
// Chat JSON->SSE event sequence semantics are Rust-owned.
// This anchor file exists for the SSE architecture boundary gate; runtime code
// must call native wrappers directly instead of restoring TS event generators.
