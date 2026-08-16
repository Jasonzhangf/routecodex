# V3 Provider Auth Key-File Expansion Test Design

## Contract

`routecodex-v3-config` is the only owner that reads provider `secretFile` authoring and
expands key names into existing manifest auth handles. Runtime, Server, Target, Virtual
Router, and provider transport remain consumers of `V3Config05ManifestPublished` and do
not enumerate files or reconstruct auth configuration.

Supported provider auth authoring:

```toml
[provider.auth]
type = "apikey"
secretFile = "/path/to/provider.conf"
```

Supported key-file shapes:

```text
opencode-go = <secret>
```

or:

```text
opencode-go.key1 = <secret>
opencode-go.key2 = <secret>
```

A provider-local file may also use unscoped aliases such as `key1` and `key2`.
Only alias and exact key name enter auth handles. Secret values never enter the
published manifest, Debug, Error, provider payload, or client payload.

## Positive tests

- Single scoped key expands to alias `key1` and retains the exact file key name.
- Multiple scoped keys expand in file order and ignore keys scoped to another provider.
- Provider-local unscoped aliases expand without requiring provider config entries.
- Existing explicit `entries`, `apiKey`, `env`, and `tokenFile` authoring remains valid
  when `secretFile` auto-discovery is absent.
- The compiled manifest entries contain `secret_file + secret_key` handles and no
  materialized `api_key` value.

## Negative tests

- Empty provider id, empty file, malformed line, empty key, empty value, duplicate key,
  or duplicate derived alias fails at config compile time.
- Top-level `secretFile` mixed with explicit `entries`, `apiKey`, `env`, or `tokenFile`
  fails instead of choosing one source.
- Unreadable `secretFile` fails with a config validation error.

## Integration and live proof

1. Run the focused discovery/compiler tests and the complete `routecodex-v3-config`
   crate test suite.
2. Run config/resource/module/function-map architecture gates and diff check.
3. Install the matching global V3 binary.
4. Replace repeated OpenCode Go auth entries with one provider `secretFile` reference,
   run global `routecodex config check`, then aggregate `routecodex restart`.
5. Verify every configured listener health and use provider-request dry-run / live route
   evidence to prove multiple aliases were expanded without exposing secret values.
