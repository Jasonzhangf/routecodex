import { describe, expect, it } from '@jest/globals';
import { computeEnvOutput } from '../../src/cli/commands/env.js';

describe('cli env output', () => {
  it('renders shell exports', () => {
    const lines = computeEnvOutput({ host: '127.0.0.1', port: 5520, json: false });
    expect(lines.join('\n')).toContain('export ANTHROPIC_BASE_URL=http://127.0.0.1:5520');
    expect(lines.join('\n')).toContain('unset ANTHROPIC_TOKEN');
  });

  it('renders json', () => {
    const lines = computeEnvOutput({ host: '127.0.0.1', port: 5520, json: true });
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:5520');
    expect(parsed.UNSET).toContain('ANTHROPIC_TOKEN');
  });
});

