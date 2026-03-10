#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname, '..');
const PROVIDER_BASE = process.env.ROUTECODEX_PROVIDER_BASE || path.join(os.homedir(), '.routecodex', 'provider');
const OUTPUT = process.env.ROUTECODEX_PATH_MATRIX || path.join(ROOT, 'test-results', 'simulated-paths.json');

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

