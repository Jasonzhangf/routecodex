# rust-core

Rust workspace for llmswitch-core native hotpaths.

## Scope

- `router-hotpath-napi`: Virtual Router quota bucket computation hotpath

## Build

```bash
cd rust-core
cargo build -p router-hotpath-napi --release
```

The produced native module can be wired into Node via
`ROUTECODEX_LLMS_ROUTER_NATIVE_PATH`.

