import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';

import {
  resolveServerToolTimeoutMs
} from '../../sharedmodule/llmswitch-core/src/servertool/orchestration-policy-block.js';

describe('servertool orchestration policy block', () => {
  test('resolves timeout env policy through native contract', () => {
    const previous = {
      ROUTECODEX_SERVERTOOL_TIMEOUT_MS: process.env.ROUTECODEX_SERVERTOOL_TIMEOUT_MS,
      RCC_SERVERTOOL_TIMEOUT_MS: process.env.RCC_SERVERTOOL_TIMEOUT_MS,
      LLMSWITCH_SERVERTOOL_TIMEOUT_MS: process.env.LLMSWITCH_SERVERTOOL_TIMEOUT_MS
    };
    try {
      delete process.env.RCC_SERVERTOOL_TIMEOUT_MS;
      delete process.env.LLMSWITCH_SERVERTOOL_TIMEOUT_MS;
      process.env.ROUTECODEX_SERVERTOOL_TIMEOUT_MS = '1500.9';

      expect(resolveServerToolTimeoutMs()).toBe(1500);
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
    expect(source).toContain('export function containsSyntheticRouteCodexControlText(');
    expect(source).not.toContain('const timeoutPolicyInput = {');
    expect(source).not.toContain('const followupTimeoutPolicyInput = {');
    expect(source).not.toContain('export function resolveServerToolFollowupTimeoutMs(');
    expect(source).not.toContain('export function readClientInjectOnly(');
    expect(source).not.toContain('export function normalizeClientInjectText(');
    expect(source).not.toContain('export function compactFollowupErrorReason(');
    expect(source).not.toContain('export function resolveAdapterContextProviderKey(');
  });
});
