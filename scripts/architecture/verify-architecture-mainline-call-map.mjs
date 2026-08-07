#!/usr/bin/env node
/**
 * verify:architecture-mainline-call-map
 *
 * Verifies the mainline call map binding state through the canonical
 * binding-state verifier. This gate exists so map features can declare a
 * stable gate name for mainline call-map integrity without reimplementing
 * the symbol-existence checks.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const result = spawnSync(
  process.execPath,
  [path.join(root, 'scripts', 'architecture', 'verify-mainline-call-map-binding-state.mjs')],
  { cwd: root, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
