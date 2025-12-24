# Multi-Token Authentication Guide

RouteCodex now supports multiple OAuth tokens per provider using a standardized naming convention.

## Token File Naming Convention

Token files must follow the pattern: `<provider>-oauth-<sequence>[-<alias>].json`

Examples:
- `iflow-oauth-1-primary.json` (sequence 1, alias "primary")
- `iflow-oauth-2-backup.json` (sequence 2, alias "backup")
- `qwen-oauth-1-work.json` (sequence 1, alias "work")

The `sequence` number determines the order in which tokens are used (1, 2, 3...).
The `alias` part is optional and ignored by the system - it's just for your reference.

## Automatic Discovery

The system automatically scans `~/.routecodex/auth/` for token files matching the pattern and creates multiple provider instances. No manual configuration needed.

## Authentication Commands

### Authenticate specific token:
```bash
# Token 1
IFLOW_TOKEN_FILE="$HOME/.routecodex/auth/iflow-oauth-1-primary.json" node scripts/auth-iflow-token-direct.mjs

# Token 2
IFLOW_TOKEN_FILE="$HOME/.routecodex/auth/iflow-oauth-2-backup.json" node scripts/auth-iflow-token-direct.mjs
```

### Manual authentication (if device flow fails):
```bash
IFLOW_TOKEN_FILE="$HOME/.routecodex/auth/iflow-oauth-1-primary.json" node scripts/auth-iflow-manual.mjs
```

### Delete and re-authenticate:
```bash
rm ~/.routecodex/auth/iflow-oauth-1-primary.json
IFLOW_TOKEN_FILE="$HOME/.routecodex/auth/iflow-oauth-1-primary.json" node scripts/auth-iflow-token-direct.mjs
```

## How It Works

1. On startup, RouteCodex scans for all token files matching the pattern
2. Each token becomes a separate provider instance with keyAlias = sequence number
3. Routing automatically includes all available tokens in round-robin order
4. If a token fails, the system tries the next one
5. Console logs show which token sequence is being used

## Troubleshooting

- **Token fails**: The system will automatically try the next token in sequence
- **Need to re-auth**: Delete the token file and run the auth command again
- **Wrong redirect**: The OAuth callback now shows a success page instead of redirecting to example.com

## Provider Support

Currently only iFlow supports multi-token authentication. Other providers will be added as needed.
