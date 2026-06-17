import { describe, expect, it } from '@jest/globals';

import fs from 'node:fs';
import path from 'node:path';

describe('llmswitch bridge state-integrations', () => {
  it('extracts session identifiers from metadata', async () => {
    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');
    expect(
      mod.extractSessionIdentifiersFromMetadata({
        sessionId: 'sess_1',
        conversationId: 'conv_1'
      })
    ).toEqual({
      sessionId: 'sess_1',
      conversationId: 'conv_1'
    });
  });

  it('does not treat tmux identifiers as request session identifiers', async () => {
    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');
    expect(
      mod.extractSessionIdentifiersFromMetadata({
        tmuxSessionId: 'tmux_only_1',
        clientTmuxSessionId: 'tmux_only_2',
        conversationId: 'conv_2'
      })
    ).toEqual({
      conversationId: 'conv_2'
    });
  });

  it('keeps removed clock and heartbeat state integrations absent', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/state-integrations.ts'),
      'utf8'
    );
    expect(source).not.toContain('servertool/clock');
    expect(source).not.toContain('servertool/heartbeat');
    expect(source).not.toContain('resolveClockConfigSnapshot');
    expect(source).not.toContain('buildHeartbeatInjectTextSnapshot');
  });

  it('sync stopless goal state bridge uses real exported function name', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/state-integrations.ts'),
      'utf8'
    );
    expect(source).toContain('syncStoplessGoalStateFromRequest');
    expect(source).not.toContain('syncStoplessGoalCarrierFromRequest');
  });

  it('persist stopless goal state bridge uses real exported function name', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/state-integrations.ts'),
      'utf8'
    );
    expect(source).toContain('persistStoplessGoalStateSnapshot');
    expect(source).not.toContain('saveStoplessGoalCarrier');
  });

  it('read stopless goal state bridge uses real exported function name', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/llmswitch/bridge/state-integrations.ts'),
      'utf8'
    );
    expect(source).toContain('readStoplessGoalState');
    expect(source).not.toContain('fetchStoplessGoalCarrier');
  });
});
