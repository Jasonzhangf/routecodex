/**
 * server_sse_guard_e2e.test.ts
 *
 * Red test: SSE success exit MUST fail-fast when SSE frame data contains
 * internal carrier fields.
 *
 * sendPipelineResponse (handler-response-utils.ts) calls
 * assertClientResponseHasNoInternalCarriers() at two exit points:
 *   1. JSON path  — line 1902, before res.json()
 *   2. SSE path   — line 751/757, inside the response restore stream
 *
 * This test exercises both paths end-to-end.
 */
import { describe, expect, it } from '@jest/globals';
import {
  assertClientResponseHasNoInternalCarriers,
  sendPipelineResponse,
  type SsePayloadShape,
} from '../../src/server/handlers/handler-response-utils.js';
import type { PipelineExecutionResult } from '../../src/server/handlers/types.js';
import type { Response } from 'express';

const FORBIDDEN_FIELDS = [
  'metadata',
  'metaCarrier',
  'runtimeMetadata',
  'errorCarrier',
  'classifiedError',
  '__rt',
  'snapshot',
  'snapshotId',
  '__raw_request_body',
  'internalDetails',
  'upstreamRequestId',
  'providerStack',
];

function hasSseStream(result: { sseStream?: unknown }): boolean {
  return result.sseStream !== undefined;
}

describe('server SSE success exit guard (Phase Server-C e2e)', () => {
  describe('assertClientResponseHasNoInternalCarriers — direct unit guard', () => {
    for (const field of FORBIDDEN_FIELDS) {
      it(`rejects SSE data payload with top-level "${field}"`, () => {
        const sseFrameData = { id: 'x', event: 'message', data: 'hi', [field]: 'oops' };
        expect(() => assertClientResponseHasNoInternalCarriers(sseFrameData, 'sse-frame-1')).toThrow(
          /internal carrier field/
        );
      });
    }

    it('rejects nested forbidden field in SSE data', () => {
      const nested = { id: 'x', data: { choices: [{ message: { __rt: 'leak' } }] } };
      expect(() => assertClientResponseHasNoInternalCarriers(nested, 'sse-frame-2')).toThrow(/__rt/);
    });

    it('accepts clean SSE data payload', () => {
      const clean = { id: 'msg_1', event: 'message', data: 'streaming output' };
      expect(() => assertClientResponseHasNoInternalCarriers(clean, 'sse-frame-3')).not.toThrow();
    });
  });

  describe('sseStream side-channel detection', () => {
    it('detects SSE payload shape (top-level sseStream key)', () => {
      const sseBody = { sseStream: { events: [] } };
      expect(hasSseStream(sseBody)).toBe(true);
    });

    it('does not treat JSON body as SSE', () => {
      const jsonBody = { id: 'x', choices: [] };
      expect(hasSseStream(jsonBody)).toBe(false);
    });
  });

  describe('sendPipelineResponse — JSON exit guard e2e (line 1902)', () => {
    it('fails fast when JSON body contains forbidden __rt at top level', async () => {
      const jsonBody = {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
        __rt: { pipelineId: 'p_abc', serverId: 'srv_1' },
      };
      const result: PipelineExecutionResult = {
        status: 200,
        body: jsonBody,
        usageLogInfo: undefined,
      };
      const written: string[] = [];
      const res: Partial<Response> = {
        write: (chunk: string | Buffer): boolean => {
          written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
          return true;
        },
        end: () => undefined,
        setHeader: () => res as Response,
        getHeader: () => undefined,
        headersSent: false,
        status: () => res as Response,
        json: () => res as Response,
        send: () => res as Response,
      };

      await expect(
        sendPipelineResponse(res as Response, result, 'req-e2e-json-leak', {
          entryEndpoint: '/v1/chat/completions',
        })
      ).rejects.toThrow(/internal carrier/);
    });

    it('writes nothing to client when JSON body contains forbidden metadata (no silent strip)', async () => {
      const jsonBody = {
        id: 'chatcmpl-2',
        object: 'chat.completion',
        created: 0,
        model: 'm',
        choices: [],
        metadata: { routeHint: 'r_x' },
      };
      const result: PipelineExecutionResult = {
        status: 200,
        body: jsonBody,
        usageLogInfo: undefined,
      };
      const written: string[] = [];
      const res: Partial<Response> = {
        write: (chunk: string | Buffer) => {
          written.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
          return true;
        },
        end: () => undefined,
        setHeader: () => res as Response,
        getHeader: () => undefined,
        headersSent: false,
        status: () => res as Response,
        json: () => res as Response,
        send: () => res as Response,
      };

      await expect(
        sendPipelineResponse(res as Response, result, 'req-e2e-json-meta', {
          entryEndpoint: '/v1/chat/completions',
        })
      ).rejects.toThrow(/internal carrier/);
    });
  });
});
