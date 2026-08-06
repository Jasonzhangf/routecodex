# GLM Tool Schema Payload Copy Budget Test Design

## Scope

`feature_id: conversion.glm_tool_schema_payload_copy_budget` owns only the Rust GLM tool-schema sanitizer in `compat_tool_schema.rs`.

## Lifecycle

The N-API wrapper parses one provider-wire JSON string into an owned `serde_json::Value`, sanitizes tool definitions, `tool_choice`, and message tool names, then serializes the same owned graph back to JSON.

## Positive Cases

- Shell tool parameters still remove `strict`, coerce `command` to array-string schema, preserve required entries, and set missing object defaults.
- Non-shell tools still remove only `strict` and preserve unsupported parameter shapes.
- Dotted or illegal tool names are normalized consistently across `tools`, `tool_choice`, assistant `tool_calls`, and tool-role message `name`.

## Negative Cases

- The sanitizer must not clone full payload branches such as top-level payload objects, complete tool definitions, messages, tool calls, or tool-choice objects.
- The N-API wrapper must not introduce a second semantic path; it remains parse owned JSON -> sanitize owned value -> serialize.
- The sanitizer must not change provider configuration, routing, retry, MetadataCenter, request inbound, response outbound, or live debug payload semantics.

## Required Gates

- `cargo test -p router-hotpath-napi compat_tool_schema --lib`
- `cargo test -p router-hotpath-napi sanitize_tool_schema_glm_shell --lib`
- `npm run verify:resource-operation-map`
- `npm run verify:function-map-compile-gate`
- `npm run build:native-hotpath`
- `ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:base`

## Completion Boundary

This slice proves source/native/build copy cleanup only. RSS reduction remains unclaimed until release install, managed restart, and large-payload replay are explicitly authorized.
