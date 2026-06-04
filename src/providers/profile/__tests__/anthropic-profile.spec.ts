import { anthropicFamilyProfile } from '../families/anthropic-profile.js';

describe('anthropicFamilyProfile.resolveStreamIntent', () => {
  it('disables upstream SSE when target streaming is never', () => {
    const result = anthropicFamilyProfile.resolveStreamIntent?.({
      request: {
        stream: true,
        metadata: {
          stream: true
        }
      },
      context: {
        requestId: 'req-1',
        providerType: 'anthropic',
        startTime: Date.now(),
        metadata: {
          stream: true,
          targetStreaming: 'never'
        }
      },
      runtimeMetadata: {
        target: {
          streaming: 'never'
        }
      }
    });

    expect(result).toBe(false);
  });

  it('forces upstream SSE when target streaming is always', () => {
    const result = anthropicFamilyProfile.resolveStreamIntent?.({
      request: {
        stream: false,
        metadata: {
          stream: false
        }
      },
      context: {
        requestId: 'req-2',
        providerType: 'anthropic',
        startTime: Date.now(),
        metadata: {
          stream: false,
          targetStreaming: 'always'
        }
      },
      runtimeMetadata: {
        target: {
          streaming: 'always'
        }
      }
    });

    expect(result).toBe(true);
  });

  it('falls back to request stream flag when no target override exists', () => {
    const result = anthropicFamilyProfile.resolveStreamIntent?.({
      request: {
        stream: true,
        metadata: {
          stream: true
        }
      },
      context: {
        requestId: 'req-3',
        providerType: 'anthropic',
        startTime: Date.now(),
        metadata: {}
      },
      runtimeMetadata: {}
    });

    expect(result).toBe(true);
  });
});

describe('anthropicFamilyProfile.resolveBusinessResponseError', () => {
  it('rejects non-SSE Anthropic responses without content array before Hub conversion', () => {
    const error = anthropicFamilyProfile.resolveBusinessResponseError?.({
      response: { id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'end_turn' },
      runtimeMetadata: {}
    });

    expect(error?.message).toContain('malformed Anthropic response');
    expect((error as any)?.code).toBe('MALFORMED_RESPONSE');
    expect((error as any)?.upstreamCode).toBe('anthropic_malformed_response');
  });

  it('accepts Anthropic message responses with content array', () => {
    const error = anthropicFamilyProfile.resolveBusinessResponseError?.({
      response: { id: 'msg_1', type: 'message', role: 'assistant', content: [], stop_reason: 'end_turn' },
      runtimeMetadata: {}
    });

    expect(error).toBeUndefined();
  });
});
