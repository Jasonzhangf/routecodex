#!/usr/bin/env node
// Simple Dry-Run CLI wrapper
// Usage examples:
//  node scripts/dry-run-cli.mjs run-request --request ./request.json --pipeline-id test --mode dry-run
//  node scripts/dry-run-cli.mjs run-response --response ./response.json --pipeline-id test
//  node scripts/dry-run-cli.mjs run-bidir --request ./request.json --response ./response.json --pipeline-id test

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    } else {
      args._.push(a);
    }
  }
  return args;
}

async function loadEngine() {
  const cwd = process.cwd();
  const distPath = path.join(cwd, 'dist', 'modules', 'dry-run-engine', 'core', 'engine.js');
  if (!fs.existsSync(distPath)) {
    console.error('\nDry-Run Engine is not built yet. Run: npm run build\n');
    process.exit(1);
  }
  const modUrl = url.pathToFileURL(distPath).href;
  const mod = await import(modUrl);
  return mod.dryRunEngine ?? new mod.DryRunEngine();
}

async function main() {
  const args = parseArgs(process.argv);
  const cmd = args._[0];
  if (!cmd) {
    console.log('Commands: run-request | run-response | run-bidir');
    process.exit(0);
  }

  const engine = await loadEngine();

  const pipelineId = args['pipeline-id'] || 'dry-run-pipeline';
  const mode = args['mode'] || 'dry-run';

  if (cmd === 'run-request') {
    if (!args.request) throw new Error('--request is required');
    const request = JSON.parse(fs.readFileSync(path.resolve(args.request), 'utf-8'));
    const result = await engine.runRequest(request, { pipelineId, mode });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'run-response') {
    if (!args.response) throw new Error('--response is required');
    const response = JSON.parse(fs.readFileSync(path.resolve(args.response), 'utf-8'));
    const result = await engine.runResponse(response, { pipelineId, mode });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === 'run-bidir') {
    if (!args.request) throw new Error('--request is required');
    const request = JSON.parse(fs.readFileSync(path.resolve(args.request), 'utf-8'));
    const realResponse = args.response ? JSON.parse(fs.readFileSync(path.resolve(args.response), 'utf-8')) : undefined;
    const result = await engine.runBidirectional(request, { pipelineId }, realResponse);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.error('Unknown command:', cmd);
  process.exit(1);
}

main().catch(err => {
  console.error('Dry-Run CLI failed:', err?.stack || String(err));
  process.exit(1);
});

