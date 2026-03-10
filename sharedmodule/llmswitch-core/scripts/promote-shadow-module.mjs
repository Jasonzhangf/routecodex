#!/usr/bin/env node
import path from 'node:path';
import {
  loadRustMigrationManifest,
  setModulePreparedForShadow,
  writeRustMigrationManifest
} from './lib/rust-migration-manifest.mjs';

function readArg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) {
    return String(process.argv[index + 1]).trim();
  }
  return fallback;
}

function main() {
  const moduleId = readArg('--module', '');
  if (!moduleId) {
    console.error('[shadow-promote] missing --module');
    process.exit(1);
  }
  const manifestPath = path.resolve(
    process.cwd(),
    readArg('--manifest', path.join('config', 'rust-migration-modules.json'))
  );
  const { raw, modules } = loadRustMigrationManifest(manifestPath);
  const matched = modules.find((item) => item.id === moduleId);
  if (!matched) {
    console.error(`[shadow-promote] module not found in manifest: ${moduleId}`);
    process.exit(1);
  }
  if (matched.preparedForShadow) {
    console.log(`[shadow-promote] module=${moduleId} already prepared`);
    return;
  }
  const updated = setModulePreparedForShadow(raw, moduleId, true);
  if (!updated) {
    console.error(`[shadow-promote] failed to update module: ${moduleId}`);
    process.exit(1);
  }
  writeRustMigrationManifest(manifestPath, raw);
  console.log(`[shadow-promote] module=${moduleId} promoted to preparedForShadow=true`);
}

main();
