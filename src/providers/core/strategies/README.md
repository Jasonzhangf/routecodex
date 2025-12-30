# Provider Core Strategies Module
## Overview
Provider core strategies module contains OAuth authentication strategy implementations for different provider requirements.
## Directory Structure
```src/providers/core/strategies/
├── oauth-auth-code-flow. ts    # Authorization Code OAuth flow implementation
├── oauth-device- flow. ts      # Device Flow OAuth for headless environments
└── oauth-hybrid-flow. ts       # Hybrid flow combining multiple auth methods```## Key Components### OAuthAuthCodeFlowStandard authorization code flow for web applications:- User authentication via browser redirect
- Authorization code exchange for tokens- Refresh token management### OAuthDeviceFlowDevice flow for headless environments:- User visits URL on separate device
- Device code polling for token issuance- Suitable for CLI tools and embedded devices### OAuthHybridFlowCombines multiple authentication methods:- Supports both API key and OAuth fallback
- Automatic method selection based on provider config## Usage```typescriptimport { OAuthAuthCodeFlow } from './oauth-auth-code-flow. js';const flow = new OAuthAuthCodeFlow(config);await flow.startAuthorization();```## Related Documentation
- `src/providers/core/config/oauth-flows. ts` - OAuth flow orchestration
- `docs/oauth-authentication-guide.md` - Complete OAuth guide
