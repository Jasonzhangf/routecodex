import { resolveRequestSemantics } from '../../../../src/server/runtime/http-server/executor/provider-response-utils.js';

describe('provider-response-utils resolveRequestSemantics', () => {
  it('falls back to processed.tools as clientToolsRaw when semantics are absent', () => {
    const processed = {
      tools: [
        { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'update_plan', parameters: { type: 'object' } } }
      ]
    };

    const semantics = resolveRequestSemantics(processed as Record<string, unknown>, undefined);
    const clientToolsRaw = (semantics?.tools as any)?.clientToolsRaw;
    expect(Array.isArray(clientToolsRaw)).toBe(true);
    expect(clientToolsRaw).toHaveLength(2);
    expect(clientToolsRaw[0]?.function?.name).toBe('exec_command');
    expect(clientToolsRaw[1]?.function?.name).toBe('update_plan');
  });

  it('merges fallback tools into existing semantics when clientToolsRaw is missing', () => {
    const processed = {
      semantics: {
        responses: {
          aliasMap: {
            exec_command: 'exec_command'
          }
        }
      },
      tools: [
        { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } }
      ]
    };

    const semantics = resolveRequestSemantics(processed as Record<string, unknown>, undefined);
    expect((semantics as any)?.responses?.aliasMap?.exec_command).toBe('exec_command');
    const clientToolsRaw = (semantics?.tools as any)?.clientToolsRaw;
    expect(Array.isArray(clientToolsRaw)).toBe(true);
    expect(clientToolsRaw).toHaveLength(1);
    expect(clientToolsRaw[0]?.function?.name).toBe('exec_command');
  });

  it('reads requestSemantics from merged request metadata on nested followup when processed requests lost semantics', () => {
    const semantics = resolveRequestSemantics(
      {
        tools: [
          { type: 'function', function: { name: 'reasoning.stop', parameters: { type: 'object' } } }
        ]
      } as Record<string, unknown>,
      undefined,
      {
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } },
              { type: 'function', function: { name: 'reasoning.stop', parameters: { type: 'object' } } }
            ]
          }
        },
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'servertool.reasoning_stop_continue'
        }
      }
    );

    const clientToolsRaw = (semantics?.tools as any)?.clientToolsRaw;
    expect(Array.isArray(clientToolsRaw)).toBe(true);
    expect(clientToolsRaw).toHaveLength(2);
    expect(clientToolsRaw[0]?.function?.name).toBe('exec_command');
    expect(clientToolsRaw[1]?.function?.name).toBe('reasoning.stop');
    expect((semantics as any)?.__routecodex).toBeUndefined();
  });

  it('prefers metadata.requestSemantics on servertool followup so original client tools survive nested turns', () => {
    const processed = {
      semantics: {
        tools: {
          clientToolsRaw: [
            { type: 'function', function: { name: 'reasoning.stop', parameters: { type: 'object' } } }
          ]
        }
      },
      metadata: {
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } },
              { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } },
              { type: 'function', function: { name: 'reasoning.stop', parameters: { type: 'object' } } }
            ]
          }
        },
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'servertool.reasoning_stop_continue'
        }
      }
    };

    const semantics = resolveRequestSemantics(processed as Record<string, unknown>, undefined);
    const clientToolsRaw = (semantics?.tools as any)?.clientToolsRaw;
    expect(Array.isArray(clientToolsRaw)).toBe(true);
    expect(clientToolsRaw).toHaveLength(3);
    expect(clientToolsRaw[0]?.function?.name).toBe('exec_command');
    expect(clientToolsRaw[1]?.function?.name).toBe('apply_patch');
    expect(clientToolsRaw[2]?.function?.name).toBe('reasoning.stop');
    expect((semantics as any)?.__routecodex).toBeUndefined();
  });

  it('merges followup root tools into clientToolsRaw so internal reasoning.stop stays declared', () => {
    const semantics = resolveRequestSemantics(
      {
        tools: [
          { type: 'function', function: { name: 'reasoning.stop', parameters: { type: 'object' } } }
        ]
      } as Record<string, unknown>,
      undefined,
      {
        requestSemantics: {
          tools: {
            clientToolsRaw: [
              { type: 'function', function: { name: 'exec_command', parameters: { type: 'object' } } },
              { type: 'function', function: { name: 'apply_patch', parameters: { type: 'object' } } }
            ]
          }
        },
        __rt: {
          serverToolFollowup: true,
          clientInjectSource: 'servertool.reasoning_stop_guard'
        }
      }
    );

    const clientToolsRaw = (semantics?.tools as any)?.clientToolsRaw;
    expect(Array.isArray(clientToolsRaw)).toBe(true);
    expect(clientToolsRaw).toHaveLength(3);
    expect(clientToolsRaw[0]?.function?.name).toBe('exec_command');
    expect(clientToolsRaw[1]?.function?.name).toBe('apply_patch');
    expect(clientToolsRaw[2]?.function?.name).toBe('reasoning.stop');
  });

});
