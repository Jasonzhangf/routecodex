#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = process.cwd();

function resolveShimDirs() {
  if (process.env.ROUTECODEX_SHIM_DIR) {
    return [path.resolve(process.env.ROUTECODEX_SHIM_DIR)];
  }
  return [path.join(os.homedir(), '.local', 'bin')];
}

function shouldPreferReleaseSnapshot(_binName) {
  const raw = String(process.env.ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function normalizeCliPath(value) {
  if (!value) return '';
  return value.split(path.sep).join('/');
}

function buildShimContent({ binName, repoCliPath, globalCliPath, defaultInstallRoot, preferReleaseSnapshot }) {
  const localHome = normalizeCliPath(path.join(os.homedir(), '.rcc'));
  const releaseSnapshotBlock = `if [ -f "$CURRENT_CLI" ]; then
  export ROUTECODEX_INSTALL_ROOT="\${ROUTECODEX_INSTALL_ROOT:-$CURRENT_INSTALL}"
  export RCC_INSTALL_ROOT="\${RCC_INSTALL_ROOT:-$CURRENT_INSTALL}"
  export ROUTECODEX_BASEDIR="\${ROUTECODEX_BASEDIR:-$CURRENT_INSTALL}"
  export RCC_BASEDIR="\${RCC_BASEDIR:-$CURRENT_INSTALL}"
  exec node "$CURRENT_CLI" "$@"
fi`;
  const devOnlySnapshotBlock = `if [ -f "$CURRENT_CLI" ]; then
  echo "${binName}: dev shim refused release snapshot and only fell back to current install because no dev build was found" >&2
  export ROUTECODEX_INSTALL_ROOT="\${ROUTECODEX_INSTALL_ROOT:-$CURRENT_INSTALL}"
  export RCC_INSTALL_ROOT="\${RCC_INSTALL_ROOT:-$CURRENT_INSTALL}"
  export ROUTECODEX_BASEDIR="\${ROUTECODEX_BASEDIR:-$CURRENT_INSTALL}"
  export RCC_BASEDIR="\${RCC_BASEDIR:-$CURRENT_INSTALL}"
  exec node "$CURRENT_CLI" "$@"
fi`;

  const resolutionBlock = preferReleaseSnapshot
    ? `${releaseSnapshotBlock}

if [ -n "$GLOBAL_ROOT" ] && [ -f "$GLOBAL_CLI" ]; then
  exec node "$GLOBAL_CLI" "$@"
fi

if [ -f "$REPO_CLI" ]; then
  exec node "$REPO_CLI" "$@"
fi`
    : `if [ -n "$GLOBAL_ROOT" ] && [ -f "$GLOBAL_CLI" ]; then
  exec node "$GLOBAL_CLI" "$@"
fi

if [ -f "$REPO_CLI" ]; then
  exec node "$REPO_CLI" "$@"
fi

${devOnlySnapshotBlock}`;

  return `#!/bin/sh
set -eu

resolve_rcc_home() {
  for candidate in "\${RCC_HOME:-}" "\${ROUTECODEX_USER_DIR:-}" "\${ROUTECODEX_HOME:-}"; do
    if [ -n "$candidate" ]; then
      case "$candidate" in
        ~/*) printf '%s\n' "$HOME/\${candidate#~/}" ;;
        *) printf '%s\n' "$candidate" ;;
      esac
      return 0
    fi
  done
  printf '%s\n' "${localHome}"
}

GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
RCC_HOME_DIR="$(resolve_rcc_home)"
CURRENT_INSTALL="$RCC_HOME_DIR/install/current"
CURRENT_CLI="$CURRENT_INSTALL/dist/cli.js"
REPO_CLI="${normalizeCliPath(repoCliPath)}"
GLOBAL_CLI="${normalizeCliPath(globalCliPath)}"
DEFAULT_INSTALL_ROOT="${defaultInstallRoot}"

if ! command -v node >/dev/null 2>&1; then
  echo "${binName}: node is required but was not found in PATH" >&2
  exit 127
fi

${resolutionBlock}

echo "${binName}: unable to locate CLI entrypoint" >&2
echo "  tried release snapshot: $CURRENT_CLI" >&2
echo "  tried global package: $GLOBAL_CLI" >&2
echo "  tried repo dist: $REPO_CLI" >&2
echo "  default release snapshot root: $DEFAULT_INSTALL_ROOT" >&2
echo "  run npm run build && npm run install:global (or install:release)" >&2
exit 127
`;
}

function writeShim(shimDir, binName, packageName) {
  if (process.platform === 'win32') {
    return null;
  }

  const preferReleaseSnapshot = shouldPreferReleaseSnapshot(binName);
  const shimPath = path.join(shimDir, binName);
  const repoCliPath = path.join(REPO_ROOT, 'dist', 'cli.js');
  const globalCliPath = packageName.startsWith('@')
    ? path.join('${GLOBAL_ROOT}', ...packageName.split('/'), 'dist', 'cli.js')
    : path.join('${GLOBAL_ROOT}', packageName, 'dist', 'cli.js');
  const defaultInstallRoot = normalizeCliPath(path.join(os.homedir(), '.rcc', 'install', 'current'));
  const content = buildShimContent({
    binName,
    repoCliPath,
    globalCliPath,
    defaultInstallRoot,
    preferReleaseSnapshot
  });

  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(shimPath, content);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function main() {
  const installed = [];
  const shimDirs = resolveShimDirs();
  for (const shimDir of shimDirs) {
    installed.push(writeShim(shimDir, 'routecodex', 'routecodex'));
    installed.push(writeShim(shimDir, 'rcc', 'routecodex'));
  }

  for (const file of installed.filter(Boolean)) {
    console.log(`[cli-shim] wrote ${file}`);
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const missing = shimDirs.filter((dir) => !pathEntries.includes(dir));
  for (const dir of missing) {
    console.warn(`[cli-shim] warning: ${dir} is not in PATH`);
  }
}

main();
