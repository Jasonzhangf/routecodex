#!/usr/bin/env node
/**
 * V4-owned immutable V3 baseline loader.
 *
 * Ordinary V4 build/test/verify must never read live V3 architecture maps.
 * The three V3-consuming verifiers load V3 baseline snapshots from
 * v4/contracts/v3-baseline/ and this helper fails fast on:
 *  - missing baseline manifest or artifact;
 *  - artifact not registered in the manifest.
 *
 * baselineRoot is a parameter so red self-tests can point the exact same code
 * path at a tampered sandbox and prove rejection.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v4Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadV3Baseline(artifactName, baselineRoot = path.join(v4Root, 'contracts/v3-baseline')) {
  const manifestPath = path.join(baselineRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`v3 baseline manifest missing: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const entry = manifest.artifacts?.[artifactName];
  if (!entry) {
    throw new Error(`v3 baseline manifest missing artifact ${artifactName}`);
  }
  const artifactPath = path.join(baselineRoot, artifactName);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`v3 baseline artifact missing: ${artifactPath}`);
  }
  return { manifest, artifactPath };
}
