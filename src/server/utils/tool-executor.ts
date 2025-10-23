import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const exec = promisify(execCb);

export interface ToolCallSpec {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  id: string;
  name: string;
  output: string;
  error?: string;
}

/**
 * Tool executor (trusts client-defined commands).
 * - Executes { name: 'shell', args: { command: string } } without internal
 *   whitelists or path restrictions.
 * - SECURITY: This mode trusts the caller. To re-enable safeguards in certain
 *   environments, set ROUTECODEX_TOOL_SAFE_MODE=1 (not default).
 */
export async function executeTool(spec: ToolCallSpec): Promise<ToolResult> {
  const name = String(spec.name || '').toLowerCase();
  if (name !== 'shell') {
    return { id: spec.id, name, output: '', error: `unsupported tool: ${name}` };
  }

  let command = '';
  try {
    const args = typeof spec.args === 'string' ? JSON.parse(spec.args) : (spec.args as Record<string, unknown>);
    const cmd = (args as any)?.command;
    if (Array.isArray(cmd)) {
      // Join tokens into a shell-safe string (no guessing/splitting elsewhere)
      const quote = (s: string) => {
        if (s === '') return "''";
        // If contains whitespace or shell metachars, single-quote and escape inner quotes
        if (/[^A-Za-z0-9_\.\-\/:]/.test(s)) {
          return "'" + s.replace(/'/g, "'\\''") + "'";
        }
        return s;
      };
      command = cmd.map((x) => quote(String(x))).join(' ').trim();
    } else {
      command = String(cmd || '').trim();
    }
  } catch {
    return { id: spec.id, name, output: '', error: 'invalid arguments' };
  }

  if (!command) {
    return { id: spec.id, name, output: '', error: 'empty command' };
  }

  // Optional safe mode (disabled by default). When enabled, block control operators.
  const SAFE_MODE = String(process.env.ROUTECODEX_TOOL_SAFE_MODE || '').trim() === '1';
  if (SAFE_MODE && /[;&|]{1,2}/.test(command)) {
    return { id: spec.id, name, output: '', error: 'blocked by safe mode: control operators not allowed' };
  }

  try {
    const { stdout, stderr } = await exec(command, { timeout: 5000, maxBuffer: 1024 * 1024 });
    const out = stdout?.toString()?.trim() || '';
    const err = stderr?.toString()?.trim() || '';
    const merged = [out, err].filter(Boolean).join('\n');
    return { id: spec.id, name, output: merged };
  } catch (e: any) {
    const msg = e?.message || String(e);
    return { id: spec.id, name, output: '', error: msg };
  }
}
