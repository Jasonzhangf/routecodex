# Claude Code Router Transformation Tables Reference

## Overview

This document contains comprehensive transformation tables extracted from the Claude Code Router repository. The tables describe how to convert between different LLM API formats, focusing on Anthropic, OpenAI, and Gemini protocols, as well as various OpenAI-compatible providers.

## Architecture Analysis

The Claude Code Router uses an **agent-based architecture** rather than static transformation tables. Protocol conversion happens dynamically through:

1. **Agent System**: Different agents handle specific types of requests (e.g., image processing)
2. **Stream Processing**: Real-time transformation of streaming responses
3. **Tool Integration**: Dynamic tool calling and response handling
4. **Configuration-Driven**: JSON-based configuration for routing and transformation

## Transformation Tables

### 1. Anthropic ↔ OpenAI Conversion

**File**: `claude-code-router-anthropic-to-openai.json`
**Reverse**: `claude-code-router-openai-to-anthropic.json`

#### Key Mappings:
- **Model Mapping**: Claude models → GPT models
  - `claude-3-5-sonnet-20241022` → `gpt-4o`
  - `claude-3-5-haiku-20241022` → `gpt-4o-mini`
  - `claude-3-opus-20240229` → `gpt-4-turbo`

- **Message Structure**: 
  - Anthropic: `{type: "text", text: "content"}`
  - OpenAI: `{role: "user", content: "content"}`

- **Tool Calling**:
  - Anthropic: `tool_use` with `input` object
  - OpenAI: `tool_calls` with `arguments` string

- **Streaming Events**:
  - `content_block_start` → `tool_calls_start`
  - `content_block_delta` → `tool_calls_delta`
  - `content_block_stop` → `tool_calls_stop`

### 2. Anthropic ↔ Gemini Conversion

**File**: `claude-code-router-anthropic-to-gemini.json`

#### Key Mappings:
- **Model Mapping**: Claude models → Gemini models
  - `claude-3-5-sonnet-20241022` → `gemini-1.5-pro`
  - `claude-3-5-haiku-20241022` → `gemini-1.5-flash`

- **Message Structure**:
  - Anthropic: `messages` array
  - Gemini: `contents` array with `parts`

- **Parameters**:
  - `max_tokens` → `generationConfig.maxOutputTokens`
  - `temperature` → `generationConfig.temperature`
  - `stop_sequences` → `generationConfig.stopSequences`

### 3. OpenAI → Compatible Providers

#### LMStudio
**File**: `claude-code-router-openai-to-lmstudio.json`
- **Direct Mapping**: LMStudio is fully OpenAI-compatible
- **No Transformation Needed**: Same API structure
- **Local Model Support**: Handles model loading dynamically

#### Ollama
**File**: `claude-code-router-openai-to-ollama.json`
- **Endpoint Changes**: `/v1/chat/completions` → `/api/chat`
- **Parameter Mapping**: `max_tokens` → `options.num_predict`
- **Stream Format**: JSON lines instead of SSE
- **No Authentication**: Removes API key requirements

#### Text Generation WebUI
**File**: `claude-code-router-openai-to-textgenwebui.json`
- **Full Compatibility**: OpenAI-compatible endpoints
- **Extended Parameters**: Additional generation parameters
- **Multiple Backends**: Supports various model backends

## Agent System Patterns

### Image Processing Agent
The Claude Code Router includes a specialized image processing agent:

```typescript
class ImageAgent implements IAgent {
  name = "image";
  tools: Map<string, ITool>;
  
  // Image caching mechanism
  private imageCache: ImageCache;
  
  // Tool: analyzeImage
  tools.set('analyzeImage', {
    name: "analyzeImage",
    description: "Analyse image or images by ID and extract information...",
    parameters: {
      imageId: "array of IDs to analyse",
      task: "detailed task description",
      regions: "optional regions of interest"
    }
  });
}
```

### Stream Processing
The router uses sophisticated stream processing:

```typescript
// SSE Parser Transform
class SSEParserTransform extends TransformStream<string, any> {
  // Parses Server-Sent Events into structured data
}

// SSE Serializer Transform  
class SSESerializerTransform extends TransformStream<any, string> {
  // Serializes structured data back to SSE format
}
```

## Configuration Patterns

### Router Configuration
```typescript
interface RouterConfig {
  providers: ProviderConfig[];
  HOST: string;
  PORT: number;
  APIKEY?: string;
  Router: {
    image?: string; // Image model for agent
    default?: string; // Default model
  };
}
```

### Agent Configuration
```typescript
interface AgentConfig {
  name: string;
  tools: Map<string, ITool>;
  shouldHandle: (req: any, config: any) => boolean;
  reqHandler: (req: any, config: any) => void;
}
```

## Transformation Patterns

### 1. Content Structure Conversion
- **Text Content**: Direct mapping with role/type conversion
- **Image Content**: URL/source format conversion with caching
- **Tool Content**: Function call format conversion

### 2. Parameter Mapping
- **Direct Mapping**: Same parameter name and value
- **Nested Mapping**: Parameter moved to nested object
- **Value Transformation**: Parameter value conversion
- **Array Processing**: Stop sequences and similar array parameters

### 3. Stream Event Mapping
- **Event Type Conversion**: Different event names for same concept
- **Data Structure Conversion**: Different data formats for same information
- **Tool Call Handling**: Special handling for tool calling in streams

### 4. Error Handling
- **Error Format**: Different error response structures
- **Error Codes**: Provider-specific error codes
- **Error Messages**: Human-readable error descriptions

## Best Practices

### 1. Model Mapping
- Use appropriate model equivalents
- Consider model capabilities and limitations
- Handle model-specific features

### 2. Message Structure
- Preserve conversation context
- Handle role conversions correctly
- Maintain message order and relationships

### 3. Tool Calling
- Convert function signatures appropriately
- Handle parameter serialization/deserialization
- Manage tool call IDs and references

### 4. Stream Processing
- Handle chunked responses correctly
- Maintain stream state and context
- Process events in correct order

### 5. Error Handling
- Provide meaningful error messages
- Handle provider-specific errors
- Maintain API compatibility

## Implementation Notes

### 1. Performance Considerations
- Use caching for frequently accessed data
- Minimize transformation overhead
- Optimize stream processing

### 2. Compatibility
- Test with multiple provider versions
- Handle API version differences
- Maintain backward compatibility

### 3. Extensibility
- Design for new providers
- Support custom transformations
- Allow configuration overrides

## Conclusion

The Claude Code Router demonstrates a sophisticated approach to LLM API conversion through its agent-based architecture. While it doesn't use static transformation tables, the patterns observed provide valuable insights for building similar systems. The key takeaways are:

1. **Dynamic Processing**: Handle conversions at runtime rather than static mappings
2. **Stream Processing**: Real-time transformation of streaming responses
3. **Agent Architecture**: Specialized agents for specific types of requests
4. **Configuration-Driven**: Flexible configuration system for routing and transformation
5. **Extensibility**: Design for adding new providers and features

These transformation tables serve as a reference for understanding the patterns and mappings needed for LLM API conversion, which can be adapted for other systems and use cases.