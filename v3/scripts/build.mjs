#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { run, v3Root } from './_common.mjs';

const pkg = JSON.parse(readFileSync(resolve(v3Root, 'package.json'), 'utf8'));
const env = {
  ...process.env,
  CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'true',
  ROUTECODEX_BUILD_VERSION: pkg.version,
};

await run('node', ['scripts/verify-isolation.mjs']);
await run('cargo', ['build', '--locked', '--workspace'], { env });
await run('node', ['scripts/copy-cli-bin.mjs'], { env });
process.stdout.write(`[v3 build] PASS version=${pkg.version}\n`);
