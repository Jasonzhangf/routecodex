# Hyper HTTP/1 parse-error response policy

Upstream: `hyper` 1.10.1, published crates.io archive `hyper-1.10.1.crate`.
Archive SHA-256: `55281c53a1894c864990125767da440a4e630446785086f52523b20033b74498`.
The upstream MIT license is preserved in `LICENSE`; upstream source and manifests
are imported verbatim except for these two Rust files:

- `src/server/conn/http1.rs`: `Builder::automatic_error_responses(bool)`, default
  true, copied into the native HTTP/1 connection.
- `src/proto/h1/conn.rs`: when false, return the original parse error after the
  existing HTTP/2 preface classification, without generating an HTTP error head.

RouteCodex Front always disables this automatic producer. Application responses,
parser acceptance, IO, serialization, keep-alive, 100 Continue and upgrades retain
upstream behavior. Other Hyper consumers retain the default policy.

Dependency ownership is the V3-local `[patch.crates-io]` entry, not a global
registry modification. The public Server framing black boxes and normal protocol
round trips must pass before changing this patch or upgrading its upstream base.
