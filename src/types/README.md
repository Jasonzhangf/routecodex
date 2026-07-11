# Types Module

## Overview
Type definitions for RouteCodex Host and shared module alignment. Focus on DTOs, config types, and debug/session types.

## Core Files
- `common-types.ts`: Base JSON/logging types
- `shared-dtos.ts`: Host-local request/response/error DTOs for app wiring
- `external-modules.d.ts`: Third-party library type declarations
- `config-types.ts`: Host config typing for loader and runtime setup

## Alignment Rule
Host-local types must not become a shadow runtime contract for llmswitch. New Hub Pipeline, routing, tool-governance, continuation, or provider-wire semantics belong in the Rust/native owner first; TypeScript may only keep the minimal host IO shape needed to call that owner.

## Do / Don't
**Do**
- Keep host-only DTOs small and tied to their production caller.
- Prefer importing concrete app types from the owning source file when possible.

**Don't**
- Recreate llmswitch-core runtime contracts in `src/types`.
- Point new code at retired external llmswitch type mirrors.
- Add business logic or runtime code in type files
