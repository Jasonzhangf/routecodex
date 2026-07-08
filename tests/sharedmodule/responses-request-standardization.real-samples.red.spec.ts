import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { coerceStandardizedRequestFromPayloadDirectNative } from './helpers/hub-pipeline-builders-direct-native.js';

const FIXTURE_ROOT = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'errorsamples',
  'responses-request-standardization',
);

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('responses request standardization real-sample regressions', () => {
  const fixtureDirs = fs
    .readdirSync(FIXTURE_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(FIXTURE_ROOT, entry.name))
    .sort();

  it('has curated real-sample fixtures', () => {
    expect(fixtureDirs.length).toBeGreaterThanOrEqual(2);
  });

  it.each(fixtureDirs)('replays request standardization fixture: %s', (fixtureDir) => {
    const meta = readJson(path.join(fixtureDir, 'meta.json'));
    const payload = readJson(path.join(fixtureDir, 'request-body.json'));

    const output = coerceStandardizedRequestFromPayloadDirectNative({
      payload,
      normalized: {
        id: meta.requestId ?? path.basename(fixtureDir),
        entryEndpoint: meta.endpoint ?? '/v1/responses',
        stream: payload?.stream !== false,
        processMode: 'chat',
      },
    });

    const standardizedRequest = output.standardizedRequest as Record<string, any>;
    const messages = Array.isArray(standardizedRequest.messages) ? standardizedRequest.messages : [];
    const tools = Array.isArray(standardizedRequest.tools) ? standardizedRequest.tools : [];
    const serializedMessages = JSON.stringify(messages);

    expect(messages.length).toBeGreaterThan(0);

    const fixtureName = path.basename(fixtureDir);
    if (fixtureName === '2026-06-13-duplicate-replay-wrapper-noise') {
      const assistantToolCalls = messages.flatMap((message: any) =>
        Array.isArray(message?.tool_calls) ? message.tool_calls : [],
      );
      expect(messages.length).toBe(33);
      expect(tools.length).toBe(16);
      expect(messages.filter((message: any) => message?.role === 'tool')).toHaveLength(7);
      expect(assistantToolCalls).toHaveLength(7);
    }

    if (fixtureName === '2026-06-07-apply-patch-error-carryover-curated') {
      expect(messages.length).toBe(5);
      expect(messages.filter((message: any) => message?.role === 'tool')).toHaveLength(2);
      expect(serializedMessages).toContain('APPLY_PATCH_ERROR: apply_patch did not apply');
      expect(serializedMessages).toContain('Retry with apply_patch only');
      expect(serializedMessages).toContain('workspace-relative');
      expect(serializedMessages).toContain('Do not switch to exec_command');
      expect(serializedMessages).not.toContain('apply_patch verification failed');
      expect(serializedMessages).not.toContain('Failed to find expected lines');
      expect(serializedMessages).not.toContain('Chunk ID:');
      expect(serializedMessages).not.toContain('Original token count:');
    }
  });
});
