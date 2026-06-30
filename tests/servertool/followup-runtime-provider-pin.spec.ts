import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';

import {
  compactFollowupErrorReason,
  normalizeClientInjectText,
  readClientInjectOnly,
  resolveAdapterContextProviderKey,
  resolveServerToolFollowupTimeoutMs,
  resolveServerToolTimeoutMs
} from '../../sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.js';

describe('servertool sticky provider pin', () => {
  test('prefers exact target providerKey over alias adapter providerKey', () => {
    expect(
      resolveAdapterContextProviderKey({
        providerKey: 'mini27.key1.minimax',
        targetProviderKey: 'mini27.key1.minimax',
        target: {
          providerKey: 'mini27.key1.MiniMax-M2.7'
        }
      })
    ).toBe('mini27.key1.MiniMax-M2.7');
  });

  test('resolves timeout env policy through native contract', () => {
    const previous = {
      ROUTECODEX_SERVERTOOL_TIMEOUT_MS: process.env.ROUTECODEX_SERVERTOOL_TIMEOUT_MS,
      RCC_SERVERTOOL_TIMEOUT_MS: process.env.RCC_SERVERTOOL_TIMEOUT_MS,
      LLMSWITCH_SERVERTOOL_TIMEOUT_MS: process.env.LLMSWITCH_SERVERTOOL_TIMEOUT_MS,
      ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS: process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS,
      RCC_SERVERTOOL_FOLLOWUP_TIMEOUT_MS: process.env.RCC_SERVERTOOL_FOLLOWUP_TIMEOUT_MS,
      LLMSWITCH_SERVERTOOL_FOLLOWUP_TIMEOUT_MS: process.env.LLMSWITCH_SERVERTOOL_FOLLOWUP_TIMEOUT_MS
    };
    try {
      delete process.env.RCC_SERVERTOOL_TIMEOUT_MS;
      delete process.env.LLMSWITCH_SERVERTOOL_TIMEOUT_MS;
      delete process.env.RCC_SERVERTOOL_FOLLOWUP_TIMEOUT_MS;
      delete process.env.LLMSWITCH_SERVERTOOL_FOLLOWUP_TIMEOUT_MS;
      process.env.ROUTECODEX_SERVERTOOL_TIMEOUT_MS = '1500.9';
      process.env.ROUTECODEX_SERVERTOOL_FOLLOWUP_TIMEOUT_MS = '2500.1';

      expect(resolveServerToolTimeoutMs()).toBe(1500);
      expect(resolveServerToolFollowupTimeoutMs()).toBe(2500);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test('keeps timeout native parse inputs behind a single thin helper', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.ts',
      'utf8'
    );
    expect(source).toContain('function resolveServerToolTimeoutMsFromEnv(');
    expect(source).toContain('return parseServertoolTimeoutMsWithNative({ raw: raw || undefined });');
    expect(source).not.toContain('const timeoutPolicyInput = {');
    expect(source).not.toContain('const followupTimeoutPolicyInput = {');
  });

  test('normalizes client inject policy through native contract', () => {
    expect(readClientInjectOnly({ clientInjectOnly: ' true ' })).toBe(true);
    expect(readClientInjectOnly({ clientInjectOnly: 'false' })).toBe(false);
    expect(normalizeClientInjectText(' hello\n[Time/Date]: now\n<**hidden**>\n[Image omitted]\n\n\nworld ')).toBe('hello\n\nworld');
  });

  test('compacts followup error reason through native contract', () => {
    expect(compactFollowupErrorReason('upstream http 503 refused')).toBe('HTTP_503');
    expect(compactFollowupErrorReason('<html><body>bad</body></html>')).toBe('UPSTREAM_HTML_ERROR');
    expect(compactFollowupErrorReason('')).toBeUndefined();
  });
});
