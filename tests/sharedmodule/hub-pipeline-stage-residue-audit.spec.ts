import fs from 'node:fs';
import path from 'node:path';

interface ResidueCheck {
  label: string;
  pattern: RegExp;
}

function collectMatches(source: string, checks: ResidueCheck[]): string[] {
  const lines = source.split('\n');
  const findings: string[] = [];
  for (const check of checks) {
    for (let index = 0; index < lines.length; index += 1) {
      if (check.pattern.test(lines[index] ?? '')) {
        findings.push(`${check.label}@L${index + 1}`);
      }
    }
  }
  return findings;
}

describe('hub pipeline stage residue audit', () => {
  it('req_process stage1 must not directly depend on process-level TS semantic residue', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/req_process/req_process_stage1_tool_governance/index.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    const findings = collectMatches(source, [
      {
        label: 'imports chat-process-heartbeat-directives',
        pattern: /chat-process-heartbeat-directives\.js/,
      },
      {
        label: 'imports chat-process-clock-runtime-bridge',
        pattern: /chat-process-clock-runtime-bridge\.js/,
      },
      {
        label: 'imports chat-process-request-sanitizer-runtime-bridge',
        pattern: /chat-process-request-sanitizer-runtime-bridge\.js/,
      },
      {
        label: 'calls applyHeartbeatDirectives',
        pattern: /\bapplyHeartbeatDirectives\s*\(/,
      },
      {
        label: 'calls applyChatProcessClockRuntimeBridge',
        pattern: /\bapplyChatProcessClockRuntimeBridge\s*\(/,
      },
      {
        label: 'calls applyChatProcessRequestSanitizerRuntimeBridge',
        pattern: /\bapplyChatProcessRequestSanitizerRuntimeBridge\s*\(/,
      },
    ]);

    expect(findings).toEqual([]);
  });

  it('resp_process stage1 must remain thin-shell and must not reintroduce TS governance sidecar mutation', () => {
    const filePath = path.join(
      process.cwd(),
      'sharedmodule/llmswitch-core/src/conversion/hub/pipeline/stages/resp_process/resp_process_stage1_tool_governance/index.ts',
    );
    const source = fs.readFileSync(filePath, 'utf8');

    const findings = collectMatches(source, [
      {
        label: 'defines attachRequestedToolNames',
        pattern: /\bfunction attachRequestedToolNames\b/,
      },
      {
        label: 'defines markTextHarvestApplied',
        pattern: /\bfunction markTextHarvestApplied\b/,
      },
      {
        label: 'writes __rcc_tool_governance sidecar',
        pattern: /__rcc_tool_governance/,
      },
    ]);

    expect(findings).toEqual([]);
  });
});
