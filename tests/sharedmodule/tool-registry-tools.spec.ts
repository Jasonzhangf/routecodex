import fs from 'node:fs';
import path from 'node:path';
import { validateToolCall } from '../../sharedmodule/llmswitch-core/src/tools/tool-registry.js';

const toArgsObject = (result: { normalizedArgs?: string }): Record<string, unknown> => {
  if (!result.normalizedArgs) {
    return {};
  }
  return JSON.parse(result.normalizedArgs) as Record<string, unknown>;
};

const TMP_DIR = path.join(process.cwd(), 'tmp', 'jest-tool-registry-exec-guard');
const POLICY_PATH = path.join(TMP_DIR, 'exec-command-guard-policy.v1.json');

describe('tool-registry validateToolCall (all tools)', () => {
  beforeAll(() => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(
      POLICY_PATH,
      JSON.stringify(
        {
          version: 1,
          rules: [
            {
              id: 'deny-mass-kill',
              type: 'regex',
              pattern:
                '\\bpkill\\b|\\bkillall\\b|\\btaskkill\\b|\\bxargs\\b[^\\n]*\\bkill\\b|\\blsof\\b[^\\n]*\\|[^\\n]*\\bxargs\\b[^\\n]*\\bkill\\b',
              flags: 'i',
              reason: 'mass kill command is not allowed'
            }
          ]
        },
        null,
        2
      )
    );
  });

  it('validates shell tool arguments', () => {
    const args = JSON.stringify({
      command: ['echo', 'hello'],
      workdir: '/tmp',
      timeout_ms: 1000
    });
    const result = validateToolCall('shell', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(Array.isArray(parsed.command)).toBe(true);
    expect(parsed.command).toContain('echo');
    expect(parsed.workdir).toBe('/tmp');
  });

  it('rejects shell with invalid command', () => {
    const args = JSON.stringify({ command: 123 });
    const result = validateToolCall('shell', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_command');
  });

  it('validates update_plan tool arguments', () => {
    const args = JSON.stringify({
      explanation: 'test plan',
      plan: [
        { step: 'step1', status: 'pending' },
        { step: 'step2', status: 'in_progress' }
      ]
    });
    const result = validateToolCall('update_plan', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(Array.isArray(parsed.plan)).toBe(true);
    expect(parsed.plan.length).toBe(2);
  });

  it('rejects update_plan without plan array', () => {
    const args = JSON.stringify({ explanation: 'no plan' });
    const result = validateToolCall('update_plan', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_plan');
  });

  it('validates view_image tool arguments', () => {
    const args = JSON.stringify({ path: 'images/example.png' });
    const result = validateToolCall('view_image', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.path).toBe('images/example.png');
  });

  it('rejects view_image with non-image path', () => {
    const args = JSON.stringify({ path: 'docs/readme.txt' });
    const result = validateToolCall('view_image', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_image_path');
  });

  it('validates list_mcp_resources arguments', () => {
    const args = JSON.stringify({
      server: 'my-server',
      filter: 'foo',
      root: '/workspace'
    });
    const result = validateToolCall('list_mcp_resources', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.server).toBe('my-server');
    expect(parsed.filter).toBe('foo');
    expect(parsed.root).toBe('/workspace');
  });

  it('validates read_mcp_resource arguments', () => {
    const args = JSON.stringify({
      server: 'my-server',
      uri: 'resource://id'
    });
    const result = validateToolCall('read_mcp_resource', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.server).toBe('my-server');
    expect(parsed.uri).toBe('resource://id');
  });

  it('rejects read_mcp_resource without server or uri', () => {
    const args = JSON.stringify({ server: 'only-server' });
    const result = validateToolCall('read_mcp_resource', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing_server_or_uri');
  });

  it('validates list_mcp_resource_templates arguments', () => {
    const args = JSON.stringify({
      server: 'my-server',
      cursor: 'next'
    });
    const result = validateToolCall('list_mcp_resource_templates', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.server).toBe('my-server');
    expect(parsed.cursor).toBe('next');
  });

  it('rejects destructive git reset --hard in exec_command', () => {
    const args = JSON.stringify({
      cmd: 'git reset --hard HEAD',
      workdir: '/workspace'
    });
    const result = validateToolCall('exec_command', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('forbidden_git_reset_hard');
    expect(result.message).toContain('git reset --hard');
  });

  it('allows git checkout for one file only in exec_command', () => {
    const args = JSON.stringify({
      cmd: 'git checkout -- src/index.ts',
      workdir: '/workspace'
    });
    const result = validateToolCall('exec_command', args);
    expect(result.ok).toBe(true);
    const parsed = toArgsObject(result);
    expect(parsed.cmd).toBe('git checkout -- src/index.ts');
  });

  it('rejects git checkout without file scope in exec_command', () => {
    const args = JSON.stringify({
      cmd: 'git checkout feature/new-flow',
      workdir: '/workspace'
    });
    const result = validateToolCall('exec_command', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('forbidden_git_checkout_scope');
    expect(result.message).toContain('single file');
  });

  it('rejects git checkout with multiple files in exec_command', () => {
    const args = JSON.stringify({
      cmd: 'git checkout -- src/a.ts src/b.ts',
      workdir: '/workspace'
    });
    const result = validateToolCall('exec_command', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('forbidden_git_checkout_scope');
  });

  it('rejects git checkout when chained with additional commands', () => {
    const args = JSON.stringify({
      cmd: 'git checkout -- src/a.ts && git status',
      workdir: '/workspace'
    });
    const result = validateToolCall('exec_command', args);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('forbidden_git_checkout_scope');
    expect(result.message).toContain('standalone');
  });

  it('rejects pkill-based mass kill in exec_command', () => {
    const args = JSON.stringify({
      cmd: 'pkill -9 node',
      workdir: '/workspace'
    });
    const result = validateToolCall('exec_command', args, {
      execCommandGuard: { enabled: true, policyFile: POLICY_PATH }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('forbidden_exec_command_policy');
    expect(result.message).toContain('mass kill command is not allowed');
  });

  it('rejects lsof | xargs kill mass kill in exec_command', () => {
    const args = JSON.stringify({
      cmd: 'lsof -ti :7701 | xargs kill -9',
      workdir: '/workspace'
    });
    const result = validateToolCall('exec_command', args, {
      execCommandGuard: { enabled: true, policyFile: POLICY_PATH }
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('forbidden_exec_command_policy');
    expect(result.message).toContain('mass kill command is not allowed');
  });
});
