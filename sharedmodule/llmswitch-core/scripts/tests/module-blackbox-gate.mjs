#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_COMMANDS = {
  'virtual-router': [
    ['npm', ['run', 'test:virtual-router']],
    ['npm', ['run', 'test:virtual-router-health']],
    ['node', ['scripts/tests/virtual-router-native-parity.mjs']]
  ],
  'hub-pipeline': [
    ['node', ['scripts/tests/hub-pipeline-smoke.mjs']],
    ['node', ['scripts/tests/hub-response-chain.mjs']],
    ['node', ['scripts/tests/provider-response-chain-order.mjs']]
  ]
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const defaultSamplesDir = path.join(projectRoot, 'tests', 'fixtures', 'codex-samples');

function parseModules(argv) {
  const values = [];
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--module' || token === '-m') {
      const value = argv[i + 1];
      if (value) {
        values.push(value.trim());
        i += 1;
      }
    }
  }
  if (!values.length) {
    return Object.keys(MODULE_COMMANDS);
  }
  return values;
}

function run(command, args) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CODEX_SAMPLES_DIR: process.env.CODEX_SAMPLES_DIR || defaultSamplesDir,
      ROUTECODEX_SAMPLES_DIR: process.env.ROUTECODEX_SAMPLES_DIR || defaultSamplesDir
    };
    const child = spawn(command, args, { stdio: 'inherit', shell: false, cwd: projectRoot, env });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function main() {
  const requested = parseModules(process.argv);
  for (const name of requested) {
    const tasks = MODULE_COMMANDS[name];
    if (!tasks) {
      console.error(`[blackbox-gate] unknown module "${name}"`);
      process.exit(1);
    }
    console.log(`[blackbox-gate] module=${name} cases=${tasks.length}`);
    for (const [command, args] of tasks) {
      console.log(`[blackbox-gate] run: ${command} ${args.join(' ')}`);
      const code = await run(command, args);
      if (code !== 0) {
        console.error(`[blackbox-gate] failed: module=${name} command="${command} ${args.join(' ')}"`);
        process.exit(code);
      }
    }
  }
  console.log('[blackbox-gate] ok');
}

main().catch((error) => {
  console.error('[blackbox-gate] fatal', error);
  process.exit(1);
});
