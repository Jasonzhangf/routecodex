import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

const REMOVED_PATHS = [
  'docs/agent-routing/30-heartbeat-delivery-clock.md',
  'docs/design/heartbeat-session-execution-state.md',
  'src/cli/commands/heartbeat.ts',
  'src/cli/register/heartbeat-command.ts',
  'src/server/runtime/http-server/clock-runtime-hooks.ts',
  'src/server/runtime/http-server/heartbeat-runtime-hooks.ts',
  'sharedmodule/llmswitch-core/src/servertool/clock',
  'sharedmodule/llmswitch-core/src/servertool/heartbeat',
  'sharedmodule/llmswitch-core/src/servertool/handlers/clock.ts',
  'sharedmodule/llmswitch-core/src/servertool/handlers/clock-auto.ts',
  'sharedmodule/llmswitch-core/src/servertool/handlers/clock-pure-blocks.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-clock-tools.ts',
  'sharedmodule/llmswitch-core/src/conversion/hub/process/chat-process-heartbeat-directives.ts',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_heartbeat_directives.rs',
  'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance_blocks/clock_runtime.rs',
];

const FORBIDDEN_SOURCE_PATTERNS = [
  /servertool\/clock/,
  /servertool\/heartbeat/,
  /handlers\/clock(?:-auto|-pure-blocks)?\.js/,
  /clock-runtime-hooks\.js/,
  /heartbeat-runtime-hooks\.js/,
  /chat_clock_[a-z_]+/,
  /hub_heartbeat_directives/,
  /plan_chat_clock_operations_json/,
  /buildHeartbeatInjectTextSnapshot/,
  /resolveClockConfigSnapshot/,
  /startClockDaemonIfNeededSnapshot/,
  /setHeartbeatRuntimeHooksSnapshot/,
];

function walkFiles(root: string, suffixes: string[]): string[] {
  const out: string[] = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') continue;
      out.push(...walkFiles(full, suffixes));
      continue;
    }
    if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
      out.push(full);
    }
  }
  return out;
}

describe('clock heartbeat feature removal gate', () => {
  it('physically removes clock and heartbeat feature files', () => {
    const survivors = REMOVED_PATHS.filter((relativePath) => fs.existsSync(path.join(process.cwd(), relativePath)));
    expect(survivors).toEqual([]);
  });

  it('keeps HubPipeline/servertool source free of clock heartbeat feature hooks', () => {
    const roots = [
      'src/modules/llmswitch',
      'src/server/runtime/http-server',
      'sharedmodule/llmswitch-core/src/conversion/hub',
      'sharedmodule/llmswitch-core/src/servertool',
      'sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src',
    ];
    const findings: string[] = [];
    for (const root of roots) {
      for (const file of walkFiles(path.join(process.cwd(), root), ['.ts', '.rs'])) {
        const relative = path.relative(process.cwd(), file);
        if (relative.endsWith('clock-heartbeat-feature-removal-gate.spec.ts')) continue;
        if (relative.endsWith('shared_tooling/tests.rs')) continue;
        const source = fs.readFileSync(file, 'utf8');
        for (const pattern of FORBIDDEN_SOURCE_PATTERNS) {
          if (pattern.test(source)) {
            findings.push(`${relative}:${pattern.source}`);
          }
        }
      }
    }
    expect(findings).toEqual([]);
  });
});
