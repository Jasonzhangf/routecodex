import fs from 'node:fs';
import path from 'node:path';

describe('hub pipeline stage3 servertool orchestration architecture', () => {
  test('resp_process.stage3 must not directly depend on TS servertool engine truth', () => {
    const repoRoot = process.cwd();
    const stage3Path = path.join(
      repoRoot,
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage3_servertool_orchestration/index.ts'
    );
    const content = fs.readFileSync(stage3Path, 'utf8');

    expect(content).not.toContain(`from '../../../../../../servertool/engine.js'`);
    expect(content).not.toContain('runServerToolOrchestration(');
  });
});
