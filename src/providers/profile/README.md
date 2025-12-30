# Provider Profile Module
## Overview
Provider profile module manages provider profiles, which define the capabilities and configurations for different AI providers. Profiles specify supported protocols, authentication methods, feature flags, and compatibility settings.
## Directory Structure
```src/providers/profile/
├── index. ts                  # Module entry point and exports
├── provider- profile. ts      # Provider profile definition and loading
└── __tests__/                 # Profile validation tests```## Key Components### ProviderProfileManages provider profiles that define:- Supported protocols (openai-chat, anthropic-messages, etc.)
- Authentication methods allowed
- Feature capabilities and limits- Compatibility profiles### ProviderProfileLoaderLoads and validates provider profiles from:- Configuration files
- Built-in profile store- User customizations## Usage```typescriptimport { ProviderProfileLoader } from './provider-profile-loader. js';const loader = new ProviderProfileLoader();const profile = await loader.load('openai');```## Related Documentation
- `src/providers/core/config/service-profiles. ts` - Service profile definitions
- `docs/CONFIG_ARCHITECTURE.md` - Configuration architecture guide
