import {
  buildStopMessageMarkerParseLog,
  cleanStopMessageMarkersInPlace,
  parseStopMessageInstruction
} from '../../sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.js';

describe('stopmessage marker module', () => {
  test('parseStopMessageInstruction remains available from unified module', () => {
    const parsed = parseStopMessageInstruction('stopMessage:"继续执行",3');
    expect(parsed).toEqual(expect.objectContaining({
      type: 'stopMessageSet',
      stopMessageText: '继续执行',
      stopMessageMaxRepeats: 3
    }));
  });

  test('parseStopMessageInstruction preserves mode-only instruction', () => {
    const parsed = parseStopMessageInstruction('stopMessage:on,3');
    expect(parsed).toEqual(expect.objectContaining({
      type: 'stopMessageMode',
      stopMessageStageMode: 'on',
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
