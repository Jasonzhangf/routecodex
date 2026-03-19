#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

async function main() {
  const mod = await import(path.join(projectRoot, 'dist', 'conversion', 'hub', 'process', 'chat-process-heartbeat-directives.js'));
  const { applyHeartbeatDirectives } = mod;

  const request = {
    messages: [{ role: 'user', content: '<**clock:clear**>\nkeep this marker for clock module' }],
    metadata: {}
  };

  const out = await applyHeartbeatDirectives(request, { sessionId: 'sess_1' });
  assert.equal(out.messages[0].content, '<**clock:clear**>\nkeep this marker for clock module');

  const hbOut = await applyHeartbeatDirectives(
    {
      messages: [{ role: 'user', content: '<**hb:15m**>\nrun patrol' }],
      metadata: {}
    },
    { tmuxSessionId: 'tmux_test_1' }
  );
  assert.equal(hbOut.messages[0].content, 'run patrol');

  console.log('✅ heartbeat-directives-preserve-clock-marker passed');
}

main().catch((error) => {
  console.error('❌ heartbeat-directives-preserve-clock-marker failed', error);
  process.exit(1);
});
