# RouteCodex Pass-Through Implementation

This document describes the pass-through implementation for RouteCodex, which forwards OpenAI API requests to a target server without implementing complex provider logic.

## Architecture Overview

The pass-through implementation consists of the following key components:

### 1. HTTP Server (`src/server/http-server.ts`)
- Express.js-based HTTP server with middleware setup
- Health check endpoints (`/health`, `/metrics`, `/ready`, `/live`)
- Error handling and logging integration
- Graceful shutdown support
- CORS and security headers configuration

### 2. OpenAI Router (`src/server/openai-router.ts`)
- OpenAI API v1 compatibility endpoints
- Request validation and forwarding
- Streaming support for chat completions
- Comprehensive error mapping
- Pass-through to target server

### 3. Pass-Through Provider (`src/providers/pass-through-provider.ts`)
- Simple provider that forwards requests to target URL
- Health check and connectivity testing
- Request/response logging
- Error handling and retry logic
- Statistics tracking

### 4. Core Components
- **Config Manager**: Configuration loading and validation
- **Request Handler**: Request validation and preprocessing
- **Response Handler**: Response formatting and error handling
- **Provider Manager**: Provider lifecycle management (simplified for pass-through)

## Configuration

The system uses a JSON configuration file (`routecodex.json`) with the following structure:

```json
{
  "version": "1.0.0",
  "server": {
    "port": 5506,
    "host": "localhost",
    "cors": {
      "origin": "*",
      "credentials": true
    },
    "timeout": 30000,
    "bodyLimit": "10mb"
  },
  "logging": {
    "level": "info",
    "enableConsole": true,
    "enableFile": false,
    "categories": ["server", "api", "request", "config", "error", "message"]
  },
  "providers": {
    "openai-passthrough": {
      "type": "custom",
      "enabled": true,
      "baseUrl": "https://api.openai.com/v1",
      "models": {
        "gpt-3.5-turbo": {
          "maxTokens": 4096,
          "enabled": true
        },
        "gpt-4": {
          "maxTokens": 8192,
          "enabled": true
        }
      }
    }
  },
  "routing": {
    "strategy": "round-robin",
    "timeout": 30000,
    "retryAttempts": 3
  },
  "passthrough": {
    "enabled": true,
    "targetUrl": "https://api.openai.com/v1",
    "timeout": 30000,
    "retryAttempts": 3,
    "enableHealthCheck": true
  }
}
```

## Features

### OpenAI API Compatibility
- **Chat Completions**: `/v1/chat/completions`
- **Completions**: `/v1/completions`
- **Models**: `/v1/models` and `/v1/models/{model}`
- **Embeddings**: `/v1/embeddings`
- **Moderations**: `/v1/moderations`
- **Image Generations**: `/v1/images/generations`
- **Audio Translations/Transcriptions**: `/v1/audio/translations`, `/v1/audio/transcriptions`

### Health and Monitoring
- **Health Checks**: `/health`, `/healthz`, `/ready`, `/live`
- **Metrics**: `/metrics` with server and provider statistics
- **Configuration**: `/config` (sanitized view)
- **Debug Info**: `/debug` (development mode only)

### Error Handling
- Comprehensive error logging and reporting
- Graceful degradation when target is unavailable
- Fallback responses for critical endpoints
- Integration with RCC error handling system

### Security
- CORS configuration
- Security headers (Helmet.js)
- Request validation
- Header sanitization for logging
- Rate limiting support (configurable)

## Usage

### Starting the Server

```bash
# Using Node.js
node dist/index.js

# Using npm script
npm start

# Using development mode
npm run dev

# With custom config file
node dist/index.js /path/to/config.json
```

### Making Requests

Once the server is running, you can make OpenAI-compatible requests:

```bash
# Chat completion
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# List models
curl -X GET http://localhost:5506/v1/models \
  -H "Authorization: Bearer your-api-key"

# Health check
curl -X GET http://localhost:5506/health
```

### Streaming Support

The server supports streaming responses:

```bash
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Tell me a story"}],
    "stream": true
  }'
```

## Integration Points

### RCC Base Module Integration
- All components extend BaseModule for consistent lifecycle management
- Debug event publishing for monitoring and debugging
- Module health and status reporting

### RCC Error Handling Integration
- Centralized error handling with ErrorHandlingCenter
- Contextual error reporting
- Error severity classification

### RCC Debug Center Integration
- Comprehensive event logging
- Request/response lifecycle tracking
- Performance monitoring

## Testing

The implementation includes several test endpoints:

- **Error Testing**: `/test-error` - Tests error handling flow
- **Configuration Testing**: `/config` - Validates configuration loading
- **Health Testing**: `/health`, `/ready`, `/live` - Tests system health

## Future Enhancements

This pass-through implementation is designed to be replaced by a full pipeline system. Key areas for future enhancement:

1. **Pipeline System**: Replace simple pass-through with configurable request processing pipelines
2. **Multiple Providers**: Support for multiple AI providers with intelligent routing
3. **Advanced Features**: Caching, rate limiting, request transformation
4. **Monitoring**: Enhanced metrics and observability
5. **Security**: Authentication, authorization, and request validation

## Configuration Options

### Server Configuration
- `port`: Server port (default: 5506)
- `host`: Server host (default: localhost)
- `cors`: CORS configuration
- `timeout`: Request timeout in milliseconds
- `bodyLimit`: Maximum request body size

### Pass-Through Configuration
- `targetUrl`: Target server URL for forwarding
- `timeout`: Request timeout for target server
- `retryAttempts`: Number of retry attempts for failed requests
- `enableHealthCheck`: Enable connectivity checks

### Logging Configuration
- `level`: Log level (debug, info, warn, error)
- `enableConsole`: Enable console logging
- `enableFile`: Enable file logging
- `categories`: Log categories to enable

## Troubleshooting

### Common Issues

1. **Server fails to start**: Check configuration file syntax and port availability
2. **Target server unreachable**: Verify `targetUrl` and network connectivity
3. **Authentication failures**: Ensure API keys are properly forwarded
4. **CORS issues**: Check CORS configuration in server settings

### Debug Mode

Enable debug logging by setting log level to 'debug' in configuration:

```json
{
  "logging": {
    "level": "debug",
    "enableConsole": true
  }
}
```

### Health Check Failures

If health checks fail, check:
- Target server connectivity
- Network connectivity
- API key validity
- Request timeout settings