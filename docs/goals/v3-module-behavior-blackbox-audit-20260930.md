# V3 module behavior blackbox audit

## Contract and test boundary

The public behavior begins at a CLI command, HTTP or WebSocket request, or a
documented crate API. A controlled provider or sidecar is an external peer, not
a substitute for the RouteCodex runtime. Each behavior test observes the client
result and the peer's captured request. It checks success, failure, cancellation
or disconnect when applicable, plus resource cleanup. Source text and private
function names are never the pass condition for a behavior regression.

The existing V3 resource, function, caller and verification maps remain the
owner and gate registry. This audit does not change their topology or locks.
The workspace currently declares 18 crates. The paths below are actual test
artifacts in the `494230ff5` baseline; naming a file is not a claim that every
behavior in its row already has an assertion.

| Module | Current public boundary and representative evidence | Behavior to lock or add |
| --- | --- | --- |
| `routecodex-v3-config` | CLI config tests and `user_config_contract.rs` | A temporary authoring file compiles through `rccv3 config check`; invalid provider/model and missing endpoint fail with the declared diagnostic, without starting a listener. |
| `routecodex-v3-config-mgmt` | `l3_config_mgmt.rs`, CLI config tests | CLI update/read round trip preserves unrelated user fields and rejects invalid edits without changing the file. |
| `routecodex-v3-cli` | `h2_p6_controlled_replay.rs`, `managed_lifecycle.rs` | Built CLI starts an isolated listener, answers a request, reports status, and shuts down its own child and ports. |
| `routecodex-v3-lifecycle` | `managed_lifecycle.rs`, hooks lifecycle tests | Installed command restart loads the expected binary; failed start leaves an explicit status and no orphan owned sidecar. Shared runtime is a separate live acceptance node. |
| `routecodex-v3-admin` | `l4_admin_api.rs`, `admin_webui_managed.rs` | Real admin HTTP action has the declared result and authorization boundary; disabled admin has no reachable endpoint. |
| `routecodex-v3-route-classifier` | crate tests, `vr_full_function_controlled_replay.rs` | Change only current-turn request facts; observe selected upstream route without inspecting classifier internals. |
| `routecodex-v3-virtual-router` | crate tests, controlled replay | One request selects one opaque route; fallback attempts do not re-enter the router. |
| `routecodex-v3-target` | crate tests, `multi_listener_server.rs` | Tier 1 success never sends to tier 2; tier 1 exhaustion does, preserving exact candidate and key selection. |
| `routecodex-v3-provider-responses` | `general_provider.rs`, `responses_websocket_v2.rs` | Loopback peer captures exact wire request and auth; 400/429/timeout and successful probe produce observable request-local and later-request behavior. |
| `provider-compat-core` | `minimax_anthropic_compat.rs`, protocol controlled servers | Send a valid and a malformed but passable client payload through a real route; inspect final provider wire and client response, not adapter source branches. |
| `routecodex-v3-runtime` | Relay integrations and `multi_listener_server.rs` | Direct and Relay JSON/SSE tool round trips preserve call ID, namespace and complete arguments; a client tool result reaches the next provider request. |
| `routecodex-v3-server` | `multi_listener_server.rs`, controlled protocol servers | HTTP and WebSocket entry, body limits, disconnect and response framing reach one terminal client result and release request resources. |
| `routecodex-v3-sse` | transport crate tests, server controlled streams | Provider frames remain buffered until a valid terminal attempt; precommit failure retries, postcommit failure closes once, and `[DONE]` is not duplicated. |
| `routecodex-v3-error` | `error_chain_contract.rs`, server failure cases | Provider external status and internal stage failure enter distinct client projections; no failed attempt leaks a partial success frame. |
| `routecodex-v3-debug` | `debug_runtime_contract.rs`, server debug endpoints | Dry run makes zero upstream sends; sample and status endpoints report the actual request while credentials remain absent. |
| `routecodex-v3-agent-memory` | `raw_capture_grammar.rs` | Public capture/restore consumer preserves request and response semantics; failure and cancellation leave no partial published record. |
| `servertool-core` | runtime web search integration | A real tool request enters the registered sidecar boundary, and the returned tool name, call ID and result are paired in the client and next turn. |
| `routecodex-v3-hooks` | `native_delivery_replay.rs`, binary readiness tests | Isolated control socket records one delivery receipt and a stopped sidecar releases its socket; this does not require the shared rccs service. |

## First conversion

`test:v3-responses-function-call-arguments-regression` currently reads
`provider_sse_json_codec.rs` and passes when expected source strings exist.
That does not prove a client can consume a tool call. Replace this gate with a
controlled `/v1/responses` Relay SSE test: provider sends structured arguments,
the client receives a string-valued `arguments` at both item and terminal
events, and the provider capture proves the request reached the selected peer.
The existing codec unit tests remain for partial and malformed event details.

Later conversions should reuse the controlled listener and provider harnesses
listed above. Add a case only where the public contract lacks an assertion;
do not duplicate the same assertion across crate, server and CLI suites.

## Findings and ordering

1. **False green, immediate:** the function-call arguments gate checks source
   markers and even checks the position of one source branch relative to a
   unit-test name. A different codec implementation could satisfy the client
   contract while failing that gate; a broken client projection could pass it.
   The replacement must be an HTTP/SSE behavior assertion at the real Server
   entry, with the controlled provider capture as the outbound witness.
2. **Missing positive route edge:**
   `cli_replay_proves_pool_match_default_floor_and_total_exhaustion` observes
   matched-pool failure followed by default-floor send. It does not assert that
   a successful matched tier prevents all lower-tier sends. Add this case in
   the same CLI controlled replay fixture, using a successful matched upstream
   and a failing lower tier so the test would fail if the lower tier is called.
3. **Existing public-entry coverage to retain:** `multi_listener_server.rs`
   already exercises Responses HTTP, inbound WebSocket, session admission,
   client disconnect, provider failure and debug endpoints. The controlled
   OpenAI Chat and Gemini server tests cover their HTTP JSON/SSE routes. New
   regression cases should extend these fixtures instead of creating a second
   fake runtime or asserting private function names.
4. **Capability still unproven at a public entry:** agent-memory raw capture
   grammar and servertool core have module tests, but the files found in this
   audit do not by themselves show capture/publish cleanup or a full tool
   execution receipt and follow-up turn through the client entry. These need
   owner-scoped designs and fixtures before claiming project-level blackbox
   coverage. With the shared rccs service paused, hooks tests should use only
   an isolated control socket.

The first two cases are independent file scopes and can run in parallel.
Each worker must report the failing baseline or mutation that proves its
assertion can catch the regression, then the passing candidate result. The
coordinator reviews the resulting diff and maps each case to its existing
required gate before integration.
