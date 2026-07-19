import { describe, expect, it } from '@jest/globals';

import {
  inspectResponsesSseBlockForProviderFailure,
  inspectResponsesSseBlockForProviderRateLimit,
  isResponsesSseAdvisoryRateLimitsBlock,
  isResponsesSseIncompleteBlock,
  isResponsesSseLifecyclePreambleBlock,
  isResponsesSseTerminalBlock
} from '../../../../src/providers/core/runtime/responses-sse-error-guard.js';

describe('responses SSE error guard', () => {
  it('maps codex.rate_limits limit_reached frames to provider rate limit', () => {
    const result = inspectResponsesSseBlockForProviderRateLimit([
      'event: codex.rate_limits',
      'data: {"type":"codex.rate_limits","limit_reached":true}',
      '',
    ].join('\n'));

    expect(result).toEqual({
      code: 'codex.rate_limits',
      message: 'upstream Responses SSE rate limit reached'
    });
  });

  it('does not treat codex.rate_limits advisory frames as provider rate limit when limit is not reached', () => {
    const block = [
      'event: codex.rate_limits',
      'data: {"type":"codex.rate_limits","limit_reached":false}',
      '',
    ].join('\n');
    const result = inspectResponsesSseBlockForProviderRateLimit(block);

    expect(result).toBeNull();
    expect(isResponsesSseAdvisoryRateLimitsBlock(block)).toBe(true);
  });

  it('maps response.failed billing frames to provider failure before direct SSE passthrough', () => {
    const result = inspectResponsesSseBlockForProviderFailure([
      'event: response.failed',
      'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"insufficient_quota","message":"Your account has insufficient quota","status":402}}}',
      '',
    ].join('\n'));

    expect(result).toEqual({
      code: 'insufficient_quota',
      message: 'Your account has insufficient quota',
      statusCode: 402
    });
  });

  it.each([
    [
      'response.completed event',
      [
        'event: response.completed',
        'data: {"type":"response.completed","response":{"status":"completed"}}',
        '',
      ].join('\n')
    ],
    [
      'response.done event',
      [
        'event: response.done',
        'data: {"type":"response.done","response":{"status":"completed"}}',
        '',
      ].join('\n')
    ],
    [
      'requires_action event',
      [
        'event: response.requires_action',
        'data: {"type":"response.requires_action","response":{"status":"requires_action"}}',
        '',
      ].join('\n')
    ],
    [
      'data-only done sentinel',
      [
        'data: [DONE]',
        '',
      ].join('\n')
    ],
    [
      'data-only completed type',
      [
        'data: {"type":"response.completed","response":{"status":"completed"}}',
        '',
      ].join('\n')
    ],
  ])('treats %s as Responses stream terminal transport', (_name, block) => {
    expect(isResponsesSseTerminalBlock(block)).toBe(true);
  });

  it('does not treat ordinary delta frames as terminal transport', () => {
    const block = [
      'data: {"type":"response.output_text.delta","delta":"hello"}',
      '',
    ].join('\n');

    expect(isResponsesSseTerminalBlock(block)).toBe(false);
  });

  it('classifies response.created and response.in_progress as lifecycle preamble, not client-ready content', () => {
    expect(isResponsesSseLifecyclePreambleBlock([
      'event: response.created',
      'data: {"type":"response.created","response":{"status":"in_progress"}}',
      '',
    ].join('\n'))).toBe(true);
    expect(isResponsesSseLifecyclePreambleBlock([
      'event: response.in_progress',
      'data: {"type":"response.in_progress","response":{"status":"in_progress"}}',
      '',
    ].join('\n'))).toBe(true);
    expect(isResponsesSseLifecyclePreambleBlock([
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"message"}}',
      '',
    ].join('\n'))).toBe(false);
  });

  it('classifies response.incomplete as incomplete transport terminal, not success terminal', () => {
    const block = [
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"status":"incomplete"}}',
      '',
    ].join('\n');

    expect(isResponsesSseIncompleteBlock(block)).toBe(true);
    expect(isResponsesSseTerminalBlock(block)).toBe(false);
  });
});
