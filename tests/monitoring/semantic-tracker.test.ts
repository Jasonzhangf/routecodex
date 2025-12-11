import semanticMap from '../../config/semantic-map.json' assert { type: 'json' };
import { compileSemanticFieldSpecs } from '../../src/monitoring/semantic-config-loader.js';
import { SemanticTracker } from '../../src/monitoring/semantic-tracker.js';
import type { SemanticSnapshotInput } from '../../src/monitoring/semantic-tracker.js';

describe('SemanticTracker with semantic-map config', () => {
  it('tracks semantic changes across stages', () => {
    const specs = compileSemanticFieldSpecs(semanticMap);
    const tracker = new SemanticTracker({ fields: specs });
    const snapshots: SemanticSnapshotInput[] = [
      {
        stage: 'client-request.pre',
        direction: 'request',
        payload: {
          model: 'gpt-test',
          messages: [
            { role: 'system', content: 'inst' },
            { role: 'user', content: 'hello' }
          ]
        },
        metadata: { entryEndpoint: '/v1/responses' },
        timestamp: 1
      },
      {
        stage: 'hub.request.post',
        direction: 'request',
        payload: {
          model: 'gpt-test',
          messages: [
            { role: 'system', content: 'inst' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  type: 'function',
                  id: 'call_1',
                  function: { name: 'foo', arguments: '{"ping":true}' }
                }
              ]
            }
          ],
          target: { providerKey: 'test.provider', clientModelId: 'gpt-test', routeName: 'default-route' }
        },
        metadata: { entryEndpoint: '/v1/responses' },
        timestamp: 2
      },
      {
        stage: 'req_inbound_stage3_context_capture',
        direction: 'request',
        payload: {
          tool_outputs: [
            { tool_call_id: 'call_1', output: 'ok' },
            { tool_call_id: 'call_2', output: '<tool_use_error>boom</tool_use_error>', is_error: true }
          ]
        },
        metadata: { entryEndpoint: '/v1/responses' },
        timestamp: 3
      },
      {
        stage: 'provider.response.final',
        direction: 'response',
        payload: {
          model: 'gpt-test',
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
            prompt_tokens_details: { cached_tokens: 5 }
          },
          output_text: 'done',
          required_action: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: 'call_1',
                  function: { name: 'foo', arguments: '{"ping":true}' }
                }
              ]
            }
          }
        },
        metadata: { entryEndpoint: '/v1/responses' },
        timestamp: 4
      }
    ];

    const result = tracker.track(snapshots);
    expect(result.points.length).toBe(4);
    const toolCallChanges = result.changes.filter((change) => change.specId === 'tool_calls');
    expect(toolCallChanges.length).toBeGreaterThan(0);
    expect(toolCallChanges.some((change) => (change.description || '').includes('tool_calls changed'))).toBe(true);

    const routePoint = result.points[1];
    expect(routePoint.values.route_target.summary).toContain('test.provider');
    expect(result.points[0].values.model_id.summary).toContain('gpt-test');
    const toolResults = result.points[2].values.tool_results;
    expect(toolResults.summary).toContain('errors=1');
    const usage = result.points[3].values.usage;
    expect(usage.summary).toContain('prompt=');
    const requiredAction = result.points[3].values.required_action;
    expect(requiredAction.summary).toContain('submit_tool_outputs');
  });

  it('normalizes system instructions across protocols', () => {
    const specs = compileSemanticFieldSpecs(semanticMap);
    const tracker = new SemanticTracker({ fields: specs });
    const snapshots: SemanticSnapshotInput[] = [
      {
        stage: 'client-request.pre',
        direction: 'request',
        payload: {
          instructions: 'You are a helpful assistant.'
        },
        metadata: { entryEndpoint: '/v1/responses' },
        timestamp: 10
      },
      {
        stage: 'hub.request.post',
        direction: 'request',
        payload: {
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'hello' }
          ]
        },
        metadata: { entryEndpoint: '/v1/chat/completions' },
        timestamp: 11
      }
    ];

    const result = tracker.track(snapshots);
    expect(result.points.length).toBe(2);
    const first = result.points[0].values.system_instruction;
    expect(first.summary).toContain('system=1');
    const second = result.points[1].values.system_instruction;
    expect(second.summary).toContain('system=1');
    const instructionChanges = result.changes.filter((change) => change.specId === 'system_instruction');
    expect(instructionChanges.length).toBeGreaterThan(0);
  });
});
