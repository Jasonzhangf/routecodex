import path from 'path';

import { BaseCompatibility } from '../../src/modules/pipeline/modules/compatibility/base-compatibility';
import { UniversalShapeFilter } from '../../src/modules/pipeline/modules/compatibility/filters/universal-shape-filter';

describe('GLM compatibility – suppressAssistantToolCalls', () => {
  test('BaseCompatibility + GLM shape json removes assistant.tool_calls', async () => {
    const shapePath = path.resolve(process.cwd(), 'src/modules/pipeline/modules/compatibility/glm/config/shape-filters.json');

    const compat = new BaseCompatibility(
      { logger: { logModule: () => undefined } },
      { providerType: 'glm', shapeFilterConfigPath: shapePath }
    );
    await compat.initialize();

    const input = {
      model: 'glm-4.6',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { type: 'function', function: { name: 'shell', arguments: { command: ['ls', '-la'] } }, id: 'call_1' },
          ],
        },
        { role: 'tool', content: 'ok', tool_call_id: 'call_1', name: 'shell' },
        { role: 'user', content: 'go on' },
      ],
      tools: [
        { type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } },
      ],
      tool_choice: 'auto',
    } as any;

    const out = await compat.processIncoming(input as any, {} as any);
    expect(Array.isArray(out.messages)).toBe(true);
    // assistant tool_calls should be removed
    const hasAssistantTC = (out.messages as any[]).some(
      (m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length
    );
    expect(hasAssistantTC).toBe(false);
    // tool message retained
    const hasTool = (out.messages as any[]).some((m) => m?.role === 'tool');
    expect(hasTool).toBe(true);
  });

  test('UniversalShapeFilter respects suppressAssistantToolCalls=false (inline config)', async () => {
    const filter = new UniversalShapeFilter({
      config: {
        request: {
          allowTopLevel: ['model', 'messages'],
          messages: {
            allowedRoles: ['system', 'user', 'assistant', 'tool'],
            assistantWithToolCallsContentNull: true,
            toolContentStringify: true,
            suppressAssistantToolCalls: false,
          },
          assistantToolCalls: { functionArgumentsType: 'object' },
        },
        response: {
          allowTopLevel: ['choices'],
          choices: { message: { allow: ['role', 'content'] } as any },
        },
      } as any,
    });
    await filter.initialize();

    const req = {
      model: 'glm-4.5-air',
      messages: [
        { role: 'system', content: 's' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { type: 'function', function: { name: 'shell', arguments: { command: ['pwd'] } }, id: 'c' },
          ],
        },
      ],
    } as any;

    const out = await filter.applyRequestFilter(req as any);
    const kept = (out.messages as any[]).some(
      (m) => m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length
    );
    expect(kept).toBe(true);
  });
});
