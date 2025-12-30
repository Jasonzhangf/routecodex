# Provider Core Utils Module
## Overview
Provider core utils module contains utility functions and helpers used by provider implementations, including HTTP client, error reporting, and snapshot writing.
## Directory Structure
```src/ providers/core/utils/
├── http-client. ts             # HTTP client with retry and timeout logic
├── provider-error- reporter. ts  # Error reporting to error handling center
├── snapshot-writer. ts         # Snapshot writing for debugging
├── provider-error- logger. ts  # Provider-specific error logging
└── provider-type- utils. ts    # Provider type conversion utilities```## Key Components### HttpClient
HTTP client with:- Automatic retry with exponential backoff- Timeout management- Connection pooling### ProviderErrorReporterReports provider errors to the central error handling system with full context including dependencies and request metadata.### SnapshotWriterWrites detailed snapshots of provider requests/responses for debugging and regression analysis.
## Usage```typescript
import { HttpClient } from './http-client. js';const client = new HttpClient({ timeout: 30000, retries: 3 });```## Related Documentation
- `src/providers/core/runtime/` - Provider runtime implementations
- `docs/debugging/ snapshot-design.md` - Snapshot design guide
