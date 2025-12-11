#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'chat-pipeline-blackbox.json');
const DEFAULT_LEGACY = '/Users/fanzhang/Documents/github/sharedmodule/llmswitch-core-worktree/legacy';

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const config = await loadConfig(CONFIG_PATH);
  const legacyPath = await resolveLegacyPath(cli.legacyOverride ?? process.env.ROUTECODEX_BLACKBOX_LEGACY ?? config.legacyWorktree ?? DEFAULT_LEGACY);
  const cases = selectCases(config.samples, cli);
  if (!cases.length) {
    throw new Error('No matching chat-pipeline regression samples found.');
  }
  console.log(`[blackbox] Using legacy worktree: ${legacyPath}`);
  let failures = 0;
  for (const testCase of cases) {
    const success = await runComparison({ testCase, legacyPath, captureStages: cli.captureStages });
    if (!success) {
      failures += 1;
      if (cli.failFast) break;
    }
  }
  if (failures) {
    throw new Error(`chat-pipeline-regression detected ${failures} failure(s).`);
  }
  console.log(`\n[blackbox] Completed ${cases.length} chat pipeline comparisons without diffs.`);
}

function parseArgs(argv) {
  const opts = {
    names: new Set(),
    codecs: new Set(),
    modes: new Set(),
    captureStages: true,
    failFast: false,
    legacyOverride: null
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === '--name' || arg === '--case') && i + 1 < argv.length) {
      opts.names.add(argv[++i]);
    } else if (arg === '--codec' && i + 1 < argv.length) {
      opts.codecs.add(argv[++i].toLowerCase());
    } else if (arg === '--mode' && i + 1 < argv.length) {
      opts.modes.add(argv[++i].toLowerCase());
    } else if (arg === '--legacy' && i + 1 < argv.length) {
      opts.legacyOverride = argv[++i];
    } else if (arg === '--no-stages') {
      opts.captureStages = false;
    } else if (arg === '--stages') {
      opts.captureStages = true;
    } else if (arg === '--fail-fast') {
      opts.failFast = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  return opts;
}

function printUsage() {
  console.log('Usage: node scripts/tests/chat-pipeline-regression.mjs [--name sampleName] [--codec anthropic|openai|responses] [--mode request|response] [--legacy path] [--no-stages] [--fail-fast]');
}

async function loadConfig(configPath) {
  const abs = path.resolve(configPath);
  const raw = await fs.readFile(abs, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.samples) || !parsed.samples.length) {
    throw new Error(`chat-pipeline-blackbox config missing samples (${abs})`);
  }
  return parsed;
}

async function resolveLegacyPath(candidate) {
  const abs = path.resolve(candidate);
  try {
    await fs.access(abs);
  } catch {
    throw new Error(`Legacy worktree missing at ${abs}. Set ROUTECODEX_BLACKBOX_LEGACY or update config/chat-pipeline-blackbox.json`);
  }
  return abs;
}

function selectCases(samples, cli) {
  return samples
    .filter((sample) => filterSample(sample, cli))
    .map((sample) => ({
      name: sample.name,
      codec: sample.codec,
      mode: sample.mode ?? 'request',
      path: path.resolve(PROJECT_ROOT, sample.path),
      captureStages: sample.stages ?? true,
      compareStages: sample.compareStages ?? true,
      comparePayload: sample.comparePayload ?? true
    }));
}

function filterSample(sample, cli) {
  if (!sample || !sample.name || !sample.codec || !sample.path) return false;
  if (cli.names.size && !cli.names.has(sample.name)) return false;
  if (cli.codecs.size && !cli.codecs.has(sample.codec)) return false;
  if (cli.modes.size && !cli.modes.has((sample.mode ?? 'request').toLowerCase())) return false;
  return true;
}

async function runComparison({ testCase, legacyPath, captureStages }) {
  const samplePath = testCase.path;
  await fs.access(samplePath);
  const runner = path.join(PROJECT_ROOT, 'scripts', 'tests', 'chat-pipeline-blackbox.mjs');
  const args = [runner, '--sample', samplePath, '--legacy', legacyPath, '--current', PROJECT_ROOT, '--codec', testCase.codec, '--mode', testCase.mode, '--fail-on-diff'];
  const shouldCapture = captureStages && testCase.captureStages;
  if (!shouldCapture) {
    args.push('--no-stages');
  }
  if (shouldCapture && testCase.compareStages === false) {
    args.push('--skip-stage-diff');
  }
  if (testCase.comparePayload === false) {
    args.push('--skip-payload-diff');
  }
  console.log(`\n[blackbox] ▶︎ ${testCase.name} (codec=${testCase.codec}, mode=${testCase.mode})`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code === 0) {
        console.log(`[blackbox] ✓ ${testCase.name}`);
        resolve(true);
      } else {
        console.error(`[blackbox] ✗ ${testCase.name} failed (exit ${code})`);
        resolve(false);
      }
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
