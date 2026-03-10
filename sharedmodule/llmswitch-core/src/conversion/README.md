# Conversion Module

## Overview
Conversion module implements the front-half and back-half pipeline for protocol transformation between different AI provider APIs. This is the core of llmswitch-core's conversion engine.

## Directory Structure
```
src/conversion/
├── index.ts                  # Main entry point and exports
├── codec-registry.ts         # Codec registry for all protocols
├── schema-validator.ts       # JSON Schema validation
├── types.ts                  # Conversion type definitions
├── codecs/                   # Protocol codec implementations (chat, responses, anthropic)
├── compat/                   # Provider compatibility profiles
├── config/                   # Conversion configuration files
├── hub/                      # Hub Pipeline implementation
├── pipeline/                 # Pipeline nodes and stages
├── responses/                # Responses protocol specific conversion
└── shared/                   # Shared utilities (reasoning normalizer, etc.)
```

## Key Components

### Front-Half Conversion
Converts inbound requests from different protocols to canonical OpenAI Chat format:
- `chat`: Minimal validation and normalization
- `responses`: Maps instructions + input to messages, function_call → tool_calls
- `anthropic`: Claude message mapping to OpenAI Chat

### Back-Half Pipeline (Tool Governance)
The only place where tool handling occurs:
- `request-tools-stage`: canonicalize tools, repair arguments, ID generation
- `response-tools-stage`: tool result pairing, responses reverse bridge

### Codec Registry
Provides codec implementations for:
- `openai-chat` - OpenAI Chat protocol
- `openai-responses` - OpenAI Responses protocol  
- `anthropic-messages` - Anthropic Messages protocol

## Related Documentation
- Root README.md - Package overview and architecture principles
