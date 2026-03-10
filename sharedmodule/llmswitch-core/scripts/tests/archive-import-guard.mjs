#!/usr/bin/env node

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
);

async function importArchive(relPath) {
  const url = pathToFileURL(path.join(projectRoot, 'dist', relPath)).href;
  return import(`${url}?t=${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

async function main() {
  delete process.env.LLMSWITCH_ALLOW_ARCHIVE_IMPORTS;
  delete process.env.ROUTECODEX_ALLOW_ARCHIVE_IMPORTS;

  let blocked = false;
  try {
    await importArchive('conversion/hub/operation-table/semantic-mappers/archive/chat-mapper.archive.js');
  } catch (error) {
    blocked = String(error?.message || error).includes('fail-closed');
  }
  assert.equal(blocked, true, 'archive import should fail-closed by default');

  process.env.LLMSWITCH_ALLOW_ARCHIVE_IMPORTS = '1';
  const mod = await importArchive('conversion/hub/operation-table/semantic-mappers/archive/chat-mapper.archive.js');
  assert.equal(typeof mod.ChatSemanticMapper, 'function');

  console.log('✅ archive import guard regression passed');
}

main().catch((error) => {
  console.error('❌ archive import guard regression failed:', error);
  process.exit(1);
});
