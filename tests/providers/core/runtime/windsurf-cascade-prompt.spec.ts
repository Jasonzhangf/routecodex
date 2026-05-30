import { describe, expect, test } from '@jest/globals';
import {
  buildCascadePromptText,
  buildCompletedNativeToolCallIds,
  buildCompletedNativeToolSignatures,
  buildWindsurfNativeToolSignature,
  collectWindsurfMappedTools,
  extractLatestCascadeUserText,
  isWindsurfNativeToolName,
  readDeltaSeedParts,
  rewriteWindsurfNativeToolAliasesInText,
  type WindsurfSemanticTurn,
} from '../../../../src/providers/core/runtime/windsurf/windsurf-cascade-prompt.ts';

describe('windsurf cascade prompt pure functions', () => {
  test('extractLatestCascadeUserText includes latest user and terminal tool result', () => {
    const semantic: WindsurfSemanticTurn[] = [
      { type: 'user', text: 'first' },
      { type: 'assistant', text: 'need tool' },
      { type: 'function_call_output', call_id: 'call_1', name: 'read_file', output: 'file text' },
    ];
    expect(extractLatestCascadeUserText(semantic)).toBe('first\n\nTool result for read_file:\nfile text');
  });

  test('buildCascadePromptText preserves system and prior turns for non-resume multi-turn', () => {
    const text = buildCascadePromptText(
      [{ role: 'system', content: 'RouteCodex system' }, { role: 'user', content: 'second' }],
      [
        { type: 'user', text: 'first question' },
        { type: 'assistant', text: 'first answer' },
        { type: 'user', text: 'second question' },
      ],
      'gpt-5.4-medium',
    );
    expect(text).toContain('RouteCodex system');
    expect(text).toContain('The following is a multi-turn conversation');
    expect(text).toContain('<human>\nfirst question\n</human>');
    expect(text).toContain('<assistant>\nfirst answer\n</assistant>');
    expect(text).toContain('<human>\nsecond question\n</human>');
  });

  test('buildCascadePromptText resume sends latest delta without replaying history', () => {
    const text = buildCascadePromptText(
      [{ role: 'system', content: 'RouteCodex system' }, { role: 'user', content: 'second' }],
      [
        { type: 'user', text: 'first question' },
        { type: 'assistant', text: 'first answer' },
        { type: 'user', text: 'second question' },
      ],
      'gpt-5.4-medium',
      [],
      ['seed tail'],
      [],
      undefined,
      true,
    );
    expect(text).toBe('second question');
  });

  test('native tool aliases rewrite only declared mapped tools', () => {
    const tools = [{ type: 'function', function: { name: 'read_file' } }];
    expect(collectWindsurfMappedTools(tools)).toEqual([{ name: 'read_file', kind: 'view_file' }]);
    expect(isWindsurfNativeToolName('read_file', tools)).toBe(true);
    expect(rewriteWindsurfNativeToolAliasesInText('call read_file now', tools)).toBe('call view_file now');
  });

  test('completed native signatures only include calls with outputs', () => {
    const semantic: WindsurfSemanticTurn[] = [
      { type: 'assistant', text: '', tool_calls: [{ call_id: 'call_1', name: 'read_file', arguments: { path: '/tmp/a' } }] },
      { type: 'function_call_output', call_id: 'call_1', name: 'read_file', output: 'ok' },
    ];
    expect(buildCompletedNativeToolCallIds(semantic)).toEqual(expect.arrayContaining(['call_1', 'fc_call_1']));
    expect(buildCompletedNativeToolSignatures(semantic, [{ type: 'function', function: { name: 'read_file' } }]))
      .toEqual([buildWindsurfNativeToolSignature('view_file', { absolute_path_uri: 'file:///tmp/a' })]);
  });

  test('readDeltaSeedParts captures response delta tool outputs', () => {
    const body = {
      input: [{ type: 'function_call_output', call_id: 'call_1', output: 'one' }],
      semantics: { responses: { resume: { deltaInput: [{ type: 'tool_result', tool_call_id: 'call_2', output: 'two' }] } } },
    } as Record<string, unknown>;
    expect(readDeltaSeedParts(body)).toEqual(['Tool result for call_1:\none', 'Tool result for call_2:\ntwo']);
  });
});
