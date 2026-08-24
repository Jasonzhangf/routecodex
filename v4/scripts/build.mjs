#!/usr/bin/env node
/**
 * Canonical V4 build entrypoint: mutable workspace crates compile through
 * Cargo; every frozen-module consumer compiles through the Active resolver.
 * The final rccv4 binary is linked only from those admitted artifacts.
 */
import { run } from './_common.mjs';

run('node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard');
// V4-LAYER-PREFLIGHT-END
run('cargo build --release --manifest-path Cargo.toml --locked');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- build-consumer --root . --consumer routecodex-v4-config --deps routecodex-v4-base-node,routecodex-v4-edge --out build-control/routecodex-v4-config/libroutecodex_v4_config.rlib');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- build-consumer --root . --consumer routecodex-v4-provider --deps routecodex-v4-base-node --out build-control/routecodex-v4-provider/libroutecodex_v4_provider.rlib');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- build-consumer --root . --consumer routecodex-v4-server --deps routecodex-v4-base-node --out build-control/routecodex-v4-server/libroutecodex_v4_server.rlib');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- build-consumer --root . --consumer routecodex-v4-runtime --deps routecodex-v4-base-node,routecodex-v4-control,routecodex-v4-error --source-deps routecodex-v4-cordis-bridge,routecodex-v4-plugin-contract,routecodex-v4-skeleton --out build-control/routecodex-v4-runtime/libroutecodex_v4_runtime.rlib');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- build-consumer --root . --consumer routecodex-v4-router --deps routecodex-v4-base-node,routecodex-v4-edge --rlib-deps routecodex_v4_config=build-control/routecodex-v4-config/libroutecodex_v4_config.rlib --out build-control/routecodex-v4-router/libroutecodex_v4_router.rlib');
run('cargo run --quiet --release --manifest-path Cargo.toml -p routecodex-v4-build-link -- build-binary --root . --consumer routecodex-v4-runtime-bin --deps routecodex-v4-base-node,routecodex-v4-edge,routecodex-v4-control,routecodex-v4-error --source-deps routecodex-v4-cli,routecodex-v4-lifecycle,routecodex-v4-servertool --rlib-deps routecodex_v4_config=build-control/routecodex-v4-config/libroutecodex_v4_config.rlib,routecodex_v4_provider=build-control/routecodex-v4-provider/libroutecodex_v4_provider.rlib,routecodex_v4_router=build-control/routecodex-v4-router/libroutecodex_v4_router.rlib,routecodex_v4_runtime=build-control/routecodex-v4-runtime/libroutecodex_v4_runtime.rlib,routecodex_v4_server=build-control/routecodex-v4-server/libroutecodex_v4_server.rlib --out target/release/rccv4');
console.log('[v4 build] OK Active-linked rccv4 release build (locked)');
