# Provider Core API Module
## Overview
Provider core API module provides the public interface and type definitions for Provider V2, defining contracts between Host and provider implementations.
## Directory Structure
```src/providers/core/api/
├── index. ts                  # Public API exports and module entry point
├── provider- types. ts        # Provider type definitions and interfaces
└── provider-config. ts        # Provider configuration types and validation```## Key Components### ProviderTypesDefines core type system for providers:- `ProviderType` - Enum of supported provider types- `ProviderRuntimeMetadata` - Runtime information injected at request time
- `ProviderHealthStatus` - Health check types### ProviderConfigProvides configuration schemas and validation:- JSON Schema definitions for provider configs- Type guards and validators
- Default value providers## Usage```typescriptimport { ProviderType, type ProviderRuntimeMetadata } from './api/index. js';const metadata: ProviderRuntimeMetadata = {  providerKey: 'openai',
  runtimeKey: 'gpt-4',  routeName: 'default'};```## Related Documentation
- `src/providers/core/runtime/` - Provider runtime implementations
- `src/types/config-types. ts` - Configuration type definitions
