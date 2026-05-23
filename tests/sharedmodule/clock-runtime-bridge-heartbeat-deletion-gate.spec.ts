import fs from 'node:fs';
import path from 'node:path';

describe('clock runtime bridge heartbeat deletion gate', () => {
  it('must not import or call TS heartbeat semantic helper', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/process/blocks/chat-process-clock-runtime-bridge.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    expect(source).not.toContain('chat-process-heartbeat-directives.js');
    expect(source).not.toMatch(/\bapplyHeartbeatDirectives\s*\(/);
  });
});
