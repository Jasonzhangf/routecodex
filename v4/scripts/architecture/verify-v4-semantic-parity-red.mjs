#!/usr/bin/env node
/**
 * Red lock: every semantic stage must bind a concrete executable test.
 * This intentionally fails until the 26-stage test matrix is registered.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const parity = yaml.load(fs.readFileSync(path.join(root, 'docs/architecture/v3-v4-semantic-parity-map.yml'), 'utf8'));
const stages = Object.values(parity.chains ?? {}).flat();
const testMatrixPath = path.join(root, 'contracts', 'semantic-parity-test-matrix.json');
const matrix = fs.existsSync(testMatrixPath)
  ? JSON.parse(fs.readFileSync(testMatrixPath, 'utf8'))
  : { stages: [] };
const entries = (matrix.stages ?? []).map((entry) =>
  typeof entry === 'string' ? { id: entry, status: 'registered' } : entry,
);
const bound = new Set(entries.map((entry) => entry.id));
const missing = stages
  .map((stage) => stage.v3_stage)
  .filter((stage) => !entries.some((entry) => entry.id === stage));

if (stages.length !== 26) {
  console.error(`expected 26 semantic stages, found ${stages.length}`);
  process.exit(1);
}
if (missing.length > 0) {
  console.error(`RED semantic parity test matrix missing ${missing.length}/26 stages:`);
  for (const stage of missing) console.error(`- ${stage}`);
  process.exit(1);
}
const pending = entries.filter((entry) => !entry.status || entry.status === 'red_baseline');
if (pending.length > 0) {
  console.error(`RED semantic parity tests pending: ${pending.length}/26`);
  for (const entry of pending) console.error(`- ${entry.id}: ${entry.test}`);
  process.exit(1);
}
console.log('semantic parity test matrix complete: 26/26');
