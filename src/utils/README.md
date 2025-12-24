# Utils Module

## Overview
Utility functions for Host layer: error handling, load balancing, failover, key tracking, and snapshot writing. No tool governance or protocol conversion.

## Core Tools
- `error-handler-registry.ts`: Error registration via `ErrorHandlingCenter`
- `load-balancer.ts`: Provider multi-key round-robin load balancing
- `failover.ts`: Provider failover and health checks
- `key-429-tracker.ts`: API key rate-limit status tracking
- `snapshot-writer.ts`: Snapshot writing (shared with `src/debug`)

## Do / Don't
**Do**
- Use `ErrorHandlingCenter` for all error reporting
- Keep utilities Host-layer only (auth, load, failover, snapshots)

**Don't**
- Implement provider-specific logic here
- Patch tool calls or routing decisions
- Store runtime config merges
