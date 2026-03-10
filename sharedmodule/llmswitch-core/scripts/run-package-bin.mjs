#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function resolveFromAncestors(specifier) {
  let current = process.cwd();
  while (true) {
    try {
      const require = createRequire(pathToFileURL(path.join(current, 'package.json')).href);
      return require.resolve(specifier);
    } catch {
      // Try the next ancestor.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return null;
}

const [, , specifier, ...args] = process.argv;
if (!specifier) {
  console.error('[run-package-bin] missing module specifier');
  process.exit(2);
}

const resolved = resolveFromAncestors(specifier);
if (!resolved) {
  console.error(`[run-package-bin] cannot resolve ${specifier} from ${process.cwd()} or its ancestors`);
  process.exit(2);
}

const result = spawnSync(process.execPath, [resolved, ...args], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}
process.exit(1);
