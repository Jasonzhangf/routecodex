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

async function loadRegistry() {
  const raw = await fs.readFile(REGISTRY_PATH, 'utf-8');
  const registry = JSON.parse(raw);
  if (!registry || typeof registry !== 'object' || !Array.isArray(registry.samples)) {
    throw new Error('Registry missing samples array');
  }
  return registry.samples;
}

async function validateSample(sample) {
  if (!sample || typeof sample !== 'object') {
    throw new Error('Invalid registry entry');
  }
  const { reqId, path: relativePath } = sample;
  if (typeof reqId !== 'string' || !reqId.includes('-')) {
    throw new Error(`Invalid reqId: ${reqId}`);
  }
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error(`Sample ${reqId} missing path`);
  }
  const sampleDir = path.join(MOCK_SAMPLES_DIR, relativePath);
  const requestPath = path.join(sampleDir, 'request.json');
  const responsePath = path.join(sampleDir, 'response.json');
  let request;
  try {
    const requestRaw = await fs.readFile(requestPath, 'utf-8');
    request = JSON.parse(requestRaw);
  } catch (error) {
    throw new Error(`Sample ${reqId} missing request.json (${error.message})`);
  }
  if (request.reqId !== reqId) {
    throw new Error(`Sample ${reqId} request reqId mismatch (${request.reqId})`);
  }
  try {
    const responseRaw = await fs.readFile(responsePath, 'utf-8');
    const response = JSON.parse(responseRaw);
    if (response.reqId !== reqId) {
      throw new Error(`Sample ${reqId} response reqId mismatch (${response.reqId})`);
    }
  } catch (error) {
    throw new Error(`Sample ${reqId} missing response.json (${error.message})`);
  }
}

async function main() {
  try {
    await fs.access(MOCK_SAMPLES_DIR);
  } catch {
    throw new Error(`Mock samples directory not found: ${MOCK_SAMPLES_DIR}`);
  }
  const samples = await loadRegistry();
  if (samples.length === 0) {
    throw new Error('Registry contains no samples');
  }
  let failures = 0;
  for (const sample of samples) {
    try {
      await validateSample(sample);
    } catch (error) {
      failures++;
      console.error(`❌ ${error.message}`);
    }
  }
  if (failures > 0) {
    throw new Error(`Validation failed for ${failures} sample(s)`);
  }
  console.log(`✅ ${samples.length} mock samples validated (${MOCK_SAMPLES_DIR})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[mock:validate] Failed: ${error.message}`);
    process.exitCode = 1;
  });
}

