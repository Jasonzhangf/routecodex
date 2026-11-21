#!/usr/bin/env node
// Run one or more V3 libtest selections through cargo's supported single
// TESTNAME form. Each selection is a separate invocation; a selection that
// matches zero tests is a gate failure, never a silent pass.
//
// Selections:
//   --exact <full::path::test_name>  exact match, must run exactly one test
//   --module <module::prefix::>      module filter, must run at least one test
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v3Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(v3Root, 'scripts', 'run-v3-cargo-test.mjs');

function fail(message) {
  process.stderr.write(`[v3-exact-tests] ${message}\n`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const selections = [];
let crate = null;
let target = null;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '-p') {
    crate = argv[index + 1];
    index += 1;
  } else if (arg === '--lib') {
    target = '--lib';
  } else if (arg === '--test') {
    target = `--test:${argv[index + 1]}`;
    index += 1;
  } else if (arg === '--exact' || arg === '--module') {
    const name = argv[index + 1];
    if (!name) fail(`${arg} requires a TESTNAME or module filter`);
    selections.push({ kind: arg === '--exact' ? 'exact' : 'module', name });
    index += 1;
  } else {
    fail(`unsupported argument: ${arg}`);
  }
}

if (!crate) fail('usage: run-v3-exact-lib-tests.mjs -p <crate> (--lib|--test <target>) --exact <name> [--module <prefix> ...]');
if (!target) fail('one of --lib or --test <target> is required');
if (selections.length === 0) fail('at least one --exact or --module selection is required');

function cargoArgsFor(selection) {
  const args = ['-p', crate];
  if (target === '--lib') {
    args.push('--lib');
  } else {
    args.push('--test', target.slice('--test:'.length));
  }
  if (selection.kind === 'exact') {
    args.push(selection.name, '--', '--exact', '--nocapture');
  } else {
    args.push(selection.name, '--', '--nocapture');
  }
  return args;
}

function executedTestCount(output) {
  const match = output.match(/^running (\d+) tests?$/mu);
  return match ? Number(match[1]) : null;
}

let failed = false;
for (const selection of selections) {
  const args = cargoArgsFor(selection);
  const result = spawnSync(process.execPath, [runner, ...args], {
    cwd: v3Root,
    encoding: 'utf8',
    env: { ...process.env, CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'true' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const count = executedTestCount(output);
  const label = selection.kind === 'exact' ? 'exact' : 'module';
  if (result.status !== 0) {
    process.stderr.write(output);
    process.stderr.write(`[v3-exact-tests] FAIL ${label} ${selection.name} (exit=${result.status ?? 'null'})\n`);
    failed = true;
    continue;
  }
  if (count === null) {
    process.stderr.write(output);
    process.stderr.write(`[v3-exact-tests] FAIL ${label} ${selection.name} (no libtest execution receipt)\n`);
    failed = true;
    continue;
  }
  const expected = selection.kind === 'exact' ? count === 1 : count >= 1;
  if (!expected) {
    process.stderr.write(output);
    process.stderr.write(
      `[v3-exact-tests] FAIL ${label} ${selection.name} (ran ${count} test(s); exact requires 1, module requires >=1)\n`,
    );
    failed = true;
    continue;
  }
  process.stdout.write(`[v3-exact-tests] PASS ${label} ${selection.name} (ran ${count} test(s))\n`);
}

process.exit(failed ? 1 : 0);
