import {
  buildStopMessageMarkerParseLog,
  cleanStopMessageMarkersInPlace,
  parseStopMessageInstruction
} from '../../sharedmodule/llmswitch-core/src/router/virtual-router/stop-message-markers.js';

describe('stopmessage marker module', () => {
  test('parseStopMessageInstruction remains available from unified module', () => {
    const parsed = parseStopMessageInstruction('stopMessage:"继续执行",3');
    expect(parsed).toEqual(expect.objectContaining({
      type: 'stopMessageSet',
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 3
    }));
  });

  test('buildStopMessageMarkerParseLog and cleaner are centralized', () => {
    const request = {
      model: 'gpt-test',
      messages: [{ role: 'user', content: '<**stopMessage:"继续执行",3**> hello' }],
      parameters: {},
      metadata: {},
      semantics: {
        responses: {
          context: {
            input: [{ role: 'user', content: [{ type: 'input_text', text: '<**stopMessage:"继续执行",3**> hello' }] }]
          }
        }
      }
    } as Record<string, unknown>;
    const log = buildStopMessageMarkerParseLog(request as any, { requestId: 'req-stop-marker' } as any);
    expect(log).toEqual(expect.objectContaining({
      requestId: 'req-stop-marker',
      markerDetected: true
    }));

    cleanStopMessageMarkersInPlace(request);
    expect(JSON.stringify(request)).not.toContain('<**');
  });
});
