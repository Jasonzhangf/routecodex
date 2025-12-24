# Types Module

## Overview
Type definitions for RouteCodex Host and shared module alignment. Focus on DTOs, config types, and debug/session types.

## Core Files
- `common-types.ts`: Base JSON/logging types
- `shared-dtos.ts`: Request/response/error data structures shared with `@jsonstudio/llms`
- `external-types.ts`: Third-party library type declarations
- `base-types.ts`: Bridge types between Host and `llmswitch-core`

## Alignment Rule
Stay in sync with `sharedmodule/llmswitch-core/dist/types`. New DTOs/interfaces should be added to shared module and rebuilt first.

## Do / Don't
**Do**
- Mirror shared module types to ensure type safety
- Keep debug types aligned with `src/debug/types.ts`

**Don't**
- Duplicate definitions that exist in shared module
- Add business logic or runtime code in type files
