#!/bin/sh
# One-command RouteCodex V3 deployment to the managed claw host.
#
# Pipeline:
#   1. resolve the local deploy environment (host/domain/key, never committed)
#   2. cross-build the Linux binary from a committed snapshot (build-linux-binary.sh)
#   3. project the authoring config into the claw runtime config
#      (project-claw-config.mjs) and validate it before it leaves this machine
#   4. stage binary + projected config + provider configs + edge key on the host
#   5. install, restart and verify through remote-install-claw.sh
#
# The repository is public, so this script contains no host, domain or key
# material. Those come from $RCC_DEPLOY_ENV (default
# ~/.config/routecodex/claw-deploy.env, mode 0600) which is not tracked.
# See scripts/deploy/README.md.
#
# POSIX sh only: scripts/verify-fast.mjs runs `sh -n` over changed shell files
# and /bin/sh is dash on the Linux CI runner.
#
# Usage:
#   scripts/deploy/deploy-claw.sh [--ref <commit-ish>] [--dry-run] [--skip-build]

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

RCC_DEPLOY_ENV=${RCC_DEPLOY_ENV:-"$HOME/.config/routecodex/claw-deploy.env"}
REF=origin/main
DRY_RUN=0
SKIP_BUILD=0

die() {
  printf '[deploy-claw] FAIL %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[deploy-claw] %s\n' "$*"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      [ "$#" -ge 2 ] || die "--ref requires a value"
      REF=$2
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    *)
      die "unsupported argument: $1"
      ;;
  esac
done

# --- local deploy environment ----------------------------------------------
[ -f "$RCC_DEPLOY_ENV" ] || die "deploy env missing: $RCC_DEPLOY_ENV (see scripts/deploy/README.md)"
[ ! -L "$RCC_DEPLOY_ENV" ] || die "deploy env must not be a symlink: $RCC_DEPLOY_ENV"

ENV_MODE=$(ls -l "$RCC_DEPLOY_ENV" | cut -c1-10)
case "$ENV_MODE" in
  -rw-------) ;;
  *) die "deploy env must be mode 0600, got $ENV_MODE: $RCC_DEPLOY_ENV" ;;
esac

# shellcheck disable=SC1090
. "$RCC_DEPLOY_ENV"

: "${RCC_CLAW_HOST:?RCC_CLAW_HOST must be set in $RCC_DEPLOY_ENV}"
: "${RCC_CLAW_USER:?RCC_CLAW_USER must be set in $RCC_DEPLOY_ENV}"
: "${RCC_CLAW_DOMAIN:?RCC_CLAW_DOMAIN must be set in $RCC_DEPLOY_ENV}"

RCC_CLAW_SSH_KEY=${RCC_CLAW_SSH_KEY:-"$HOME/.ssh/claw.pem"}
RCC_HOME=${RCC_HOME:-"$HOME/.rcc"}
RCC_UPSTREAM_PORT=${RCC_UPSTREAM_PORT:-4444}
RCC_EDGE_KEY_FILE=${RCC_EDGE_KEY_FILE:-"$HOME/.config/routecodex/claw-api-key"}
# Host facts with no safe generic default: the edge vhost path and the host
# paths that must resolve to the runtime config dir.
: "${RCC_NGINX_CONF:?RCC_NGINX_CONF must be set in $RCC_DEPLOY_ENV}"
: "${RCC_HOST_SYMLINKS:?RCC_HOST_SYMLINKS must be set in $RCC_DEPLOY_ENV}"

[ -f "$RCC_CLAW_SSH_KEY" ] || die "SSH key missing: $RCC_CLAW_SSH_KEY"
[ -f "$RCC_HOME/config.toml" ] || die "authoring config missing: $RCC_HOME/config.toml"
[ -f "$RCC_HOME/secrets/v3/provider-auth.conf" ] || die "provider secret file missing: $RCC_HOME/secrets/v3/provider-auth.conf"
[ -d "$RCC_HOME/provider" ] || die "provider config directory missing: $RCC_HOME/provider"
command -v ssh >/dev/null 2>&1 || die "ssh is required"
command -v scp >/dev/null 2>&1 || die "scp is required"
command -v node >/dev/null 2>&1 || die "node is required"
command -v openssl >/dev/null 2>&1 || die "openssl is required"
command -v rccv3 >/dev/null 2>&1 || die "rccv3 is required to validate the projected config"
command -v tar >/dev/null 2>&1 || die "tar is required"

ssh_run() {
  ssh -i "$RCC_CLAW_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
    "$RCC_CLAW_USER@$RCC_CLAW_HOST" "$@"
}

scp_run() {
  scp -i "$RCC_CLAW_SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$@"
}

# --- edge key ---------------------------------------------------------------
install -d -m 0700 "$(dirname "$RCC_EDGE_KEY_FILE")"
if [ ! -e "$RCC_EDGE_KEY_FILE" ]; then
  log "generating edge API key at $RCC_EDGE_KEY_FILE"
  openssl rand -hex 32 > "$RCC_EDGE_KEY_FILE"
fi
[ -f "$RCC_EDGE_KEY_FILE" ] || die "invalid edge key path: $RCC_EDGE_KEY_FILE"
chmod 600 "$RCC_EDGE_KEY_FILE"
EDGE_KEY=$(cat "$RCC_EDGE_KEY_FILE")
case "$EDGE_KEY" in
  *[!0-9a-f]*|'') die "edge key must be one 64-character hex key" ;;
esac
[ ${#EDGE_KEY} -eq 64 ] || die "edge key must be one 64-character hex key"

# --- resolve ref ------------------------------------------------------------
git -C "$REPO_ROOT" fetch --quiet origin main 2>/dev/null || true
SOURCE_SHA=$(git -C "$REPO_ROOT" rev-parse --verify "$REF^{commit}") \
  || die "cannot resolve ref to a commit: $REF"

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN ref=$REF sha=$SOURCE_SHA host=$RCC_CLAW_HOST domain=$RCC_CLAW_DOMAIN port=$RCC_UPSTREAM_PORT"
fi

WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/rcc-claw-deploy.XXXXXX")
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

# --- build ------------------------------------------------------------------
ARTIFACT="$WORK_DIR/artifact/rccv3"
if [ "$SKIP_BUILD" -eq 1 ]; then
  [ -n "${RCC_SKIP_BUILD_ARTIFACT:-}" ] \
    || die "--skip-build requires RCC_SKIP_BUILD_ARTIFACT to point at an existing rccv3"
  [ -f "$RCC_SKIP_BUILD_ARTIFACT" ] || die "RCC_SKIP_BUILD_ARTIFACT is not a file: $RCC_SKIP_BUILD_ARTIFACT"
  install -d -m 0700 "$WORK_DIR/artifact"
  cp "$RCC_SKIP_BUILD_ARTIFACT" "$ARTIFACT"
  chmod 0755 "$ARTIFACT"
  VERSION=${RCC_SKIP_BUILD_VERSION:?--skip-build requires RCC_SKIP_BUILD_VERSION}
  log "reusing prebuilt artifact version=$VERSION"
else
  log "building Linux binary from $SOURCE_SHA"
  sh "$SCRIPT_DIR/build-linux-binary.sh" --ref "$SOURCE_SHA" --out "$WORK_DIR/artifact" \
    || die "local cross build failed"
  VERSION=$(node -p "require('$WORK_DIR/artifact/build-manifest.json').version") \
    || die "cannot read built version"
  ARTIFACT="$WORK_DIR/artifact/rccv3"
  [ -f "$ARTIFACT" ] || die "build produced no artifact"
fi

ARTIFACT_SHA=$(shasum -a 256 "$ARTIFACT" | cut -d' ' -f1)
log "artifact version=$VERSION sha256=$ARTIFACT_SHA"

# --- project and validate the runtime config --------------------------------
# The stage directory mirrors the host runtime root exactly: `rccv3 config
# check` resolves `provider/` relative to the config's parent directory, so the
# projected config must be validated from the layout it will actually run in.
STAGE_DIR="$WORK_DIR/stage"
mkdir -p "$STAGE_DIR/secrets/v3" "$STAGE_DIR/provider"

PROJECTION=$(node "$SCRIPT_DIR/project-claw-config.mjs" \
  --input "$RCC_HOME/config.toml" \
  --output "$STAGE_DIR/config.toml" \
  --bind 127.0.0.1 \
  --providers-dir "$RCC_HOME/provider") \
  || die "config projection failed"

PROVIDERS=$(printf '%s\n' "$PROJECTION" | grep '^provider=' | cut -d= -f2 | sort -u)
[ -n "$PROVIDERS" ] || die "config projection reported no providers"

# The projection reports the exact [servers.<id>] listener ports. They are
# passed to the host verbatim so health checks never probe a port that does not
# serve /health (for example a declared admin/webui port).
SERVER_PORTS=$(printf '%s\n' "$PROJECTION" | grep '^port=' | cut -d= -f2)
[ -n "$SERVER_PORTS" ] || die "config projection reported no listener ports"
SERVER_PORTS=$(printf '%s' "$SERVER_PORTS" | tr '\n' ' ')

log "projected providers: $(printf '%s' "$PROVIDERS" | tr '\n' ' ')"
log "projected listener ports: $SERVER_PORTS"

cp -a "$RCC_HOME/secrets/v3/provider-auth.conf" "$STAGE_DIR/secrets/v3/provider-auth.conf"
for provider in $PROVIDERS; do
  cp -a "$RCC_HOME/provider/$provider" "$STAGE_DIR/provider/$provider"
done
cp -a "$RCC_EDGE_KEY_FILE" "$STAGE_DIR/edge-api-key"
chmod 0600 "$STAGE_DIR/edge-api-key"

rccv3 config check -c "$STAGE_DIR/config.toml" || die "projected config failed local validation"
log "projected config validated locally"

# --- stage on the host ------------------------------------------------------
REMOTE_STAGE="/var/tmp/rcc-claw-deploy-$SOURCE_SHA-$$"

STAGE_TAR="$WORK_DIR/runtime.tar"

# `tar | ssh` cannot use `pipefail` under POSIX sh, so the archive is written
# and verified locally, then copied as a file. `COPYFILE_DISABLE` and the
# libarchive xattr suppression keep macOS extended attributes out of the
# archive, which GNU tar on the host otherwise reports as unknown keywords.
COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -C "$STAGE_DIR" -cf "$STAGE_TAR" . \
  || die "failed to create staging archive"
tar -tf "$STAGE_TAR" >/dev/null || die "staging archive is unreadable"
[ -s "$STAGE_TAR" ] || die "staging archive is empty"

if [ "$DRY_RUN" -eq 1 ]; then
  log "DRY-RUN would stage sha=$SOURCE_SHA version=$VERSION to $REMOTE_STAGE"
  log "DRY-RUN would install and verify https://$RCC_CLAW_DOMAIN/v1 via 127.0.0.1:$RCC_UPSTREAM_PORT"
  log "DRY-RUN OK (no remote mutation)"
  printf 'dry_run=1\nsource_sha=%s\nversion=%s\nsha256=%s\n' "$SOURCE_SHA" "$VERSION" "$ARTIFACT_SHA"
  exit 0
fi

log "creating remote stage $REMOTE_STAGE"
ssh_run "test ! -e '$REMOTE_STAGE' && install -d -m 0700 '$REMOTE_STAGE/bin' '$REMOTE_STAGE/runtime' && touch '$REMOTE_STAGE/.created-by-deploy-claw'" \
  || die "failed to create remote stage (does it already exist?)"

scp_run "$ARTIFACT" "$RCC_CLAW_USER@$RCC_CLAW_HOST:$REMOTE_STAGE/bin/rccv3" \
  || die "failed to copy binary"
scp_run "$STAGE_TAR" "$RCC_CLAW_USER@$RCC_CLAW_HOST:$REMOTE_STAGE/runtime.tar" \
  || die "failed to copy staging archive"

ssh_run "tar --no-same-owner -xf '$REMOTE_STAGE/runtime.tar' -C '$REMOTE_STAGE/runtime' && rm -f '$REMOTE_STAGE/runtime.tar'" \
  || die "failed to unpack staging archive on the host"

# --- install ----------------------------------------------------------------
log "installing on $RCC_CLAW_HOST"
INSTALL_OUT=$(ssh_run "sh -s -- '$SOURCE_SHA' '$VERSION' '$REMOTE_STAGE' '$RCC_CLAW_DOMAIN' '$RCC_UPSTREAM_PORT' '$RCC_NGINX_CONF' '$RCC_HOST_SYMLINKS' '$SERVER_PORTS'" \
  < "$SCRIPT_DIR/remote-install-claw.sh") \
  || die "remote install failed"
printf '%s\n' "$INSTALL_OUT" | sed 's/^/[deploy-claw] host: /'

log "OK version=$VERSION sha=$SOURCE_SHA sha256=$ARTIFACT_SHA"
printf 'base_url=%s\nbearer_key_file=%s\nsource_sha=%s\nversion=%s\nsha256=%s\n' \
  "https://$RCC_CLAW_DOMAIN/v1" "$RCC_EDGE_KEY_FILE" "$SOURCE_SHA" "$VERSION" "$ARTIFACT_SHA"
