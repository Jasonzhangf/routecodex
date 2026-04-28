#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function waitForFile(dir, predicate, timeoutMs = 1500) {
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const entries = await fs.readdir(dir);
      const match = entries.find(predicate);
      if (match) {
        return path.join(dir, match);
      }
    } catch {
      // ignore while waiting
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for file in ${dir}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function main() {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const moduleUrl = pathToFileURL(
    path.join(
      repoRoot,
      'dist',
      'router',
      'virtual-router',
      'engine-selection',
      'native-chat-process-governance-semantics.js'
    )
  ).href;
  const mod = await import(`${moduleUrl}?case=${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const { finalizeRespProcessChatResponseWithNative } = mod;

  const errorsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'routecodex-finalize-errorsamples-'));
  const previousErrorsDir = process.env.ROUTECODEX_ERRORSAMPLES_DIR;
  const previousSnapshotAsync = process.env.ROUTECODEX_SNAPSHOT_ASYNC;
  process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsDir;
  process.env.ROUTECODEX_SNAPSHOT_ASYNC = '0';

  try {
    const finalized = await finalizeRespProcessChatResponseWithNative({
      payload: {
        id: 'chatcmpl_finalize_empty_1',
        choices: [{
          finish_reason: 'stop',
          message: {
            content: ''
          }
        }]
      },
      stream: false,
      reasoningMode: 'keep',
      endpoint: '/v1/chat/completions',
      requestId: 'req_finalize_empty_1'
    });

    assert.equal(
      finalized.choices?.[0]?.message?.content,
      '[RouteCodex] assistant response became empty after response sanitization.'
    );

    const groupDir = path.join(errorsDir, 'payload-contract-error');
    const file = await waitForFile(
      groupDir,
      (name) => name.includes('assistant_sanitized_empty_placeholder')
    );
    const json = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal(json.kind, 'payload_contract_error');
    assert.equal(json.phase, 'provider-response');
    assert.equal(json.marker, 'assistant_sanitized_empty_placeholder');
    assert.equal(json.requestId, 'req_finalize_empty_1');
    assert.equal(
      json.observation?.finalizedPayload?.choices?.[0]?.message?.content,
      '[RouteCodex] assistant response became empty after response sanitization.'
    );

    console.log('✅ coverage-finalize-empty-sanitize-errorsample passed');
  } finally {
    if (previousErrorsDir === undefined) {
      delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
    } else {
      process.env.ROUTECODEX_ERRORSAMPLES_DIR = previousErrorsDir;
    }
    if (previousSnapshotAsync === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_ASYNC;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_ASYNC = previousSnapshotAsync;
    }
    await fs.rm(errorsDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('❌ coverage-finalize-empty-sanitize-errorsample failed:', error);
  process.exit(1);
});
