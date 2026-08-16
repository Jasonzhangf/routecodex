#!/usr/bin/env node
/**
 * V4-owned immutable V3 baseline loader.
 *
 * Ordinary V4 build/test/verify must never read live V3 architecture maps.
 * The three V3-consuming verifiers load frozen snapshots from
 * v4/contracts/v3-baseline/ and this helper fails fast on:
 *  - missing baseline manifest or artifact;
 *  - digest mismatch (unauthorized change or corruption);
 *  - manifest not in frozen status.
 *
 * baselineRoot is a parameter so red self-tests can point the exact same code
 * path at a tampered sandbox and prove rejection.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v4Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function loadV3Baseline(artifactName, baselineRoot = path.join(v4Root, 'contracts/v3-baseline')) {
  const manifestPath = path.join(baselineRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`v3 baseline manifest missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.status !== 'frozen') {
    throw new Error(`v3 baseline manifest status must be frozen (got ${manifest.status})`);
  }
  const entry = manifest.artifacts?.[artifactName];
  if (!entry?.sha256) {
    throw new Error(`v3 baseline manifest missing artifact ${artifactName}`);
  }
  const artifactPath = path.join(baselineRoot, artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`v3 baseline artifact missing: ${artifactPath}`);
  }
  const actual = sha256File(artifactPath);
  if (actual !== entry.sha256) {
    throw new Error(
      `v3 baseline ${artifactName}: digest mismatch (unauthorized change or corruption; expected ${entry.sha256}, got ${actual})`,
    );
  }
  return { manifest, artifactPath };
}
