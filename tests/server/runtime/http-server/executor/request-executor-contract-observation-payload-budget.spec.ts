import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  queueRequestExecutorPayloadContractErrorsample,
  summarizePayloadContractObservationForErrorsample,
} from '../../../../../src/server/runtime/http-server/executor/request-executor-runtime-blocks.js';
import {
  __flushErrorsampleQueueForTests,
  __resetErrorsampleQueueForTests,
} from '../../../../../src/utils/errorsamples.js';

// feature_id: debug.contract_observation_payload_budget
describe('request executor contract observation payload budget', () => {
  it('summarizes large contract observations without embedding complete bodies', () => {
    const largePrompt = 'prompt-token-'.repeat(20_000);
    const largeOutput = 'assistant-output-'.repeat(20_000);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const summary = summarizePayloadContractObservationForErrorsample({
      providerRequestPayload: {
        model: 'gpt-large',
        input: largePrompt,
        nested: circular,
      },
      normalizedResponse: {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          status: 'completed',
          output_text: largeOutput,
        },
      },
      convertedResponse: {
        status: 200,
        headers: { 'x-test': '1' },
        body: {
          choices: [
            {
              message: { content: largeOutput },
            },
          ],
        },
      },
    }) as Record<string, unknown>;

    const serialized = JSON.stringify(summary);
    expect(serialized).toContain('gpt-large');
    expect(serialized).toContain('stringLength');
    expect(serialized).toContain('[CIRCULAR]');
    expect(serialized).not.toContain(largePrompt);
    expect(serialized).not.toContain(largeOutput);
    expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThan(12_000);
  });

  it('does not pass raw contract observations directly into errorsample serialization', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/server/runtime/http-server/executor/request-executor-runtime-blocks.ts'),
      'utf8',
    );
    const queueName = ['queueRequestExecutorPayloadContract', 'Errorsample'].join('');
    const writerName = ['createRequestExecutorPayloadContract', 'ErrorsampleWriter'].join('');
    const summaryName = ['summarizePayloadContractObservation', 'ForErrorsample'].join('');
    const start = source.indexOf(`export function ${queueName}(`);
    const end = source.indexOf(`\nexport function ${writerName}`, start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain(`${summaryName}(args.observation)`);
    expect(body).not.toContain('observation: args.observation');
  });

  it('writes a bounded payload-contract errorsample summary', async () => {
    const tempDir = fs.mkdtempSync(path.join(process.cwd(), '.tmp-contract-observation-'));
    const previousDir = process.env.ROUTECODEX_ERRORSAMPLES_DIR;
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = tempDir;
    __resetErrorsampleQueueForTests();
    try {
      const giant = 'raw-observation-payload-'.repeat(30_000);
      queueRequestExecutorPayloadContractErrorsample({
        phase: 'provider-response',
        requestId: 'req-contract-budget',
        providerKey: 'mock.key1',
        providerId: 'mock',
        marker: 'empty_assistant',
        reason: 'empty assistant',
        observation: {
          providerRequestPayload: { model: 'gpt-large', input: giant },
          normalizedResponse: { status: 200, body: { output_text: giant } },
          convertedResponse: { status: 200, body: { output_text: giant } },
        },
        onNonBlockingError: () => undefined,
      });
      await __flushErrorsampleQueueForTests();
      const groupDir = path.join(tempDir, 'payload-contract-error');
      const [fileName] = fs.readdirSync(groupDir);
      const written = fs.readFileSync(path.join(groupDir, fileName), 'utf8');

      expect(written).toContain('payload_contract_error');
      expect(written).toContain('gpt-large');
      expect(written).toContain('stringLength');
      expect(written).not.toContain(giant);
      expect(Buffer.byteLength(written, 'utf8')).toBeLessThan(32_000);
    } finally {
      __resetErrorsampleQueueForTests();
      if (previousDir === undefined) {
        delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
      } else {
        process.env.ROUTECODEX_ERRORSAMPLES_DIR = previousDir;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
