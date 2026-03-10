import type { RoutingInstruction } from './routing-instructions.js';
import { resolvePreCommandScriptPath } from './pre-command-file-resolver.js';

const DEFAULT_PRECOMMAND_SCRIPT = 'default.sh';

export function parsePreCommandInstruction(instruction: string): RoutingInstruction | null {
  const trimmed = typeof instruction === 'string' ? instruction.trim() : '';
  if (!trimmed) {
    return null;
  }

  if (/^precommand$/i.test(trimmed)) {
    return {
      type: 'preCommandSet',
      preCommandScriptPath: resolvePreCommandScriptPath(resolveDefaultScriptRef())
    };
  }

  if (!/^precommand\s*:/i.test(trimmed)) {
    return null;
  }

  const body = trimmed.slice('precommand'.length + 1).trim();
  if (!body) {
    return null;
  }

  const parsedValue = readPreCommandToken(body);
  if (!parsedValue) {
    return null;
  }

  const normalized = parsedValue.trim();
  if (!normalized) {
    return null;
  }

  if (/^(?:clear|off|none)$/i.test(normalized)) {
    return { type: 'preCommandClear' };
  }

  if (/^on$/i.test(normalized)) {
    return {
      type: 'preCommandSet',
      preCommandScriptPath: resolvePreCommandScriptPath(resolveDefaultScriptRef())
    };
  }

  return {
    type: 'preCommandSet',
    preCommandScriptPath: resolvePreCommandScriptPath(normalized)
  };
}

function resolveDefaultScriptRef(): string {
  const configured = process.env.ROUTECODEX_PRECOMMAND_DEFAULT_SCRIPT;
  if (typeof configured === 'string' && configured.trim()) {
    return configured.trim();
  }
  return DEFAULT_PRECOMMAND_SCRIPT;
}

function readPreCommandToken(body: string): string | null {
  if (!body) {
    return null;
  }

  const first = body[0];
  if (first === '"' || first === "'") {
    const end = findClosingQuote(body, first);
    if (end <= 0) {
      return null;
    }
    return body.slice(1, end).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }

  const comma = body.indexOf(',');
  if (comma >= 0) {
    return body.slice(0, comma).trim();
  }

  return body.trim();
}

function findClosingQuote(text: string, quote: '"' | "'"): number {
  let escaped = false;
  for (let idx = 1; idx < text.length; idx += 1) {
    const ch = text[idx];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) {
      return idx;
    }
  }
  return -1;
}
