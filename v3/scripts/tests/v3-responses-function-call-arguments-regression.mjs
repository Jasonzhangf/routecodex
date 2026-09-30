#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const v3Root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const result = spawnSync(
  process.execPath,
  [
    'scripts/run-v3-cargo-test.mjs',
    '-p',
    'routecodex-v3-server',
    '--test',
    'multi_listener_server',
    'responses_relay_structured_function_call_arguments_reach_client_as_string',
    '--',
    '--exact',
    '--nocapture',
  ],
  {
    cwd: v3Root,
    stdio: 'inherit',
    env: {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
    },
  },
);

if (result.error) {
  console.error(`[test:v3-responses-function-call-arguments-regression] FAIL: ${result.error.message}`);
  process.exit(70);
}

process.exit(result.status ?? 1);
