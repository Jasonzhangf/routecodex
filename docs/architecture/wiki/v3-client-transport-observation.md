# Client transport observation

Front owns the accepted socket. Debug observes that boundary through the existing
`serve_v3_front_http_connection -> V3FrontHttpIo -> V3StableFrontSocket` path.
The response DAG still ends at a committed client-frame candidate. Observation
does not create an Error-to-client edge, change bytes, or drive recovery.

Record every accepted connection, admitted request, prepared HTTP response,
each successful socket write for that response, write/flush failure, and socket
close. Write high-frequency diagnostics only to the declared Debug file sink;
never mirror them to the human console, even when console logging is enabled.
Include time, local
port, connection identity, request sequence, endpoint, and the existing Debug
trace identity when allocated. Do not capture bodies, credentials, query strings,
or infer identity/status from opaque business bytes.

`response_prepared` describes the typed response returned by the HTTP service;
it does not prove any bytes reached the socket. A `socket_write` event is emitted
only after the real socket write and flush succeed. Its `prepared_status` comes
from that response, not from Provider status. Frame annotations are captured
before enqueueing so later keep-alive requests cannot relabel queued writes.
HTTP interim heads and upgraded writes without a prepared response retain a
null prepared status. A socket write is not a client acknowledgement.

`write_failure` retains its real I/O stage and error. `socket_closed` records
successfully written byte totals and the last response observation. A prepared
response followed by zero written bytes is never reported as delivered. Protocol
body/decode/provider failures remain in their existing typed Error/diagnostic
owners. Logging failures are reported out of band and cannot affect transport.

Required public-boundary regressions compare real client bytes and Debug records:
normal JSON/SSE; a model failure with no response; provider-error SSE transport
break; management HTTP errors; fresh/reused malformed framing; and multiple
keep-alive responses. Verify an independent later request still succeeds.
