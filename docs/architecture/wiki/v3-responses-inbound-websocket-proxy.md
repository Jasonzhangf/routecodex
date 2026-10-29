# V3 Responses inbound WebSocket proxy

Server owns only the client WebSocket upgrade and frame projection shell.
Provider WebSocket state remains owned by v3.responses_websocket_v2_transport_hardening.

Mainline:

- V3ResponsesInboundWs01ClientUpgrade: GET /v1/responses upgrades only when OpenAI-Beta contains responses_websockets=2026-02-06.
- V3ResponsesInboundWs02CreateEventParsed: one client response.create event is parsed, its type field is removed, and the remaining data-plane payload enters the configured Responses Direct or Relay Runtime.
- V3Server03HttpRequestRaw through the client response payload: the configured Responses binding owner runs the normal Direct or Relay path with the server-scoped provider health store.
- A Relay-to-Direct provider reselection remains a typed runtime handoff; the Server executes it through the existing Direct outcome owner before projecting any WebSocket event.
- V3ResponsesInboundWs04ClientEventProjected: JSON Runtime output becomes response.completed; Runtime SSE output is decoded incrementally and projected as WebSocket text events.

Boundaries:

- Server does not own provider/upstream sockets, connection cache, provider event correlation, or remote continuation state.
- Server does not restore or repair continuation, history, tools, required_action, or servertool state.
- WebSocket failures are explicit error events or close; there is no HTTP retry or fallback path.
- Normal provider/client payloads must not carry internal control fields such as provider_id, auth_alias, continuation_owner, capability_revision, routing_group, session_id, or thread_id.

Controlled evidence:

- Plain GET without WebSocket upgrade and WebSocket missing `OpenAI-Beta: responses_websockets=2026-02-06` are rejected at the Server boundary; WebSocket ping/pong stays transport-only.
- JSON response.create enters the existing Runtime and returns a response.completed WebSocket event.
- Relay-to-Direct reselection executes the selected Direct target and never projects the Relay handoff placeholder as `response.completed` with a null response.
- Binary JSON response.create enters the same Runtime path.
- stream=true response.create projects Runtime SSE events as WebSocket text frames without collecting the full stream.
- malformed client events, missing type, unsupported `response.cancel`, and nested `response.create.response` payloads fail before provider send.
- A same-socket second response.create with `previous_response_id` and `function_call_output` is rejected before provider send; Responses continuation is retired.
- Scope mismatch fails before provider send; Server does not repair continuation/history/tool state.
- A provider terminal closes the current WebSocket without any client payload, so a WebSocket client never observes a provider status, code, or body; a runtime/validation failure still projects an explicit WebSocket error event without HTTP fallback.
- Client disconnect during incremental Runtime SSE projection drops the provider stream/connection instead of silently draining to terminal behind the client.
- While one request waits inside a recoverable provider failure recovery wait, the Server keeps reading the client socket: a client Close drops the in-flight request future, drives the WebSocket protocol Close reply onto the wire before the socket is released, projects no business or error frame, and starts no further provider business attempt for it. Controlled evidence covers both the Direct and Relay public-entry paths.
- Client Text and Binary events read during that wait are held in arrival order and never become a second in-flight request. The held queue is bounded to 32 events or 4 MiB of retained bytes. Reaching either bound stops reading the socket, which reapplies TCP read backpressure to the peer without silently dropping a queued business message or terminating the recoverable request. When backpressure is active, a later client Close is not observed until the in-flight request settles; that is the declared bound/cancellation trade-off.
- The same held queue and bound remain in force when the recovered outcome is incremental Direct or Relay SSE. The original response completes first; client Text and Binary frames read below the bound are retained for the session, and no held event is treated as a second in-flight request or projected as an error. Once the bound is reached, projection stops polling the client socket until the stream settles, then serves all held events in arrival order. Controlled tests also hold a sibling WebSocket live and observe client write backpressure while the main socket remains bounded.
