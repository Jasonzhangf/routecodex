#!/usr/bin/env node
process.env.ROUTECODEX_V3_ADMISSION_WORKSPACE ??= '1';
await import('../v3/scripts/run-admission-gate.mjs');
