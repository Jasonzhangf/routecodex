import { prepareAntigravityThoughtSignatureForGeminiRequest } from '../antigravity-thought-signature-prepare.js';
import {
  cacheAntigravitySessionSignature,
  resetAntigravitySessionSignatureCachesForTests,
} from '../../antigravity-session-signature.js';

describe('antigravity-thought-signature-prepare native wrapper', () => {
  beforeEach(() => {
    resetAntigravitySessionSignatureCachesForTests();
  });

  test('injects cached signature into Gemini function calls', () => {
    const signature = 'A'.repeat(64);
    cacheAntigravitySessionSignature(
      'antigravity.alpha2',
      'sid-1111111111111111',
      signature,
      2,
    );

    const payload: any = {
      requestId: 'agent-888',
      userAgent: 'antigravity',
      contents: [
        { role: 'user', parts: [{ text: 'compile project sigcache gemini cli 1' }] },
        {
          role: 'assistant',
          parts: [
            {
              functionCall: { name: 'exec_command', args: { cmd: 'pwd' } },
            },
          ],
        },
      ],
    };

    const result = prepareAntigravityThoughtSignatureForGeminiRequest(payload, {
      compatibilityProfile: 'chat:gemini-cli',
      providerProtocol: 'gemini-chat',
      providerId: 'antigravity',
      providerKey: 'antigravity.alpha2.gemini-2.5',
      runtimeKey: 'antigravity.alpha2',
      requestId: 'req_gemini_cli_sig_2',
    } as any) as any;

    expect(result.contents[1].parts[0].thoughtSignature).toBe(signature);
  });

  test('rewind recovery strips signature and appends recovery prompt without reinjection', () => {
    const payload: any = {
      requestId: 'agent-recover-1',
      contents: [
        {
          role: 'user',
          parts: [{ text: 'compile project sigcache gemini cli 1' }],
        },
        {
          role: 'assistant',
          parts: [
            {
              functionCall: { name: 'exec_command', args: { cmd: 'pwd' } },
              thoughtSignature: 'B'.repeat(64),
            },
          ],
        },
      ],
    };

    const result = prepareAntigravityThoughtSignatureForGeminiRequest(payload, {
      compatibilityProfile: 'chat:gemini-cli',
      providerProtocol: 'gemini-chat',
      providerId: 'antigravity',
      providerKey: 'antigravity.alpha2.gemini-2.5',
      runtimeKey: 'antigravity.alpha2',
      requestId: 'req_gemini_cli_recover_1',
      __rt: { antigravityThoughtSignatureRecovery: true },
    } as any) as any;

    expect(result.contents[1].parts[0].thoughtSignature).toBeUndefined();
    expect(result.contents[1].parts[result.contents[1].parts.length - 1].text).toContain(
      '[System Recovery]',
    );
  });
});
