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

function normalizeCliPath(value) {
  if (!value) return '';
  return value.split(path.sep).join('/');
}

function writeShim(shimDir, binName, packageName) {
  if (process.platform === 'win32') {
    return null;
  }

  const shimPath = path.join(shimDir, binName);
  const repoCliPath = path.join(REPO_ROOT, 'dist', 'cli.js');
  const globalCliPath = packageName.startsWith('@')
    ? path.join('${GLOBAL_ROOT}', ...packageName.split('/'), 'dist', 'cli.js')
    : path.join('${GLOBAL_ROOT}', packageName, 'dist', 'cli.js');

  const content = `#!/bin/sh
set -eu

GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
REPO_CLI="${normalizeCliPath(repoCliPath)}"
GLOBAL_CLI="${normalizeCliPath(globalCliPath)}"

if ! command -v node >/dev/null 2>&1; then
  echo "${binName}: node is required but was not found in PATH" >&2
  exit 127
fi

if [ -n "$GLOBAL_ROOT" ] && [ -f "$GLOBAL_CLI" ]; then
  exec node "$GLOBAL_CLI" "$@"
fi

if [ -f "$REPO_CLI" ]; then
  exec node "$REPO_CLI" "$@"
fi

echo "${binName}: unable to locate CLI entrypoint" >&2
echo "  tried global package: $GLOBAL_CLI" >&2
echo "  tried repo dist: $REPO_CLI" >&2
echo "  run npm run build && npm run install:global (or install:release for rcc)" >&2
exit 127
`;

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
    installed.push(writeShim(shimDir, 'rcc', '@jsonstudio/rcc'));
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
