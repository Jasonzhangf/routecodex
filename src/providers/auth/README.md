# Provider Auth Module
## Overview
Provider auth module contains authentication implementations for different providers, including API key, OAuth, and token file based authentication.## Directory Structure
```src/providers/auth/
├── index.ts                   # Module entry point and exports
├── apikey-auth. ts            # API key authentication implementation
├── tokenfile- auth. ts        # Token file based authentication
├── oauth-auth. ts             # OAuth base implementation
├── oauth-lifecycle. ts        # OAuth token lifecycle management
└── token-scanner/             # Token scanning and validation    └── index. ts            # Token scanner implementation```## Key Components### APIKeyAuth
Simple authentication using API keys from:- Environment variables- Auth files- Direct configuration### TokenfileAuthToken-based authentication supporting:- JSON token files
- Automatic token refresh- Multiple token management### OAuthAuthBase OAuth implementation providing:- Authorization flow orchestration
- Token storage and retrieval- Scope management## Usage```typescriptimport { APIKeyAuth } from './apikey-auth. js';const auth = new APIKeyAuth({ env: 'OPENAI_API_KEY' });```## Related Documentation
- `docs/oauth-authentication-guide. md` - OAuth guide
- `src/providers/core/strategies/` - OAuth strategy implementations
