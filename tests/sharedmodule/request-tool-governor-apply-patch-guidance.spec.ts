import { processChatRequestTools } from '../../sharedmodule/llmswitch-core/src/conversion/shared/tool-governor-request.js';

describe('request tool governor apply_patch guidance shape', () => {
  it('switches relay apply_patch guidance to hashline-first when schema declares filePath', () => {
    const request = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Edit files by patch',
            parameters: {
              type: 'object',
              properties: {
                filePath: {
                  type: 'string',
                  description: 'target file path'
                },
                fileContent: {
                  type: 'string',
                  description: 'current file content'
                }
              }
            }
          }
        }
      ]
    };

    const out = processChatRequestTools(request as any) as any;
    const patchDesc = String(out?.tools?.[0]?.function?.parameters?.properties?.patch?.description || '');
    const inputDesc = String(out?.tools?.[0]?.function?.parameters?.properties?.input?.description || '');
    expect(patchDesc).toContain('hashline');
    expect(patchDesc).toContain('filePath');
    expect(patchDesc).toContain('Do not author canonical apply_patch blocks in this mode');
    expect(patchDesc).not.toContain('compatibility alias only');
    expect(inputDesc).toContain('Compatibility alias of patch');
    expect(inputDesc).toContain('Do not use input to switch syntax families');
  });

  it('preserves declared hashline filepath fields on relay apply_patch request tools', () => {
    const request = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Use `apply_patch` to edit files.',
            parameters: {
              type: 'object',
              properties: {
                patch: { type: 'string' },
                input: { type: 'string' },
                filePath: {
                  type: 'string',
                  description: 'Required for hashline patch syntax.'
                },
                file_path: {
                  type: 'string',
                  description: 'Required for hashline patch syntax.'
                }
              },
              required: ['patch']
            }
          }
        }
      ]
    };

    const out = processChatRequestTools(request as any) as any;
    const properties = out?.tools?.[0]?.function?.parameters?.properties || {};
    expect(properties.patch).toBeDefined();
    expect(properties.input).toBeDefined();
    expect(properties.filePath).toBeDefined();
    expect(properties.file_path).toBeDefined();
    expect(properties.fileContent).toBeDefined();
    expect(properties.file_content).toBeDefined();
  });

  it('keeps relay apply_patch non-strict so upstream does not rewrite compatibility alias into required fields', () => {
    const request = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Use `apply_patch` to edit files.',
            parameters: {
              type: 'object',
              properties: {
                patch: { type: 'string' },
                input: { type: 'string' }
              },
              required: ['patch']
            },
            strict: true
          }
        }
      ]
    };

    const out = processChatRequestTools(request as any) as any;
    expect(out?.tools?.[0]?.function?.strict).toBe(false);
  });

  it('preserves hashline filepath fields only when request schema declares file content contract too', () => {
    const request = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Use `apply_patch` to edit files.',
            parameters: {
              type: 'object',
              properties: {
                patch: { type: 'string' },
                input: { type: 'string' },
                filePath: {
                  type: 'string',
                  description: 'Required for hashline patch syntax.'
                },
                fileContent: {
                  type: 'string',
                  description: 'Required for hashline patch syntax current file content.'
                }
              },
              required: ['patch']
            }
          }
        }
      ]
    };

    const out = processChatRequestTools(request as any) as any;
    const properties = out?.tools?.[0]?.function?.parameters?.properties || {};
    expect(properties.filePath).toBeDefined();
    expect(properties.file_path).toBeDefined();
    expect(properties.fileContent).toBeDefined();
    expect(properties.file_content).toBeDefined();
  });

  it('keeps canonical apply_patch grammar when schema does not declare filePath', () => {
    const request = {
      tools: [
        {
          type: 'function',
          function: {
            name: 'apply_patch',
            description: 'Edit files by patch',
            parameters: {
              type: 'object',
              properties: {}
            }
          }
        }
      ]
    };

    const out = processChatRequestTools(request as any) as any;
    const patchDesc = String(out?.tools?.[0]?.function?.parameters?.properties?.patch?.description || '');
    const inputDesc = String(out?.tools?.[0]?.function?.parameters?.properties?.input?.description || '');
    expect(patchDesc).toContain('*** Begin Patch');
    expect(patchDesc).toContain('*** End Patch');
    expect(patchDesc).toContain('*** Update File:');
    expect(patchDesc).toContain('*** Add File:');
    expect(patchDesc).toContain('GNU diff headers');
    expect(patchDesc).toContain('Do not add `filePath`/`file_path` unless the schema explicitly declares it');
    expect(inputDesc).toContain('Compatibility alias of patch');
    expect(inputDesc).not.toContain('hashline mode still stays patch-first');
  });
});
