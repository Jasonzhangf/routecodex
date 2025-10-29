/**
 * Shared helpers for standard tool normalization (shell packing rules).
 * The goal is deterministic, minimal shaping so executors succeed consistently.
 */

export interface ShellArgs {
  command: string | string[];
  workdir?: string;
  timeout_ms?: number;
  // allow pass-through of any other vendor fields without actively pruning
  // [key: string]: unknown;
}

// We intentionally do NOT evaluate shell control operators (&&, |, etc.).
// Codex CLI executor runs argv directly (execvp-like), not through a shell.
// So we avoid wrapping with "bash -lc" and leave such tokens as-is.

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === 'string') return [v];
  if (v == null) return [];
  return [String(v)];
}

export function splitCommandString(input: string): string[] {
  const s = input.trim();
  if (!s) return [];
  const out: string[] = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; }
      cur += ch; continue;
    }
    if (inDouble) {
      if (ch === '"') { inDouble = false; continue; }
      if (ch === '\\' && i + 1 < s.length) { // simple escape in double quotes
        i++; cur += s[i]; continue;
      }
      cur += ch; continue;
    }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Pack shell arguments per unified rules:
 * - command: string -> ["bash","-lc","<string>"]
 * - command: tokens[]
 *   - if starts with ["cd", path, ...rest]:
 *       - set workdir to path when absent
 *       - if rest empty => command=["pwd"]
 *       - else if rest has control tokens => command=["bash","-lc", join(rest)]
 *       - else command=rest (argv)
 *   - else if tokens contain control tokens => command=["bash","-lc", join(tokens)]
 *   - else command=tokens (argv)
 * - join(rest) uses single-space join without extra quoting
 */
export function packShellArgs(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  const cmdRaw = (out as any).command as unknown;
  const workdir = (out as any).workdir as unknown;

  // string => split into argv tokens (no shell wrapping)
  if (typeof cmdRaw === 'string') {
    const tokens = splitCommandString(cmdRaw);
    // handle leading cd as cwd switch
    if (tokens[0] === 'cd' && typeof tokens[1] === 'string' && tokens[1]) {
      const dir = tokens[1];
      let rest = tokens.slice(2);
      // tolerate common chain operator right after cd
      if (rest[0] === '&&' || rest[0] === ';') {
        rest = rest.slice(1);
      }
      if (!workdir) out.workdir = dir;
      out.command = rest.length ? rest : ['pwd'];
      return out;
    }
    out.command = tokens.length ? tokens : ['pwd'];
    if (typeof workdir === 'string' && workdir) out.workdir = workdir;
    return out;
  }

  // array tokens
  const tokens = toStringArray(cmdRaw);
  if (tokens.length === 0) {
    out.command = ['pwd'];
    if (typeof workdir === 'string' && workdir) out.workdir = workdir;
    return out;
  }

  // cd chain for argv input
  if (tokens[0] === 'cd' && typeof tokens[1] === 'string' && tokens[1]) {
    const dir = tokens[1];
    const rest = tokens.slice(2);
    if (!workdir) out.workdir = dir;
    out.command = rest.length ? rest : ['pwd'];
    return out;
  }

  // argv straight
  out.command = tokens;
  if (typeof workdir === 'string' && workdir) out.workdir = workdir;
  return out;
}
