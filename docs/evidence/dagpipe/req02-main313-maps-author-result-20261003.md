# REQ02 #313 bounded maps correction

Date: 2026-10-03

## Scope

- Worktree: `/Volumes/Intel/playground/routecodex/dagpipe-req02-main313-maps-20261003`
- Base/HEAD: `50ba5e540869f4021d40e884dcf629b9e59ffc95`
- #313 merge first parent: `2fde74987ed8079c36961bd7bb0c8c07348cb4b9`
- Writable scope used: `docs/architecture/v3-verification-map.yml`, generated caller-flow surfaces, `.execution/maps-*.log`, and this result.
- No Cargo/umbrella test, install, restart, commit, push, Collab, child worker, goal edit, Rust edit, or architecture lock edit was performed.

## Concrete correction

The stale required test suffix at map line 3747 was replaced with the declaration that exists in #313:

```diff
@@ -3744,7 +3744,7 @@ features:
   - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test multi_listener_server p6_responses_endpoint_uses_runtime_provider_path_and_projects_json
   - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test multi_listener_server responses_direct_shared_provider_health_reselects_after_unrecoverable_failure
-  - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test multi_listener_server responses_direct_preserves_last_real_provider_http_error
+  - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test multi_listener_server responses_direct_provider_http_error_never_reaches_the_client
   - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test multi_listener_server openai_chat_http_entry_completes_responses_tool_round_trip
   - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test multi_listener_server responses_inbound_websocket_projects_json_completed_event_and_enters_runtime
   - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test req02_namespace_presence --test req02_tool_call_namespace_presence --test req02_nested_declarations --test req02_public_normalization --test req02_tool_shapes --no-fail-fast
```

Declaration check:

```text
v3/crates/routecodex-v3-server/tests/multi_listener_server.rs:5056:async fn responses_direct_provider_http_error_never_reaches_the_client() {
docs/architecture/v3-verification-map.yml:3747:  - cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-server --test multi_listener_server responses_direct_provider_http_error_never_reaches_the_client
```

Bounded diff and hash:

```text
.execution/maps-bounded.diff
sha256 581ddfadba9a30b9b5c8a567deb9b17a7fbbe97d91654c94941d387854983593
exit=0
```

## #313 stale-suffix scan

The #313 changed test declarations were extracted from:

```text
git diff --unified=0 2fde74987ed8079c36961bd7bb0c8c07348cb4b9 HEAD -- 'v3/**/tests/*.rs'
```

The map was searched for the pre-#313 names of all renamed declarations. Before correction, only `responses_direct_preserves_last_real_provider_http_error` remained in the map. After correction, the scan found no remaining old name and exited 1, which is `rg`'s no-match result:

```text
.execution/maps-stale-suffix-scan.log
sha256 cf205dbb8cea84897b488abcc281bf96698d5e94b1096b16657b4caba9082a22
exit=1 (no matches)
```

No other proven stale suffix remains in the changed map. The other #313 renames checked were:

```text
bug_705d624_real_http_429_retains_status_and_error_in_json_and_sse
bug_705d624_last_real_429_survives_later_transport_failure_and_reselection_succeeds
provider_terminal_http_response_preserves_real_status_body_and_end_to_end_headers
responses_relay_provider_503_preserves_external_error_body
responses_inbound_websocket_preserves_eligible_provider_429_error_fields
responses_inbound_websocket_preserves_binary_provider_error_body
p6_provider_503_preserves_real_status_body_for_streaming_client
anthropic_messages_provider_failure_preserves_real_external_http_error
```

The supporting declaration diff is retained at:

```text
.execution/maps-313-changed-test-declarations.log
sha256 83ac95270ecdd70b2f4b4bb7bc6daab27ef4bb39975cb3ced31e134b4eb45f37
exit=0
```

## Commands

| Command | Log | Exit | Log sha256 |
| --- | --- | ---: | --- |
| `node v3/scripts/architecture/verify-v3-operation-runner-dagpipe.mjs` | `.execution/maps-operation-runner-dagpipe.log` | 0 | `390374163142bbcfb2576b7e1815e685eb3b0edf9f1040b744c20af4e47a3adb` |
| `node v3/scripts/architecture/verify-v3-resource-map.mjs` | `.execution/maps-resource-map.log` | 0 | `2412c0a4ab6ab4457e0f32af6cc36ad066ed4ac2fe6f41e2191c2cf6aef27278` |
| `node v3/scripts/architecture/verify-v3-hub-v1-node-file-topology.mjs` | `.execution/maps-hub-v1-node-file-topology.log` | 0 | `7f7bcbcb52db87b8bf2f0e8da1289f6f18e8f45ed9d36e374ae984bad0036065` |
| `ROUTECODEX_V3_ADMISSION_WORKSPACE=1 node v3/scripts/architecture/render-v3-mainline-caller-flow.mjs` | `.execution/maps-render-mainline-caller-flow.log` | 0 | `22ef56049b7f5b205bf46c23375639948604074a9a6aca6e9a0a5735f844eccd` |
| `ROUTECODEX_V3_ADMISSION_WORKSPACE=1 node v3/scripts/architecture/verify-v3-mainline-caller-flow.mjs` | `.execution/maps-verify-mainline-caller-flow.log` | 1 | `bdbcfa46e981849b40de809be1eb5e0f4cbca4de2511693850120206950cfa27` |

The last command is the expected preserved blocker:

```text
[verify:v3-mainline-caller-flow] failed
- architecture audit lock failure: chain:v3.provider_action_gate.mainline: audited locked fingerprint changed; needs Jason manual authorization and refreshed lock (sha256:78d79632e9ad17d590ec3c2f631ba01361706cea83a84914532e3e367c72531b != sha256:2c98f80e4310712b2cc10d509ec35bc7156c6ca457dd26adb2397fd8f2077231)
exit=1
```

No bypass, approval request, or architecture-lock edit was made.

## Generated and map hashes

```text
8b3eeac1620a87a58c4a93966ccc547172e5345fb8bf0f935efa891229eb449a  docs/architecture/v3-verification-map.yml
0b09eadf7ecfb8f1f0fb5c1ef1ac53004091bca9c7303ead5d7ee7fca8a3556d  docs/architecture/wiki/v3-mainline-caller-flow.md
ef8d617f133bb4dc4f2e76e292dd3d1ec48e761124fa8d2bdfe0387539ebff6f  docs/architecture/wiki/html/v3-mainline-caller-flow.html
```

`git diff --check` for the map and generated flow surfaces exited 0.

## Disposition

The actual stale test name is corrected. All applicable static checks passed except the explicitly expected manual provider-action caller fingerprint rejection, whose precise blocker is preserved. The worktree remains dirty for parent integration and cleanup.
