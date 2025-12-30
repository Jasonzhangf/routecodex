# Server Utils Module
## Overview
Server utils module contains utility functions for the HTTP server, including error mapping, request parsing, SSE handling, and logging utilities.
## Directory Structure
```src/server/utils/
├── http-error- mapper. ts       # Maps provider errors to HTTP responses
├── non-blocking- error-logger. ts  # Non-blocking error logging
├── port-resolver. ts            # Port resolution and availability checking
├── rate-limiter. ts             # Request rate limiting
├── request-id- manager. ts      # Request ID generation and tracking
├── sse-request-parser. ts       # SSE request parsing and validation
├── stage- logger. ts            # Request stage logging
├── utf8-chunk-buffer. ts        # UTF-8 chunk buffer for SSE handling
├── warmup-detector. ts          # Server warmup detection
└── warmup-storm- tracker. ts    # Warmup storm tracking and prevention```## Key Components### HttpErrorMapperMaps provider errors to appropriate HTTP status codes and response formats.### SSE UtilitiesHandle Server-Sent Events:- UTF-8 chunk buffering
- Request parsing- Heartbeat management### RateLimiterImplements request rate limiting based on:- IP address
- API key
- Provider limits## Usage```typescriptimport { HttpErrorMapper } from './http-error-mapper. js';const mapper = new HttpErrorMapper();const response = mapper.toHttpResponse(error);```## Related Documentation
- `src/server/handlers/` - Request handlers using these utilities
