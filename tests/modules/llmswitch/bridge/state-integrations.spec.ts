import { describe, expect, it, jest } from '@jest/globals';

describe('llmswitch bridge state-integrations', () => {
  it('fails fast when sticky session load throws', async () => {
    jest.resetModules();

    const stickySessionStoreMock = {
      loadRoutingInstructionStateSync: () => {
        throw new Error('sticky boom');
      },
      saveRoutingInstructionStateAsync: () => undefined,
      saveRoutingInstructionStateSync: () => undefined
    };

    jest.unstable_mockModule(
      '../../../../node_modules/@jsonstudio/llms/dist/router/virtual-router/sticky-session-store.js',
      () => stickySessionStoreMock
    );

    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');

    expect(() => mod.loadRoutingInstructionStateSync('session:test')).toThrow(
      'sticky_session_store.load_state.invoke failed: Error: sticky boom'
    );
  });

  it('fails fast when reasoning stop sync api is unavailable', async () => {
    jest.resetModules();

    jest.unstable_mockModule(
      '../../../../node_modules/@jsonstudio/llms/dist/servertool/handlers/reasoning-stop-state.js',
      () => ({})
    );

    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');

    expect(() => mod.syncReasoningStopModeFromRequest({}, 'off')).toThrow(
      'reasoning_stop_state.sync_mode.api_unavailable failed: "syncReasoningStopModeFromRequest not available"'
    );
  });

  it('fails fast when session identifier extraction api is unavailable', async () => {
    jest.resetModules();

    jest.unstable_mockModule(
      '../../../../node_modules/@jsonstudio/llms/dist/conversion/hub/pipeline/session-identifiers.js',
      () => ({})
    );

    const mod = await import('../../../../src/modules/llmswitch/bridge/state-integrations.js');

    expect(() => mod.extractSessionIdentifiersFromMetadata({})).toThrow(
      'session_identifiers.extract.api_unavailable failed: "extractSessionIdentifiersFromMetadata not available"'
    );
  });
});
