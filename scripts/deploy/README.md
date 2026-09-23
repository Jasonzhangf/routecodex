# RouteCodex deployment scripts

Scripted cross-build of the V3 Linux binary and one-command deployment to the
managed claw host.

## Why this exists

Deploying V3 to the claw host previously required hand-running a local
`cargo zigbuild` and a long inline remote script. That made two things easy to
get wrong:

- **Wrong embedded version.** `cargo zigbuild` run without
  `ROUTECODEX_BUILD_VERSION` makes `routecodex-v3-config/build.rs` fall back to
  `source_package_version()`, which reads the **repository-root**
  `package.json`. That is a *different* version truth from `v3/package.json`,
  which every canonical V3 build path (`v3/scripts/build.mjs`,
  `install-cli.mjs`, `pack-release.mjs`) uses. The resulting binary reports a
  stale version in `--version` and in `/health.build_version`.
- **Drift between the authoring config and the runtime config.** The host needs
  every listener bound to loopback (public exposure is nginx' job), but the
  authoring config binds `0.0.0.0`.

Recorded evidence for the version defect, from the deployed host:

```text
/usr/local/bin/rccv3 --version                  -> rccv3 0.90.4601 (crate 0.1.0)
/usr/local/lib/rccv3/deployed-source-sha        -> 3f8b35145f30eab1247cb88bfa27ee53c7987047
git show 3f8b3514:v3/package.json    .version   -> 0.90.4803
git show 3f8b3514:package.json       .version   -> 0.90.4601   <- what build.rs read
```

So the deployed binary claimed `0.90.4601` while the deployed source was
`0.90.4803`. `build-linux-binary.sh` sets `ROUTECODEX_BUILD_VERSION` from the
snapshot's `v3/package.json` and refuses to publish an artifact that does not
embed that version, so this cannot recur.

## Files

| Path | Runs on | Owns |
| --- | --- | --- |
| `build-linux-binary.sh` | your Mac | committed snapshot -> verified Linux `rccv3` artifact + manifest |
| `project-claw-config.mjs` | your Mac | authoring config -> claw runtime config (loopback binds) + provider list |
| `remote-install-claw.sh` | the host | release dir, active binary, config, nginx, systemd, verification |
| `deploy-claw.sh` | your Mac | the whole pipeline, end to end |

All shell scripts are POSIX `sh`. `scripts/verify-fast.mjs` runs `sh -n` over
changed shell files and `/bin/sh` is `dash` on the Linux CI runner, so bashisms
(array literals, `[[ ]]`, process substitution, `pipefail`) fail the gate.

## Configuration

Host, domain and key material are **not** in this repository (it is public).
They are read from `$RCC_DEPLOY_ENV`, default
`~/.config/routecodex/claw-deploy.env`, which must be mode `0600`:

```sh
RCC_CLAW_HOST=<host>
RCC_CLAW_USER=root
RCC_CLAW_DOMAIN=<public domain>
RCC_CLAW_SSH_KEY=$HOME/.ssh/claw.pem
RCC_HOME=$HOME/.rcc
RCC_UPSTREAM_PORT=4444
RCC_NGINX_CONF=/etc/nginx/conf.d/<edge>.conf
RCC_HOST_SYMLINKS="<path-a> <path-b>"
```

The edge API key lives at `~/.config/routecodex/claw-api-key` (mode `0600`) and
is generated on first run if absent. The deployer fails if the env file is
group/world readable.

## Usage

```sh
# 1. build the Linux binary only
scripts/deploy/build-linux-binary.sh
# -> v3/artifacts/deploy/linux-x86_64/{rccv3,rccv3.sha256,build-manifest.json}

# 2. preview the full deployment without touching the host
scripts/deploy/deploy-claw.sh --dry-run

# 3. deploy
scripts/deploy/deploy-claw.sh

# deploy a specific commit
scripts/deploy/deploy-claw.sh --ref <commit-ish>
```

`deploy-claw.sh` refuses to run on a dirty working tree only as a warning: it
always builds from `git archive <commit>`, so uncommitted edits can never reach
the host.

`--skip-build` reuses an existing artifact and requires `RCC_SKIP_BUILD_ARTIFACT`
(a path to a built `rccv3`) plus `RCC_SKIP_BUILD_VERSION` to be set in the
environment.

## Deployment layout on the host

```text
/opt/rcc/releases/<source-sha>/rccv3     immutable per-commit binary
/usr/local/bin/rccv3                     active binary
/usr/local/lib/rccv3/deployed-source-sha active source commit marker
/etc/rcc/config.toml                     projected runtime config (loopback binds)
/etc/rcc/provider/<id>/config.v2.toml    provider configs for referenced providers
/etc/rcc/secrets/v3/provider-auth.conf   provider credentials
/etc/rcc/certs/{fullchain,privkey}.pem   ACME certificate
$RCC_NGINX_CONF                          edge vhost (nginx)
/etc/systemd/system/rccv3.service
```

The paths in `$RCC_HOST_SYMLINKS` are symlinked to `/etc/rcc` on the host,
matching the absolute `secretFile` paths recorded in the provider configs.

## Fail-closed behaviour

The deployer aborts before mutating anything when:

- the env file is missing, symlinked, or not mode `0600`
- the edge key is not one 64-character hex string
- `project-claw-config.mjs` finds a server table without exactly one `bind` or
  `port`, no server table, or no referenced provider
- the projected config still binds a non-loopback address (an unrecognized
  root server table would otherwise keep its authoring bind)
- a referenced provider config is missing
- the projected config fails `rccv3 config check`
- the cross build produces no artifact, a non-ELF artifact, or an artifact that
  does not embed the expected version

The remote installer aborts before mutating when a path it would overwrite is
not marked as managed by this deployer, and after mutating it rolls back and
aborts when:

- `nginx -t` rejects the generated config
- `rccv3 config check` rejects the deployed config
- `rccv3.service` or `nginx` is not active
- any configured `[servers.*]` listener never reports `status: ok`
- any listener reports a `build_version` different from the deployed version
- the edge returns anything but `200` authenticated `/v1/models`, `401`
  unauthenticated, and `403` for `/_routecodex/*`

Every file it replaces is backed up with a UTC stamp (`.bak-<stamp>`).

## Verification

`build-linux-binary.sh` is a pure local build. `deploy-claw.sh --dry-run`
proves config projection and local validation without remote mutation. Only a
real `deploy-claw.sh` run proves install, restart, health and edge behaviour;
source tests, a candidate artifact, or a dry run never substitute for it.
