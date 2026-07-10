import {
  buildStopMessageMarkerParseLog,
  cleanStopMessageMarkersInPlace,
  formatStopMessageStatusLabel,
  parseStopMessageInstruction
} from '../sharedmodule/helpers/virtual-router-engine-direct-native.js';

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

  test('formatStopMessageStatusLabel delegates status formatting to native', () => {
    expect(formatStopMessageStatusLabel(null, 'session:abc', true)).toBe(
      '[stopMessage:scope=session:abc active=no state=cleared]'
    );
    expect(formatStopMessageStatusLabel({
      stopMessageText: 'continue until done',
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 1,
      stopMessageStageMode: 'auto'
    } as any, 'session:abc', false)).toBe(
      '[stopMessage:scope=session:abc text="continue until done" mode=auto round=1/3 left=2 active=yes]'
    );
  });
});
