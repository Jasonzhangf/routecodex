# HTTP Server Module
## Overview
HTTP server module contains the Express-based HTTP server implementation for RouteCodex, handling all incoming API requests and delegating to the Hub Pipeline.
## Directory Structure
```src/server/runtime/http-server/
├── index. ts                  # Main HTTP server entry point and initialization
├── routes. ts                 # Route definitions for all API endpoints
├── middleware. ts             # Express middleware (CORS, logging, error handling)
├── request- executor. ts      # Request execution and Hub Pipeline invocation
├── runtime-manager. ts        # Server lifecycle management (start/stop)
├── stats- manager. ts         # Statistics and metrics collection
├── provider-utils. ts         # Provider runtime metadata injection
├── llmswitch- loader. ts      # Hub Pipeline initialization and loading
└── types. ts                  # HTTP server type definitions```## Key Components### HttpServerMain Express server handling:- Route registration and middleware setup- Request parsing and validation
- SSE (Server-Sent Events) handling- Graceful shutdown### Routes| Endpoint | Handler | Description |
|----------|---------|-------------| | `/v1/chat/completions` | ChatHandler | OpenAI Chat API |
| `/v1/messages` | MessagesHandler | Anthropic Messages API || `/v1/responses` | ResponsesHandler | OpenAI Responses API |
| `/health` | HealthHandler | Health check endpoint |### RequestExecutorOrchestrates request processing:1. Parse and validate incoming request2. Attach provider runtime metadata3. Invoke Hub Pipeline
4. Handle SSE streaming or JSON response5. Write snapshots## Usage```typescriptimport { createHttpServer } from './index. js';const server = await createHttpServer(config);await server.start();```## Do / Don't
**Do**
- Handle HTTP protocol and SSE encapsulation only
- Pass request body to Hub Pipeline without modification
- Use provider runtime metadata injection for error tracking**Don't**
- Parse or modify payload in handlers
- Bypass Hub Pipeline to call providers directly
- Implement tool governance logic## Related Documentation
- `src/server/handlers/` - Request handlers for each endpoint
- `docs/v2-architecture/README. md` - V2 architecture overview
