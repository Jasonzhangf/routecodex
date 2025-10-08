#!/usr/bin/env node
// Select provider-out samples with/without tool errors for focused dry-run tests
// Classifies provider-out-openai_*.json under ~/.routecodex/codex-samples into:
//  - success: contains tool role outputs with success markers
//  - errors: contains <tool_use_error> or common failure phrases
//  - neutral: no tool role entries found

import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.routecodex', 'codex-samples');
if (!fs.existsSync(dir)) {
  console.error(`Samples dir not found: ${dir}`);
  process.exit(1);
}

const files = fs.readdirSync(dir).filter(f => f.startsWith('provider-out-openai_') && f.endsWith('.json'));

const has = (s, pat) => pat.test(s);

const PAT_SUCCESS = /(File created successfully|has been updated|Todos have been modified successfully)/i;
const PAT_ERROR = /<tool_use_error>|InputValidationError|File does not exist|Error editing file/i;

const success = [];
const errors = [];
const neutral = [];

for (const f of files) {
  const p = path.join(dir, f);
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }

  const containsToolRole = /"role"\s*:\s*"tool"/i.test(text);
  if (!containsToolRole) { neutral.push(f); continue; }

  const ok = has(text, PAT_SUCCESS);
  const bad = has(text, PAT_ERROR);
  if (bad) { errors.push(f); }
  else if (ok) { success.push(f); }
  else { neutral.push(f); }
}

console.log('Provider-out sample selection summary');
console.log(` total=${files.length}  success=${success.length}  errors=${errors.length}  neutral=${neutral.length}`);
if (success.length) { console.log('\nSUCCESS:'); success.slice(0, 20).forEach(x => console.log('  ' + x)); }
if (errors.length) { console.log('\nERRORS:'); errors.slice(0, 20).forEach(x => console.log('  ' + x)); }
if (neutral.length) { console.log('\nNEUTRAL:'); neutral.slice(0, 20).forEach(x => console.log('  ' + x)); }

// Write lists for downstream tests
fs.mkdirSync('tmp', { recursive: true });
fs.writeFileSync('tmp/provider-samples-success.txt', success.join('\n'));
fs.writeFileSync('tmp/provider-samples-errors.txt', errors.join('\n'));
fs.writeFileSync('tmp/provider-samples-neutral.txt', neutral.join('\n'));
console.log('\nLists written under tmp/:');
console.log('  tmp/provider-samples-success.txt');
console.log('  tmp/provider-samples-errors.txt');
console.log('  tmp/provider-samples-neutral.txt');

