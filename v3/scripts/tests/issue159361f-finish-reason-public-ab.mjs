#!/usr/bin/env node
// Issue 159361f public A/B: run the five one-completion Responses fixtures and
// the separate two-turn DSML harvest fixture against distinct baseline and
// candidate binaries, then compare client/provider bytes and each turn's
// request-correlated closeout.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from './v3-protocol-live-mock-matrix.mjs';
import { cases, compare, twoTurnCases } from './issue159361f-finish-reason-blackbox.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));

function optionArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value) throw new Error('expected --flag value pairs, got ' + argv.slice(index).join(' '));
    args[flag] = value;
  }
  return args;
}

async function runSide(role, binary, root) {
  const caseIds = [...cases.map(([caseId]) => caseId), ...twoTurnCases.map(({ id }) => id)];
  for (const caseId of caseIds) {
    const exit = await main(['--case', caseId, '--binary', binary, '--binary-kind', 'candidate', '--evidence', join(root, role, caseId)]);
    if (exit !== 0) throw new Error(role + ' public case failed: ' + caseId + ' (exit ' + exit + ')');
  }
}

const args = optionArgs(process.argv.slice(2));
const candidateBinary = resolve(args['--candidate-binary'] ?? join(scriptDir, '..', '..', 'dist', 'bin', 'rccv3'));
const baselineBinary = args['--baseline-binary'] ?? process.env.RCC_BASELINE_BINARY;
if (!baselineBinary) throw new Error('a baseline binary is required: --baseline-binary PATH or RCC_BASELINE_BINARY');
if (resolve(baselineBinary) === candidateBinary) throw new Error('baseline and candidate must be different binaries');
const evidenceRoot = args['--evidence-root'] ? resolve(args['--evidence-root']) : mkdtempSync(join(tmpdir(), 'issue159361f-public-ab-'));

try {
  mkdirSync(evidenceRoot, { recursive: true });
  await runSide('baseline', resolve(baselineBinary), evidenceRoot);
  await runSide('candidate', candidateBinary, evidenceRoot);
  const receipt = compare(join(evidenceRoot, 'baseline'), join(evidenceRoot, 'candidate'));
  receipt.binaries = { baseline: resolve(baselineBinary), candidate: candidateBinary };
  receipt.evidence_root = evidenceRoot;
  writeFileSync(join(evidenceRoot, 'ab-comparison.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ status: receipt.status, evidence_root: evidenceRoot, cases: receipt.cases.map(({ case_id, status }) => ({ case_id, status })) }));
  if (receipt.status !== 'PASS') process.exitCode = 1;
} finally {
  if (!args['--evidence-root']) rmSync(evidenceRoot, { recursive: true, force: true });
}
