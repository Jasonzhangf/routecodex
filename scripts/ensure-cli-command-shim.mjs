#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SHIM_DIR = process.env.ROUTECODEX_SHIM_DIR
  ? path.resolve(process.env.ROUTECODEX_SHIM_DIR)
  : path.join(os.homedir(), '.local', 'bin');

const REPO_ROOT = process.cwd();

function normalizeCliPath(value) {
  if (!value) return '';
  return value.split(path.sep).join('/');
}

function writeShim(binName, packageName) {
  if (process.platform === 'win32') {
    return null;
  }

  const shimPath = path.join(SHIM_DIR, binName);
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

  fs.mkdirSync(SHIM_DIR, { recursive: true });
  fs.writeFileSync(shimPath, content);
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function main() {
  const installed = [
    writeShim('routecodex', 'routecodex'),
    writeShim('rcc', '@jsonstudio/rcc')
  ].filter(Boolean);

  for (const file of installed) {
    console.log(`[cli-shim] wrote ${file}`);
  }

  const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (!pathEntries.includes(SHIM_DIR)) {
    console.warn(`[cli-shim] warning: ${SHIM_DIR} is not in PATH`);
  }
}

main();
