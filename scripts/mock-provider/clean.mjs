#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

function resolveSamplesDir() {
  const override = String(process.env.ROUTECODEX_MOCK_SAMPLES_DIR || '').trim();
  if (override) {
    return path.isAbsolute(override) ? override : path.resolve(projectRoot, override);
  }
  return path.join(projectRoot, 'samples/mock-provider');
}

const MOCK_SAMPLES_DIR = resolveSamplesDir();
const REGISTRY_PATH = path.join(MOCK_SAMPLES_DIR, '_registry/index.json');
const ARCHIVE_DIR = path.join(MOCK_SAMPLES_DIR, '_archive');

async function loadRegistry() {
  const raw = await fs.readFile(REGISTRY_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.samples)) {
    throw new Error('Registry is malformed');
  }
  return parsed;
}

async function saveRegistry(registry) {
  registry.updated = new Date().toISOString();
  await fs.writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

async function moveSample(sample) {
  const source = path.join(MOCK_SAMPLES_DIR, sample.path);
  const destination = path.join(ARCHIVE_DIR, sample.path);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(source, destination);
  console.log(`Archive: ${sample.reqId}`);
}

async function main(argv) {
  const options = { keep: 50, provider: undefined, dry: false };
  for (const arg of argv) {
    if (arg.startsWith('--keep=')) {
      options.keep = Number(arg.split('=')[1]) || options.keep;
    } else if (arg.startsWith('--provider=')) {
      options.provider = arg.split('=')[1];
    } else if (arg === '--dry') {
      options.dry = true;
    }
  }

  const registry = await loadRegistry();
  let samples = registry.samples;
  if (options.provider) {
    samples = samples.filter((sample) => sample.providerId === options.provider);
  }
  samples.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const toKeep = samples.slice(0, options.keep);
  const toArchive = samples.slice(options.keep);

  if (!options.dry) {
    await fs.mkdir(ARCHIVE_DIR, { recursive: true });
    for (const sample of toArchive) {
      try {
        await moveSample(sample);
      } catch (error) {
        console.warn(`⚠️  Failed to archive ${sample.reqId}: ${error.message}`);
      }
    }
  }

  const archivedIds = new Set(toArchive.map((sample) => sample.reqId));
  registry.samples = registry.samples.filter((sample) => !archivedIds.has(sample.reqId));
  await saveRegistry(registry);

  console.log(`Kept: ${toKeep.length} | Archived: ${toArchive.length}${options.dry ? ' (dry run)' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[mock:clean] Failed: ${error.message}`);
    process.exitCode = 1;
  });
}
