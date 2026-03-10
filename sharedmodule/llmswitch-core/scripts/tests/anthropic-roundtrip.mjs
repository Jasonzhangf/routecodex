#!/usr/bin/env node

/**
 * Anthropic conversion roundtrip test:
 * - Loads Anthropic fixtures
 * - buildOpenAIChatFromAnthropic → Chat payload
 * - buildAnthropicRequestFromOpenAIChat → Anthropic payload
 * - Ensures core fields survive the roundtrip.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(__filename), '..', '..');
const fixturesDir = path.join(projectRoot, 'test', 'fixtures', 'anthropic');
const codecModule = path.join(projectRoot, 'dist', 'conversion', 'codecs', 'anthropic-openai-codec.js');

async function loadFixtures() {
  const entries = await fs.readdir(fixturesDir);
  const jsonFiles = entries.filter((file) => file.toLowerCase().endsWith('.json'));
  if (!jsonFiles.length) {
    throw new Error(`No anthropic fixtures found in ${fixturesDir}`);
  }
  const fixtures = [];
  for (const file of jsonFiles) {
    const fullPath = path.join(fixturesDir, file);
    const payload = JSON.parse(await fs.readFile(fullPath, 'utf-8'));
    fixtures.push({ name: file, payload });
  }
  return fixtures;
}

async function runRoundtripTests() {
  const { buildOpenAIChatFromAnthropic, buildAnthropicRequestFromOpenAIChat } = await import(
    pathToFileURL(codecModule).href
  );

  const fixtures = await loadFixtures();
  let passed = 0;

  for (const fixture of fixtures) {
    const chatPayload = buildOpenAIChatFromAnthropic(fixture.payload);
    assert.ok(
      Array.isArray(chatPayload?.messages) && chatPayload.messages.length > 0,
      `Fixture ${fixture.name}: anthropic→chat produced no messages`
    );

    const roundtrip = buildAnthropicRequestFromOpenAIChat(chatPayload);
    assert.ok(
      Array.isArray(roundtrip?.messages) && roundtrip.messages.length > 0,
      `Fixture ${fixture.name}: chat→anthropic roundtrip produced no messages`
    );

    const origSys = fixture.payload.system;
    const roundSys = roundtrip.system;
    if (typeof origSys === 'string' && origSys.trim() && typeof roundSys === 'string') {
      assert.strictEqual((roundSys || '').trim(), origSys.trim(), `Fixture ${fixture.name}: system prompt mismatch`);
    }

    const userCount = fixture.payload.messages?.filter((m) => m?.role === 'user').length || 0;
    const roundTripUserCount = roundtrip.messages?.filter((m) => m?.role === 'user').length || 0;
    assert.strictEqual(
      roundTripUserCount,
      userCount,
      `Fixture ${fixture.name}: user message count changed`
    );

    passed += 1;
    console.log(`✅ Anthropic roundtrip passed for ${fixture.name}`);
  }

  console.log(`\nAnthropic conversion roundtrip complete. Passed: ${passed}/${fixtures.length}`);
}

try {
  await runRoundtripTests();
} catch (error) {
  console.error('❌ Anthropic roundtrip test failed:', error);
  process.exitCode = 1;
}
