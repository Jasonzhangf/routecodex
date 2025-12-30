# Provider Update Tool
## Overview
Provider update tool fetches provider templates, models, and metadata from upstream AI providers to keep RouteCodex configurations current.
## Directory Structure
```src/tools/provider-update/
├── index. ts                  # Main entry point and orchestration
├── fetch- models. ts          # Model fetching from provider APIs
├── config- builder. ts        # Configuration template generation
├── key- probe. ts             # API key validation and probing
└── types. ts                  # Type definitions for provider metadata```## Key Components### FetchModelsFetches available models from:- Provider API endpoints
- Model listings and capabilities- Pricing and limit information### ConfigBuilderGenerates configuration templates based on:- Fetched model data
- Provider capabilities- Best practice defaults## Usage```bash
routecodex provider-update --config ~/.routecodex/config.json
```## Related Documentation- `src/commands/provider-update.ts` - CLI command implementation
