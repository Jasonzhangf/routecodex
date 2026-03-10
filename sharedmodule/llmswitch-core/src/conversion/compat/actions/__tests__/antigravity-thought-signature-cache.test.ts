import { cacheAntigravityThoughtSignatureFromGeminiResponse } from '../antigravity-thought-signature-cache.js';
import {
  prepareAntigravityThoughtSignatureForGeminiRequest,
} from '../antigravity-thought-signature-prepare.js';
import {
  resetAntigravitySessionSignatureCachesForTests,
} from '../../antigravity-session-signature.js';

describe('antigravity-thought-signature-cache native wrapper', () => {
  beforeEach(() => {
    resetAntigravitySessionSignatureCachesForTests();
  });

  test('caches Gemini response signature and makes it available to request prepare path', () => {
    const warmupPrepared = prepareAntigravityThoughtSignatureForGeminiRequest(
      {
        requestId: 'agent-cache-warmup-1',
        userAgent: 'antigravity',
        contents: [
          { role: 'user', parts: [{ text: 'compile project sigcache gemini cli 2' }] },
          {
            role: 'assistant',
            parts: [{ functionCall: { name: 'exec_command', args: { cmd: 'pwd' } } }],
          },
        ],
      } as any,
      {
        compatibilityProfile: 'chat:gemini-cli',
        providerProtocol: 'gemini-chat',
        providerId: 'antigravity',
        providerKey: 'antigravity.alpha2.gemini-2.5',
        runtimeKey: 'antigravity.alpha2',
        requestId: 'req_gemini_cli_sig_cache_warmup_1',
      } as any,
    ) as any;

    expect(warmupPrepared.contents[1].parts[0].thoughtSignature).toBeUndefined();

    const responsePayload: any = {
      request_id: 'req_gemini_cli_sig_cache_warmup_1',
      candidates: [
        {
          content: {
            parts: [{ thoughtSignature: 'C'.repeat(64) }],
          },
        },
      ],
    };

    const cached = cacheAntigravityThoughtSignatureFromGeminiResponse(responsePayload, {
      compatibilityProfile: 'chat:gemini-cli',
      providerProtocol: 'gemini-chat',
      providerId: 'antigravity',
      providerKey: 'antigravity.alpha2.gemini-2.5',
      runtimeKey: 'antigravity.alpha2',
      requestId: 'req_gemini_cli_sig_cache_warmup_1',
    } as any) as any;

    expect(cached.candidates[0].content.parts[0].thoughtSignature).toBe('C'.repeat(64));

    const prepared = prepareAntigravityThoughtSignatureForGeminiRequest(
      {
        requestId: 'agent-cache-followup-1',
        userAgent: 'antigravity',
        contents: [
          { role: 'user', parts: [{ text: 'compile project sigcache gemini cli 2' }] },
          {
            role: 'assistant',
            parts: [{ functionCall: { name: 'exec_command', args: { cmd: 'pwd' } } }],
          },
        ],
      } as any,
      {
        compatibilityProfile: 'chat:gemini-cli',
        providerProtocol: 'gemini-chat',
        providerId: 'antigravity',
        providerKey: 'antigravity.alpha2.gemini-2.5',
        runtimeKey: 'antigravity.alpha2',
        requestId: 'req_gemini_cli_sig_cache_followup_1',
      } as any,
    ) as any;

    expect(prepared.contents[1].parts[0].thoughtSignature).toBe('C'.repeat(64));
  });
});
