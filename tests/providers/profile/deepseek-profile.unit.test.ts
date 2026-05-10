import { describe, expect, test } from '@jest/globals';

import {
  DEEPSEEK_UPSTREAM_CLIENT_VERSION,
  DEEPSEEK_UPSTREAM_USER_AGENT
} from '../../../src/providers/core/contracts/deepseek-provider-contract.js';
import { getProviderFamilyProfile } from '../../../src/providers/profile/profile-registry.js';

describe('deepseek profile', () => {
  test('scrubs client identity headers and reapplies upstream deepseek headers', () => {
    const deepseekProfile = getProviderFamilyProfile({ providerId: 'deepseek' });
    expect(deepseekProfile).toBeTruthy();

    const headers = deepseekProfile?.applyRequestHeaders?.({
      headers: {
        Authorization: 'Bearer test-token',
        'User-Agent': 'opencode/1.2.27',
        originator: 'codex-tui',
        'x-client-platform': 'macos',
        'x-client-version': '1.8.0',
        'x-client-locale': 'zh_CN',
        session_id: 'sess-1',
        conversation_id: 'conv-1',
        'anthropic-session-id': 'anth-sess',
        'anthropic-conversation-id': 'anth-conv'
      }
    } as any);

    expect(headers?.Authorization).toBe('Bearer test-token');
    expect(headers?.['User-Agent']).toBe(DEEPSEEK_UPSTREAM_USER_AGENT);
    expect(headers?.['x-client-platform']).toBe('android');
    expect(headers?.['x-client-version']).toBe(DEEPSEEK_UPSTREAM_CLIENT_VERSION);
    expect(headers?.originator).toBeUndefined();
    expect(headers?.session_id).toBeUndefined();
    expect(headers?.conversation_id).toBeUndefined();
    expect(headers?.['anthropic-session-id']).toBeUndefined();
    expect(headers?.['anthropic-conversation-id']).toBeUndefined();
    expect(headers?.Origin).toBe('https://chat.deepseek.com');
    expect(headers?.Referer).toBe('https://chat.deepseek.com/');
  });
});
