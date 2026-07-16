# V3 Responses inbound WebSocket proxy

Server owns only the client WebSocket upgrade and frame projection shell.
Provider WebSocket state remains owned by v3.responses_websocket_v2_transport_hardening.

Mainline:

- V3ResponsesInboundWs01ClientUpgrade: GET /v1/responses upgrades only when OpenAI-Beta contains responses_websockets=2026-02-06.
- V3ResponsesInboundWs02CreateEventParsed: one client response.create event is parsed, its type field is removed, and the remaining data-plane payload enters the existing Responses Direct Runtime.
- V3Server03HttpRequestRaw through V3Resp15ClientPayload: the existing execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation owner runs the normal Direct path.
- V3ResponsesInboundWs04ClientEventProjected: JSON Runtime output becomes response.completed; Runtime SSE output is decoded incrementally and projected as WebSocket text events.

Boundaries:

- Server does not own provider/upstream sockets, connection cache, provider event correlation, or remote continuation state.
- Server does not restore or repair continuation, history, tools, required_action, or servertool state.
- WebSocket failures are explicit error events or close; there is no HTTP retry or fallback path.
- Normal provider/client payloads must not carry internal control fields such as provider_id, auth_alias, continuation_owner, capability_revision, routing_group, session_id, or thread_id.

Controlled evidence:

- Plain GET without WebSocket upgrade and WebSocket missing `OpenAI-Beta: responses_websockets=2026-02-06` are rejected at the Server boundary; WebSocket ping/pong stays transport-only.
- JSON response.create enters the existing Runtime and returns a response.completed WebSocket event.
- Binary JSON response.create enters the same Runtime path.
- stream=true response.create projects Runtime SSE events as WebSocket text frames without collecting the full stream.
- malformed client events, missing type, unsupported `response.cancel`, and nested `response.create.response` payloads fail before provider send.
- A same-socket second response.create with `previous_response_id` and `function_call_output` uses the existing continuation owner and does not re-enter Router.
- Scope mismatch fails before provider send; Server does not repair continuation/history/tool state.
- Provider WebSocket/runtime failure projects an explicit WebSocket error event without HTTP fallback.
- Client disconnect during incremental Runtime SSE projection drops the provider stream/connection instead of silently draining to terminal behind the client.
