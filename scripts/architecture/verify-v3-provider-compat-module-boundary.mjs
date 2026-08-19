#!/usr/bin/env node
import {
  loadProviderCompatBoundarySources,
  verifyProviderCompatBoundary,
} from './v3-provider-compat-module-boundary-lib.mjs';

const failures = verifyProviderCompatBoundary(loadProviderCompatBoundarySources());

if (failures.length > 0) {
  console.error('[verify:v3-provider-compat-module-boundary] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[verify:v3-provider-compat-module-boundary] ok');
