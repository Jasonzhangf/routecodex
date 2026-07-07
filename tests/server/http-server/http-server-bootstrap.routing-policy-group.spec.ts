import { describe, expect, test } from '@jest/globals';
import {
  extractProviderKeysFromPipelineRuntimeConfig,
  extractRoutingTiersForPipelineRuntimeConfigRoute,
} from '../../../src/server/runtime/http-server/http-server-bootstrap.js';

describe('http-server bootstrap Rust pipeline runtime artifact extraction', () => {
  test('reads provider allowlist from Rust pipelineRuntimeConfig only', () => {
    expect(extractProviderKeysFromPipelineRuntimeConfig({
      routingProviderIds: [
        'llmgate',
        'mini27',
        'mini27',
        'mimo',
        '',
        null,
        'demochat',
      ],
    } as any)).toEqual([
      'demochat',
      'llmgate',
      'mimo',
      'mini27',
    ]);
  });

  test('returns empty provider allowlist when the Rust artifact is absent', () => {
    expect(extractProviderKeysFromPipelineRuntimeConfig(undefined)).toEqual([]);
  });

  test('extracts exact route tiers plus global default route for primary_exhausted planner without flattening forwarders', () => {
    const pipelineRuntimeConfig = {
      routingTiersByRoute: {
        coding: [
          {
            id: 'coding-primary',
            priority: 200,
            targets: ['fwd.gpt.gpt-5.5', 'halphen.glm-5.2'],
          },
          {
            id: 'coding-backup',
            priority: 100,
            backup: true,
            targets: ['fwd.minimax.MiniMax-M3'],
          },
        ],
        default: [
          {
            id: 'default-primary',
            priority: 50,
            targets: ['mimo.mimo-v2.5'],
          },
        ],
      },
    };

    expect(extractRoutingTiersForPipelineRuntimeConfigRoute(pipelineRuntimeConfig as any, 'coding')).toEqual([
      {
        id: 'coding-primary',
        priority: 200,
        backup: undefined,
        targets: ['fwd.gpt.gpt-5.5', 'halphen.glm-5.2'],
      },
      {
        id: 'coding-backup',
        priority: 100,
        backup: true,
        targets: ['fwd.minimax.MiniMax-M3'],
      },
      {
        id: 'default-primary',
        priority: 50,
        backup: true,
        targets: ['mimo.mimo-v2.5'],
      },
    ]);
  });

  test('marks routing.default as the global backup pool when the selected route has no local backup tier', () => {
    const pipelineRuntimeConfig = {
      routingTiersByRoute: {
        tools: [
          {
            id: 'gateway-glm-4444-tools',
            priority: 200,
            targets: ['fwd.gpt.gpt-5.3-codex-spark'],
          },
        ],
        default: [
          {
            id: 'gateway-glm-4444-default',
            priority: 100,
            targets: ['fwd.minimax.MiniMax-M3'],
          },
        ],
      },
    };

    expect(extractRoutingTiersForPipelineRuntimeConfigRoute(pipelineRuntimeConfig as any, 'tools')).toEqual([
      {
        id: 'gateway-glm-4444-tools',
        priority: 200,
        backup: undefined,
        targets: ['fwd.gpt.gpt-5.3-codex-spark'],
      },
      {
        id: 'gateway-glm-4444-default',
        priority: 100,
        backup: true,
        targets: ['fwd.minimax.MiniMax-M3'],
      },
    ]);
  });
});
