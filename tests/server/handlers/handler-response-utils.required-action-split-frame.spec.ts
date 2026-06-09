import { PassThrough, Readable } from 'node:stream';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';

const writeServerSnapshotMock = jest.fn(async (options: {
  phase: string;
  requestId: string;
  data: unknown;
  entryEndpoint?: string;
}) => {
  const root = process.env.RCC_SNAPSHOT_DIR;
  if (!root || options.phase !== 'client-response') return;
  const dir = path.join(root, 'openai-responses', options.requestId.replace(/[^A-Za-z0-9_.-]/g, '_'));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'client-response_server.json'),
    JSON.stringify({ meta: { stage: options.phase }, data: options.data }, null, 2),
    'utf8'
  );
});

jest.unstable_mockModule('../../../src/modules/llmswitch/bridge.js', async () => ({
  createResponsesJsonToSseConverter: jest.fn(),
  importCoreDist: jest.fn(),
  requireCoreDist: jest.fn(),
  deriveFinishReasonNative: jest.fn(() => undefined),
  isToolCallContinuationResponseNative: jest.fn(() => false),
  updateResponsesContractProbeFromSseChunkNative: jest.fn((chunk: unknown, probe: Record<string, unknown> | undefined) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk ?? '');
    const next = { ...(probe ?? {}) } as Record<string, unknown>;
    const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) return next;
    try {
      const parsed = JSON.parse(dataLine.slice('data:'.length).trim()) as Record<string, unknown>;
      const response = parsed.response && typeof parsed.response === 'object' && !Array.isArray(parsed.response)
        ? parsed.response as Record<string, unknown>
        : undefined;
      if (response) Object.assign(next, response);
      if (parsed.required_action) next.required_action = parsed.required_action;
    } catch {}
    return next;
  }),
  buildResponsesTerminalSseFramesFromProbeNative: jest.fn((probe: Record<string, unknown> | undefined) => {
    if (!probe?.required_action) return [];
    const response = { ...probe, status: 'requires_action' };
    return [
      `event: response.required_action\ndata: ${JSON.stringify({ type: 'response.required_action', response, required_action: probe.required_action })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
      `event: response.done\ndata: ${JSON.stringify({ type: 'response.done', response })}\n\n`
    ];
  }),
  captureResponsesRequestContextForRequest: jest.fn(async () => undefined),
  clearResponsesConversationByRequestId: jest.fn(async () => undefined),
  finalizeResponsesConversationRequestRetention: jest.fn(async () => undefined),
  recordResponsesResponseForRequest: jest.fn(async () => undefined)
  ,
  rebindResponsesConversationRequestId: jest.fn(async () => undefined)
}));

jest.unstable_mockModule('../../../src/utils/snapshot-writer.js', () => ({
  isSnapshotsEnabled: () => true,
  writeServerSnapshot: writeServerSnapshotMock
}));

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  json(body: unknown): this {
    this.end(JSON.stringify(body));
    return this;
  }
}

async function waitForEndWithTimeout(stream: PassThrough, timeoutMs: number): Promise<boolean> {
  return await Promise.race<boolean>([
    new Promise<boolean>((resolve, reject) => {
      stream.once('end', () => resolve(true));
      stream.once('error', reject);
      stream.resume();
    }),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

async function readClientSnapshotFromDir(root: string): Promise<{ meta?: { stage?: string }; data?: { bodyText?: string } } | undefined> {
  async function walk(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await walk(fullPath));
      } else if (entry.isFile() && entry.name.includes('client-response') && entry.name.endsWith('.json')) {
        files.push(fullPath);
      }
    }
    return files;
  }
  const files = await walk(root);
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { meta?: { stage?: string }; data?: { bodyText?: string } };
    if (parsed.meta?.stage === 'client-response') {
      return parsed;
    }
  }
  return undefined;
}

async function waitForClientSnapshot(root: string, timeoutMs: number): Promise<{ meta?: { stage?: string }; data?: { bodyText?: string } } | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const snapshot = await readClientSnapshotFromDir(root);
    if (snapshot) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

describe('handler-response-utils required_action split frame regression', () => {
  it('RED: split response.required_action SSE frames must not terminate before data payload arrives', async () => {
    const previousCapture = process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS;
    const previousSnapshotDir = process.env.RCC_SNAPSHOT_DIR;
    const previousGlobalSnapshotFlag = (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled;
    const snapshotRoot = await mkdtemp(path.join(tmpdir(), 'rcc-client-sse-snap-'));
    process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS = '1';
    process.env.RCC_SNAPSHOT_DIR = snapshotRoot;
    (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled = true;
    writeServerSnapshotMock.mockClear();
    const { sendPipelineResponse } = await import('../../../src/server/handlers/handler-response-utils.js');
    const { allowSnapshotLocalDiskWrite } = await import('../../../src/utils/snapshot-local-disk-gate.js');
    const requestId = 'openai-responses-router-gpt-5.3-codex-native-sse-required-action-split-frame';
    const responseId = 'resp_native_sse_required_action_split_frame_1';
    const callId = 'call_native_sse_required_action_split_frame_1';

    async function* splitRequiredActionStream(): AsyncGenerator<string> {
      yield 'event: response.required_action\n';
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield `data: ${JSON.stringify({
        type: 'response.required_action',
        response: { id: responseId, object: 'response', status: 'requires_action' },
        required_action: {
          type: 'submit_tool_outputs',
          submit_tool_outputs: {
            tool_calls: [{ id: callId, type: 'function_call', name: 'update_plan', arguments: '{"plan":[{"step":"split-frame"}]}' }]
          }
        }
      })}\n\n`;
      await new Promise(() => {});
    }

    const res = new MockResponse();
    const chunks: string[] = [];
    res.on('data', (chunk) => chunks.push(String(chunk)));
    allowSnapshotLocalDiskWrite(requestId);

    void sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          __sse_responses: Readable.from(splitRequiredActionStream()),
          __routecodex_stream_finish_reason: 'tool_calls',
          __routecodex_stream_contract_probe_body: {
            id: responseId,
            object: 'response',
            status: 'requires_action',
            output: [
              {
                type: 'function_call',
                call_id: callId,
                id: `fc_${callId}`,
                name: 'update_plan',
                arguments: '{"plan":[{"step":"split-frame"}]}'
              }
            ],
            required_action: {
              type: 'submit_tool_outputs',
              submit_tool_outputs: {
                tool_calls: [{ id: callId, type: 'function_call', name: 'update_plan', arguments: '{"plan":[{"step":"split-frame"}]}' }]
              }
            }
          }
        },
        usageLogInfo: {
          finishReason: 'tool_calls',
          routeName: 'thinking/gateway-priority-5555-thinking',
          sessionId: 'rcc-native-sse-required-action-split-frame'
        },
        metadata: { outboundStream: true }
      } as any,
      requestId,
      {
        entryEndpoint: '/v1/responses',
        responsesRequestContext: {
          payload: {
            model: 'gpt-5.3-codex',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'call update_plan then continue' }] }]
          },
          context: {
            input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call update_plan then continue' }] }]
          },
          sessionId: 'rcc-native-sse-required-action-split-frame'
        }
      }
    );

    const ended = await waitForEndWithTimeout(res, 700);
    expect(ended).toBe(true);
    const text = chunks.join('');
    expect(text).toContain('event: response.required_action');
    expect(text).toContain('data: {"type":"response.required_action"');
    expect(text).toContain('event: response.completed');
    expect(text).toContain('event: response.done');
    expect(text.indexOf('event: response.required_action')).toBeLessThan(text.indexOf('event: response.completed'));
    expect(text.indexOf('event: response.completed')).toBeLessThan(text.indexOf('event: response.done'));
    const clientSnapshot = await waitForClientSnapshot(snapshotRoot, 500);
    expect(clientSnapshot?.data?.bodyText).toContain('event: response.required_action');
    expect(clientSnapshot?.data?.bodyText).toContain(callId);
    await rm(snapshotRoot, { recursive: true, force: true });
    if (previousCapture === undefined) {
      delete process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS;
    } else {
      process.env.ROUTECODEX_CAPTURE_STREAM_SNAPSHOTS = previousCapture;
    }
    if (previousSnapshotDir === undefined) {
      delete process.env.RCC_SNAPSHOT_DIR;
    } else {
      process.env.RCC_SNAPSHOT_DIR = previousSnapshotDir;
    }
    if (previousGlobalSnapshotFlag === undefined) {
      delete (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled;
    } else {
      (globalThis as { rccSnapshotsEnabled?: boolean }).rccSnapshotsEnabled = previousGlobalSnapshotFlag;
    }
  });
});
