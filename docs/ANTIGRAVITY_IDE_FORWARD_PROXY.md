# Antigravity IDE → Local Forward Proxy (Best-effort Recording)

## Goal
Best-effort capture of Antigravity IDE network activity by forcing it through a local **forward proxy**:
- Always records **CONNECT targets** (host:port) + bytes + duration.
- Records **plaintext HTTP** method/url/status when it happens.
- Does **not** MITM TLS; HTTPS payloads remain encrypted.

This is intended for debugging only and does not modify RouteCodex runtime.

## 1) Start the proxy

Example (write JSONL logs to a file):

```bash
node scripts/antigravity-ide-forward-proxy.mjs --host 127.0.0.1 --port 8080 --log-file /tmp/antigravity-proxy.jsonl
```

Optional: record up to 4KB of plaintext HTTP request body:

```bash
node scripts/antigravity-ide-forward-proxy.mjs --port 8080 --record-body 1 --max-body-bytes 4096
```

Note: request headers are logged with basic redaction for `Authorization/Cookie/Proxy-Authorization`.

## 2) Configure Antigravity to use the proxy

Edit:

`~/Library/Application Support/Antigravity/User/settings.json`

Add:

```json
{
  "http.proxy": "http://127.0.0.1:8080",
  "http.proxySupport": "on"
}
```

Restart Antigravity IDE.

## 3) Verify locally (no IDE required)

HTTP (should log a `kind=http` entry):

```bash
curl -x http://127.0.0.1:8080 http://example.com -I
```

HTTPS (should log a `kind=connect` entry):

```bash
curl -x http://127.0.0.1:8080 https://example.com -I
```

## Limitations
- If Antigravity bypasses proxy for some traffic, you will see gaps.
- If Antigravity enforces stronger TLS pinning/attestation for some endpoints, you will only see CONNECT metadata (and sometimes not even that).

