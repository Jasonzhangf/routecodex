#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const mode = (process.argv[2] || 'link').toLowerCase();
const root = process.cwd();
const source = path.join(root, 'sharedmodule', 'llmswitch-core');
const scopeDir = path.join(root, 'node_modules', '@jsonstudio');
const dest = path.join(scopeDir, 'llms');

function ensureNodeModules() {
  if (!fs.existsSync(path.join(root, 'node_modules'))) {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  }
  if (!fs.existsSync(scopeDir)) {
    fs.mkdirSync(scopeDir, { recursive: true });
  }
}

function removeDest() {
  try {
    const stat = fs.lstatSync(dest);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(dest);
    } else if (stat.isDirectory()) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

if (mode === 'link') {
  if (!fs.existsSync(source)) {
    console.error('[llmswitch-link] sharedmodule/llmswitch-core not found; did you clone sharedmodule repo?');
    process.exit(1);
  }
  ensureNodeModules();
  removeDest();
  fs.symlinkSync(source, dest);
  console.log('[llmswitch-link] linked node_modules/@jsonstudio/llms -> sharedmodule/llmswitch-core');
  process.exit(0);
}

if (mode === 'unlink') {
  if (fs.existsSync(dest)) {
    removeDest();
    console.log('[llmswitch-link] removed link at node_modules/@jsonstudio/llms');
  } else {
    console.log('[llmswitch-link] nothing to unlink');
  }
  process.exit(0);
}

console.error('[llmswitch-link] unknown mode. Use `link` (default) or `unlink`.');
process.exit(1);
