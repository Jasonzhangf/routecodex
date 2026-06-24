import * as fs from 'node:fs';
import { describe, expect, test, jest } from '@jest/globals';

describe('engine-observation-shell', () => {
  test('engine.ts delegates orchestration into engine-orchestration-shell', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine.ts',
      'utf8'
    );

    expect(source).toContain("from './engine-orchestration-shell.js'");
    expect(source).toContain('runServerToolOrchestration');
    expect(source).not.toContain('createServertoolObservation({');
    expect(source).not.toContain('recordServertoolEngineMatchSkipped({');
    expect(source).not.toContain('recordServertoolEngineMatchHit({');
    expect(source).not.toContain('runServertoolEnginePostflight');
    expect(source).not.toContain('runEnginePreflight');
    expect(source).not.toContain('planServertoolEngineRuntimeActionWithNative');
  });

  test('engine-observation-shell owns progress logger and match logging fan-in', async () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.ts',
      'utf8'
    );

    expect(source).toContain('export function logServertoolNonBlocking(');
    expect(source).toContain('export function createServertoolObservation(');
    expect(source).toContain('createServertoolProgressLogger({');
    expect(source).toContain('recordServertoolMatchSkipped({');
    expect(source).toContain('recordServertoolMatchHit({');

    const progressSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../../sharedmodule/llmswitch-core/src/servertool/engine-observation-shell.js');
    mod.logServertoolNonBlocking('unit_test', new Error('boom'), { flowId: 'flow_obs_1' });
    expect(progressSpy).toHaveBeenCalledWith(
      expect.stringContaining('[servertool][non-blocking] stage=unit_test error=boom flowId=flow_obs_1')
    );
    progressSpy.mockRestore();
  });

  test('engine-orchestration-shell owns the engine mainline body', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/engine-orchestration-shell.ts',
      'utf8'
    );

    expect(source).toContain('export async function runServerToolOrchestrationShell(');
    expect(source).toContain('createServertoolObservation({');
    expect(source).toContain('runEnginePreflight({');
    expect(source).toContain('planServertoolEngineSkipWithNative({');
    expect(source).toContain('recordServertoolEngineMatchSkipped({');
    expect(source).toContain('recordServertoolEngineMatchHit({');
    expect(source).toContain('planStoplessOrchestrationActionShell({');
    expect(source).toContain('runServertoolEnginePostflight({');
  });
});
