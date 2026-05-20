import { describe, expect, jest, test } from '@jest/globals';
import {
  buildWindsurfCloudEndpointCandidates,
  buildWindsurfCloudMetadata,
  buildWindsurfModelConfigProbeRequests,
  buildWindsurfStatusProbeRequests,
  WINDSURF_GET_CASCADE_MODEL_CONFIGS_PATH,
  WINDSURF_GET_USER_STATUS_PATH,
  WindsurfCloudClient,
} from '../../../../src/providers/core/runtime/windsurf-cloud-client.ts';

describe('windsurf cloud client', () => {
  test('build metadata matches WindsurfAPI truth shape', () => {
    expect(buildWindsurfCloudMetadata('session-token-1234567890')).toEqual({
      apiKey: 'session-token-1234567890',
      ideName: 'windsurf',
      ideVersion: '1.9600.41',
      extensionName: 'windsurf',
      extensionVersion: '1.9600.41',
      locale: 'en',
    });
  });

  test('build endpoint candidates trims slash and deduplicates', () => {
    expect(buildWindsurfCloudEndpointCandidates([
      'https://server.self-serve.windsurf.com/',
      'https://server.codeium.com',
      'https://server.self-serve.windsurf.com',
      '',
      undefined,
    ])).toEqual([
      'https://server.self-serve.windsurf.com',
      'https://server.codeium.com',
    ]);
  });

  test('build status/model probes only target cloud paths', () => {
    const statusProbes = buildWindsurfStatusProbeRequests({
      apiKey: 'session-token-1234567890',
      endpoints: ['https://server.self-serve.windsurf.com', 'https://server.codeium.com'],
    });
    const modelProbes = buildWindsurfModelConfigProbeRequests({
      apiKey: 'session-token-1234567890',
      endpoints: ['https://server.self-serve.windsurf.com', 'https://server.codeium.com'],
    });
    expect(statusProbes.every((entry) => entry.path === WINDSURF_GET_USER_STATUS_PATH)).toBe(true);
    expect(modelProbes.every((entry) => entry.path === WINDSURF_GET_CASCADE_MODEL_CONFIGS_PATH)).toBe(true);
    for (const entry of [...statusProbes, ...modelProbes]) {
      expect(entry.endpoint.startsWith('https://')).toBe(true);
      expect(entry.endpoint.includes('localhost')).toBe(false);
      expect((entry.body.metadata as Record<string, unknown>).apiKey).toBe('session-token-1234567890');
    }
  });

  test('client posts connect-protocol requests and returns first successful response', async () => {
    const post = jest.fn()
      .mockRejectedValueOnce(new Error('primary failed'))
      .mockResolvedValueOnce({ data: { ok: true } });
    const client = new WindsurfCloudClient({ post } as any);
    const result = await client.getUserStatus([
      { endpoint: 'https://server.self-serve.windsurf.com', path: WINDSURF_GET_USER_STATUS_PATH, body: { metadata: { apiKey: 'a' } } },
      { endpoint: 'https://server.codeium.com', path: WINDSURF_GET_USER_STATUS_PATH, body: { metadata: { apiKey: 'a' } } },
    ]);
    expect(result).toEqual({ ok: true });
    expect(post).toHaveBeenNthCalledWith(
      1,
      'https://server.self-serve.windsurf.com/exa.seat_management_pb.SeatManagementService/GetUserStatus',
      { metadata: { apiKey: 'a' } },
      expect.objectContaining({
        'Connect-Protocol-Version': '1',
        'User-Agent': 'windsurf/1.9600.41',
      })
    );
  });
});
