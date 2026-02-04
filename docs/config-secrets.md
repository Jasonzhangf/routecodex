# Secrets in config (env-based)

RouteCodex configs are meant to be shareable (and can live in a repo). To avoid committing secrets, use environment variable references for API keys.

## Provider API keys (apikey auth)

Use an env reference in `auth.apiKey`:

```json
{
  "auth": { "type": "apikey", "apiKey": "${OPENAI_API_KEY}" }
}
```

Recommended env var naming follows the provider key:

- `openai` → `OPENAI_API_KEY`
- `glm` → `GLM_API_KEY`
- `tab` → `TAB_API_KEY`
- `tabglm` → `TABGLM_API_KEY`
- `kimi` → `KIMI_API_KEY`
- `modelscope` → `MODELSCOPE_API_KEY`
- `mimo` → `MIMO_API_KEY`

## HTTP server apikey (optional)

If you use `httpserver.apikey`, prefer an env reference:

```json
{
  "httpserver": { "apikey": "${ROUTECODEX_HTTP_APIKEY}" }
}
```

## Shell setup (zsh)

Add exports to `~/.zshrc`, then `source ~/.zshrc`:

```bash
export OPENAI_API_KEY='...'
export GLM_API_KEY='...'
export ROUTECODEX_HTTP_APIKEY='...'
```

## Notes

- Inline apikey values are still supported for local/dev usage, but not recommended for shared configs.
- `authfile-*` references are also supported (see daemon-admin credentials endpoints for generating authfile entries).

