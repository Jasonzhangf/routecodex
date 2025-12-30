# Error Handling Module
## Overview
Centralized error handling system for RouteCodex, implementing the V2 error architecture with fail-fast principles and structured error reporting.
## Directory Structure
```
src/error- handling/
├── route-error-hub.ts          # Central error routing and distribution hub
└── quiet-error- handling-center. ts  # Error processing center with noise reduction
```
## Key Components
### RouteErrorHub
Routes errors to appropriate handlers based on error scope (http/server/pipeline/provider) and ensures proper logging and HTTP response mapping.
### QuietErrorHandlingCenter
Processes errors with intelligent filtering to reduce noise while maintaining visibility into critical issues.
## Error Flow
```
Provider/Hub Pipeline → emitProviderError() → RouteErrorHub → 
ErrorHandlerRegistry → providerErrorCenter → HTTP Response
```
## Do / Don't
**Do**
- Use `emitProviderError()` for all provider failures
- Call `reportRouteError()` when catching exceptions in HTTP/CLI/pipeline
- Include full context (dependencies, requestId) in error reports

**Don't**
- Silently swallow errors without reporting
- Implement custom fallback logic for provider failures
- Store sensitive data in error messages

## Related Documentation
- `docs/error-handling-v2.md` - Complete error handling guide
- `src/utils/error-handler-registry.ts` - Error registration system
