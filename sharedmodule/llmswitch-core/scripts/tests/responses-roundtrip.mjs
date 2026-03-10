#!/usr/bin/env node

/**
 * Responses conversion roundtrip test:
 * - Loads canonical Responses fixtures
 * - Converts them to Chat payloads (buildChatRequestFromResponses)
 * - Converts back to Responses payloads
 * - Verifies essential fields survive roundtrip (messages/input/instructions)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..', '..');
const fixturesDir = path.join(projectRoot, 'test', 'fixtures', 'responses');
const distBridge = path.join(projectRoot, 'dist', 'conversion', 'responses', 'responses-openai-bridge.js');

async function loadFixtures() {
  const entries = await fs.readdir(fixturesDir);
  const jsonFiles = entries.filter((file) => file.toLowerCase().endsWith('.json'));
  if (!jsonFiles.length) {
    throw new Error(`No fixtures found under ${fixturesDir}`);
  }
  const fixtures = [];
  for (const file of jsonFiles) {
    const fullPath = path.join(fixturesDir, file);
    const raw = await fs.readFile(fullPath, 'utf-8');
    fixtures.push({ name: file, payload: JSON.parse(raw) });
  }
  return fixtures;
}

async function runRoundtripTests() {
  const bridge = await import(pathToFileURL(distBridge).href);
  const { buildResponsesRequestFromChat } = bridge;

  const requestAdapter = await import(
    pathToFileURL(
      path.join(projectRoot, 'dist', 'conversion', 'shared', 'responses-request-adapter.js')
    ).href
  );
  const {
    captureResponsesContext,
    buildChatRequestFromResponses
  } = requestAdapter;

  const fixtures = await loadFixtures();
  let passed = 0;

  for (const fixture of fixtures) {
    const ctx = captureResponsesContext(fixture.payload, { route: { requestId: `responses_roundtrip_${fixture.name}` } });
    const { request: chatRequest } = buildChatRequestFromResponses(fixture.payload, ctx);

    assert.ok(
      Array.isArray(chatRequest?.messages) && chatRequest.messages.length > 0,
      `Fixture ${fixture.name}: chat conversion produced no messages`
    );
    const hasUserMessage = chatRequest.messages.some((msg) => String(msg?.role).toLowerCase() === 'user');
    assert.ok(hasUserMessage, `Fixture ${fixture.name}: chat messages missing user role`);

    const { request: responsesPayload } = buildResponsesRequestFromChat(chatRequest);
    assert.ok(
      Array.isArray(responsesPayload?.input) && responsesPayload.input.length > 0,
      `Fixture ${fixture.name}: roundtrip responses payload missing input`
    );

    if (typeof fixture.payload.instructions === 'string' && fixture.payload.instructions.trim()) {
      assert.strictEqual(
        responsesPayload.instructions?.trim(),
        fixture.payload.instructions.trim(),
        `Fixture ${fixture.name}: instructions mismatch after roundtrip`
      );
    }

    passed += 1;
    console.log(`✅ Responses roundtrip passed for ${fixture.name}`);
  }

  console.log(`\nResponses conversion roundtrip complete. Passed: ${passed}/${fixtures.length}`);
}

try {
  await runRoundtripTests();
} catch (error) {
  console.error('❌ Responses roundtrip test failed:', error);
  process.exitCode = 1;
}
