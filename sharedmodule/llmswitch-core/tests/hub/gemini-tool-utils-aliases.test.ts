import { describe, expect, test } from '@jest/globals';

import { buildGeminiToolsFromBridge } from '../../src/conversion/shared/gemini-tool-utils.js';

describe('gemini tool schema alias + description fixups', () => {
  test('groups all functionDeclarations into a single tool entry', () => {
    const defs: any[] = [
      {
        type: 'function',
        function: { name: 'a', parameters: { type: 'object', properties: {} } }
      },
      {
        type: 'function',
        function: { name: 'b', parameters: { type: 'object', properties: {} } }
      }
    ];

    const tools = buildGeminiToolsFromBridge(defs as any);
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    expect(Array.isArray((tools as any)[0]?.functionDeclarations)).toBe(true);
    expect((tools as any)[0].functionDeclarations).toHaveLength(2);
  });

  test('keeps Gemini tool declarations tolerant to Codex-style aliases', () => {
    const defs: any[] = [
      {
        type: 'function',
        function: {
          name: 'apply_patch',
          description:
            'Use the `apply_patch` tool to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.',
          parameters: {
            type: 'object',
            properties: {
              patch: { type: 'string' }
            },
            required: ['patch']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'exec_command',
          parameters: {
            type: 'object',
            properties: {
              cmd: { type: 'string' },
              workdir: { type: 'string' }
            },
            required: ['cmd']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'write_stdin',
          parameters: {
            type: 'object',
            properties: {
              session_id: { type: 'number' }
            },
            required: ['session_id']
          }
        }
      }
    ];

    const tools = buildGeminiToolsFromBridge(defs as any);
    expect(Array.isArray(tools)).toBe(true);

    const decls: any[] = [];
    for (const tool of tools || []) {
      const fds = (tool as any)?.functionDeclarations;
      if (Array.isArray(fds)) decls.push(...fds);
    }

    const applyPatch = decls.find((d) => d?.name === 'apply_patch');
    expect(applyPatch).toBeTruthy();
    expect(String(applyPatch.description).toLowerCase()).not.toContain('freeform');
    expect(applyPatch.parameters).toBeTruthy();
    expect(applyPatch.parameters.required).toBeUndefined();
    expect(Object.keys(applyPatch.parameters.properties || {})).toEqual(
      expect.arrayContaining(['patch', 'input', 'instructions', 'text'])
    );

    const execCommand = decls.find((d) => d?.name === 'exec_command');
    expect(execCommand).toBeTruthy();
    expect(execCommand.parameters.required).toBeUndefined();
    expect(Object.keys(execCommand.parameters.properties || {})).toEqual(
      expect.arrayContaining(['cmd', 'command', 'workdir'])
    );

    const writeStdin = decls.find((d) => d?.name === 'write_stdin');
    expect(writeStdin).toBeTruthy();
    expect(writeStdin.parameters.required).toBeUndefined();
    expect(Object.keys(writeStdin.parameters.properties || {})).toEqual(
      expect.arrayContaining(['session_id', 'chars', 'text'])
    );
  });
});
