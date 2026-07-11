import { describe, expect, it } from '@jest/globals';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const legacyPrefix = '__routecodex';
const legacyStreamProbeKey = `${legacyPrefix}_stream_contract_probe_body`;
const legacyStreamFinishReasonKey = `${legacyPrefix}_stream_finish_reason`;

function readRepoFile(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function collectFiles(path: string): string[] {
  const absolute = resolve(root, path);
  const stat = statSync(absolute);
  if (stat.isFile()) {
    return [absolute];
  }
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'build') {
      continue;
    }
    files.push(...collectFiles(`${path}/${entry}`));
  }
  return files;
}

describe('response SSE wrapper contract', () => {
  it('does not use body.sseStream as a response stream source', () => {
    const source = readRepoFile('src/server/handlers/handler-response-sse.ts');

    expect(source).toContain('const streamSource = result.sseStream;');
    expect(source).not.toContain('bodyRecord?.sseStream');
    expect(source).not.toMatch(/result\.sseStream\s*\?\?/);
  });

  it('does not expose a body-level sseStream predicate as a canonical bridge builder', () => {
    const handler = readRepoFile('src/server/handlers/handler-response-utils.ts');
    const sseHandler = readRepoFile('src/server/handlers/handler-response-sse.ts');

    expect(existsSync(resolve(root, 'src/modules/llmswitch/bridge/index.ts'))).toBe(false);
    expect(existsSync(resolve(root, 'src/modules/llmswitch/bridge/responses-sse-bridge.ts'))).toBe(false);

    for (const source of [handler, sseHandler]) {
      expect(source).not.toContain('hasResponsesSsePayloadForHttp');
      expect(source).not.toContain('hasSsePayload:');
      expect(source).not.toContain('args.hasSsePayload');
    }
  });

  it('fails client JSON projection if an internal sseStream wrapper reaches normal payload', async () => {
    const { assertClientResponseHasNoInternalCarriers, sendPipelineResponse } = await import(
      '../../../src/server/handlers/handler-response-utils.js'
    );

    expect(() => assertClientResponseHasNoInternalCarriers(
      {
        id: 'resp_illegal_sse_wrapper',
        object: 'response',
        status: 'completed',
        sseStream: { pipe: () => undefined },
      },
      'req-illegal-sse-wrapper',
    )).toThrow('sseStream');

    await expect(sendPipelineResponse(
      {
        setHeader: () => undefined,
        status: () => ({
          json: () => undefined,
          end: () => undefined,
        }),
        json: () => undefined,
        end: () => undefined,
      } as any,
      {
        status: 200,
        body: {
          id: 'resp_illegal_body_sse_stream',
          object: 'response',
          status: 'completed',
          sseStream: { pipe: () => undefined },
        },
      } as any,
      'req-illegal-body-sse-stream',
      {
        entryEndpoint: '/v1/responses',
        responsesRequestContext: {
          payload: {},
          context: { toolsRaw: [] },
        },
      },
    )).rejects.toThrow('sseStream');
  });

  it('does not model legacy RouteCodex stream probe wrappers in server tests or fixtures', () => {
    const scannedFiles = [
      ...collectFiles('tests/server/handlers'),
      ...collectFiles('tests/server/runtime'),
      ...collectFiles('tests/fixtures/conversion-matrix'),
    ].filter((path) => /\.(json|ts)$/.test(path));

    const offenders = scannedFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [legacyStreamProbeKey, legacyStreamFinishReasonKey]
        .filter((legacyKey) => source.includes(legacyKey))
        .map((legacyKey) => `${file.replace(`${root}/`, '')}: ${legacyKey}`);
    });

    expect(offenders).toEqual([]);
  });
});
