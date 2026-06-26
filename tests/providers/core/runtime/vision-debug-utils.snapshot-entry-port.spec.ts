import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const writeProviderSnapshot = jest.fn(async () => {});

describe('captureVisionDebugPayloadSnapshot snapshot entryPort', () => {
  const previousEnv = process.env.ROUTECODEX_VISION_DEBUG;

  beforeEach(() => {
    jest.resetModules();
    process.env.ROUTECODEX_VISION_DEBUG = '1';
    writeProviderSnapshot.mockClear();
  });

  afterAll(() => {
    if (previousEnv === undefined) {
      delete process.env.ROUTECODEX_VISION_DEBUG;
    } else {
      process.env.ROUTECODEX_VISION_DEBUG = previousEnv;
    }
  });

  it('forwards entryPort from provider runtime metadata into vision debug snapshots', async () => {
    jest.unstable_mockModule('../../../../src/providers/core/utils/snapshot-writer.js', () => ({
      writeProviderSnapshot
    }));
    const { captureVisionDebugPayloadSnapshot } = await import(
      '../../../../src/providers/core/runtime/vision-debug-utils.ts'
    );
    const { attachProviderRuntimeMetadata } = await import(
      '../../../../src/providers/core/runtime/provider-runtime-metadata.ts'
    );

    const payload: Record<string, unknown> = {
      metadata: {
        entryEndpoint: '/v1/responses'
      },
      messages: [{ role: 'user', content: 'hello' }]
    };
    attachProviderRuntimeMetadata(payload, {
      requestId: 'req-vision-entry-port',
      routeName: 'vision',
      entryPort: 5555
    });

    await captureVisionDebugPayloadSnapshot('provider-body-debug', payload as any);

    expect(writeProviderSnapshot).toHaveBeenCalledTimes(1);
    expect(writeProviderSnapshot.mock.calls[0]?.[0]).toMatchObject({
      phase: 'provider-body-debug',
      requestId: 'req-vision-entry-port',
      entryPort: 5555
    });
  });
});
