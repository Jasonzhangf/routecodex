#!/bin/sh
# Local cross-build of the RouteCodex V3 Linux CLI binary.
#
# Owner of: committed-source snapshot -> x86_64-unknown-linux-gnu rccv3 artifact.
#
# Properties:
#   - Builds from a `git archive` snapshot of one commit, so uncommitted work in
#     the working tree can never leak into a deployed binary.
#   - Sets ROUTECODEX_BUILD_VERSION from the *snapshot's* v3/package.json, the
#     version truth every canonical V3 build path uses. Without this the
#     build.rs fallback reads the repository-root package.json, a different
#     (stale) version, and the binary silently reports the wrong version.
#     See scripts/deploy/README.md for the recorded evidence.
#   - Verifies the artifact is ELF and embeds the expected version before
#     publishing, then emits a manifest binding source commit -> sha256.
#   - Uses a persistent cargo target directory so repeat builds are incremental.
#
# POSIX sh only: scripts/verify-fast.mjs runs `sh -n` over changed shell files
# and /bin/sh is dash on the Linux CI runner.
#
# Usage:
#   scripts/deploy/build-linux-binary.sh [--ref <commit-ish>] [--out <dir>] [--cache <dir>]
#
# Exit codes: 0 = artifact published, 1 = failure (nothing is published).

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

LINUX_TARGET=${RCC_LINUX_TARGET:-x86_64-unknown-linux-gnu}
REF=HEAD
OUT_DIR="$REPO_ROOT/v3/artifacts/deploy/linux-x86_64"
CACHE_ROOT=${RCC_LOCAL_BUILD_DIR:-"$HOME/.cache/rcc-claw-build"}

die() {
  printf '[build-linux-binary] FAIL %s\n' "$*" >&2
  exit 1
}

log() {
  printf '[build-linux-binary] %s\n' "$*"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      [ "$#" -ge 2 ] || die "--ref requires a value"
      REF=$2
      shift 2
      ;;
    --out)
      [ "$#" -ge 2 ] || die "--out requires a value"
      OUT_DIR=$2
      shift 2
      ;;
    --cache)
      [ "$#" -ge 2 ] || die "--cache requires a value"
      CACHE_ROOT=$2
      shift 2
      ;;
    *)
      die "unsupported argument: $1"
      ;;
  esac
done

[ -f "$REPO_ROOT/v3/Cargo.toml" ] || die "not a RouteCodex repository root: $REPO_ROOT"
[ -f "$REPO_ROOT/v3/package.json" ] || die "V3 package manifest missing"

command -v cargo >/dev/null 2>&1 || die "cargo is required"
command -v cargo-zigbuild >/dev/null 2>&1 || die "cargo-zigbuild is required (cargo install cargo-zigbuild)"
command -v zig >/dev/null 2>&1 || die "zig is required by cargo-zigbuild"
command -v node >/dev/null 2>&1 || die "node is required to read the snapshot version"

SOURCE_SHA=$(git -C "$REPO_ROOT" rev-parse --verify "$REF^{commit}") \
  || die "cannot resolve ref to a commit: $REF"

if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  log "WARN working tree is dirty; the snapshot uses commit $SOURCE_SHA only"
fi

log "ref=$REF sha=$SOURCE_SHA target=$LINUX_TARGET"

SOURCE_DIR="$CACHE_ROOT/source"
TARGET_DIR="$CACHE_ROOT/target"

rm -rf "$SOURCE_DIR"
mkdir -p "$SOURCE_DIR" "$TARGET_DIR" "$OUT_DIR"

# `git archive | tar` cannot rely on `pipefail` (not POSIX), so the snapshot is
# validated by content instead of by pipeline status.
if ! git -C "$REPO_ROOT" archive "$SOURCE_SHA" | tar -x -C "$SOURCE_DIR"; then
  die "failed to extract snapshot $SOURCE_SHA"
fi
[ -f "$SOURCE_DIR/v3/package.json" ] || die "snapshot $SOURCE_SHA is missing v3/package.json"

VERSION=$(node -p "require('$SOURCE_DIR/v3/package.json').version") \
  || die "cannot read version from snapshot v3/package.json"
[ -n "$VERSION" ] || die "snapshot v3/package.json has an empty version"
log "snapshot version=$VERSION"

(
  cd "$SOURCE_DIR/v3" || exit 1
  rustup target add "$LINUX_TARGET" >/dev/null 2>&1 || true
  CARGO_NET_OFFLINE=${CARGO_NET_OFFLINE:-true} \
  ROUTECODEX_BUILD_VERSION="$VERSION" \
  CARGO_TARGET_DIR="$TARGET_DIR" \
    cargo zigbuild --locked --release --target "$LINUX_TARGET" -p routecodex-v3-cli
) || die "cross build failed"

BUILT_BIN="$TARGET_DIR/$LINUX_TARGET/release/rccv3"
[ -f "$BUILT_BIN" ] || die "cross build did not produce $BUILT_BIN"

MAGIC=$(head -c 4 "$BUILT_BIN" | od -An -tx1 | tr -d ' \n')
[ "$MAGIC" = "7f454c46" ] || die "built artifact is not an ELF binary: $BUILT_BIN"

LC_ALL=C grep -a -q -m1 "$VERSION" "$BUILT_BIN" \
  || die "built artifact does not embed version $VERSION"

STAGED="$OUT_DIR/.rccv3.$$.tmp"
cp "$BUILT_BIN" "$STAGED" || die "failed to stage artifact"
chmod 0755 "$STAGED"

ARTIFACT="$OUT_DIR/rccv3"
mv "$STAGED" "$ARTIFACT" || die "failed to publish artifact"

SHA256=$(shasum -a 256 "$ARTIFACT" | cut -d' ' -f1)
SIZE=$(wc -c < "$ARTIFACT" | tr -d ' ')
printf '%s  %s\n' "$SHA256" "rccv3" > "$OUT_DIR/rccv3.sha256"

node -e '
const [out, sha, version, ref, sourceSha, target, size] = process.argv.slice(1);
require("node:fs").writeFileSync(
  `${out}/build-manifest.json`,
  `${JSON.stringify(
    {
      artifact: "rccv3",
      sha256: sha,
      size_bytes: Number(size),
      version,
      linux_target: target,
      source_ref: ref,
      source_sha: sourceSha,
    },
    null,
    2,
  )}\n`,
);
' "$OUT_DIR" "$SHA256" "$VERSION" "$REF" "$SOURCE_SHA" "$LINUX_TARGET" "$SIZE" \
  || die "failed to write build manifest"

printf '%s\n' "$SOURCE_SHA" > "$CACHE_ROOT/.built-source-sha"

log "OK version=$VERSION sha256=$SHA256 size=$SIZE"
printf 'artifact=%s\nversion=%s\nsha256=%s\nsource_sha=%s\n' \
  "$ARTIFACT" "$VERSION" "$SHA256" "$SOURCE_SHA"
