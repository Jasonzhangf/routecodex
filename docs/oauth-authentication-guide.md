# Unified OAuth Authentication System Guide

## Overview

The Unified OAuth Authentication System provides a comprehensive solution for managing authentication across multiple AI service providers. It supports both static token files and dynamic OAuth 2.0 flows with automatic token refresh, PKCE security, and unified configuration management.

## Architecture

### Core Components

1. **OAuthConfigManager** - Centralized configuration management
2. **BaseOAuthManager** - Abstract base class for OAuth implementations
3. **Provider-specific Managers** - QwenOAuthManager and iFlowOAuthManager
4. **AuthResolver** - Unified token resolution supporting both static and OAuth
5. **UserConfigParser** - Extended to support OAuth configuration parsing

### Authentication Flow

```
Request → Provider → AuthResolver → OAuth Manager → Token Resolution → Response
```

## Configuration

### OAuth Configuration

OAuth configurations are defined in the provider configuration under the `oauth` section:

```json
{
  "providers": {
    "qwen-provider": {
      "type": "qwen-http",
      "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": ["auth-qwen-oauth-config"],
      "oauth": {
        "qwen-oauth-config": {
          "clientId": "your-client-id",
          "clientSecret": "your-client-secret",
          "authUrl": "https://dashscope.aliyuncs.com/api/v1/oauth/authorize",
          "tokenUrl": "https://dashscope.aliyuncs.com/api/v1/oauth/token",
          "deviceCodeUrl": "https://dashscope.aliyuncs.com/api/v1/oauth/device_code",
          "scopes": ["openid", "profile", "api"],
          "enablePKCE": true,
          "apiBaseUrl": "https://dashscope.aliyuncs.com"
        }
      }
    }
  }
}
```

### Auth ID Patterns

- **Static tokens**: `auth-config-name`
- **OAuth tokens**: `auth-provider-config-name` (e.g., `auth-qwen-oauth-config`)

## Provider-Specific Implementations

### Qwen OAuth Manager

The Qwen OAuth Manager supports:

- **Device Flow** with PKCE security
- **API Key authentication** as fallback
- **Automatic token refresh**
- **JWT token parsing** for expiry information

#### Configuration Example

```typescript
const qwenConfig = {
  clientId: 'your-qwen-client-id',
  clientSecret: 'your-qwen-client-secret',
  authUrl: 'https://dashscope.aliyuncs.com/api/v1/oauth/authorize',
  tokenUrl: 'https://dashscope.aliyuncs.com/api/v1/oauth/token',
  deviceCodeUrl: 'https://dashscope.aliyuncs.com/api/v1/oauth/device_code',
  scopes: ['openid', 'profile', 'api'],
  enablePKCE: true,
  apiBaseUrl: 'https://dashscope.aliyuncs.com'
};
```

### iFlow OAuth Manager

The iFlow OAuth Manager supports:

- **Device Flow** with PKCE security
- **Legacy credentials file** compatibility
- **Automatic token refresh**
- **Fallback to existing credentials**

#### Configuration Example

```typescript
const iflowConfig = {
  clientId: '10009311001',
  clientSecret: '4Z3YjXycVsQvyGF1etiNlIBB4RsqSDtW',
  authUrl: 'https://iflow.cn/oauth',
  tokenUrl: 'https://iflow.cn/oauth/token',
  deviceCodeUrl: 'https://iflow.cn/oauth/device/code',
  scopes: ['openid', 'profile', 'api'],
  enablePKCE: true,
  useLegacyCredentials: true,
  apiBaseUrl: 'https://api.iflow.cn/v1'
};
```

## Usage

### Basic Usage

```typescript
import { AuthResolver } from './src/modules/pipeline/utils/auth-resolver.js';
import { QwenOAuthManager } from './src/modules/pipeline/utils/qwen-oauth-manager.js';
import { iFlowOAuthManager } from './src/modules/pipeline/utils/iflow-oauth-manager.js';
import { PipelineDebugLogger } from './src/modules/pipeline/utils/debug-logger.js';

// Initialize logger
const logger = new PipelineDebugLogger('oauth-test');

// Create OAuth managers
const qwenManager = new QwenOAuthManager(logger, qwenConfig);
const iflowManager = new iFlowOAuthManager(logger, iflowConfig);

// Create auth resolver
const authResolver = new AuthResolver({}, logger);

// Register OAuth managers
authResolver.registerOAuthProvider('qwen', qwenManager);
authResolver.registerOAuthProvider('iflow', iflowManager);

// Resolve tokens
const qwenToken = await authResolver.resolveToken('auth-qwen-config');
const iflowToken = await authResolver.resolveToken('auth-iflow-config');
```

### Integration with Providers

The Qwen HTTP Provider and iFlow Provider have been updated to automatically use the unified authentication system:

```typescript
// Provider automatically detects OAuth configuration
const qwenProvider = new QwenHTTPProvider(config, dependencies);
const iflowProvider = new iFlowProvider(config, dependencies);

// Authentication is handled automatically
const response = await qwenProvider.processIncoming(request);
```

## Authentication Flows

### Device Flow with PKCE

1. **Generate PKCE Codes**: Create code verifier and challenge
2. **Request Device Code**: Get device code and user code
3. **User Authentication**: User visits verification URL and enters code
4. **Token Polling**: Poll for access token using device code
5. **Token Storage**: Store token securely with expiry information

### Token Refresh

1. **Expiry Check**: Check if token is about to expire
2. **Refresh Request**: Use refresh token to get new access token
3. **Update Storage**: Store new token with updated expiry
4. **Update Context**: Update in-memory authentication context

### Static Token Fallback

1. **File Detection**: Detect if auth ID corresponds to static file
2. **Token Reading**: Read token from configured file path
3. **Caching**: Cache token for performance
4. **Validation**: Optional token validation with provider

## Security Features

### PKCE (Proof Key for Code Exchange)

- **Code Verifier**: Random 32-byte string
- **Code Challenge**: SHA256 hash of verifier
- **Method**: S256 (SHA256)
- **Security**: Prevents authorization code interception attacks

### Token Security

- **Secure Storage**: Tokens stored in user's home directory
- **Automatic Refresh**: Tokens refreshed before expiry
- **Revocation**: Support for token revocation and cleanup
- **Minimal Exposure**: Tokens only exposed when necessary

### Configuration Security

- **Sensitive Data**: Client secrets and tokens are encrypted at rest
- **Access Control**: Configuration files have restricted permissions
- **Environment Variables**: Support for environment-based configuration

## Error Handling

### Common Errors

1. **Authentication Failed**: Invalid credentials or configuration
2. **Token Expired**: Token has expired and refresh failed
3. **Network Error**: Cannot reach OAuth provider
4. **Configuration Error**: Invalid OAuth configuration
5. **Device Code Expired**: User did not authenticate in time

### Error Recovery

1. **Retry Logic**: Automatic retry for transient errors
2. **Fallback**: Fallback to static tokens if OAuth fails
3. **Re-authentication**: Trigger new OAuth flow if refresh fails
4. **Configuration Validation**: Validate configuration before use

## Testing

### Test Script

Run the comprehensive test suite:

```bash
node examples/test-oauth-system.mjs
```

### Test Coverage

- OAuth Configuration Manager
- Provider-specific OAuth Managers
- Auth Resolver Integration
- Token Resolution
- Auth Context Management
- Cleanup and Resource Management

## Migration Guide

### From Static Tokens

1. **Update Configuration**: Add OAuth configuration to provider settings
2. **Update Auth IDs**: Change from static auth IDs to OAuth auth IDs
3. **Update Dependencies**: Ensure OAuth managers are imported and registered
4. **Test Authentication**: Verify OAuth flows work correctly

### From Legacy OAuth

1. **Update Provider**: Use new unified OAuth managers
2. **Update Configuration**: Migrate to new OAuth configuration format
3. **Update Auth Resolution**: Use AuthResolver instead of direct OAuth calls
4. **Test Compatibility**: Verify existing functionality still works

## Troubleshooting

### Common Issues

1. **OAuth Flow Not Triggered**
   - Verify auth ID pattern: `auth-provider-config`
   - Check OAuth manager registration
   - Verify configuration syntax

2. **Token Refresh Fails**
   - Check refresh token availability
   - Verify refresh token URL
   - Check network connectivity

3. **Authentication Errors**
   - Verify client credentials
   - Check OAuth scopes
   - Verify redirect URIs

4. **Configuration Errors**
   - Validate JSON syntax
   - Check required fields
   - Verify file permissions

### Debug Logging

Enable debug logging to troubleshoot issues:

```typescript
const logger = new PipelineDebugLogger('oauth-test', { level: 'debug' });
```

## Performance Considerations

### Token Caching

- **Memory Cache**: Tokens cached in memory for performance
- **File Cache**: Tokens persisted to disk for reuse
- **Cache Invalidation**: Automatic cache invalidation on expiry

### Concurrent Access

- **Authentication Lock**: Prevent concurrent authentication attempts
- **Token Refresh**: Atomic token refresh operations
- **Thread Safety**: Safe for use in multi-threaded environments

## Future Enhancements

### Planned Features

1. **Additional Providers**: Support for more OAuth providers
2. **Advanced Flows**: Authorization code flow with web server
3. **Token Encryption**: Enhanced token encryption at rest
4. **Metrics**: Authentication metrics and monitoring
5. **Web UI**: Web-based authentication interface

### Extensibility

The system is designed to be easily extensible:

1. **New Providers**: Extend BaseOAuthManager
2. **Custom Flows**: Implement custom authentication flows
3. **Plugin System**: Support for third-party authentication plugins
4. **Configuration Sources**: Support for additional configuration sources

## Contributing

### Development Setup

1. **Install Dependencies**: `npm install`
2. **Run Tests**: `npm test`
3. **Lint Code**: `npm run lint`
4. **Build**: `npm run build`

### Code Standards

- **TypeScript**: Use TypeScript for all new code
- **ES Modules**: Use ES module syntax
- **Documentation**: Document all public APIs
- **Testing**: Write comprehensive tests

## License

This project is licensed under the MIT License. See LICENSE file for details.